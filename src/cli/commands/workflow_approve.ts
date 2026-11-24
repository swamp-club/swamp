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
  createWorkflowApproveDeps,
  workflowApprove,
  type WorkflowApproveData,
  type WorkflowApproveEvent,
} from "../../libswamp/workflows/approve.ts";
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
  DECIDED_ON_SERVE_OPTION_TEXTS,
  formatCommandTarget,
  remoteGateRefusalUserError,
  requestServerResponse,
  requireGateAttemptCheck,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowApproveResponse } from "../../serve/protocol.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import {
  parentResumeCommand,
  renderAwaitingParent,
} from "./nested_run_hints.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export function serveIsResuming(data: Record<string, unknown>): boolean {
  return data.autoResumed === true;
}

export type RemoteResumeDecision =
  | "serve_resuming"
  | "owner_resumes"
  | "pending"
  | "resume";

/** serve may already have launched the resume; a second one is never sent */
export function remoteResumeDecision(
  data: Record<string, unknown>,
): RemoteResumeDecision {
  if (serveIsResuming(data)) return "serve_resuming";
  if (data.ownerResumes === true) return "owner_resumes";
  if (data.allGatesDecided !== true) return "pending";
  return "resume";
}

export function describePendingGates(data: WorkflowApproveData): string {
  const gates = data.pendingGates;
  if (!gates) return "other gates are still pending";
  const all = [
    ...gates.approvals.map((g) => ({ ...g, kind: "approval" })),
    ...gates.signalWaits.map((g) => ({ ...g, kind: "signal" })),
    ...gates.nestedRuns.map((g) => ({ ...g, kind: "nested run" })),
  ];
  if (all.length === 0) return "the run is not ready to resume";
  const repeated = (name: string) =>
    all.filter((g) => g.stepName === name).length > 1;
  return all.map((g) =>
    `${repeated(g.stepName) ? `${g.jobName}/` : ""}${g.stepName} (${g.kind})`
  ).join(", ");
}

/**
 * the next commands go through writeOutput, not the logger: LogTape quotes
 * values and the pretty sink wraps lines, breaking copy-pasted commands
 */
export function renderApproveResult(
  cliCtx: CommandContext,
  data: WorkflowApproveData,
  remote?: { server?: string; serveResuming: boolean },
  resume?: { resuming: boolean },
): void {
  if (cliCtx.outputMode === "json") {
    console.log(
      JSON.stringify(resume ? { ...data, resuming: resume.resuming } : data),
    );
    return;
  }
  cliCtx.logger
    .info`Approved step ${data.stepName} in workflow ${data.workflowName}`;
  if (remote?.serveResuming) {
    cliCtx.logger.info`Serve is resuming run ${data.runId} automatically`;
  }
  if (data.ownerResumes === true) {
    cliCtx.logger
      .info`Serve does not resume a run a member drives: the run's owner resumes ${data.runId}`;
  }
  // the resume, or approve after it, names the parent run once it finishes
  if (resume?.resuming) {
    cliCtx.logger.info`Resuming run ${data.runId}`;
    return;
  }
  if (resume && !data.allGatesDecided) {
    cliCtx.logger.info`Not resumed: run ${data.runId} still waits on ${
      describePendingGates(data)
    }`;
  }
  if (cliCtx.verbosity === "quiet") return;
  // The owner resumes where the run is, not on the server named here.
  const target = remote && data.ownerResumes !== true
    ? formatCommandTarget({ server: remote.server })
    : "";
  if (!remote?.serveResuming) {
    writeOutput(
      `${
        data.ownerResumes === true
          ? "If you started this run"
          : "After approval"
      }: swamp workflow resume ${
        quoteShellWord(data.workflowName)
      } --run ${data.runId}${target}`,
    );
  }
  const parent = data.awaitingParent;
  if (parent) {
    writeOutput(
      remote && data.ownerResumes !== true
        ? `Once it finishes, resume the parent run unless serve resumes it automatically: ${
          parentResumeCommand(parent, remote)
        }`
        : `Once it finishes, resume the parent run: ${parent.resumeCommand}`,
    );
  }
}

