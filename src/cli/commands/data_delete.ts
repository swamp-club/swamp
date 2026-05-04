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
import {
  consumeStream,
  createDataDeleteDeps,
  createLibSwampContext,
  dataDelete,
  dataDeletePreview,
} from "../../libswamp/mod.ts";
import {
  createDataDeleteRenderer,
  renderDataDeleteCancelled,
} from "../../presentation/renderers/data_delete.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";

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

export const dataDeleteCommand = new Command()
  .name("delete")
  .description(
    "Delete a data artifact (all versions, or one when --version is set)",
  )
  .example(
    "Delete an artifact (prompts for confirmation)",
    "swamp data delete my-server hetzner-state",
  )
  .example(
    "Delete a specific version",
    "swamp data delete my-server hetzner-state --version 2",
  )
  .example(
    "Skip the confirmation prompt",
    "swamp data delete my-server hetzner-state --force",
  )
  .arguments("<model_id_or_name:string> <data_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--version <n:integer>", "Delete a specific version")
  .option("-f, --force", "Skip confirmation prompt")
  .action(
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      dataName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "data",
        "delete",
      ]);

      const { repoDir, datastoreResolver } = await requireInitializedRepo({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createDataDeleteDeps(repoDir, datastoreResolver);
      const renderer = createDataDeleteRenderer(cliCtx.outputMode);

      // Phase 1: Preview + Prompt (only in interactive log mode without --force).
      if (cliCtx.outputMode === "log" && !options.force) {
        let preview;
        try {
          preview = await dataDeletePreview(ctx, deps, {
            modelIdOrName,
            dataName,
          });
        } catch (error) {
          throw new UserError(
            error instanceof Error ? error.message : String(error),
          );
        }

        const target = options.version !== undefined
          ? `version ${options.version} of "${dataName}"`
          : `${preview.versionsCount} version(s) of "${dataName}"`;
        const confirmed = await promptConfirmation(
          `About to delete ${target} from ${preview.modelName}. Proceed?`,
        );
        if (!confirmed) {
          renderDataDeleteCancelled(cliCtx.outputMode);
          return;
        }
      }

      // Phase 2: Execute delete.
      await consumeStream(
        dataDelete(ctx, deps, {
          modelIdOrName,
          dataName,
          version: options.version,
        }),
        renderer.handlers(),
      );

      cliCtx.logger.debug("Data delete command completed");
    },
  );
