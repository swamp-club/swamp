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
import {
  createWorkflowSignalDeps,
  workflowSignal,
  type WorkflowSignalData,
} from "../../libswamp/workflows/signal.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import {
  type CommandContext,
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  libSwampContextForRepo,
  requireInitializedRepoUnlocked,
  signalWaitsOf,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  formatCommandTarget,
  requestNewerServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type {
  WorkflowSignalResponse,
  WorkflowSignalResponseData,
} from "../../serve/protocol.ts";
import { normalizeWaitId } from "../../domain/workflows/signal_wait_records.ts";
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
  // The step shows as waiting until the resume applies the signal.
  writeOutput(
    data.awaitingResume
      ? `After the signal: ${data.resumeCommand}`
      : !data.runRecordAvailable
      ? `This host has no copy of the run, so it cannot tell whether the run still waits on something else. ` +
        `Check with "swamp workflow waits", then resume where the run is: ${data.resumeCommand}`
      : `The run still waits on something else. Once that settles: ${data.resumeCommand}`,
  );
}

/**
 * Renders a signal delivered through a server. The server names the
 * workflow, the run and the step only to a caller who may read the
 * workflow; one who may only signal gets the receipt.
 */
export function renderRemoteSignalResult(
  cliCtx: CommandContext,
  data: WorkflowSignalResponseData,
  server: string | undefined,
): void {
  if (
    data.workflowId !== undefined && data.workflowName !== undefined &&
    data.runId !== undefined && data.jobName !== undefined &&
    data.stepName !== undefined && data.resumeCommand !== undefined
  ) {
    renderSignalResult(
      cliCtx,
      {
        waitId: data.waitId,
        workflowId: data.workflowId,
        workflowName: data.workflowName,
        runId: data.runId,
        jobName: data.jobName,
        stepName: data.stepName,
        signal: data.signal,
        awaitingResume: data.awaitingResume ?? false,
        runRecordAvailable: data.runRecordAvailable ?? false,
        resumeCommand: data.resumeCommand,
      },
      formatCommandTarget({ server }),
    );
    return;
  }
  if (cliCtx.outputMode === "json") {
    console.log(JSON.stringify(data));
    return;
  }
  cliCtx.logger
    .info`Signal ${data.signal.id} delivered to wait ${data.waitId}`;
  if (cliCtx.verbosity === "quiet") return;
  // The server does not say which run this was; it still has to be resumed.
  writeOutput(
    "The signal takes effect when the run is next resumed, by someone who may resume it.",
  );
}

export const workflowSignalCommand = withRemoteOptions(
  new Command()
    .name("signal")
    .description(
      "Send a JSON message to a workflow step that waits for a signal",
    )
    .example(
      "Answer a wait",
      `swamp workflow signal 6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90 --payload '{"verdict":"ship"}'`,
    )
    .example(
      "Answer a wait a server holds",
      `swamp workflow signal 6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90 --payload '{"verdict":"ship"}' --server wss://swamp.example.com`,
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
    ),
)
  .action(async function (options: AnyOptions, waitId: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "signal",
    ]);
    const payload = parseSignalPayload(options.payload as string);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      // The server accepts only a UUID, and answers anything else as a
      // malformed request; it is answered here as the local command would.
      const id = normalizeWaitId(waitId);
      if (id === undefined) {
        throw new UserError(`Signal wait not found: ${waitId}`, "not_found");
      }
      const token = await resolveServerTokenFromOptions(server, options);
      const response = await requestNewerServerResponse<
        WorkflowSignalResponse
      >(
        "signals",
        { server, token },
        { type: "workflow.signal", payload: { waitId: id, payload } },
      );
      renderRemoteSignalResult(
        cliCtx,
        response.data,
        options.server as string | undefined,
      );
      return;
    }

    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = libSwampContextForRepo(repoContext, { logger: cliCtx.logger });
    // A signal creates the wait's outcome record and never writes the run,
    // so it takes no claim and asks nothing of the run's owner.
    const deps = createWorkflowSignalDeps(
      repoContext.workflowRunRepo,
      signalWaitsOf(repoContext),
    );
    const commandTarget = formatCommandTarget({
      repoDir: options.repoDir as string | undefined,
    });

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
  });
