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

import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  evaluateApprovalTimeout,
  gateTimeoutSeconds,
} from "../../domain/workflows/approval_timeout.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { getLogger } from "@logtape/logtape";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { NestedRunLink } from "../../domain/workflows/nested_run_link.ts";

export interface PendingApproval {
  workflowId: string;
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt: string | undefined;
  prompt: string | undefined;
  inputs: Readonly<Record<string, unknown>>;
  /**
   * On a nested workflow's run, the parent step that started it
   * (swamp-club#2736).
   */
  parentRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
  };
  /**
   * With `parentRun`: whether the parent still waits on this run. False once
   * the parent ended and left this run suspended on its own.
   */
  parentWaiting?: boolean;
}

/**
 * An expired gate: a `manual_approval` step past its timeout on a run that
 * is still suspended. It can no longer be approved or rejected, only
 * cancelled.
 */
export interface ExpiredApproval {
  workflowId: string;
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt: string;
  timeoutSeconds: number;
  /** When the gate expired: `suspendedAt` plus the timeout. */
  expiredAt: string;
  /** A serve instance started the run, so only a serve cancel clears it. */
  serveStarted: boolean;
  /** On a nested workflow's run, the parent step that started it. */
  parentRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
    /** A serve instance started the parent run. */
    serveStarted: boolean;
  };
  /** With `parentRun`: whether the parent still waits on this run. */
  parentWaiting?: boolean;
}

export interface WorkflowApprovalsData {
  approvals: PendingApproval[];
  expired: ExpiredApproval[];
}

export type WorkflowApprovalsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowApprovalsData }
  | { kind: "error"; error: SwampError };

export interface WorkflowApprovalsDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
  findSuspendedRuns?: (
    workflowId: WorkflowId,
  ) => Promise<WorkflowRun[]>;
  findEvaluatedWorkflow?: (
    workflowId: WorkflowId,
  ) => Promise<Workflow | null>;
}

export function createWorkflowApprovalsDeps(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  findSuspendedRuns?: (
    workflowId: WorkflowId,
  ) => Promise<WorkflowRun[]>,
  findEvaluatedWorkflow?: (
    workflowId: WorkflowId,
  ) => Promise<Workflow | null>,
): WorkflowApprovalsDeps {
  return { workflowRepo, runRepo, findSuspendedRuns, findEvaluatedWorkflow };
}

export async function* workflowApprovals(
  _ctx: LibSwampContext,
  deps: WorkflowApprovalsDeps,
): AsyncIterable<WorkflowApprovalsEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.approvals",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const logger = getLogger(["swamp", "workflow", "approvals"]);
      const workflows = await deps.workflowRepo.findAll();
      const pending: PendingApproval[] = [];
      const expired: ExpiredApproval[] = [];
      // Many nested runs can share one parent: load each parent once.
      const parents = new Map<string, Promise<WorkflowRun | null>>();
      const findParent: WorkflowRunRepository["findById"] = (
        workflowId,
        runId,
      ) => {
        const key = `${workflowId}/${runId}`.toLowerCase();
        let found = parents.get(key);
        if (!found) {
          found = deps.runRepo.findById(workflowId, runId);
          parents.set(key, found);
        }
        return found;
      };
      const nestedLink = new NestedRunLink({
        workflowRepo: deps.workflowRepo,
        runRepo: { findById: findParent },
      });

      for (const workflow of workflows) {
        const runs = deps.findSuspendedRuns
          ? await deps.findSuspendedRuns(workflow.id)
          : await deps.runRepo.findAllByWorkflowId(workflow.id);

        let evaluatedWorkflow: Workflow | null | undefined;

        for (const run of runs) {
          if (run.status !== "suspended") continue;
          const waiting = run.findWaitingApprovalStep();
          if (!waiting) continue;

          const job = run.getJob(waiting.jobName);
          const step = job?.getStep(waiting.stepName);
          const definitionSteps = workflow.jobs
            .find((j) => j.name === waiting.jobName)?.steps;
          const taskData = definitionSteps
            ?.find((s) => s.name === waiting.stepName)?.task.data;

          const timeout = evaluateApprovalTimeout(
            step?.startedAt,
            gateTimeoutSeconds(step, definitionSteps),
            new Date(),
          );
          const parentRun = run.parentRun?.kind === "valid"
            ? {
              workflowId: run.parentRun.ref.workflowId,
              workflowName: run.parentRun.ref.workflowName,
              runId: run.parentRun.ref.runId,
              stepName: run.parentRun.ref.stepName,
            }
            : undefined;
          // One unreadable parent must not fail the whole listing.
          const parentWaiting = parentRun
            ? await nestedLink.isAwaitedByParent(run).catch(() => false)
            : undefined;

          if (timeout?.expired && step?.startedAt) {
            const parent = run.parentRun?.kind === "valid"
              ? await findParent(
                createWorkflowId(run.parentRun.ref.workflowId),
                createWorkflowRunId(run.parentRun.ref.runId),
              ).catch(() => null)
              : null;
            expired.push({
              workflowId: workflow.id,
              workflowName: workflow.name,
              runId: run.id,
              stepName: waiting.stepName,
              suspendedAt: step.startedAt.toISOString(),
              timeoutSeconds: timeout.timeoutSeconds,
              expiredAt: new Date(
                step.startedAt.getTime() + timeout.timeoutSeconds * 1000,
              ).toISOString(),
              serveStarted: run.instanceId !== undefined,
              ...(parentRun
                ? {
                  parentRun: {
                    ...parentRun,
                    serveStarted: parent?.instanceId !== undefined,
                  },
                  parentWaiting,
                }
                : {}),
            });
            continue;
          }

          if (evaluatedWorkflow === undefined && deps.findEvaluatedWorkflow) {
            try {
              evaluatedWorkflow = await deps.findEvaluatedWorkflow(
                workflow.id,
              );
            } catch {
              logger
                .warn`Failed to load evaluated workflow for ${workflow.name}, using raw definition`;
              evaluatedWorkflow = null;
            }
          }

          let prompt: string | undefined = step?.approvalPrompt;
          if (!prompt && evaluatedWorkflow) {
            const evalTaskData = evaluatedWorkflow.jobs
              .find((j) => j.name === waiting.jobName)?.steps
              .find((s) => s.name === waiting.stepName)?.task.data;
            prompt = evalTaskData?.type === "manual_approval"
              ? evalTaskData.prompt
              : undefined;
          }
          if (!prompt) {
            prompt = taskData?.type === "manual_approval"
              ? taskData.prompt
              : undefined;
          }

          pending.push({
            workflowId: workflow.id,
            workflowName: workflow.name,
            runId: run.id,
            stepName: waiting.stepName,
            suspendedAt: step?.startedAt?.toISOString(),
            prompt,
            inputs: run.inputs,
            ...(parentRun ? { parentRun, parentWaiting } : {}),
          });
        }
      }

      yield { kind: "completed", data: { approvals: pending, expired } };
    })(),
  );
}
