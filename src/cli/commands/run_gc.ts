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
  createLibSwampContext,
  createRunGcDeps,
  DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
  parseDuration,
  runGc,
  runGcPreview,
} from "../../libswamp/mod.ts";
import {
  createRunGcRenderer,
  renderRunGcCancelled,
  renderRunGcPreview,
} from "../../presentation/renderers/run_gc.ts";
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

export const runGcCommand = new Command()
  .name("gc")
  .description(
    "Garbage-collect old workflow runs and model method outputs. Running and suspended runs are never deleted regardless of age.",
  )
  .example("Preview what would be collected", "swamp run gc --dry-run")
  .example("Run GC with default 30-day retention", "swamp run gc --force")
  .example("Delete runs older than 7 days", "swamp run gc --older-than 7d")
  .example(
    "Run non-interactively in JSON mode (no prompt, structured output)",
    "swamp run gc --json --older-than 14d",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--dry-run", "Show what would be deleted without deleting")
  .option("-f, --force", "Skip confirmation prompt")
  .option(
    "--older-than <duration:string>",
    `Retention period. Units: m=minutes, h=hours, d=days, w=weeks, mo=months, y=years (e.g. 7d, 2w, 1mo). Default: ${DEFAULT_WORKFLOW_RUN_RETENTION_DAYS}d`,
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["run", "gc"]);

    const repoOpts = {
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    };
    const { repoDir, repoContext, datastoreResolver } = options.dryRun
      ? await requireInitializedRepoReadOnly(repoOpts)
      : await requireInitializedRepo(repoOpts);

    let retentionDays = DEFAULT_WORKFLOW_RUN_RETENTION_DAYS;
    if (options.olderThan) {
      const ms = parseDuration(options.olderThan);
      retentionDays = ms / (24 * 60 * 60 * 1000);
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createRunGcDeps(
      repoDir,
      datastoreResolver,
      repoContext.markDirty,
    );

    const gcInput = {
      dryRun: !!options.dryRun,
      workflowRunRetentionDays: retentionDays,
      outputRetentionDays: retentionDays,
    };

    if (cliCtx.outputMode === "log" && !options.force && !options.dryRun) {
      const preview = await runGcPreview(ctx, deps, gcInput);
      if (
        preview.workflowRunsToDelete === 0 && preview.outputsToDelete === 0
      ) {
        console.log("Nothing to clean up.");
        return;
      }

      renderRunGcPreview(preview, cliCtx.outputMode);
      const confirmed = await promptConfirmation(
        "Proceed with run garbage collection?",
      );
      if (!confirmed) {
        renderRunGcCancelled(cliCtx.outputMode);
        return;
      }
    }

    const renderer = createRunGcRenderer(cliCtx.outputMode);
    await consumeStream(
      runGc(ctx, deps, gcInput),
      renderer.handlers(),
    );
  });
