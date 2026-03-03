// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { Command } from "@cliffy/command";
import type { Logger } from "@logtape/logtape";
import { basename, dirname, join, relative, resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { resolveVaultsDir } from "../resolve_vaults_dir.ts";
import { resolveWorkflowsDir } from "../resolve_workflows_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";
import { verifyChecksum } from "../../domain/update/integrity.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import {
  renderExtensionPull,
  renderExtensionPullCancelled,
  renderExtensionPullConflicts,
  renderExtensionPullDependencyPull,
  renderExtensionPullIntegrity,
  renderExtensionPullPlatforms,
  renderExtensionPullRepository,
  renderExtensionPullResolved,
  renderExtensionPullSafetyWarnings,
} from "../../presentation/output/extension_pull_output.ts";

/** Returns true if the filename is a macOS resource fork (AppleDouble) file. */
function isMacOsResourceFork(name: string): boolean {
  return name.startsWith("._");
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const DEFAULT_SERVER_URL = "https://swamp.club";
const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+$/;
const MAX_DEPENDENCY_DEPTH = 10;
const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_DELAY_MS = 100;

/** Parsed extension reference from CLI argument. */
export interface ExtensionRef {
  name: string;
  version: string | null;
}

/** Result of installing a single extension (no rendering). */
export interface InstallResult {
  name: string;
  version: string;
  description: string | undefined;
  extractedFiles: string[];
  integrityStatus: "verified" | "unverified";
  repository: string | undefined;
  platforms: string[];
  safetyWarnings: SafetyIssue[];
  conflicts: string[];
  dependencyResults: InstallResult[];
}

/** Context for the headless install function. */
export interface InstallContext {
  extensionClient: ExtensionApiClient;
  logger: Logger;
  modelsDir: string;
  workflowsDir: string;
  vaultsDir: string;
  repoDir: string;
  force: boolean;
  alreadyPulled: Set<string>;
  depth: number;
}

/** Thrown when file conflicts are detected and force is false. */
export class ConflictError extends UserError {
  conflicts: string[];
  constructor(conflicts: string[]) {
    super(
      `The following files already exist and would be overwritten:\n${
        conflicts.map((c) => `  ${c}`).join("\n")
      }\nUse --force to overwrite.`,
    );
    this.conflicts = conflicts;
  }
}

/** Entry in upstream_extensions.json. */
export interface UpstreamExtensionEntry {
  version: string;
  pulledAt: string;
  files?: string[];
}

/** Shape of upstream_extensions.json. */
type UpstreamExtensionsMap = Record<string, UpstreamExtensionEntry>;

/**
 * Parses an extension reference string into name and optional version.
 *
 * Examples:
 * - `@ns/name` → `{ name: "@ns/name", version: null }`
 * - `@ns/name@2026.02.26.1` → `{ name: "@ns/name", version: "2026.02.26.1" }`
 */
export function parseExtensionRef(ref: string): ExtensionRef {
  if (!ref.startsWith("@")) {
    throw new UserError(
      `Invalid extension name: "${ref}". Extension names must start with "@" (e.g., @namespace/name).`,
    );
  }

  // Find the version separator '@' after the initial '@'
  const versionSepIdx = ref.indexOf("@", 1);
  if (versionSepIdx === -1) {
    return { name: ref, version: null };
  }

  const name = ref.slice(0, versionSepIdx);
  const version = ref.slice(versionSepIdx + 1);

  if (!version) {
    throw new UserError(
      `Invalid extension reference: "${ref}". Version cannot be empty after "@".`,
    );
  }

  return { name, version };
}

/**
 * Resolves the registry server URL.
 * Priority: SWAMP_CLUB_URL env var > default "https://swamp.club"
 */
function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SERVER_URL;
}

async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

/**
 * Acquires an advisory lockfile. Retries with short backoff.
 * Returns a cleanup function to release the lock.
 */
async function acquireLock(lockPath: string): Promise<Deno.FsFile> {
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      const file = await Deno.open(lockPath, {
        create: true,
        createNew: true,
        write: true,
      });
      return file;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        if (attempt < LOCK_RETRY_COUNT - 1) {
          await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
          continue;
        }
        throw new UserError(
          "Could not acquire lock on upstream_extensions.json. Another pull may be in progress. Please retry.",
        );
      }
      throw error;
    }
  }
  // Unreachable, but satisfies TypeScript
  throw new UserError("Could not acquire lock on upstream_extensions.json.");
}

