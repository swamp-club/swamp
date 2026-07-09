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
import {
  consumeStream,
  createDataGcDeps,
  createLibSwampContext,
  dataGc,
  dataGcPreview,
} from "../../libswamp/mod.ts";
import {
  createDataGcRenderer,
  renderDataGcCancelled,
  renderDataGcPreview,
} from "../../presentation/renderers/data_gc.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
} from "../repo_context.ts";
import { promptConfirmation } from "../prompt_helpers.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataGcCommand = new Command()
  .name("gc")
  .description("Run garbage collection on data (lifecycle and versions)")
  .example("Preview what would be collected", "swamp data gc --dry-run")
  .example("Run garbage collection", "swamp data gc --force")
  .example(
    "Run non-interactively in JSON mode (no prompt, structured output)",
    "swamp data gc --json",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--dry-run", "Show what would be deleted without deleting")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["data", "gc"]);

    const repoOpts = {
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    };
    const { repoDir, repoContext, datastoreResolver } = options.dryRun
      ? await requireInitializedRepoReadOnly(repoOpts)
      : await requireInitializedRepo(repoOpts);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createDataGcDeps(
      repoDir,
      datastoreResolver,
      repoContext.markDirty,
    );

    // Phase 1: Preview + Prompt (only in interactive mode without --force and not dry-run)
    if (cliCtx.outputMode === "log" && !options.force && !options.dryRun) {
      const preview = await dataGcPreview(ctx, deps);
      if (
        preview.items.length === 0 && preview.versionGcItems.length === 0
      ) {
        console.log("Nothing to clean up.");
        return;
      }

      renderDataGcPreview(preview, cliCtx.outputMode);
      const confirmed = await promptConfirmation(
        "Proceed with garbage collection?",
      );
      if (!confirmed) {
        renderDataGcCancelled(cliCtx.outputMode);
        return;
      }
    }

    // Phase 2: Execute GC
    const renderer = createDataGcRenderer(cliCtx.outputMode);
    await consumeStream(
      dataGc(ctx, deps, { dryRun: !!options.dryRun }),
      renderer.handlers(),
    );
  });
