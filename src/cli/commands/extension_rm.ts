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
import { join, resolve } from "@std/path";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  consumeStream,
  createExtensionRmDeps,
  createLibSwampContext,
  extensionRm,
  extensionRmPreview,
  parseExtensionRef,
  validateExtensionName,
  warnLegacyExtensionLayout,
} from "../../libswamp/mod.ts";
import {
  createExtensionRmRenderer,
  renderExtensionRmCancelled,
} from "../../presentation/renderers/extension_rm.ts";

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

export const extensionRemoveCommand = new Command()
  .name("rm")
  .alias("remove")
  .description("Remove a pulled extension and its files")
  .example("Remove extension", "swamp extension rm @stack72/aws-ec2")
  .example("Force remove", "swamp extension rm @stack72/aws-ec2 --force")
  .arguments("<extension:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("-f, --force", "Skip confirmation prompt")
  .action(async function (options: AnyOptions, extension: string) {
    const ctx = createContext(options as GlobalOptions, ["extension", "rm"]);
    ctx.logger.debug`Starting extension remove`;

    const repoDir = resolveRepoDir(options.repoDir);
    await requireInitializedRepo({
      repoDir,
      outputMode: ctx.outputMode,
    });

    // Parse extension reference (ignore version if provided)
    const ref = parseExtensionRef(extension);
    validateExtensionName(ref.name);

    // Resolve models dir from .swamp.yaml
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    // Warn if any extensions are still in a legacy layout. rm follows
    // the lockfile's tracked paths so it works against either generation.
    await warnLegacyExtensionLayout(
      lockfilePath,
      (msg) => ctx.logger.warn(msg),
    );

    // Create libswamp context, deps, renderer.
    // W2 (commit 4): the deps now own a catalog handle (via the W2
    // ExtensionRepository) so the rm flow routes through
    // RemoveExtensionService and prunes catalog rows (closes
    // swamp-club#201). Catalog must be closed when we're done.
    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const deps = await createExtensionRmDeps(repoDir, lockfilePath);
    try {
      const renderer = createExtensionRmRenderer(ctx.outputMode);
      const input = { extensionName: ref.name };

      // Preview: validates extension, returns preview data
      const preview = await extensionRmPreview(libCtx, deps, input);

      // Dependency warning
      if (preview.dependents.length > 0) {
        renderer.renderDependencyWarning(preview.dependents);
      }

      // Confirmation prompt (log mode only, unless --force)
      if (ctx.outputMode === "log" && !options.force) {
        const confirmed = await promptConfirmation(
          `Remove ${preview.name} (v${preview.version})? This will delete ${preview.fileCount} file(s).`,
        );
        if (!confirmed) {
          renderExtensionRmCancelled(ctx.outputMode);
          return;
        }
      }

      // Execute removal
      await consumeStream(
        extensionRm(libCtx, deps, input),
        renderer.handlers(),
      );

      ctx.logger.debug("Extension remove command completed");
    } finally {
      deps.repository.close();
    }
  });
