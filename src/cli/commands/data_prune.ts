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
  createDataPruneDeps,
  createLibSwampContext,
  dataPrune,
  dataPrunePreview,
} from "../../libswamp/mod.ts";
import {
  createDataPruneRenderer,
  renderDataPruneCancelled,
  renderDataPrunePreview,
} from "../../presentation/renderers/data_prune.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
} from "../repo_context.ts";

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

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataPruneCommand = new Command()
  .name("prune")
  .description(
    "Reclaim orphaned data whose owning model definition no longer exists.\n" +
      "Unlike `data gc` (which enforces each model's declared lifetime and\n" +
      "version-cap), prune removes data left behind when a model definition is\n" +
      "deleted or migrated away. Deletion is irreversible; use --dry-run first.",
  )
  .example(
    "Preview orphaned data that would be reclaimed",
    "swamp data prune --dry-run",
  )
  .example("Reclaim orphaned data", "swamp data prune --force")
  .example(
    "Run non-interactively in JSON mode (no prompt, structured output)",
    "swamp data prune --json",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--dry-run", "Show what would be reclaimed without deleting")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["data", "prune"]);

    const repoOpts = {
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    };
    const { repoDir, datastoreResolver } = options.dryRun
      ? await requireInitializedRepoReadOnly(repoOpts)
      : await requireInitializedRepo(repoOpts);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createDataPruneDeps(repoDir, datastoreResolver);

    // Phase 1: Preview + Prompt (only in interactive mode without --force and not dry-run)
    if (cliCtx.outputMode === "log" && !options.force && !options.dryRun) {
      const preview = await dataPrunePreview(ctx, deps);
      if (preview.items.length === 0) {
        console.log("No orphaned data to reclaim.");
        return;
      }

      renderDataPrunePreview(preview, cliCtx.outputMode);
      const confirmed = await promptConfirmation(
        "Reclaim this orphaned data?",
      );
      if (!confirmed) {
        renderDataPruneCancelled(cliCtx.outputMode);
        return;
      }
    }

    // Phase 2: Execute prune
    const renderer = createDataPruneRenderer(cliCtx.outputMode);
    await consumeStream(
      dataPrune(ctx, deps, { dryRun: !!options.dryRun }),
      renderer.handlers(),
    );
  });
