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
import { evaluateApprovalTimeout } from "../../domain/workflows/approval_timeout.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
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
}

export function createWorkflowApprovalsDeps(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
): WorkflowApprovalsDeps {
  return { workflowRepo, runRepo };
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

      const workflows = await deps.workflowRepo.findAll();
      const pending: PendingApproval[] = [];

      for (const workflow of workflows) {
        const runs = await deps.runRepo.findAllByWorkflowId(workflow.id);
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

          const prompt = taskData && taskData.type === "manual_approval"
            ? taskData.prompt
            : undefined;

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
