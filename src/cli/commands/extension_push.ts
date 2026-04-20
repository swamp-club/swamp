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
import { dirname, join, resolve } from "@std/path";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveExtensionFiles } from "../resolve_extension_files.ts";
import { UserError } from "../../domain/errors.ts";
import { sourceHasBareSpecifiers } from "../../domain/models/bundle.ts";
import { CalVer } from "../../domain/models/calver.ts";
import {
  consumeStream,
  createExtensionPushExecuteDeps,
  createExtensionPushPrepareDeps,
  createLibSwampContext,
  extensionPush,
  extensionPushPrepare,
} from "../../libswamp/mod.ts";
import {
  createExtensionPushRenderer,
  renderExtensionPushCancelled,
} from "../../presentation/renderers/extension_push.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import type { QualityIssue } from "../../domain/extensions/extension_quality_checker.ts";
import type {
  CollectiveMismatch,
} from "../../domain/extensions/extension_collective_validator.ts";
import type { CompilationError, SwampError } from "../../libswamp/mod.ts";

interface ExtensionPushOptions extends GlobalOptions {
  repoDir?: string;
  yes?: boolean;
  dryRun?: boolean;
  releaseNotes?: string;
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
 * Walks up from `startDir` looking for a `deno.json` file, stopping at
 * `boundaryDir` (inclusive). Returns the absolute path if found, or
 * undefined if no `deno.json` exists between `startDir` and the boundary.
 */
async function findDenoConfig(
  startDir: string,
  boundaryDir: string,
): Promise<string | undefined> {
  let current = resolve(startDir);
  const boundary = resolve(boundaryDir);

  while (true) {
    const candidate = join(current, "deno.json");
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch {
      // Not found at this level
    }

    // Stop if we've reached the boundary
    if (current === boundary) break;

    // Walk up
    const parent = dirname(current);
    // Safety: stop if we can't go higher (filesystem root)
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/**
 * Walks up from `startDir` looking for a `package.json` file, stopping at
 * `boundaryDir` (inclusive). Returns the absolute path to the directory
 * containing package.json if found, or undefined.
 */
async function findPackageJson(
  startDir: string,
  boundaryDir: string,
): Promise<string | undefined> {
  let current = resolve(startDir);
  const boundary = resolve(boundaryDir);

  while (true) {
    const candidate = join(current, "package.json");
    try {
      await Deno.stat(candidate);
      return current;
    } catch {
      // Not found at this level
    }

    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/**
 * Validates that node_modules/ exists alongside a package.json project.
 * Throws UserError with clear instructions if missing.
 */
async function requireNodeModules(projectDir: string): Promise<void> {
  const nodeModulesPath = join(projectDir, "node_modules");
  try {
    const stat = await Deno.stat(nodeModulesPath);
    if (!stat.isDirectory) {
      throw new UserError(
        `Expected node_modules/ to be a directory at ${nodeModulesPath}. ` +
          `Run 'npm install' or 'deno install' in ${projectDir} first.`,
      );
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      `No node_modules/ found at ${projectDir}. ` +
        `Run 'npm install' or 'deno install' to install dependencies before pushing.`,
    );
  }
}

export const extensionPushCommand = new Command()
  .name("push")
  .description("Push an extension to the swamp registry")
  .example(
    "Publish extension",
    "swamp extension push extensions/models/my-model/manifest.json",
  )
  .example(
    "Dry run",
    "swamp extension push extensions/models/my-model/manifest.json --dry-run",
  )
  .example(
    "With release notes",
    `swamp extension push extensions/models/my-model/manifest.json --release-notes "Added validate method"`,
  )
  .arguments("<manifest-path:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("-y, --yes", "Skip confirmation prompts")
  .option("--dry-run", "Build archive locally without pushing to registry")
  .option(
    "--release-notes <text:string>",
    "Per-version release notes (max 5000 chars)",
  )
  .action(async function (options: ExtensionPushOptions, manifestPath: string) {
    const cliCtx = createContext(options, ["extension", "push"]);
    cliCtx.logger.debug`Starting extension push`;

    // 1. Validate repo
    const repoDir = resolveRepoDir(options.repoDir);
    const { repoContext } = await requireInitializedRepo({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    // 2. Resolve extension files (manifest, models, workflows, additional files)
    const resolved = await resolveExtensionFiles({
      repoDir,
      manifestPath,
      repoContext,
      logger: cliCtx.logger,
    });
    const {
      manifest,
      modelsDir,
      modelEntryPoints,
      allModelFiles,
      vaultsDir,
      vaultEntryPoints,
      allVaultFiles,
      driversDir,
      driverEntryPoints,
      allDriverFiles,
      datastoresDir,
      datastoreEntryPoints,
      allDatastoreFiles,
      reportsDir,
      reportEntryPoints,
      allReportFiles,
      workflowFiles,
      includeFilePaths,
      additionalFilePaths,
    } = resolved;

    // 2b. Detect project config for project-aware bundling and quality checks.
    const absoluteManifestPath = resolve(repoDir, manifestPath);
    const manifestDir = dirname(absoluteManifestPath);
    const denoConfigPath = await findDenoConfig(manifestDir, resolve(repoDir));
    let packageJsonDir: string | undefined;
    if (denoConfigPath) {
      cliCtx.logger.debug`Found deno.json at ${denoConfigPath}`;
    } else {
      const candidateDir = await findPackageJson(
        manifestDir,
        resolve(repoDir),
      );
      if (candidateDir) {
        const allEntryPoints = [
          ...modelEntryPoints,
          ...vaultEntryPoints,
          ...driverEntryPoints,
          ...datastoreEntryPoints,
          ...reportEntryPoints,
        ];
        let hasBare = false;
        for (const ep of allEntryPoints) {
          const src = await Deno.readTextFile(ep);
          if (sourceHasBareSpecifiers(src)) {
            hasBare = true;
            break;
          }
        }
        if (hasBare) {
          packageJsonDir = candidateDir;
          cliCtx.logger
            .debug`Found package.json project at ${packageJsonDir}`;
          await requireNodeModules(packageJsonDir);
        } else {
          cliCtx.logger
            .debug`Ignoring package.json at ${candidateDir} (extension uses npm: prefixed imports)`;
        }
      }
    }

    // 3. Create libswamp context and deps
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const prepareDeps = createExtensionPushPrepareDeps();
    const renderer = createExtensionPushRenderer(cliCtx.outputMode);

    // 4. Run prepare phase
    let prepared;
    try {
      prepared = await extensionPushPrepare(ctx, prepareDeps, {
        manifest,
        repoDir,
        modelsDir,
        allModelFiles,
        modelEntryPoints,
        vaultsDir,
        allVaultFiles,
        vaultEntryPoints,
        driversDir,
        allDriverFiles,
        driverEntryPoints,
        datastoresDir,
        allDatastoreFiles,
        datastoreEntryPoints,
        reportsDir,
        allReportFiles,
        reportEntryPoints,
        workflowFiles,
        skillDirs: resolved.skillDirs,
        allSkillFiles: resolved.allSkillFiles,
        includeFilePaths,
        additionalFilePaths,
        dryRun: options.dryRun ?? false,
        releaseNotes: options.releaseNotes,
        denoConfigPath,
        packageJsonDir,
      });
    } catch (error) {
      // Handle structured errors from the prepare phase with rich rendering
      if (isSwampError(error)) {
        const details = error.details as Record<string, unknown> | undefined;
        if (details?.safetyErrors) {
          renderer.renderSafetyErrors(
            details.safetyErrors as SafetyIssue[],
          );
        } else if (details?.qualityErrors) {
          renderer.renderQualityErrors(
            details.qualityErrors as QualityIssue[],
          );
        } else if (details?.compilationErrors) {
          renderer.renderCompilationErrors(
            details.compilationErrors as CompilationError[],
          );
        } else if (details?.expectedCollective && details?.mismatches) {
          renderer.renderCollectiveErrors(
            details.expectedCollective as string,
            details.mismatches as CollectiveMismatch[],
          );
        } else if (details?.existingVersion) {
          // Version already exists — handle interactive bump
          const existingVersion = details.existingVersion as string;
          if (cliCtx.outputMode === "log" && !options.yes) {
            const bumped = CalVer.bump(CalVer.create(existingVersion));
            const confirmed = await promptConfirmation(
              `Version ${existingVersion} already exists. Bump to ${bumped.value}?`,
            );
            if (confirmed) {
              manifest.version = bumped.value;
              // Re-run prepare with bumped version
              try {
                prepared = await extensionPushPrepare(ctx, prepareDeps, {
                  manifest,
                  repoDir,
                  modelsDir,
                  allModelFiles,
                  modelEntryPoints,
                  vaultsDir,
                  allVaultFiles,
                  vaultEntryPoints,
                  driversDir,
                  allDriverFiles,
                  driverEntryPoints,
                  datastoresDir,
                  allDatastoreFiles,
                  datastoreEntryPoints,
                  reportsDir,
                  allReportFiles,
                  reportEntryPoints,
                  workflowFiles,
                  skillDirs: resolved.skillDirs,
                  allSkillFiles: resolved.allSkillFiles,
                  includeFilePaths,
                  additionalFilePaths,
                  dryRun: options.dryRun ?? false,
                  releaseNotes: options.releaseNotes,
                  denoConfigPath,
                  packageJsonDir,
                });
              } catch (retryError) {
                if (isSwampError(retryError)) {
                  throw new UserError(retryError.message);
                }
                throw retryError;
              }
            } else {
              renderExtensionPushCancelled(cliCtx.outputMode);
              return;
            }
          } else {
            throw new UserError(
              `Version ${existingVersion} already exists for ${manifest.name}. ` +
                `Use a different version or let the CLI bump it interactively.`,
            );
          }
        }
        if (!prepared) {
          throw new UserError(error.message);
        }
      } else {
        throw error;
      }
    }

    // 5. Render resolved data
    renderer.renderResolved(prepared.resolvedData);

    // 6. Handle safety warnings
    if (prepared.safetyWarnings.length > 0) {
      renderer.renderSafetyWarnings(prepared.safetyWarnings);
      if (!options.yes && cliCtx.outputMode === "log") {
        const confirmed = await promptConfirmation(
          "Continue with push despite warnings?",
        );
        if (!confirmed) {
          renderExtensionPushCancelled(cliCtx.outputMode);
          return;
        }
      }
    }

    // 7. Dry run — stop here
    if (prepared.isDryRun) {
      renderer.renderDryRun({
        name: prepared.manifest.name,
        version: prepared.manifest.version,
        archiveSize: prepared.archiveBytes.length,
      });
      return;
    }

    // 8. Confirmation prompt
    if (!options.yes && cliCtx.outputMode === "log") {
      const confirmed = await promptConfirmation(
        `Push ${prepared.manifest.name}@${prepared.manifest.version} to registry?`,
      );
      if (!confirmed) {
        renderExtensionPushCancelled(cliCtx.outputMode);
        return;
      }
    }

    // 9. Execute push
    const executeDeps = createExtensionPushExecuteDeps();
    await consumeStream(
      extensionPush(ctx, executeDeps, {
        manifest: prepared.manifest,
        archiveBytes: prepared.archiveBytes,
        contentMetadata: prepared.contentMetadata,
        counts: prepared.counts,
        releaseNotes: options.releaseNotes,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension push command completed");
  });

function isSwampError(
  error: unknown,
): error is SwampError {
  return typeof error === "object" && error !== null && "code" in error &&
    "message" in error;
}