/**
 * Updates upstream_extensions.json with a new entry, using a lockfile
 * for concurrency safety and atomicWriteTextFile for crash safety.
 */
export async function updateUpstreamExtensions(
  modelsDir: string,
  name: string,
  version: string,
  files: string[],
): Promise<void> {
  const jsonPath = join(modelsDir, "upstream_extensions.json");
  const lockPath = `${jsonPath}.lock`;

  const lockFile = await acquireLock(lockPath);
  try {
    // Read current state
    let data: UpstreamExtensionsMap = {};
    try {
      const content = await Deno.readTextFile(jsonPath);
      data = JSON.parse(content) as UpstreamExtensionsMap;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Merge new entry
    data[name] = {
      version,
      pulledAt: new Date().toISOString(),
      files,
    };

    // Write atomically
    await atomicWriteTextFile(jsonPath, JSON.stringify(data, null, 2) + "\n");
  } finally {
    lockFile.close();
    try {
      await Deno.remove(lockPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Removes an extension entry from upstream_extensions.json, using a lockfile
 * for concurrency safety and atomicWriteTextFile for crash safety.
 */
export async function removeUpstreamExtension(
  modelsDir: string,
  name: string,
): Promise<void> {
  const jsonPath = join(modelsDir, "upstream_extensions.json");
  const lockPath = `${jsonPath}.lock`;

  const lockFile = await acquireLock(lockPath);
  try {
    let data: UpstreamExtensionsMap = {};
    try {
      const content = await Deno.readTextFile(jsonPath);
      data = JSON.parse(content) as UpstreamExtensionsMap;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    delete data[name];

    await atomicWriteTextFile(jsonPath, JSON.stringify(data, null, 2) + "\n");
  } finally {
    lockFile.close();
    try {
      await Deno.remove(lockPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Reads upstream_extensions.json and returns the parsed map.
 */
export async function readUpstreamExtensions(
  modelsDir: string,
): Promise<UpstreamExtensionsMap> {
  const jsonPath = join(modelsDir, "upstream_extensions.json");
  try {
    const content = await Deno.readTextFile(jsonPath);
    return JSON.parse(content) as UpstreamExtensionsMap;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    throw error;
  }
}

/**
 * Checks if a file exists at the given path.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copies a directory's contents, returning list of relative dest paths.
 */
async function copyDir(
  srcDir: string,
  destDir: string,
  repoDir: string,
): Promise<string[]> {
  const extracted: string[] = [];
  try {
    for await (const entry of Deno.readDir(srcDir)) {
      // Skip macOS resource fork files (._*)
      if (isMacOsResourceFork(entry.name)) continue;

      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory) {
        await Deno.mkdir(destPath, { recursive: true });
        const sub = await copyDir(srcPath, destPath, repoDir);
        extracted.push(...sub);
      } else if (entry.isFile) {
        await Deno.mkdir(dirname(destPath), { recursive: true });
        await Deno.copyFile(srcPath, destPath);
        extracted.push(relative(repoDir, destPath));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return extracted;
}

/**
 * Lists all files recursively under a directory.
 */
async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      // Skip macOS resource fork files (._*)
      if (isMacOsResourceFork(entry.name)) continue;

      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        files.push(...await listFiles(path));
      } else if (entry.isFile) {
        files.push(path);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return files;
}

/**
 * Detects files that already exist at target paths.
 */
export async function detectConflicts(
  extractDir: string,
  modelsDir: string,
  workflowsDir: string,
  bundlesDir: string,
  repoDir: string,
  vaultsDir?: string,
  vaultBundlesDir?: string,
): Promise<string[]> {
  const conflicts: string[] = [];

  // Check models
  const modelsSrc = join(extractDir, "models");
  for (const file of await listFiles(modelsSrc)) {
    const relPath = relative(modelsSrc, file);
    const destPath = join(modelsDir, relPath);
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

  // Check workflows
  const workflowsSrc = join(extractDir, "workflows");
  for (const file of await listFiles(workflowsSrc)) {
    const destPath = join(workflowsDir, basename(file));
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

  // Check bundles
  const bundlesSrc = join(extractDir, "bundles");
  for (const file of await listFiles(bundlesSrc)) {
    const relPath = relative(bundlesSrc, file);
    const destPath = join(bundlesDir, relPath);
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

  // Check vaults
  if (vaultsDir) {
    const vaultsSrc = join(extractDir, "vaults");
    for (const file of await listFiles(vaultsSrc)) {
      const relPath = relative(vaultsSrc, file);
      const destPath = join(vaultsDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  // Check vault bundles
  if (vaultBundlesDir) {
    const vaultBundlesSrc = join(extractDir, "vault-bundles");
    for (const file of await listFiles(vaultBundlesSrc)) {
      const relPath = relative(vaultBundlesSrc, file);
      const destPath = join(vaultBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  // Check additional files
  const filesSrc = join(extractDir, "files");
  for (const file of await listFiles(filesSrc)) {
    const relPath = relative(filesSrc, file);
    const destPath = join(modelsDir, relPath);
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

  return conflicts;
}

export interface PullContext {
  extensionClient: ExtensionApiClient;
  logger: Logger;
  modelsDir: string;
  workflowsDir: string;
  vaultsDir: string;
  repoDir: string;
  force: boolean;
  outputMode: "log" | "json";
  alreadyPulled: Set<string>;
  depth: number;
}

/**
 * Core install logic: download, verify, extract, copy, track.
 * No rendering — returns structured data for callers to present.
 * Throws ConflictError when !force and conflicts exist.
 * Recursively installs dependencies.
 */
export async function installExtension(
  ref: ExtensionRef,
  ctx: InstallContext,
): Promise<InstallResult | undefined> {
  const { extensionClient, logger, modelsDir, repoDir } = ctx;

  // Guard against circular deps
  if (ctx.alreadyPulled.has(ref.name)) {
    return undefined;
  }

  if (ctx.depth > MAX_DEPENDENCY_DEPTH) {
    throw new UserError(
      `Dependency depth exceeds maximum of ${MAX_DEPENDENCY_DEPTH}. Possible circular dependency.`,
    );
  }

  ctx.alreadyPulled.add(ref.name);

  // Get extension metadata (unauthenticated) — also resolves latest version
  const extInfo = await extensionClient.getExtension(ref.name);
  if (!extInfo) {
    throw new UserError(
      `Extension ${ref.name} not found in the registry.`,
    );
  }

  // Resolve version: use explicit version or latest from metadata
  const version = ref.version ?? extInfo.latestVersion;
  if (!version) {
    throw new UserError(
      `Extension ${ref.name} has no published versions.`,
    );
  }

  // Download archive
  const archiveBytes = await extensionClient.downloadArchive(
    ref.name,
    version,
  );

  // Verify integrity
  const serverChecksum = await extensionClient.getChecksum(ref.name, version);
  const localChecksum = await computeChecksum(archiveBytes);
  let integrityStatus: "verified" | "unverified";
  if (serverChecksum !== null) {
    verifyChecksum(serverChecksum, localChecksum);
    integrityStatus = "verified";
  } else {
    integrityStatus = "unverified";
  }

  // Extract to temp dir
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_pull_" });
  try {
    // Write archive to temp file
    const archivePath = join(tmpDir, "extension.tar.gz");
    await Deno.writeFile(archivePath, archiveBytes);

    // Extract using tar
    // COPYFILE_DISABLE prevents macOS tar from creating ._ resource fork files
    const tarCommand = new Deno.Command("tar", {
      args: ["-xzf", archivePath, "-C", tmpDir],
      stdout: "piped",
      stderr: "piped",
      env: { COPYFILE_DISABLE: "1" },
    });
    const tarOutput = await tarCommand.output();
    if (!tarOutput.success) {
      const stderr = new TextDecoder().decode(tarOutput.stderr);
      throw new UserError(`Failed to extract archive: ${stderr}`);
    }

    const extractDir = join(tmpDir, "extension");

    // Log extracted files for debugging
    const allExtractedFiles = await listFiles(extractDir);
    for (const f of allExtractedFiles) {
      logger.debug`Archive contains: ${relative(extractDir, f)}`;
    }

    // Parse manifest
    let manifestContent: string;
    try {
      manifestContent = await Deno.readTextFile(
        join(extractDir, "manifest.yaml"),
      );
    } catch {
      throw new UserError(
        "Downloaded archive is missing manifest.yaml. The extension may be corrupt.",
      );
    }
    const manifest = parseExtensionManifest(manifestContent);

    // Safety analysis on .ts files (models and vaults)
    const safetyWarnings: SafetyIssue[] = [];
    const modelTsFiles = (await listFiles(join(extractDir, "models"))).filter(
      (f) => f.endsWith(".ts"),
    );
    const vaultTsFiles = (await listFiles(join(extractDir, "vaults"))).filter(
      (f) => f.endsWith(".ts"),
    );
    const tsFiles = [...modelTsFiles, ...vaultTsFiles];
    if (tsFiles.length > 0) {
      const safetyResult = await analyzeExtensionSafety(tsFiles);

      if (safetyResult.errors.length > 0) {
        throw new UserError(
          `Extension has safety errors. Install aborted.\n${
            safetyResult.errors.map((e) => `  ${e.file}: ${e.message}`).join(
              "\n",
            )
          }`,
        );
      }

      safetyWarnings.push(...safetyResult.warnings);
    }

    // Detect file conflicts
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const absoluteWorkflowsDir = resolve(repoDir, ctx.workflowsDir);
    const absoluteVaultsDir = resolve(repoDir, ctx.vaultsDir);
    const bundlesDir = swampPath(repoDir, "bundles");
    const vaultBundlesDir = swampPath(repoDir, "vault-bundles");

    const conflicts = await detectConflicts(
      extractDir,
      absoluteModelsDir,
      absoluteWorkflowsDir,
      bundlesDir,
      repoDir,
      absoluteVaultsDir,
      vaultBundlesDir,
    );

    if (conflicts.length > 0 && !ctx.force) {
      throw new ConflictError(conflicts);
    }

    // Copy files to their destinations
    const extractedFiles: string[] = [];

    // Models → modelsDir
    const modelsExtracted = await copyDir(
      join(extractDir, "models"),
      absoluteModelsDir,
      repoDir,
    );
    extractedFiles.push(...modelsExtracted);

    // Workflows → workflowsDir (default: extensions/workflows/)
    await Deno.mkdir(absoluteWorkflowsDir, { recursive: true });
    const workflowsExtracted = await copyDir(
      join(extractDir, "workflows"),
      absoluteWorkflowsDir,
      repoDir,
    );
    extractedFiles.push(...workflowsExtracted);

    // Bundles → .swamp/bundles/
    await Deno.mkdir(bundlesDir, { recursive: true });
    const bundlesExtracted = await copyDir(
      join(extractDir, "bundles"),
      bundlesDir,
      repoDir,
    );
    extractedFiles.push(...bundlesExtracted);

    // Vaults → vaultsDir
    await Deno.mkdir(absoluteVaultsDir, { recursive: true });
    const vaultsExtracted = await copyDir(
      join(extractDir, "vaults"),
      absoluteVaultsDir,
      repoDir,
    );
    extractedFiles.push(...vaultsExtracted);

    // Vault bundles → .swamp/vault-bundles/
    await Deno.mkdir(vaultBundlesDir, { recursive: true });
    const vaultBundlesExtracted = await copyDir(
      join(extractDir, "vault-bundles"),
      vaultBundlesDir,
      repoDir,
    );
    extractedFiles.push(...vaultBundlesExtracted);

    // Additional files → modelsDir
    const filesExtracted = await copyDir(
      join(extractDir, "files"),
      absoluteModelsDir,
      repoDir,
    );
    extractedFiles.push(...filesExtracted);

    // Update upstream_extensions.json
    await updateUpstreamExtensions(
      absoluteModelsDir,
      ref.name,
      version,
      extractedFiles,
    );

    // Install dependencies recursively
    const dependencyResults: InstallResult[] = [];
    if (manifest.dependencies.length > 0) {
      for (const dep of manifest.dependencies) {
        // Check if already pulled in this session or already installed
        if (ctx.alreadyPulled.has(dep)) {
          continue;
        }

        // Check if already in upstream_extensions.json
        const upstreamPath = join(
          absoluteModelsDir,
          "upstream_extensions.json",
        );
        let isInstalled = false;
        try {
          const upstreamContent = await Deno.readTextFile(upstreamPath);
          const upstream = JSON.parse(
            upstreamContent,
          ) as UpstreamExtensionsMap;
          if (upstream[dep]) {
            isInstalled = true;
          }
        } catch {
          // File may not exist yet
        }

        if (!isInstalled) {
          const depRef = parseExtensionRef(dep);
          const depResult = await installExtension(depRef, {
            ...ctx,
            depth: ctx.depth + 1,
          });
          if (depResult) {
            dependencyResults.push(depResult);
          }
        }
      }
    }

    return {
      name: ref.name,
      version,
      description: extInfo.description,
      extractedFiles,
      integrityStatus,
      repository: manifest.repository,
      platforms: manifest.platforms,
      safetyWarnings,
      conflicts,
      dependencyResults,
    };
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Renders an InstallResult and its dependency tree using pull output functions.
 */
function renderInstallResult(
  result: InstallResult,
  outputMode: "log" | "json",
): void {
  renderExtensionPullResolved(
    {
      name: result.name,
      version: result.version,
      description: result.description,
    },
    outputMode,
  );

  renderExtensionPullIntegrity(
    {
      name: result.name,
      version: result.version,
      status: result.integrityStatus,
    },
    outputMode,
  );

  if (result.repository) {
    renderExtensionPullRepository(result.repository, outputMode);
  }

  if (result.platforms.length > 0) {
    renderExtensionPullPlatforms(result.platforms, outputMode);
  }

  if (result.safetyWarnings.length > 0) {
    renderExtensionPullSafetyWarnings(result.safetyWarnings, outputMode);
  }

  renderExtensionPull(
    {
      name: result.name,
      version: result.version,
      extractedFiles: result.extractedFiles,
    },
    outputMode,
  );

  for (const depResult of result.dependencyResults) {
    renderExtensionPullDependencyPull(
      depResult.name,
      depResult.version,
      outputMode,
    );
    renderInstallResult(depResult, outputMode);
  }
}

/**
 * Pull command wrapper: calls installExtension and handles rendering + conflict prompts.
 */
export async function pullExtension(
  ref: ExtensionRef,
  ctx: PullContext,
): Promise<void> {
  const { outputMode } = ctx;
  const installCtx: InstallContext = {
    extensionClient: ctx.extensionClient,
    logger: ctx.logger,
    modelsDir: ctx.modelsDir,
    workflowsDir: ctx.workflowsDir,
    vaultsDir: ctx.vaultsDir,
    repoDir: ctx.repoDir,
    force: ctx.force,
    alreadyPulled: ctx.alreadyPulled,
    depth: ctx.depth,
  };

  try {
    const result = await installExtension(ref, installCtx);
    if (result) {
      renderInstallResult(result, outputMode);
    }
  } catch (error) {
    if (error instanceof ConflictError) {
      renderExtensionPullConflicts(error.conflicts, outputMode);
      if (outputMode === "json") {
        throw new UserError(
          "Files already exist. Use --force to overwrite.",
        );
      }
      const confirmed = await promptConfirmation(
        "Overwrite existing files?",
      );
      if (!confirmed) {
        renderExtensionPullCancelled(outputMode);
        return;
      }
      // Retry with force
      installCtx.force = true;
      // Reset alreadyPulled so the extension can be retried
      installCtx.alreadyPulled.delete(ref.name);
      const result = await installExtension(ref, installCtx);
      if (result) {
        renderInstallResult(result, outputMode);
      }
    } else {
      throw error;
    }
  }
}

export const extensionPullCommand = new Command()
  .name("pull")
  .description("Pull an extension from the swamp registry")
  .arguments("<extension:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--force", "Overwrite existing files without prompting")
  .action(async function (options: AnyOptions, extension: string) {
    const ctx = createContext(options as GlobalOptions, ["extension", "pull"]);
    ctx.logger.debug`Starting extension pull`;

    // 1. Validate repo
    const repoDir = options.repoDir ?? ".";
    await requireInitializedRepo({
      repoDir,
      outputMode: ctx.outputMode,
    });

    // 2. Parse extension reference
    const ref = parseExtensionRef(extension);

    // 3. Validate name format
    if (!SCOPED_NAME_PATTERN.test(ref.name)) {
      throw new UserError(
        `Invalid extension name: "${ref.name}". Must match @namespace/name pattern (lowercase, alphanumeric, hyphens, underscores).`,
      );
    }

    // 4. Resolve models dir, workflows dir, and vaults dir from .swamp.yaml
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const workflowsDir = resolveWorkflowsDir(marker);
    const vaultsDir = resolveVaultsDir(marker);

    // 5. Resolve server URL (from env or default)
    const serverUrl = resolveServerUrl();

    // 6. Create API client and pull
    const extensionClient = new ExtensionApiClient(serverUrl);

    await pullExtension(ref, {
      extensionClient,
      logger: ctx.logger,
      modelsDir,
      workflowsDir,
      vaultsDir,
      repoDir,
      force: options.force ?? false,
      outputMode: ctx.outputMode,
      alreadyPulled: new Set(),
      depth: 0,
    });
  });
