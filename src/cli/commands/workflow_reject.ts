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
import { runCommandInRootUnit } from "../command_root_unit.ts";
import {
  createWorkflowRejectDeps,
  workflowReject,
  type WorkflowRejectData,
  type WorkflowRejectEvent,
} from "../../libswamp/workflows/reject.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
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
import {
  renderAwaitingParent,
  renderNestedCascade,
  type ThroughServe,
} from "./nested_run_hints.ts";
import { localNestedCascade } from "../local_nested_cascade.ts";
import {
  DECIDED_ON_SERVE_OPTION_TEXTS,
  remoteGateRefusalUserError,
  requestServerResponse,
  requireGateAttemptCheck,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowRejectResponse } from "../../serve/protocol.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowRejectCommand = withRemoteOptions(
  new Command()
    .name("reject")
    .description(
      "Reject a manual approval step in a suspended workflow run. In team mode the rejection is decided on serve",
    )
    .example(
      "Reject a step",
      "swamp workflow reject deploy-with-gate verify-build",
    )
    .example(
      "Reject with reason",
      "swamp workflow reject deploy-with-gate verify-build --reason 'Not ready'",
    )
    .example(
      "Reject only the attempt you read",
      "swamp workflow reject deploy-with-gate verify-build --run <run-id> --suspended-at 2026-11-06T10:00:00.000Z",
    )
    .arguments("<workflow_id_or_name:string> <step_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--reason <reason:string>", "Reason for rejection")
    .option("--run <run_id:string>", "Target a specific run ID")
    .option(
      "--suspended-at <time:string>",
      "Decide only this attempt of the gate, using suspendedAt from 'swamp workflow approvals --json'; refused if the gate has been asked again since",
    ),
  DECIDED_ON_SERVE_OPTION_TEXTS,
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
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );
      if (options.suspendedAt !== undefined) {
        await requireGateAttemptCheck({ server, token });
      }
      const response = await requestServerResponse<WorkflowRejectResponse>(
        { server, token },
        {
          type: "workflow.reject",
          payload: {
            workflowIdOrName,
            stepName,
            reason: options.reason as string | undefined,
            runId: options.run as string | undefined,
            suspendedAt: options.suspendedAt as string | undefined,
          },
        },
      ).catch((error: unknown) => {
        throw remoteGateRefusalUserError(error, "workflow_reject_failed");
      });
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
              logFanOutHeld(cliCtx, e.data);
              logNestedRunFollowUps(cliCtx, e.data, {
                server: options.server as string | undefined,
              });
            }
          },
          error: (e) => {
            throw userErrorFromSwampError(e.error);
          },
        },
      );
      return;
    }

    const { repoDir, repoContext, datastoreResolver, datastoreConfig } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    // The evaluated snapshots live where ExecutionService wrote them: the
    // datastore-resolved path, not the repo-dir default.
    const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
      repoDir,
      datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
    );
    try {
      const ctx = libSwampContextForRepo(repoContext, {
        logger: cliCtx.logger,
      });
      const deps = createWorkflowRejectDeps(
        repoContext.workflowRepo,
        repoContext.workflowRunRepo,
        createWorkflowRunClaims(datastoreConfig),
        (runId) => evaluatedWorkflowRepo.findByRunId(runId),
        runTracker,
      );
      // the suspended nested runs the rejected run waited on are cancelled with
      // it
      deps.cascade = localNestedCascade({
        workflowRepo: deps.workflowRepo,
        runRepo: deps.runRepo,
        runClaims: deps.runClaims,
        findEvaluatedWorkflow: deps.findEvaluatedWorkflow,
        runTracker,
      });

      // a root of its own, so the result waits for the commit; it pushes
      // nothing
      await runCommandInRootUnit(
        repoContext,
        { push: undefined },
        () =>
          consumeStream(
            workflowReject(ctx, deps, {
              workflowIdOrName,
              stepName,
              reason: options.reason as string | undefined,
              runId: options.run as string | undefined,
              suspendedAt: options.suspendedAt as string | undefined,
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
                  logFanOutHeld(cliCtx, e.data);
                  logNestedRunFollowUps(cliCtx, e.data);
                }
              },
              error: (e) => {
                throw userErrorFromSwampError(e.error);
              },
            },
          ),
      );
    } finally {
      runTracker.close();
    }
  },
);

function logNestedRunFollowUps(
  cliCtx: CommandContext,
  data: WorkflowRejectData,
  remote?: ThroughServe,
): void {
  renderNestedCascade(cliCtx, data, remote);
  if (data.awaitingParent) {
    renderAwaitingParent(cliCtx, data.awaitingParent, remote);
  }
}

function logFanOutHeld(cliCtx: CommandContext, data: WorkflowRejectData): void {
  const held = data.fanOutHeld;
  if (held === undefined) return;
  cliCtx.logger
    .info`Fan-out job ${held.jobName}: ${held.held.length} lane(s) held, never started (reason ${held.reason}): ${
    held.held.join(", ")
  }`;
}
