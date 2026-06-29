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
  createWorkflowRejectDeps,
  workflowReject,
  type WorkflowRejectData,
  type WorkflowRejectEvent,
} from "../../libswamp/mod.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowRejectResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowRejectCommand = withRemoteOptions(
  new Command()
    .name("reject")
    .description("Reject a manual approval step in a suspended workflow run")
    .example(
      "Reject a step",
      "swamp workflow reject deploy-with-gate verify-build",
    )
    .example(
      "Reject with reason",
      "swamp workflow reject deploy-with-gate verify-build --reason 'Not ready'",
    )
    .arguments("<workflow_id_or_name:string> <step_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--reason <reason:string>", "Reason for rejection")
    .option("--run <run_id:string>", "Target a specific run ID"),
).action(
  async function (
    options: AnyOptions,
    workflowIdOrName: string,
    stepName: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "reject",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const response = await requestServerResponse<WorkflowRejectResponse>(
        { server, token },
        {
          type: "workflow.reject",
          payload: {
            workflowIdOrName,
            stepName,
            reason: options.reason as string | undefined,
            runId: options.run as string | undefined,
          },
        },
      );
      await consumeStream<WorkflowRejectEvent>(
        (async function* () {
          yield {
            kind: "completed" as const,
            data: response.data as unknown as WorkflowRejectData,
          };
        })(),
        {
          resolving: () => {},
          completed: (e) => {
            if (cliCtx.outputMode === "json") {
              console.log(JSON.stringify(e.data));
            } else {
              cliCtx.logger
                .info`Rejected step ${e.data.stepName} in workflow ${e.data.workflowName}`;
              cliCtx.logger.info("Workflow run marked as failed.");
            }
          },
          error: (e) => {
            throw new Error(e.error.message);
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
    const deps = createWorkflowRejectDeps(
      repoContext.workflowRepo,
      repoContext.workflowRunRepo,
    );

    await consumeStream(
      workflowReject(ctx, deps, {
        workflowIdOrName,
        stepName,
        reason: options.reason as string | undefined,
        runId: options.run as string | undefined,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          if (cliCtx.outputMode === "json") {
            console.log(JSON.stringify(e.data));
          } else {
            cliCtx.logger
              .info`Rejected step ${e.data.stepName} in workflow ${e.data.workflowName}`;
            cliCtx.logger.info("Workflow run marked as failed.");
          }
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );
  },
);
