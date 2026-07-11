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
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import { resolveSuspendedRun } from "../../domain/workflows/suspended_run_resolver.ts";
import { evaluateApprovalTimeout } from "../../domain/workflows/approval_timeout.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface WorkflowRejectData {
  runId: string;
  workflowName: string;
  stepName: string;
  approved: false;
  decidedBy: string;
  reason: string | null;
  runStatus: string;
}

export type WorkflowRejectEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowRejectData }
  | { kind: "error"; error: SwampError };

export interface WorkflowRejectInput {
  workflowIdOrName: string;
  stepName: string;
  reason?: string;
  runId?: string;
  decidedBy?: string;
}

export interface WorkflowRejectDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
  runTracker?: RunTrackerRepository;
}

export function createWorkflowRejectDeps(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  runTracker?: RunTrackerRepository,
): WorkflowRejectDeps {
  return { workflowRepo, runRepo, runTracker };
}

export async function* workflowReject(
  _ctx: LibSwampContext,
  deps: WorkflowRejectDeps,
  input: WorkflowRejectInput,
): AsyncIterable<WorkflowRejectEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.reject",
    {
      "workflow.id_or_name": input.workflowIdOrName,
      "step.name": input.stepName,
    },
    (async function* () {
      yield { kind: "resolving" };

      let resolved: {
        run: WorkflowRun;
        workflowName: string;
        workflowId: string;
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

      const { run, workflowName, workflowId, workflow } = resolved;

      let step:
        | import("../../domain/workflows/workflow_run.ts").StepRun
        | undefined;
      let matchedJob:
        | import("../../domain/workflows/workflow_run.ts").JobRun
        | undefined;
      let jobName: string | undefined;
      for (const job of run.jobs) {
        const s = job.getStep(input.stepName);
        if (s && s.status === "waiting_approval") {
          step = s;
          matchedJob = job;
          jobName = job.jobName;
          break;
        }
      }
      if (!step || !matchedJob) {
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
        approved: false,
        reason: input.reason,
        decidedBy,
        decidedAt: new Date().toISOString(),
      });
      step.fail(input.reason ?? "Approval rejected");
      matchedJob.fail();
      run.complete();
      await deps.runRepo.save(createWorkflowId(workflowId), run);
      if (deps.runTracker) {
        deps.runTracker.complete(run.id, "failed");
      }

      yield {
        kind: "completed",
        data: {
          runId: run.id,
          workflowName,
          stepName: input.stepName,
          approved: false,
          decidedBy,
          reason: input.reason ?? null,
          runStatus: "failed",
        },
      };
    })(),
  );
}
