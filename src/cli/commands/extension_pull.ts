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
import { join, resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { UserError } from "../../domain/errors.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import {
  ConflictError,
  consumeStream,
  createExtensionPullDeps,
  createLibSwampContext,
  extensionPull,
  type ExtensionPullDeps,
  type ExtensionRegistryInfo,
  parseExtensionRef,
  requireCurrentExtensionLayout,
  resolveServerUrl,
  validateExtensionName,
} from "../../libswamp/mod.ts";
import {
  createExtensionPullRenderer,
  renderExtensionPullCancelled,
} from "../../presentation/renderers/extension_pull.ts";

// Re-export types that other CLI commands depend on
export {
  ConflictError,
  createInstallContext,
  detectConflicts,
  type ExtensionRef,
  type ExtensionRegistryInfo,
  type InstallContext,
  installExtension,
  type InstallResult,
  parseExtensionRef,
  removeUpstreamExtension,
  updateUpstreamExtensions,
  validateExtensionName,
} from "../../libswamp/mod.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

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

/** PullContext for use by extension_search.ts and other callers. */
export interface PullContext {
  getExtension: (name: string) => Promise<ExtensionRegistryInfo | null>;
  downloadArchive: (name: string, version: string) => Promise<Uint8Array>;
  getChecksum: (name: string, version: string) => Promise<string | null>;
  logger: Logger;
  /** Full path to the upstream_extensions.json lockfile. */
  lockfilePath: string;
  modelsDir: string;
  workflowsDir: string;
  vaultsDir: string;
  driversDir: string;
  datastoresDir: string;
  reportsDir: string;
  repoDir: string;
  force: boolean;
  outputMode: "log" | "json";
  alreadyPulled: Set<string>;
  depth: number;
}

/**
 * Pull command wrapper: calls extensionPull and handles rendering + conflict prompts.
 */
export async function pullExtension(
  ref: { name: string; version: string | null },
  ctx: PullContext,
): Promise<void> {
  const { outputMode } = ctx;
  const libCtx = createLibSwampContext({ logger: ctx.logger });
  const deps: ExtensionPullDeps = {
    getExtension: ctx.getExtension,
    downloadArchive: ctx.downloadArchive,
    getChecksum: ctx.getChecksum,
    lockfilePath: ctx.lockfilePath,
    modelsDir: ctx.modelsDir,
    workflowsDir: ctx.workflowsDir,
    vaultsDir: ctx.vaultsDir,
    driversDir: ctx.driversDir,
    datastoresDir: ctx.datastoresDir,
    reportsDir: ctx.reportsDir,
    repoDir: ctx.repoDir,
    alreadyPulled: ctx.alreadyPulled,
    depth: ctx.depth,
  };
  const renderer = createExtensionPullRenderer(outputMode);

  try {
    await consumeStream(
      extensionPull(libCtx, deps, { ref, force: ctx.force }),
      renderer.handlers(),
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      renderer.renderConflicts(error.conflicts);
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
      // Retry with force, reset alreadyPulled so the extension can be retried
      deps.alreadyPulled.delete(ref.name);
      await consumeStream(
        extensionPull(libCtx, deps, { ref, force: true }),
        renderer.handlers(),
      );
    } else {
      throw error;
    }
  }
}

export const extensionPullCommand = new Command()
  .name("pull")
  .description("Pull an extension from the swamp registry")
  .example("Pull an extension", "swamp extension pull @stack72/aws-ec2")
  .example("Force re-pull", "swamp extension pull @stack72/aws-ec2 --force")
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
    validateExtensionName(ref.name);

    // 4. Resolve lockfile path (stays in committed extensions/models/ dir)
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    // 5. Check for legacy extension layout
    await requireCurrentExtensionLayout(lockfilePath);

    // 6. Resolve pulled-extension dirs (.swamp/pulled-extensions/{type}/)
    const pulledModelsDir = swampPath(repoDir, SWAMP_SUBDIRS.pulledModels);
    const pulledWorkflowsDir = swampPath(
      repoDir,
      SWAMP_SUBDIRS.pulledWorkflows,
    );
    const pulledVaultsDir = swampPath(repoDir, SWAMP_SUBDIRS.pulledVaults);
    const pulledDriversDir = swampPath(repoDir, SWAMP_SUBDIRS.pulledDrivers);
    const pulledDatastoresDir = swampPath(
      repoDir,
      SWAMP_SUBDIRS.pulledDatastores,
    );
    const pulledReportsDir = swampPath(repoDir, SWAMP_SUBDIRS.pulledReports);

    // 7. Create deps via factory and pull
    const serverUrl = resolveServerUrl();
    const deps = createExtensionPullDeps(
      serverUrl,
      lockfilePath,
      pulledModelsDir,
      pulledWorkflowsDir,
      pulledVaultsDir,
      pulledDriversDir,
      pulledDatastoresDir,
      pulledReportsDir,
      repoDir,
    );

    await pullExtension(ref, {
      getExtension: deps.getExtension,
      downloadArchive: deps.downloadArchive,
      getChecksum: deps.getChecksum,
      logger: ctx.logger,
      lockfilePath,
      modelsDir: pulledModelsDir,
      workflowsDir: pulledWorkflowsDir,
      vaultsDir: pulledVaultsDir,
      driversDir: pulledDriversDir,
      datastoresDir: pulledDatastoresDir,
      reportsDir: pulledReportsDir,
      repoDir,
      force: options.force ?? false,
      outputMode: ctx.outputMode,
      alreadyPulled: new Set(),
      depth: 0,
    });
  });
