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

import type { Workflow } from "./workflow.ts";
import type { WorkflowRun } from "./workflow_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import { createWorkflowId, createWorkflowRunId } from "./workflow_id.ts";
import { UserError } from "../errors.ts";
import { planFailedRunResume } from "./resume_reset.ts";

export interface SuspendedRunInfo {
  workflowName: string;
  workflowId: string;
  workflow: Workflow;
  run: WorkflowRun;
}

export async function resolveSuspendedRun(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  workflowIdOrName: string,
  runId?: string,
): Promise<SuspendedRunInfo> {
  const workflow = await workflowRepo.findByName(workflowIdOrName) ??
    await workflowRepo.findById(createWorkflowId(workflowIdOrName));
  if (!workflow) {
    throw new UserError(`Workflow not found: ${workflowIdOrName}`);
  }

  if (runId) {
    const run = await runRepo.findById(
      workflow.id,
      createWorkflowRunId(runId),
    );
    if (!run) {
      throw new UserError(`Workflow run not found: ${runId}`);
    }
    if (run.status !== "suspended") {
      throw new UserError(
        `Run ${runId} is not suspended (status: ${run.status})`,
      );
    }
    return {
      workflowName: workflow.name,
      workflowId: workflow.id,
      workflow,
      run,
    };
  }

  const allRuns = await runRepo.findAllByWorkflowId(workflow.id);
  const suspendedRuns = allRuns.filter((r) => r.status === "suspended");

  if (suspendedRuns.length === 0) {
    throw new UserError(
      noRunsInStateMessage(workflow.name, "suspended", allRuns),
    );
  }
  if (suspendedRuns.length > 1) {
    const ids = suspendedRuns.map((r) => r.id).join("\n  ");
    throw new UserError(
      `Multiple suspended runs found for workflow "${workflow.name}":\n  ${ids}\n` +
        `Use --run <run-id> to specify which run to target.`,
    );
  }

  return {
    workflowName: workflow.name,
    workflowId: workflow.id,
    workflow,
    run: suspendedRuns[0],
  };
}

export type ResumableRunInfo = SuspendedRunInfo;

export interface ResolveResumableRunOptions {
  /** The --from step; when set, only a failed run is resumable. */
  fromStep?: string;
}

/**
 * Resolves the run for `workflow resume`.
 *
 * - With `runId`: loads that run. With --from it must be failed; without,
 *   suspended or failed (a failed run is retried).
 * - Without `runId`: requires exactly one failed run with --from, or exactly
 *   one suspended run without it. A failed run is retried only when named,
 *   so approve followed by a bare resume never becomes ambiguous because of
 *   old failed runs.
 *
 * A failed run is planned here — retry eligibility without --from, and the
 * structure check either way — so callers fail before starting anything;
 * resume() checks again.
 */
export async function resolveResumableRun(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  workflowIdOrName: string,
  runId?: string,
  options: ResolveResumableRunOptions = {},
): Promise<ResumableRunInfo> {
  if (!options.fromStep && !runId) {
    return await resolveSuspendedRun(
      workflowRepo,
      runRepo,
      workflowIdOrName,
    );
  }

  const workflow = await workflowRepo.findByName(workflowIdOrName) ??
    await workflowRepo.findById(createWorkflowId(workflowIdOrName));
  if (!workflow) {
    throw new UserError(`Workflow not found: ${workflowIdOrName}`);
  }

  if (runId) {
    const run = await runRepo.findById(
      workflow.id,
      createWorkflowRunId(runId),
    );
    if (!run) {
      throw new UserError(`Workflow run not found: ${runId}`);
    }
    if (options.fromStep) {
      if (run.status !== "failed") {
        throw new UserError(
          `--from requires a failed run, but run ${runId} has status "${run.status}"`,
        );
      }
      planFailedRunResume(workflow, run, options.fromStep);
    } else if (run.status === "failed") {
      planFailedRunResume(workflow, run);
    } else if (run.status !== "suspended") {
      throw new UserError(
        `Run ${runId} is not suspended or failed (status: ${run.status}).` +
          nextActionForStatus(run.status, workflow.name, run.id),
      );
    }
    return {
      workflowName: workflow.name,
      workflowId: workflow.id,
      workflow,
      run,
    };
  }

  const allRuns = await runRepo.findAllByWorkflowId(workflow.id);
  const failedRuns = allRuns.filter((r) => r.status === "failed");

  if (failedRuns.length === 0) {
    throw new UserError(
      noRunsInStateMessage(workflow.name, "failed", allRuns),
    );
  }
  if (failedRuns.length > 1) {
    const ids = failedRuns.map((r) => r.id).join("\n  ");
    throw new UserError(
      `Multiple failed runs found for workflow "${workflow.name}":\n  ${ids}\n` +
        `Use --run <run-id> to specify which run to resume with --from.`,
    );
  }

  planFailedRunResume(workflow, failedRuns[0], options.fromStep);
  return {
    workflowName: workflow.name,
    workflowId: workflow.id,
    workflow,
    run: failedRuns[0],
  };
}

function noRunsInStateMessage(
  workflowName: string,
  expectedStatus: string,
  allRuns: readonly WorkflowRun[],
): string {
  const base = `No ${expectedStatus} runs found for workflow "${workflowName}"`;
  if (allRuns.length === 0) {
    return `${base}. No runs exist — run the workflow first with 'swamp workflow run ${workflowName}'.`;
  }
  const latest = allRuns[0];
  const suggestion = nextActionForStatus(
    latest.status,
    workflowName,
    latest.id,
  );
  // A failed run's hint already names the run id, so it is not repeated
  // here; that keeps the message within serve's 200-character error limit.
  const id = latest.status === "failed" ? "" : ` (${latest.id})`;
  return `${base}. The latest run is ${latest.status}${id}.${suggestion}`;
}

/**
 * A sentence, with a leading space, naming the command to run next for a
 * run in `status`.
 */
export function nextActionForStatus(
  status: string,
  workflowName: string,
  runId: string,
): string {
  switch (status) {
    case "running":
      return ` Wait for it to complete, or check progress with 'swamp workflow history ${workflowName}'.`;
    case "succeeded":
      return ` The workflow has already completed — inspect results with 'swamp workflow history ${workflowName}'.`;
    case "failed":
      // A full command, since approve, reject and auto-resume show this too.
      return ` Retry it with 'swamp workflow resume ${workflowName} --run ${runId}'.`;
    case "suspended":
      return ` Approve or resume the suspended run with 'swamp workflow approve ${workflowName}'.`;
    case "interrupted":
      return ` Recover the interrupted run with 'swamp workflow recover ${workflowName}'.`;
    default:
      return ` Check the run status with 'swamp workflow history ${workflowName}'.`;
  }
}
