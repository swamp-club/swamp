// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { pruneOrphanFiles } from "../../infrastructure/persistence/directory_cleanup.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import { InstallExtensionService } from "./install_extension_service.ts";
import {
  bundleNamespace,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  extractTarGz,
  listTarGzEntries,
} from "../../infrastructure/archive/tar_archive.ts";
import { readInstalledExtensionDigest } from "../../infrastructure/persistence/installed_extension_digest_reader.ts";
import { verifyChecksum } from "../../domain/update/integrity.ts";
import { resolveLocalImports } from "../../domain/models/local_import_resolver.ts";
import type { Logger } from "@logtape/logtape";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;
const MAX_DEPENDENCY_DEPTH = 10;

/** Parsed extension reference from CLI argument. */
export interface ExtensionRef {
  name: string;
  version: string | null;
}

/** Safety warning from extension analysis. */
export interface ExtensionSafetyWarning {
  file: string;
  message: string;
}

/** Extension metadata returned by the registry. */
export interface ExtensionRegistryInfo {
  name: string;
  description: string;
  latestVersion: string;
  latestRc?: string | null;
  latestBeta?: string | null;
  deprecatedAt?: string | null;
  deprecationReason?: string | null;
  supersededBy?: string | null;
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
  safetyWarnings: ExtensionSafetyWarning[];
  binaries: string[];
  conflicts: string[];
  missingSourceFiles: string[];
  hasSkills: boolean;
  hasSkillScripts: boolean;
  skillFiles: string[];
  dependencyResults: InstallResult[];
  /**
   * Repo-relative paths that were declared in the prior version's
   * lockfile entry but absent from the current version's
   * `extractedFiles`, and which were actually removed from disk by
   * `pruneOrphanFiles` during this install. Empty for first-installs
   * (no prior entry) and re-installs of the same version (no diff).
   * Reflects ground truth — paths skipped due to NotFound are NOT
   * included.
   */
  pruned: string[];
}

/**
 * Context for the headless install function (internal, used by
 * extension_update, extensionInstall, and extensionPull).
 *
 * Per-type destination dirs (models/workflows/vaults/drivers/
 * datastores/reports) are deliberately NOT fields on this context —
 * `installExtension` derives them itself as
 * `.swamp/pulled-extensions/<ref.name>/<type>/` so filesystem state is
 * strictly per-extension (issue 120). Only `skillsDir` remains because
 * skills land in a tool-specific dir (`.claude/skills/`, etc.) that
 * the caller owns.
 */
