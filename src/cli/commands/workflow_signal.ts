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
  createWorkflowSignalDeps,
  userErrorFromSwampError,
  workflowSignal,
  type WorkflowSignalData,
} from "../../libswamp/mod.ts";
import {
  type CommandContext,
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  createWorkflowRunClaims,
  libSwampContextForRepo,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  suspendedRunHasDeadOwner,
  suspendedRunOwnerIsRunning,
} from "../../domain/workflows/orphaned_run_reaper.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { formatCommandTarget } from "../remote_run.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Parses the `--payload` flag. The payload must be JSON; what it may contain
 * is decided by the wait's schema, not here.
 */
export function parseSignalPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UserError(
      `--payload is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Renders a delivered signal in log or JSON mode. The command to run next
 * goes through writeOutput, not the logger, so it can be copied as printed.
 * `--quiet` hides it, as it hides the logger's info lines. `commandTarget`
 * is appended to that command in both modes, so it reaches the same
 * repository from another directory.
 */
export function renderSignalResult(
  cliCtx: CommandContext,
  result: WorkflowSignalData,
  commandTarget = "",
): void {
  const data = {
    ...result,
    resumeCommand: `${result.resumeCommand}${commandTarget}`,
  };
  if (cliCtx.outputMode === "json") {
    console.log(JSON.stringify(data));
    return;
  }
  cliCtx.logger
    .info`Signalled step ${data.stepName} in workflow ${data.workflowName}`;
  if (cliCtx.verbosity === "quiet") return;
  writeOutput(
    data.awaitingResume
      ? `After the signal: ${data.resumeCommand}`
      : `The run still waits on something else. Once that settles: ${data.resumeCommand}`,
  );
}

export const workflowSignalCommand = new Command()
  .name("signal")
  .description(
    "Send a JSON message to a workflow step that waits for a signal",
  )
  .example(
    "Answer a wait",
    `swamp workflow signal 6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90 --payload '{"verdict":"ship"}'`,
  )
  .arguments("<wait_id:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--payload <json:string>",
    "The message, as a JSON object matching the wait's schema",
    { required: true },
  )
  .action(async function (options: AnyOptions, waitId: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "signal",
    ]);
    const payload = parseSignalPayload(options.payload as string);

    const { repoDir, repoContext, datastoreConfig } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    const ctx = libSwampContextForRepo(repoContext, { logger: cliCtx.logger });
    // The tracker says whether the run's owner is still running the level
    // the wait is in, or abandoned it with a step recorded running.
    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    const liveness = localOwnerLiveness();
    const deps = createWorkflowSignalDeps(
      repoContext.workflowRunRepo,
      createWorkflowRunClaims(datastoreConfig),
      (run) => suspendedRunHasDeadOwner(run, tracker, liveness),
      (run) => suspendedRunOwnerIsRunning(run, tracker, liveness),
    );
    const commandTarget = formatCommandTarget({
      repoDir: options.repoDir as string | undefined,
    });

    try {
      await consumeStream(
        workflowSignal(ctx, deps, { waitId, payload }),
        {
          resolving: () => {},
          completed: (e) => {
            renderSignalResult(cliCtx, e.data, commandTarget);
          },
          error: (e) => {
            throw userErrorFromSwampError(e.error);
          },
        },
      );
    } finally {
      tracker.close();
    }
  });
