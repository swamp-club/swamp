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
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { evaluateApprovalTimeout } from "../../domain/workflows/approval_timeout.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { getLogger } from "@logtape/logtape";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface PendingApproval {
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt: string | undefined;
  prompt: string | undefined;
  inputs: Readonly<Record<string, unknown>>;
}

export interface WorkflowApprovalsData {
  approvals: PendingApproval[];
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
          const taskData = workflow.jobs
            .find((j) => j.name === waiting.jobName)?.steps
            .find((s) => s.name === waiting.stepName)?.task.data;

          const timeout = evaluateApprovalTimeout(
            step?.startedAt,
            taskData,
            new Date(),
          );
          if (timeout?.expired) continue;

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
            workflowName: workflow.name,
            runId: run.id,
            stepName: waiting.stepName,
            suspendedAt: step?.startedAt?.toISOString(),
            prompt,
            inputs: run.inputs,
          });
        }
      }

      yield { kind: "completed", data: { approvals: pending } };
    })(),
  );
}