export interface InstallContext {
  getExtension: (name: string) => Promise<ExtensionRegistryInfo | null>;
  downloadArchive: (name: string, version: string) => Promise<Uint8Array>;
  getChecksum: (
    name: string,
    version: string,
  ) => Promise<string | null>;
  logger?: Logger;
  /**
   * Lockfile repository owning read+write of upstream_extensions.json.
   *
   * **Single-use semantics.** The repository captures a snapshot at
   * construction time (per its own JSDoc); reads serve from that snapshot.
   * A given InstallContext therefore embeds a snapshot taken at the moment
   * the context was constructed. DO NOT reuse the same context across
   * multiple install operations — a sibling process or a prior
   * installExtension() call may have written between constructions, and
   * the snapshot would be stale relative to disk. Construct a fresh
   * context per install via `createInstallContext` /
   * `createExtensionPullDeps`. Today's installExtension() reads the
   * snapshot exactly once at install time (line ~726, formerly
   * upstreamMapBefore via readUpstreamExtensions); the migration
   * preserves that timing.
   */
  lockfileRepository: LockfileRepository;
  /** Tool-aware skills destination (e.g. `.claude/skills/`). */
  skillsDir: string;
  repoDir: string;
  force: boolean;
  alreadyPulled: Set<string>;
  depth: number;
  /**
   * Optional lockfile-anchored integrity check. When set, installExtension
   * verifies the downloaded archive's SHA-256 matches this value BEFORE
   * extraction and throws a UserError on mismatch. Scoped strictly to the
   * lockfile-restore path (extensionInstall, migration re-pull) — explicit
   * `swamp extension pull` leaves this unset so the user opts into
   * whatever bytes the registry currently serves.
   */
  expectedChecksum?: string;
  /** Release channel to record in the lockfile entry. */
  channel?: string;
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

export type ExtensionPullEvent =
  | { kind: "installing" }
  | {
    kind: "deprecated_warning";
    name: string;
    reason: string | null;
    supersededBy: string | null;
  }
  | {
    kind: "orphans-pruned";
    name: string;
    version: string;
    paths: string[];
  }
  | { kind: "completed"; data: InstallResult }
  | { kind: "error"; error: SwampError };

/** Input for the extension pull operation. */
export interface ExtensionPullInput {
  ref: ExtensionRef;
  force: boolean;
  channel?: string;
}

/** Dependencies for the extension pull operation. */
export interface ExtensionPullDeps {
  getExtension: (name: string) => Promise<ExtensionRegistryInfo | null>;
  getLatestVersion?: (
    name: string,
    channel: string,
  ) => Promise<string | null>;
  downloadArchive: (name: string, version: string) => Promise<Uint8Array>;
  getChecksum: (name: string, version: string) => Promise<string | null>;
  /**
   * Lockfile repository owning read+write of upstream_extensions.json.
   * See {@link InstallContext.lockfileRepository} for snapshot semantics
   * and the single-use rule.
   */
  lockfileRepository: LockfileRepository;
  /** Tool-aware skills destination (e.g. `.claude/skills/`). */
  skillsDir: string;
  repoDir: string;
  alreadyPulled: Set<string>;
  depth: number;
  /**
   * Test seam (W2 Pin 2). Defaults to the real {@link installExtension}
   * from this module; tests inject a stub so the
   * {@link ExtensionPullEvent} stream can be exercised without a real
   * registry, tarball, or filesystem write. Production callers always
   * leave this unset — `extensionPull` falls back to the real
   * `installExtension` automatically.
   */
  installExtensionFn?: (
    ref: ExtensionRef,
    ctx: InstallContext,
  ) => Promise<InstallResult | undefined>;
  /**
   * W2 service deps. When BOTH are provided, `extensionPull` routes
   * through {@link InstallExtensionService} — phase 8 fires (synchronous
   * type extraction + `repository.save` + FS rollback on
   * `DuplicateTypeError`). When either is missing, falls back to the
   * pre-W2 free-function path (catalog rows populated lazily by the
   * loader's next pass — same behavior as W1b shipped).
   *
   * Production paths that want the W2 contract (I-Repo-1 fires at install
   * time) MUST pass both. Migrating callers is plan v4 commit 3 (CONVERT
   * callsites) and the wrapper-internal swap for KEEP callsites.
   */
  denoRuntime?: DenoRuntime;
  repository?: ExtensionRepository;
}

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
      `Invalid extension name: "${ref}". Extension names must start with "@" (e.g., @collective/name).`,
    );
  }

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
 * Validates a scoped extension name matches the expected pattern.
 */
