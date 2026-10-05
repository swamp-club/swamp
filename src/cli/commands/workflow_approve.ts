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
  createWorkflowApproveDeps,
  userErrorFromSwampError,
  workflowApprove,
  type WorkflowApproveData,
  type WorkflowApproveEvent,
} from "../../libswamp/mod.ts";
import {
  type CommandContext,
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import {
  formatCommandTarget,
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowApproveResponse } from "../../serve/protocol.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Whether serve reported that it resumed the run itself after this approval
 * (the workflow opted into auto-resume and every gate is now decided).
 */
export function serveIsResuming(data: Record<string, unknown>): boolean {
  return data.autoResumed === true;
}

/**
 * Renders an approval in log or JSON mode. The commands to run next go
 * through writeOutput, not the logger: LogTape quotes interpolated values and
 * the pretty sink wraps long lines, and either breaks a copy-pasted command
 * (swamp-club#2977). `--quiet` hides them, as it hides the logger's info lines.
 */
export function renderApproveResult(
  cliCtx: CommandContext,
  data: WorkflowApproveData,
  remote?: { server?: string; serveResuming: boolean },
): void {
  if (cliCtx.outputMode === "json") {
    console.log(JSON.stringify(data));
    return;
  }
  cliCtx.logger
    .info`Approved step ${data.stepName} in workflow ${data.workflowName}`;
  if (remote?.serveResuming) {
    cliCtx.logger.info`Serve is resuming run ${data.runId} automatically`;
  }
  if (cliCtx.verbosity === "quiet") return;
  if (!remote?.serveResuming) {
    const target = remote ? formatCommandTarget({ server: remote.server }) : "";
    writeOutput(
      `After approval: swamp workflow resume ${
        quoteShellWord(data.workflowName)
      } --run ${data.runId}${target}`,
    );
  }
  if (data.awaitingParent) {
    writeOutput(
      remote
        ? `Once it finishes, resume the parent run unless serve resumes it automatically: ${data.awaitingParent.resumeCommand}`
        : `Once it finishes, resume the parent run: ${data.awaitingParent.resumeCommand}`,
    );
  }
}

export const workflowApproveCommand = withRemoteOptions(
  new Command()
    .name("approve")
    .description("Approve a manual approval step in a suspended workflow run")
    .example(
      "Approve by workflow name",
      "swamp workflow approve deploy-with-gate verify-build",
    )
    .example(
      "Approve with reason",
      "swamp workflow approve deploy-with-gate verify-build --reason 'Verified'",
    )
    .arguments("<workflow_id_or_name:string> <step_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--reason <reason:string>", "Reason for approval")
    .option("--run <run_id:string>", "Target a specific run ID"),
).action(
  async function (
    options: AnyOptions,
    workflowIdOrName: string,
    stepName: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "approve",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );
      const response = await requestServerResponse<WorkflowApproveResponse>(
        { server, token },
        {
          type: "workflow.approve",
          payload: {
            workflowIdOrName,
            stepName,
            reason: options.reason as string | undefined,
            runId: options.run as string | undefined,
          },
        },
      );
      await consumeStream<WorkflowApproveEvent>(
        (async function* () {
          yield {
            kind: "completed" as const,
            data: response.data as unknown as WorkflowApproveData,
          };
        })(),
        {
          resolving: () => {},
          completed: (e) => {
            renderApproveResult(cliCtx, e.data, {
              server: options.server as string | undefined,
              serveResuming: serveIsResuming(response.data),
            });
          },
          error: (e) => {
            throw userErrorFromSwampError(e.error);
          },
        },
      );
      return;
    }

    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowApproveDeps(
      repoContext.workflowRepo,
      repoContext.workflowRunRepo,
    );

    await consumeStream(
      workflowApprove(ctx, deps, {
        workflowIdOrName,
        stepName,
        reason: options.reason as string | undefined,
        runId: options.run as string | undefined,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          renderApproveResult(cliCtx, e.data);
        },
        error: (e) => {
          throw userErrorFromSwampError(e.error);
        },
      },
    );
  },
);
