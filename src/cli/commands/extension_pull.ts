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

import { Command } from "@cliffy/command";
import type { Logger } from "@logtape/logtape";
import { join, resolve } from "@std/path";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { readLocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireRepoMarker } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { UserError } from "../../domain/errors.ts";
import { resolveSkillsDir } from "../../domain/repo/skill_dirs.ts";
import { resolvePrimaryTool } from "../../domain/repo/primary_tool.ts";
import { loadIdentity } from "../load_identity.ts";
import {
  ConflictError,
  consumeStream,
  createExtensionPullDeps,
  createLibSwampContext,
  extensionPull,
  type ExtensionPullDeps,
  type ExtensionRegistryInfo,
  type LockfileRepository,
  parseExtensionRef,
  resolveServerUrl,
  validateExtensionName,
  warnLegacyExtensionLayout,
} from "../../libswamp/mod.ts";
import {
  createExtensionPullRenderer,
  renderExtensionPullCancelled,
} from "../../presentation/renderers/extension_pull.ts";
import { ReleaseChannel } from "../../domain/extensions/release_channel.ts";

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
  LockfileRepository,
  parseExtensionRef,
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
  getLatestVersion?: (
    name: string,
    channel: string,
  ) => Promise<string | null>;
  downloadArchive: (name: string, version: string) => Promise<Uint8Array>;
  getChecksum: (name: string, version: string) => Promise<string | null>;
  logger: Logger;
  /**
   * Lockfile repository owning read+write of upstream_extensions.json.
   * Captures a snapshot at construction; construct fresh per pull.
   */
  lockfileRepository: LockfileRepository;
  /** Tool-aware skills destination (e.g. `.claude/skills/`). */
  skillsDir: string;
  repoDir: string;
  force: boolean;
  outputMode: "log" | "json";
  alreadyPulled: Set<string>;
  depth: number;
  channel?: string;
  /**
   * W2 service deps. When BOTH are provided, `extensionPull` routes
   * through {@link InstallExtensionService} so phase 8 fires (catalog
   * populated synchronously, I-Repo-1 fires on `(kind, type)` collision,
   * FS rollback on conflict). When either is missing, falls back to
   * the pre-W2 free-function path. See {@link ExtensionPullDeps} for
   * the full contract.
   */
  denoRuntime?: DenoRuntime;
  repository?: ExtensionRepository;
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
    getLatestVersion: ctx.getLatestVersion,
    downloadArchive: ctx.downloadArchive,
    getChecksum: ctx.getChecksum,
    lockfileRepository: ctx.lockfileRepository,
    skillsDir: ctx.skillsDir,
    repoDir: ctx.repoDir,
    alreadyPulled: ctx.alreadyPulled,
    depth: ctx.depth,
    denoRuntime: ctx.denoRuntime,
    repository: ctx.repository,
  };
  const renderer = createExtensionPullRenderer(outputMode);

  try {
    await consumeStream(
      extensionPull(libCtx, deps, {
        ref,
        force: ctx.force,
        channel: ctx.channel,
      }),
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
        extensionPull(libCtx, deps, {
          ref,
          force: true,
          channel: ctx.channel,
        }),
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
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--force", "Overwrite existing files without prompting")
  .option(
    "--channel <channel:string>",
    "Release channel: 'beta' or 'rc' (default: stable)",
  )
  .action(async function (options: AnyOptions, extension: string) {
    const channel: string | undefined = options.channel;
    if (
      channel !== undefined && !ReleaseChannel.isPrereleaseName(channel)
    ) {
      throw new UserError(
        `Invalid channel: "${channel}". Must be one of: beta, rc. Stable is the default; omit --channel to use it.`,
      );
    }

    const ctx = createContext(options as GlobalOptions, ["extension", "pull"]);
    ctx.logger.debug`Starting extension pull`;

    // 1. Validate repo (lightweight — no datastore resolution, so pulling
    // the repo's own datastore extension doesn't circular-fail; see #445)
    const { repoDir, marker } = await requireRepoMarker(
      resolveRepoDir(options.repoDir),
    );

    // 2. Parse extension reference
    const ref = parseExtensionRef(extension);

    // 3. Validate name format
    validateExtensionName(ref.name);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    // 5. Warn if any extensions are still in a legacy layout. We don't
    // block — the lockfile tolerates mixed generations and the new pull
    // writes to the per-extension subtree regardless.
    await warnLegacyExtensionLayout(
      lockfilePath,
      (msg) => ctx.logger.warn(msg),
    );

    // 6. Resolve skills destination (tool-aware). Per-extension
    // models/workflows/vaults/drivers/datastores/reports destinations
    // are derived inside installExtension from `ref.name` — the CLI
    // doesn't need to compute them.
    const tool = resolvePrimaryTool(marker);
    const skillsDir = resolveSkillsDir(repoDir, tool);

    // 7. Construct W2 service deps (denoRuntime + ExtensionRepository)
    // so phase 8 fires synchronously at install time. Both are required
    // for `extensionPull` to route through {@link InstallExtensionService}
    // — without them it falls back to the pre-W2 free-function path.
    const denoRuntime = new EmbeddedDenoRuntime();
    const catalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
    );
    try {
      const serverUrl = resolveServerUrl();
      const identity = await loadIdentity();
      const deps = await createExtensionPullDeps(
        serverUrl,
        lockfilePath,
        skillsDir,
        repoDir,
        { identity },
      );
      const repository = new ExtensionRepository({
        catalog,
        lockfileRepository: deps.lockfileRepository,
        repoRoot: repoDir,
        localManifestIdentity: readLocalManifestIdentity(repoDir),
      });

      await pullExtension(ref, {
        getExtension: deps.getExtension,
        getLatestVersion: deps.getLatestVersion,
        downloadArchive: deps.downloadArchive,
        getChecksum: deps.getChecksum,
        logger: ctx.logger,
        lockfileRepository: deps.lockfileRepository,
        skillsDir,
        repoDir,
        force: options.force ?? false,
        outputMode: ctx.outputMode,
        alreadyPulled: new Set(),
        depth: 0,
        channel,
        denoRuntime,
        repository,
      });
    } finally {
      catalog.close();
    }
  });