export function validateExtensionName(name: string): void {
  if (!SCOPED_NAME_PATTERN.test(name)) {
    throw new UserError(
      `Invalid extension name: "${name}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }
}

/**
 * Resolves the registry server URL.
 * Priority: SWAMP_CLUB_URL env var > DEFAULT_SWAMP_CLUB_URL
 */
export function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

/** Returns true if the filename is a macOS resource fork (AppleDouble) file. */
function isMacOsResourceFork(name: string): boolean {
  return name.startsWith("._");
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
 * Recursively validates that no symlink under `path` resolves to a target
 * outside `resolvedTmpDir`. Throws a UserError if a symlink escapes.
 */
async function validateNoSymlinkEscape(
  path: string,
  resolvedTmpDir: string,
): Promise<void> {
  const stat = await Deno.lstat(path);
  if (stat.isSymlink) {
    const linkTarget = await Deno.readLink(path);
    const resolvedTarget = resolve(join(path, "..", linkTarget));
    if (!resolvedTarget.startsWith(resolvedTmpDir + SEPARATOR)) {
      throw new UserError(
        `Archive contains a symlink that escapes the temp directory: ${path}`,
      );
    }
  } else if (stat.isDirectory) {
    for await (const entry of Deno.readDir(path)) {
      await validateNoSymlinkEscape(join(path, entry.name), resolvedTmpDir);
    }
  }
}

/**
 * Detects files that already exist at target paths.
 *
 * Under the extension-first layout, every dir passed in is per-extension,
 * so a non-empty return means this extension is being re-installed on top
 * of itself (resolved by --force) — it never means a collision with a
 * different extension.
 */
export async function detectConflicts(
  extractDir: string,
  modelsDir: string,
  workflowsDir: string,
  bundlesDir: string,
  repoDir: string,
  vaultsDir?: string,
  vaultBundlesDir?: string,
  driversDir?: string,
  driverBundlesDir?: string,
  datastoresDir?: string,
  datastoreBundlesDir?: string,
  reportsDir?: string,
  reportBundlesDir?: string,
  filesDir?: string,
): Promise<string[]> {
  const conflicts: string[] = [];

  const modelsSrc = join(extractDir, "models");
  for (const file of await listFiles(modelsSrc)) {
    const relPath = relative(modelsSrc, file);
    const destPath = join(modelsDir, relPath);
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

  const workflowsSrc = join(extractDir, "workflows");
  for (const file of await listFiles(workflowsSrc)) {
    const destPath = join(workflowsDir, basename(file));
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

  const bundlesSrc = join(extractDir, "bundles");
  for (const file of await listFiles(bundlesSrc)) {
    const relPath = relative(bundlesSrc, file);
    const destPath = join(bundlesDir, relPath);
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

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

  if (driversDir) {
    const driversSrc = join(extractDir, "drivers");
    for (const file of await listFiles(driversSrc)) {
      const relPath = relative(driversSrc, file);
      const destPath = join(driversDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (driverBundlesDir) {
    const driverBundlesSrc = join(extractDir, "driver-bundles");
    for (const file of await listFiles(driverBundlesSrc)) {
      const relPath = relative(driverBundlesSrc, file);
      const destPath = join(driverBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (datastoresDir) {
    const datastoresSrc = join(extractDir, "datastores");
    for (const file of await listFiles(datastoresSrc)) {
      const relPath = relative(datastoresSrc, file);
      const destPath = join(datastoresDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (datastoreBundlesDir) {
    const datastoreBundlesSrc = join(extractDir, "datastore-bundles");
    for (const file of await listFiles(datastoreBundlesSrc)) {
      const relPath = relative(datastoreBundlesSrc, file);
      const destPath = join(datastoreBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (reportsDir) {
    const reportsSrc = join(extractDir, "reports");
    for (const file of await listFiles(reportsSrc)) {
      const relPath = relative(reportsSrc, file);
      const destPath = join(reportsDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (reportBundlesDir) {
    const reportBundlesSrc = join(extractDir, "report-bundles");
    for (const file of await listFiles(reportBundlesSrc)) {
      const relPath = relative(reportBundlesSrc, file);
      const destPath = join(reportBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (filesDir) {
    const filesSrc = join(extractDir, "files");
    for (const file of await listFiles(filesSrc)) {
      const relPath = relative(filesSrc, file);
      const destPath = join(filesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  return conflicts;
}

/**
 * Validates that all source files referenced by imports are present.
 * Returns paths of missing files (relative to the base directory).
 */
async function validateSourceCompleteness(
  ...dirs: string[]
): Promise<string[]> {
  const entryPoints: string[] = [];
  for (const dir of dirs) {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".ts")) {
          entryPoints.push(join(dir, entry.name));
        } else if (entry.isDirectory && !entry.name.startsWith("_")) {
          const subEntries = await collectTsFiles(join(dir, entry.name));
          entryPoints.push(...subEntries);
        }
      }
    } catch {
      // Directory may not exist
    }
  }

  if (entryPoints.length === 0) return [];

  const boundaryDir = dirs[0];
  const result = await resolveLocalImports(entryPoints, boundaryDir);

  const missing: string[] = [];
  for (const resolved of result.resolvedFiles) {
    try {
      await Deno.stat(resolved);
    } catch {
      missing.push(relative(boundaryDir, resolved));
    }
  }
  return missing;
}

/** Recursively collects .ts files from a directory, skipping _-prefixed dirs. */
async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".ts")) {
        files.push(join(dir, entry.name));
      } else if (entry.isDirectory && !entry.name.startsWith("_")) {
        files.push(...await collectTsFiles(join(dir, entry.name)));
      }
    }
  } catch {
    // Directory may not exist
  }
  return files;
}

/**
 * Computes which paths from a prior version's lockfile entry are
 * orphans relative to a new version's extracted file set — i.e. paths
 * declared by the old version but absent from the new one. Pure
 * function; the caller hands the result to `pruneOrphanFiles` to
 * remove them from disk.
 *
 * Both lists are repo-relative paths. Uses a Set for O(N) lookup
 * instead of O(N²) `.includes()`.
 *
 * Exported for direct unit testing — production callers go through
 * `installExtension`.
 */
export function computeOrphanDiff(
  oldFiles: ReadonlyArray<string>,
  extractedFiles: ReadonlyArray<string>,
): string[] {
  const newFilesSet = new Set(extractedFiles);
  return oldFiles.filter((f) => !newFilesSet.has(f));
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
  const { logger, repoDir } = ctx;

  if (ctx.alreadyPulled.has(ref.name)) {
    return undefined;
  }

  if (ctx.depth > MAX_DEPENDENCY_DEPTH) {
    throw new UserError(
      `Dependency depth exceeds maximum of ${MAX_DEPENDENCY_DEPTH}. Possible circular dependency.`,
    );
  }

  ctx.alreadyPulled.add(ref.name);

  // Snapshot the prior lockfile entry's `files[]` BEFORE extraction.
  // Used after extraction to compute the orphan diff (paths declared
  // by the prior version but absent from the new version) and prune
  // them. Empty when this is a first-install (no prior entry). The
  // lockfile snapshot was captured at InstallContext construction
  // (per createInstallContext / createExtensionPullDeps); callers MUST
  // construct a fresh context per install (see InstallContext JSDoc).
  const oldFiles = ctx.lockfileRepository.getEntry(ref.name)?.files ?? [];

  const extInfo = await ctx.getExtension(ref.name);
  if (!extInfo) {
    throw new UserError(
      `Extension ${ref.name} not found in the registry.`,
    );
  }

  const version = ref.version ?? extInfo.latestVersion;
  if (!version) {
    throw new UserError(
      `Extension ${ref.name} has no published versions.`,
    );
  }

  const archiveBytes = await ctx.downloadArchive(
    ref.name,
    version,
  );

  const serverChecksum = await ctx.getChecksum(ref.name, version);
  const localChecksum = await computeChecksum(archiveBytes);
  let integrityStatus: "verified" | "unverified";
  if (serverChecksum !== null) {
    verifyChecksum(serverChecksum, localChecksum);
    integrityStatus = "verified";
  } else {
    integrityStatus = "unverified";
  }

  // Lockfile-anchored integrity check. When expectedChecksum is provided
  // (lockfile-restore flows: extensionInstall, migration re-pull), verify
  // the freshly-downloaded bytes match what was recorded when the user
  // originally installed this version. This catches registry content drift
  // between the user's original install and their upgrade/reinstall and
  // lets us restore authentic per-extension content during migration.
  if (ctx.expectedChecksum !== undefined) {
    if (ctx.expectedChecksum !== localChecksum) {
      throw new UserError(
        `Checksum mismatch for ${ref.name}@${version} ` +
          `(stored ${ctx.expectedChecksum}, fetched ${localChecksum}). ` +
          `The registry content has changed since your original install. ` +
          `Run 'swamp extension pull ${ref.name}' to accept the current ` +
          `version, or 'swamp extension pull ${ref.name}@<pinned-version>' ` +
          `to hold a specific release.`,
      );
    }
    integrityStatus = "verified";
    if (logger) {
      logger.debug`Lockfile integrity verified for ${ref.name}@${version}`;
    }
  } else if (logger) {
    // Pre-checksum-tracking lockfile entries (pre-f4dfc083) have no stored
    // checksum; verification is skipped. Subsequent installs write a fresh
    // checksum so future restores gain full integrity coverage.
    logger
      .debug`No stored checksum for ${ref.name}@${version}; skipping lockfile-anchored verification`;
  }

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_pull_" });
  try {
    const archivePath = join(tmpDir, "extension.tar.gz");
    await Deno.writeFile(archivePath, archiveBytes);

    let archiveEntries: string[];
    try {
      const listFile = await Deno.open(archivePath, { read: true });
      archiveEntries = await listTarGzEntries(listFile.readable);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Failed to list archive contents: ${message}`);
    }
    for (const entry of archiveEntries) {
      if (entry.includes("..") || entry.startsWith("/")) {
        throw new UserError(
          `Archive contains unsafe path: ${entry}`,
        );
      }
    }

    try {
      const extractFile = await Deno.open(archivePath, { read: true });
      // The Deno-native extractor doesn't shell out to BSD tar, so the macOS
      // `COPYFILE_DISABLE=1` env var that suppressed AppleDouble files in
      // the previous implementation is no longer needed: AppleDouble entries
      // are filtered out at extraction time as a defensive measure.
      await extractTarGz(extractFile.readable, tmpDir);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Failed to extract archive: ${message}`);
    }

    const extractDir = join(tmpDir, "extension");

    for (const entry of archiveEntries) {
      if (logger) {
        logger.debug`Archive contains: ${entry}`;
      }
    }

    const resolvedTmpDir = resolve(tmpDir);
    for await (const entry of Deno.readDir(extractDir)) {
      await validateNoSymlinkEscape(
        join(extractDir, entry.name),
        resolvedTmpDir,
      );
    }

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

    const safetyWarnings: ExtensionSafetyWarning[] = [];
    const modelTsFiles = (await listFiles(join(extractDir, "models"))).filter(
      (f) => f.endsWith(".ts"),
    );
    const vaultTsFiles = (await listFiles(join(extractDir, "vaults"))).filter(
      (f) => f.endsWith(".ts"),
    );
    const driverTsFiles = (await listFiles(join(extractDir, "drivers")))
      .filter((f) => f.endsWith(".ts"));
    const datastoreTsFiles = (
      await listFiles(join(extractDir, "datastores"))
    ).filter((f) => f.endsWith(".ts"));
    const reportTsFiles = (await listFiles(join(extractDir, "reports"))).filter(
      (f) => f.endsWith(".ts"),
    );
    const tsFiles = [
      ...modelTsFiles,
      ...vaultTsFiles,
      ...driverTsFiles,
      ...datastoreTsFiles,
      ...reportTsFiles,
    ];
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

    // Extension-first on-disk layout: each installed extension owns a
    // dedicated subtree under .swamp/pulled-extensions/<ext-name>/. Prevents
    // cross-extension filename collisions (e.g. _lib/aws.ts shared between
    // @swamp/aws/ec2 and @swamp/aws/eks, or README.md across unrelated
    // extensions). Skills remain at ctx.skillsDir — already per-skill.
    const absoluteExtRoot = join(
      swampPath(repoDir, "pulled-extensions"),
      ref.name,
    );
    const absoluteModelsDir = join(absoluteExtRoot, "models");
    const absoluteWorkflowsDir = join(absoluteExtRoot, "workflows");
    const absoluteVaultsDir = join(absoluteExtRoot, "vaults");
    const absoluteDriversDir = join(absoluteExtRoot, "drivers");
    const absoluteDatastoresDir = join(absoluteExtRoot, "datastores");
    const absoluteReportsDir = join(absoluteExtRoot, "reports");
    const absoluteFilesDir = join(absoluteExtRoot, "files");
    // Bundle cache is namespaced by source dir path. Because each extension
    // now has a unique per-extension models dir, each extension gets its own
    // bundle namespace automatically — no cross-extension bundle collisions.
    const bundlesDir = join(
      swampPath(repoDir, "bundles"),
      bundleNamespace(absoluteModelsDir, repoDir),
    );
    const vaultBundlesDir = join(
      swampPath(repoDir, "vault-bundles"),
      bundleNamespace(absoluteVaultsDir, repoDir),
    );
    const driverBundlesDir = join(
      swampPath(repoDir, "driver-bundles"),
      bundleNamespace(absoluteDriversDir, repoDir),
    );
    const datastoreBundlesDir = join(
      swampPath(repoDir, "datastore-bundles"),
      bundleNamespace(absoluteDatastoresDir, repoDir),
    );
    const reportBundlesDir = join(
      swampPath(repoDir, "report-bundles"),
      bundleNamespace(absoluteReportsDir, repoDir),
    );

    const conflicts = await detectConflicts(
      extractDir,
      absoluteModelsDir,
      absoluteWorkflowsDir,
      bundlesDir,
      repoDir,
      absoluteVaultsDir,
      vaultBundlesDir,
      absoluteDriversDir,
      driverBundlesDir,
      absoluteDatastoresDir,
      datastoreBundlesDir,
      absoluteReportsDir,
      reportBundlesDir,
      absoluteFilesDir,
    );

    if (conflicts.length > 0 && !ctx.force) {
      throw new ConflictError(conflicts);
    }

    const extractedFiles: string[] = [];

    await Deno.mkdir(absoluteModelsDir, { recursive: true });
    const modelsExtracted = await copyDir(
      join(extractDir, "models"),
      absoluteModelsDir,
      repoDir,
    );
    extractedFiles.push(...modelsExtracted);

    await Deno.mkdir(absoluteWorkflowsDir, { recursive: true });
    const workflowsExtracted = await copyDir(
      join(extractDir, "workflows"),
      absoluteWorkflowsDir,
      repoDir,
    );
    extractedFiles.push(...workflowsExtracted);

    await Deno.mkdir(bundlesDir, { recursive: true });
    const bundlesExtracted = await copyDir(
      join(extractDir, "bundles"),
      bundlesDir,
      repoDir,
    );
    extractedFiles.push(...bundlesExtracted);

    await Deno.mkdir(absoluteVaultsDir, { recursive: true });
    const vaultsExtracted = await copyDir(
      join(extractDir, "vaults"),
      absoluteVaultsDir,
      repoDir,
    );
    extractedFiles.push(...vaultsExtracted);

    await Deno.mkdir(vaultBundlesDir, { recursive: true });
    const vaultBundlesExtracted = await copyDir(
      join(extractDir, "vault-bundles"),
      vaultBundlesDir,
      repoDir,
    );
    extractedFiles.push(...vaultBundlesExtracted);

    await Deno.mkdir(absoluteDriversDir, { recursive: true });
    const driversExtracted = await copyDir(
      join(extractDir, "drivers"),
      absoluteDriversDir,
      repoDir,
    );
    extractedFiles.push(...driversExtracted);

    await Deno.mkdir(driverBundlesDir, { recursive: true });
    const driverBundlesExtracted = await copyDir(
      join(extractDir, "driver-bundles"),
      driverBundlesDir,
      repoDir,
    );
    extractedFiles.push(...driverBundlesExtracted);

    await Deno.mkdir(absoluteDatastoresDir, { recursive: true });
    const datastoresExtracted = await copyDir(
      join(extractDir, "datastores"),
      absoluteDatastoresDir,
      repoDir,
    );
    extractedFiles.push(...datastoresExtracted);

    await Deno.mkdir(datastoreBundlesDir, { recursive: true });
    const datastoreBundlesExtracted = await copyDir(
      join(extractDir, "datastore-bundles"),
      datastoreBundlesDir,
      repoDir,
    );
    extractedFiles.push(...datastoreBundlesExtracted);

    await Deno.mkdir(absoluteReportsDir, { recursive: true });
    const reportsExtracted = await copyDir(
      join(extractDir, "reports"),
      absoluteReportsDir,
      repoDir,
    );
    extractedFiles.push(...reportsExtracted);

    await Deno.mkdir(reportBundlesDir, { recursive: true });
    const reportBundlesExtracted = await copyDir(
      join(extractDir, "report-bundles"),
      reportBundlesDir,
      repoDir,
    );
    extractedFiles.push(...reportBundlesExtracted);

    await Deno.mkdir(absoluteFilesDir, { recursive: true });
    const filesExtracted = await copyDir(
      join(extractDir, "files"),
      absoluteFilesDir,
      repoDir,
    );
    extractedFiles.push(...filesExtracted);

    // Restore executable bits for declared binaries
    if (Deno.build.os !== "windows" && manifest.binaries.length > 0) {
      for (const bin of manifest.binaries) {
        const binPath = join(absoluteFilesDir, bin);
        try {
          await Deno.chmod(binPath, 0o755);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          if (logger) {
            logger.debug`Failed to chmod binary ${bin}: ${error}`;
          }
        }
      }
    }

    // Extract skills to tool-specific skill directory.
    // Track only the skill directory root (not individual files) so that
    // extension rm can delete the entire directory in one shot.
    let hasSkills = false;
    let hasSkillScripts = false;
    const skillFiles: string[] = [];
    const skillsSrc = join(extractDir, "skills");
    try {
      const skillEntries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(skillsSrc)) {
        skillEntries.push(entry);
      }
      if (skillEntries.length > 0) {
        hasSkills = true;
        const absoluteSkillsDir = resolve(repoDir, ctx.skillsDir);
        await Deno.mkdir(absoluteSkillsDir, { recursive: true });
        for (const entry of skillEntries) {
          if (!entry.isDirectory) continue;
          const srcSkillDir = join(skillsSrc, entry.name);
          const destSkillDir = join(absoluteSkillsDir, entry.name);
          await Deno.mkdir(destSkillDir, { recursive: true });
          const extracted = await copyDir(srcSkillDir, destSkillDir, repoDir);
          // Track the skill directory root, not individual files
          const skillDirRelative = relative(repoDir, destSkillDir);
          extractedFiles.push(skillDirRelative);
          skillFiles.push(...extracted);

          // Check for scripts/ directory
          try {
            const scriptsDir = join(srcSkillDir, "scripts");
            const stat = await Deno.stat(scriptsDir);
            if (stat.isDirectory) {
              hasSkillScripts = true;
            }
          } catch {
            // No scripts/ directory
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const missingSourceFiles = await validateSourceCompleteness(
      absoluteModelsDir,
      absoluteVaultsDir,
      absoluteDriversDir,
      absoluteDatastoresDir,
      absoluteReportsDir,
    );

    // Extract manifest.yaml into the per-extension root as a read-only
    // copy. Makes each installed extension self-describing on disk so
    // downstream consumers (e.g. findDependents in extension rm) can
    // resolve the manifest without re-parsing the archive. Scoped to
    // per-extension so the file cannot collide across extensions.
    const manifestDestPath = join(absoluteExtRoot, "manifest.yaml");
    const manifestWithHeader =
      "# Read-only; regenerate via 'swamp extension pull'\n" + manifestContent;
    await Deno.mkdir(absoluteExtRoot, { recursive: true });
    // chmod 0o444 makes subsequent overwrites fail; remove the prior copy
    // first so re-installs (--force) succeed. NotFound is expected on a
    // first install.
    try {
      await Deno.remove(manifestDestPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    await Deno.writeTextFile(manifestDestPath, manifestWithHeader);
    try {
      await Deno.chmod(manifestDestPath, 0o444);
    } catch {
      // chmod is advisory on some filesystems/platforms (notably Windows);
      // intent is documented via the file header, enforcement is best-effort.
    }
    extractedFiles.push(relative(repoDir, manifestDestPath));

    // Record include files from manifest for loader skip logic
    const includeFiles = manifest.include.length > 0
      ? manifest.include.map((inc) =>
        relative(repoDir, resolve(absoluteModelsDir, inc))
      )
      : undefined;

    // Per-extension on-disk digest anchor. Computed AFTER every write that
    // belongs to the install (copyDir + the read-only manifest.yaml copy)
    // and BEFORE the lockfile write, so the digest captures exactly what
    // the installer just produced. Auto-update consults this on the next
    // version bump to refuse overwrites when the user has local edits
    // (issue #126).
    const filesChecksum = await readInstalledExtensionDigest(absoluteExtRoot);

    // Prune orphans: paths declared by the prior version's lockfile
    // entry that are NOT in the new version's extractedFiles[]. Done
    // BEFORE writeEntry persists the new entry so a kill mid-prune
    // leaves the lockfile pointing at the OLD version — the next install
    // retries the diff. The inverse ordering (write then prune) would
    // orphan paths the lockfile can't see if the prune never runs.
    const orphanDiff = computeOrphanDiff(oldFiles, extractedFiles);
    const pruned = orphanDiff.length > 0
      ? await pruneOrphanFiles(orphanDiff, repoDir)
      : [];

    await ctx.lockfileRepository.writeEntry(
      ref.name,
      version,
      extractedFiles,
      {
        include: includeFiles,
        checksum: localChecksum,
        filesChecksum: filesChecksum ?? undefined,
        serverUrl: resolveServerUrl(),
        channel: ctx.channel,
      },
    );

    const dependencyResults: InstallResult[] = [];
    if (manifest.dependencies.length > 0) {
      for (const dep of manifest.dependencies) {
        if (ctx.alreadyPulled.has(dep)) {
          continue;
        }

        // ctx.lockfileRepository reflects writes the parent install has
        // made — writeEntry updates the cache on every commit, and child
        // installs in this loop reuse the same repository instance, so
        // their writes are visible too.
        const isInstalled = ctx.lockfileRepository.getEntry(dep) !== null;

        if (!isInstalled) {
          const depRef = parseExtensionRef(dep);
          const depResult = await installExtension(depRef, {
            ...ctx,
            depth: ctx.depth + 1,
            channel: undefined,
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
      binaries: manifest.binaries,
      conflicts,
      missingSourceFiles,
      hasSkills,
      hasSkillScripts,
      skillFiles,
      dependencyResults,
      pruned,
    };
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/** Async generator wrapping installExtension for the stream pattern. */
export async function* extensionPull(
  ctx: LibSwampContext,
  deps: ExtensionPullDeps,
  input: ExtensionPullInput,
): AsyncIterable<ExtensionPullEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.pull",
    { "extension.name": input.ref.name },
    (async function* () {
      yield { kind: "installing" } as const;

      const prefetchedInfo = await deps.getExtension(input.ref.name);
      if (prefetchedInfo?.deprecatedAt != null) {
        yield {
          kind: "deprecated_warning" as const,
          name: input.ref.name,
          reason: prefetchedInfo.deprecationReason ?? null,
          supersededBy: prefetchedInfo.supersededBy ?? null,
        };
      }

      // Resolve channel-specific version when --channel is set and
      // no explicit version is pinned. The resolved ref always carries
      // an explicit version so installExtension doesn't need channel
      // awareness — it just installs the pinned version.
      let resolvedRef = input.ref;
      if (input.channel && !input.ref.version) {
        if (!deps.getLatestVersion) {
          throw new UserError(
            "Channel-aware pull requires getLatestVersion support.",
          );
        }
        const channelVersion = await deps.getLatestVersion(
          input.ref.name,
          input.channel,
        );
        if (!channelVersion) {
          throw new UserError(
            `Extension ${input.ref.name} has no published ${input.channel} versions.`,
          );
        }
        resolvedRef = { name: input.ref.name, version: channelVersion };
      }

      const installCtx: InstallContext = {
        getExtension: (name) =>
          name === input.ref.name && prefetchedInfo
            ? Promise.resolve(prefetchedInfo)
            : deps.getExtension(name),
        downloadArchive: deps.downloadArchive,
        getChecksum: deps.getChecksum,
        logger: ctx.logger,
        lockfileRepository: deps.lockfileRepository,
        skillsDir: deps.skillsDir,
        repoDir: deps.repoDir,
        force: input.force,
        alreadyPulled: deps.alreadyPulled,
        depth: deps.depth,
        channel: input.channel,
      };

      // Let ConflictError propagate — CLI catches it for the two-phase prompt
      // flow. Routing precedence:
      //   1. deps.installExtensionFn (test seam — Pin 2 stubs)
      //   2. InstallExtensionService when deps.denoRuntime + deps.repository
      //      are both provided (W2 contract: phase 8 fires, I-Repo-1 fires
      //      at install time, FS rollback on DuplicateTypeError)
      //   3. Free-function installExtension (pre-W2 fallback — catalog rows
      //      populated lazily on next loader pass)
      const denoRt = deps.denoRuntime;
      const repo = deps.repository;
      const install = deps.installExtensionFn ??
        (denoRt !== undefined && repo !== undefined
          ? (r: ExtensionRef, c: InstallContext) =>
            new InstallExtensionService({
              denoRuntime: denoRt,
              repository: repo,
            }).execute(r, c)
          : installExtension);
      const result = await install(resolvedRef, installCtx);
      if (result) {
        if (result.pruned.length > 0) {
          yield {
            kind: "orphans-pruned" as const,
            name: result.name,
            version: result.version,
            paths: result.pruned,
          };
        }
        yield { kind: "completed" as const, data: result };
      }
    })(),
  );
}

/**
 * Wires real infrastructure into ExtensionPullDeps. Constructs a fresh
 * {@link LockfileRepository} that captures a snapshot at this moment —
 * the returned deps object is therefore single-use per the
 * {@link InstallContext.lockfileRepository} JSDoc. Construct fresh deps
 * per install operation; do not reuse across multiple installs.
 *
 * **W2 service deps.** Optional `denoRuntime` and `repository` activate
 * the {@link InstallExtensionService} routing inside `extensionPull`.
 * When BOTH are passed, phase 8 fires (catalog populated synchronously,
 * I-Repo-1 fires on `(kind, type)` collision, FS rollback on conflict).
 * When either is missing, the deps fall back to the pre-W2 free-function
 * path (catalog populated lazily on next loader pass) — same behavior
 * as before W2.
 */
export async function createExtensionPullDeps(
  serverUrl: string,
  lockfilePath: string,
  skillsDir: string,
  repoDir: string,
  args?: {
    denoRuntime?: DenoRuntime;
    repository?: ExtensionRepository;
    identity?: ClientIdentity;
  },
): Promise<ExtensionPullDeps> {
  const client = new ExtensionApiClient(serverUrl, args?.identity);
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  return {
    getExtension: (name) => client.getExtension(name),
    getLatestVersion: async (name, channel) => {
      const info = await client.getLatestVersion(name, undefined, channel);
      return info?.version ?? null;
    },
    downloadArchive: (name, version) => client.downloadArchive(name, version),
    getChecksum: (name, version) => client.getChecksum(name, version),
    lockfileRepository,
    skillsDir,
    repoDir,
    alreadyPulled: new Set(),
    depth: 0,
    denoRuntime: args?.denoRuntime,
    repository: args?.repository,
  };
}

/**
 * Creates an InstallContext from an ExtensionApiClient (for
 * extension_update compatibility). Like {@link createExtensionPullDeps},
 * constructs a fresh snapshot-captured {@link LockfileRepository}; the
 * returned context is single-use per the
 * {@link InstallContext.lockfileRepository} JSDoc.
 */
export async function createInstallContext(
  serverUrl: string,
  opts: {
    lockfilePath: string;
    skillsDir: string;
    repoDir: string;
    force: boolean;
    logger?: Logger;
    identity?: ClientIdentity;
    channel?: string;
  },
): Promise<InstallContext> {
  const client = new ExtensionApiClient(serverUrl, opts.identity);
  const lockfileRepository = await LockfileRepository.create(opts.lockfilePath);
  return {
    getExtension: (name) => client.getExtension(name),
    downloadArchive: (name, version) => client.downloadArchive(name, version),
    getChecksum: (name, version) => client.getChecksum(name, version),
    logger: opts.logger,
    lockfileRepository,
    skillsDir: opts.skillsDir,
    repoDir: opts.repoDir,
    force: opts.force,
    alreadyPulled: new Set(),
    depth: 0,
    channel: opts.channel,
  };
}