export const workflowApproveCommand = withRemoteOptions(
  new Command()
    .name("approve")
    .description(
      "Approve a manual approval step in a suspended workflow run. In team mode the approval is decided on serve",
    )
    .example(
      "Approve by workflow name",
      "swamp workflow approve deploy-with-gate verify-build",
    )
    .example(
      "Approve with reason",
      "swamp workflow approve deploy-with-gate verify-build --reason 'Verified'",
    )
    .example(
      "Approve and continue the run once no gate is left",
      "swamp workflow approve deploy-with-gate verify-build --run <run-id> --resume",
    )
    .example(
      "Approve only the attempt you read",
      "swamp workflow approve deploy-with-gate verify-build --run <run-id> --suspended-at 2026-11-06T10:00:00.000Z",
    )
    .example(
      "Approve a fan-out gate (quote the name: zsh globs the brackets)",
      "swamp workflow approve patch-web 'patch[approve-plan]'",
    )
    .arguments("<workflow_id_or_name:string> <step_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--reason <reason:string>", "Reason for approval")
    .option("--run <run_id:string>", "Target a specific run ID")
    .option(
      "--suspended-at <time:string>",
      "Decide only this attempt of the gate, using suspendedAt from 'swamp workflow approvals --json'; refused if the gate has been asked again since",
    )
    .option(
      "--resume",
      "Resume the run in this invocation once this approval leaves every gate decided; the exit code is then the resume's. For resume inputs use 'swamp workflow resume'",
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
      "approve",
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
      const response = await requestServerResponse<WorkflowApproveResponse>(
        { server, token },
        {
          type: "workflow.approve",
          payload: {
            workflowIdOrName,
            stepName,
            reason: options.reason as string | undefined,
            runId: options.run as string | undefined,
            suspendedAt: options.suspendedAt as string | undefined,
          },
        },
      ).catch((error: unknown) => {
        throw remoteGateRefusalUserError(error, "workflow_approve_failed");
      });
      const approved = response.data as unknown as WorkflowApproveData;
      const decision = options.resume === true
        ? remoteResumeDecision(response.data)
        : undefined;
      await consumeStream<WorkflowApproveEvent>(
        (async function* () {
          yield { kind: "completed" as const, data: approved };
        })(),
        {
          resolving: () => {},
          completed: (e) => {
            renderApproveResult(
              cliCtx,
              e.data,
              {
                server: options.server as string | undefined,
                serveResuming: serveIsResuming(response.data),
              },
              decision ? { resuming: decision === "resume" } : undefined,
            );
          },
          error: (e) => {
            throw userErrorFromSwampError(e.error);
          },
        },
      );
      if (decision === "resume") {
        const { resumeRunOverServer } = await import("./workflow_resume.ts");
        const finished = await resumeRunOverServer(
          cliCtx,
          { server, token, serverOption: options.server as string | undefined },
          {
            workflowIdOrName: approved.workflowName,
            runId: approved.runId,
            inputs: {},
          },
        );
        // serve names the parent only to a reader of it, and only serve can
        // find it: the run is not in this checkout
        if (finished && approved.awaitingParent) {
          renderAwaitingParent(cliCtx, approved.awaitingParent, {
            server: options.server as string | undefined,
          });
        }
      }
      return;
    }

    const unlocked = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });
    const { repoDir, repoContext, datastoreResolver, datastoreConfig } =
      unlocked;

    const ctx = libSwampContextForRepo(repoContext, { logger: cliCtx.logger });
    const deps = createWorkflowApproveDeps(
      repoContext.workflowRepo,
      repoContext.workflowRunRepo,
      createWorkflowRunClaims(datastoreConfig),
    );
    // a nested run nothing waits on is cancelled instead of approved: settled
    // against its own evaluated snapshot and its tracker row closed
    const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    deps.runTracker = runTracker;
    deps.findEvaluatedWorkflow = (runId) =>
      new YamlEvaluatedWorkflowRepository(
        repoDir,
        datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
      ).findByRunId(runId);

    const approval: { data?: WorkflowApproveData } = {};
    try {
      // a root of its own, so the result waits for the commit; it pushes
      // nothing
      await runCommandInRootUnit(
        repoContext,
        { push: undefined },
        () =>
          consumeStream(
            workflowApprove(ctx, deps, {
              workflowIdOrName,
              stepName,
              reason: options.reason as string | undefined,
              runId: options.run as string | undefined,
              suspendedAt: options.suspendedAt as string | undefined,
            }),
            {
              resolving: () => {},
              completed: (e) => {
                approval.data = e.data;
                renderApproveResult(
                  cliCtx,
                  e.data,
                  undefined,
                  options.resume === true
                    ? { resuming: e.data.allGatesDecided }
                    : undefined,
                );
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

    const approved = approval.data;
    if (options.resume === true && approved?.allGatesDecided) {
      // loaded only to resume: it brings in the whole executor
      const { resumeRunLocally } = await import("./workflow_resume.ts");
      await resumeRunLocally(cliCtx, unlocked, {
        workflowIdOrName: approved.workflowName,
        runId: approved.runId,
        inputs: {},
        repoDirOption: options.repoDir as string | undefined,
      });
    }
  },
);
