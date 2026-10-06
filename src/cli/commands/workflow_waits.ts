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
  createWorkflowWaitsDeps,
  userErrorFromSwampError,
  workflowWaits,
  type WorkflowWaitsData,
  type WorkflowWaitsEvent,
} from "../../libswamp/mod.ts";
import {
  type CommandContext,
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepoUnlocked,
  signalWaitsOf,
} from "../repo_context.ts";
import { formatCommandTarget } from "../remote_run.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Renders the open waits in log or JSON mode. Commands go through
 * writeOutput, not the logger, so they can be copied as printed. `--quiet`
 * hides them, as it hides the logger's info lines. `commandTarget` is
 * appended to every command in both modes, so it reaches the same repository
 * from another directory.
 */
export function renderWaits(
  cliCtx: CommandContext,
  result: WorkflowWaitsData,
  commandTarget = "",
): void {
  const waits = result.waits.map((wait) => ({
    ...wait,
    nextCommand: `${wait.nextCommand}${commandTarget}`,
  }));
  const unreadableWaits = result.unreadableWaits.map((wait) => ({
    ...wait,
    nextCommand: `${wait.nextCommand}${commandTarget}`,
  }));
  if (cliCtx.outputMode === "json") {
    console.log(JSON.stringify({ waits, unreadableWaits }, null, 2));
    return;
  }
  if (waits.length === 0 && unreadableWaits.length === 0) {
    cliCtx.logger.info("No workflows waiting for a signal");
    return;
  }
  const quiet = cliCtx.verbosity === "quiet";
  for (const wait of waits) {
    cliCtx.logger.info(
      "{workflowName} / {stepName} — wait {waitId}",
      {
        workflowName: wait.workflowName,
        stepName: wait.stepName,
        waitId: wait.waitId,
      },
    );
    cliCtx.logger.info("  Run:      {runId}", { runId: wait.runId });
    cliCtx.logger.info(
      wait.expired
        ? "  Deadline: {deadline} (expired — a resume fails the step)"
        : "  Deadline: {deadline}",
      { deadline: wait.deadline },
    );
    cliCtx.logger.info("  Schema:   {schema}", {
      schema: JSON.stringify(wait.schema),
    });
    if (!quiet) writeOutput(`  ${wait.nextCommand}`);
  }
  for (const wait of unreadableWaits) {
    cliCtx.logger.warn(
      "{workflowName} / {stepName} — the wait stored on run {runId} cannot be read, so no signal can reach it. A resume fails the step with wait_unreadable.",
      {
        workflowName: wait.workflowName,
        stepName: wait.stepName,
        runId: wait.runId,
      },
    );
    if (!quiet) writeOutput(`  ${wait.nextCommand}`);
  }
}

export const workflowWaitsCommand = new Command()
  .name("waits")
  .description("List all workflow steps waiting for a signal")
  .example("List open waits", "swamp workflow waits")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "waits",
    ]);

    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowWaitsDeps(
      repoContext.workflowRunRepo,
      signalWaitsOf(repoContext),
    );

    let data: WorkflowWaitsData = { waits: [], unreadableWaits: [] };
    await consumeStream<WorkflowWaitsEvent>(
      workflowWaits(ctx, deps),
      {
        resolving: () => {},
        completed: (e) => {
          data = e.data;
        },
        error: (e) => {
          throw userErrorFromSwampError(e.error);
        },
      },
    );

    renderWaits(
      cliCtx,
      data,
      formatCommandTarget({ repoDir: options.repoDir as string | undefined }),
    );
  });
