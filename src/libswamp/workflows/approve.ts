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

import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import { resolveSuspendedRun } from "../../domain/workflows/suspended_run_resolver.ts";
import { evaluateApprovalTimeout } from "../../domain/workflows/approval_timeout.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface WorkflowApproveData {
  runId: string;
  workflowName: string;
  stepName: string;
  approved: true;
  decidedBy: string;
  reason: string | null;
}

export type WorkflowApproveEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowApproveData }
  | { kind: "error"; error: SwampError };

export interface WorkflowApproveInput {
  workflowIdOrName: string;
  stepName: string;
  reason?: string;
  runId?: string;
  decidedBy?: string;
}

export interface WorkflowApproveDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
}

export function createWorkflowApproveDeps(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
): WorkflowApproveDeps {
  return { workflowRepo, runRepo };
}

export async function* workflowApprove(
  _ctx: LibSwampContext,
  deps: WorkflowApproveDeps,
  input: WorkflowApproveInput,
): AsyncIterable<WorkflowApproveEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.approve",
    {
      "workflow.id_or_name": input.workflowIdOrName,
      "step.name": input.stepName,
    },
    (async function* () {
      yield { kind: "resolving" };

      let resolved: {
        run: WorkflowRun;
        workflowName: string;
        workflow: Workflow;
      };
      try {
        resolved = await resolveSuspendedRun(
          deps.workflowRepo,
          deps.runRepo,
          input.workflowIdOrName,
          input.runId,
        );
      } catch (error) {
        yield {
          kind: "error",
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      const { run, workflowName, workflow } = resolved;

      let step:
        | import("../../domain/workflows/workflow_run.ts").StepRun
        | undefined;
      let jobName: string | undefined;
      for (const job of run.jobs) {
        const s = job.getStep(input.stepName);
        if (s && s.status === "waiting_approval") {
          step = s;
          jobName = job.jobName;
          break;
        }
      }
      if (!step || !jobName) {
        yield {
          kind: "error",
          error: validationFailed(
            `Step "${input.stepName}" is not awaiting approval in the suspended run`,
          ),
        };
        return;
      }

      const wfJob = workflow.jobs.find((j) => j.name === jobName);
      const wfStep = wfJob?.steps.find((s) => s.name === input.stepName);
      const timeout = evaluateApprovalTimeout(
        step.startedAt,
        wfStep?.task.data,
        new Date(),
      );
      if (timeout?.expired) {
        yield {
          kind: "error",
          error: validationFailed(
            `Approval timed out: step "${input.stepName}" has been waiting ${
              Math.round(timeout.elapsedSeconds)
            }s (timeout: ${timeout.timeoutSeconds}s)`,
          ),
        };
        return;
      }

      const decidedBy = input.decidedBy ?? Deno.env.get("USER") ??
        Deno.env.get("USERNAME") ?? "unknown";
      step.recordApprovalDecision({
        approved: true,
        reason: input.reason,
        decidedBy,
        decidedAt: new Date().toISOString(),
      });
      step.succeed();
      await deps.runRepo.save(createWorkflowId(run.workflowId), run);

      yield {
        kind: "completed",
        data: {
          runId: run.id,
          workflowName,
          stepName: input.stepName,
          approved: true,
          decidedBy,
          reason: input.reason ?? null,
        },
      };
    })(),
  );
}
