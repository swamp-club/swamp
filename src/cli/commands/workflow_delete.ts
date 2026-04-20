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
  createLibSwampContext,
  createWorkflowDeleteDeps,
  workflowDelete,
  workflowDeletePreview,
} from "../../libswamp/mod.ts";
import {
  createWorkflowDeleteRenderer,
  renderWorkflowDeleteCancelled,
} from "../../presentation/renderers/workflow_delete.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";

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

export const workflowDeleteCommand = new Command()
  .name("delete")
  .description("Delete a workflow and its run history")
  .example("Delete a workflow", "swamp workflow delete deploy-pipeline")
  .example("Force delete", "swamp workflow delete deploy-pipeline --force")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("-f, --force", "Skip confirmation prompt")
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "delete",
    ]);
    cliCtx.logger.debug`Deleting workflow: ${workflowIdOrName}`;

    const { repoDir, datastoreResolver } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowDeleteDeps(repoDir, datastoreResolver);

    // Phase 1: Preview
    let preview;
    try {
      preview = await workflowDeletePreview(ctx, deps, {
        workflowIdOrName,
      });
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    // Phase 2: Prompt
    if (cliCtx.outputMode === "log" && !options.force) {
      const runWarning = preview.runCount > 0
        ? ` This will also delete ${preview.runCount} run${
          preview.runCount === 1 ? "" : "s"
        }.`
        : "";
      const confirmed = await promptConfirmation(
        `Delete workflow '${preview.name}' (${preview.id})?${runWarning}`,
      );
      if (!confirmed) {
        renderWorkflowDeleteCancelled(cliCtx.outputMode);
        return;
      }
    }

    // Phase 3: Execute mutation
    const renderer = createWorkflowDeleteRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowDelete(ctx, deps, { workflowIdOrName }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Workflow delete command completed");
  });
