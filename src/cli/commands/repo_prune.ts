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
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createRepoPruneDeps,
  repoPrune,
  type RepoPruneEvent,
  type RepoPrunePreview,
  repoPrunePreview,
} from "../../libswamp/repo/prune.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import {
  createRepoPruneRenderer,
  renderRepoPruneCancelled,
  renderRepoPrunePreview,
} from "../../presentation/renderers/repo_prune.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { promptConfirmation } from "../prompt_helpers.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const repoPruneCommand = new Command()
  .description(
    "Remove the settings swamp manages for AI tools that are no longer " +
      "enrolled: audit hook entries, swamp's plugin files and the Kiro swamp " +
      "agent. User entries, permissions, skills and instructions files are " +
      "kept, and enrolled tools are never touched. Use --dry-run first. " +
      "A file it could not change is listed under failed and the command " +
      "exits 1. Error codes: validation_failed (not a swamp repository), " +
      "prune_failed (the repository could not be read or changed).",
  )
  .example("Preview what would be removed", "swamp repo prune --dry-run")
  .example("Remove without a prompt", "swamp repo prune --yes")
  .arguments("[path:string]")
  .option("--dry-run", "Show what would be removed without changing anything")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("-f, --force", "Skip confirmation prompt (alias for --yes)")
  .action(async function (options: AnyOptions, pathArg?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["repo", "prune"]);
    const path = pathArg ?? ".";
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createRepoPruneDeps();

    let preview: RepoPrunePreview | undefined;
    const skipPrompt = options.yes || options.force || options.dryRun;
    if (cliCtx.outputMode === "log" && !skipPrompt) {
      let found: RepoPrunePreview | null;
      try {
        // outside a repository the preview is null and repoPrune reports it
        found = await repoPrunePreview(ctx, deps, { path });
      } catch (error) {
        throw new UserError(
          error instanceof Error ? error.message : String(error),
          "prune_failed",
        );
      }
      if (found !== null) {
        renderRepoPrunePreview(found);
        if (found.items.length === 0) return;
        const confirmed = await promptConfirmation("Remove these settings?");
        if (!confirmed) {
          renderRepoPruneCancelled();
          return;
        }
        preview = found;
      }
    }

    await consumeStream(
      repoPrune(ctx, deps, { path, dryRun: !!options.dryRun, preview }),
      exitOneOnFailedChanges(
        createRepoPruneRenderer(cliCtx.outputMode).handlers(),
      ),
    );
  });

/** sets the exit code only after the result is rendered, so stdout keeps it */
export function exitOneOnFailedChanges(
  handlers: EventHandlers<RepoPruneEvent>,
): EventHandlers<RepoPruneEvent> {
  return {
    ...handlers,
    completed: async (e) => {
      await handlers.completed(e);
      if (e.data.failed.length > 0) Deno.exitCode = 1;
    },
  };
}
