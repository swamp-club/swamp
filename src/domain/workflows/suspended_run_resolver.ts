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
import { createWorkflowRunId } from "./workflow_id.ts";
import { findWorkflowById, findWorkflowByIdOrName } from "./workflow_lookup.ts";
import { UserError } from "../errors.ts";
import { quoteShellWord } from "../shell_word.ts";
import { entryTemplateOf, fromJobFor } from "./failed_step_retry.ts";
import { assertNestedWaitsSettled } from "./nested_run_link.ts";
import type { SignalWaitSupport } from "./signal_wait_store.ts";
import {
  checkSuspendedRunResume,
  planFailedRunResume,
} from "./resume_reset.ts";

/**
 * for a resume serve launched itself this is a lost race, not a failure: a peer
 * or a person resumed the run first
 */
export class RunNotSuspendedError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "RunNotSuspendedError";
  }
}

export interface SuspendedRunInfo {
  workflowName: string;
  workflowId: string;
  workflow: Workflow;
  run: WorkflowRun;
}

export interface WorkflowLookupOptions {
  /**
   * look up by id only, so the operation acts on the workflow the caller
   * authorized
   */
  byId?: boolean;
  /**
   * ids are not guaranteed unique, so only a workflow with both this name and
   * the id is accepted
   */
  expectedName?: string;
}

function lookupWorkflow(
  workflowRepo: WorkflowRepository,
  workflowIdOrName: string,
  lookup: WorkflowLookupOptions,
): Promise<Workflow | null> {
  return lookup.byId
    ? findWorkflowById(workflowRepo, workflowIdOrName, lookup.expectedName)
    : findWorkflowByIdOrName(workflowRepo, workflowIdOrName);
}

export interface ResolveSuspendedRunOptions extends WorkflowLookupOptions {
  ownerIsDead?: (run: WorkflowRun) => boolean;
}

export async function resolveSuspendedRun(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  workflowIdOrName: string,
  runId?: string,
  lookup: ResolveSuspendedRunOptions = {},
): Promise<SuspendedRunInfo> {
  const workflow = await lookupWorkflow(
    workflowRepo,
    workflowIdOrName,
    lookup,
  );
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
      throw new RunNotSuspendedError(
        `Run ${runId} is not suspended (status: ${run.status}).` +
          nextActionForStatus(
            run.status,
            workflow.name,
            run.id,
            rejectedGateOf(workflow, run),
          ),
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
      noRunsInStateMessage(
        workflow,
        "suspended",
        allRuns,
        lookup.ownerIsDead,
      ),
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

/** alone, --job would be ignored and a retry would re-run every job */
export const FROM_JOB_WITHOUT_FROM =
  "--job requires --from: it names the job of the --from step.";

export interface ResolveResumableRunOptions extends ResolveSuspendedRunOptions {
  fromStep?: string;
  fromJob?: string;
  /** as auto-resume after an approval needs; takes precedence over fromStep */
  suspendedOnly?: boolean;
  /**
   * without it the nested run's record is read, which shows a signalled wait as
   * open until that run is resumed
   */
  signalWaits?: SignalWaitSupport;
}

/**
 * a failed run is retried only when named, so approve then a bare resume never
 * becomes ambiguous; approve and reject skip the structure check so a gate can
 * be decided after the workflow changed
 */
export async function resolveResumableRun(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  workflowIdOrName: string,
  runId?: string,
  options: ResolveResumableRunOptions = {},
): Promise<ResumableRunInfo> {
  // The CLI refuses --job without --from too; serve's payload does not.
  if (options.fromJob !== undefined && !options.fromStep) {
    throw new UserError(FROM_JOB_WITHOUT_FROM);
  }
  if (options.suspendedOnly || (!options.fromStep && !runId)) {
    const resolved = await resolveSuspendedRun(
      workflowRepo,
      runRepo,
      workflowIdOrName,
      runId,
      {
        byId: options.byId,
        expectedName: options.expectedName,
        ownerIsDead: options.ownerIsDead,
      },
    );
    checkSuspendedRunResume(resolved.workflow, resolved.run);
    await assertNestedWaitsSettled(
      { runRepo, workflowRepo, signalWaits: options.signalWaits },
      resolved.run,
    );
    return resolved;
  }

  const workflow = await lookupWorkflow(
    workflowRepo,
    workflowIdOrName,
    options,
  );
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
    if (run.status === "running" && options.ownerIsDead?.(run)) {
      throw new UserError(
        `Run ${runId} is recorded as running, but its owning process` +
          `${run.pid !== undefined ? ` (pid ${run.pid})` : ""} is gone.` +
          deadOwnerNextAction(workflow.name, run.id),
      );
    }
    if (options.fromStep) {
      if (run.status !== "failed") {
        throw new UserError(
          `--from requires a failed run, but run ${runId} has status "${run.status}"`,
        );
      }
      planFailedRunResume(workflow, run, {
        step: options.fromStep,
        job: options.fromJob,
      });
    } else if (run.status === "failed") {
      planFailedRunResume(workflow, run);
    } else if (run.status === "suspended") {
      checkSuspendedRunResume(workflow, run);
      await assertNestedWaitsSettled(
        { runRepo, workflowRepo, signalWaits: options.signalWaits },
        run,
      );
    } else {
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
      noRunsInStateMessage(workflow, "failed", allRuns),
    );
  }
  if (failedRuns.length > 1) {
    const ids = failedRuns.map((r) => r.id).join("\n  ");
    throw new UserError(
      `Multiple failed runs found for workflow "${workflow.name}":\n  ${ids}\n` +
        `Use --run <run-id> to specify which run to resume with --from.`,
    );
  }

  planFailedRunResume(
    workflow,
    failedRuns[0],
    options.fromStep !== undefined
      ? { step: options.fromStep, job: options.fromJob }
      : undefined,
  );
  return {
    workflowName: workflow.name,
    workflowId: workflow.id,
    workflow,
    run: failedRuns[0],
  };
}

function deadOwnerNextAction(workflowName: string, runId: string): string {
  return ` Recover it with 'swamp workflow recover ${workflowName} --run ${runId}', then resume it.`;
}

function noRunsInStateMessage(
  workflow: Workflow,
  expectedStatus: string,
  allRuns: readonly WorkflowRun[],
  ownerIsDead?: (run: WorkflowRun) => boolean,
): string {
  const workflowName = workflow.name;
  const base = `No ${expectedStatus} runs found for workflow "${workflowName}"`;
  if (allRuns.length === 0) {
    return `${base}. No runs exist — run the workflow first with 'swamp workflow run ${workflowName}'.`;
  }
  const latest = allRuns[0];
  if (latest.status === "running" && ownerIsDead?.(latest)) {
    return `${base}. The latest run (${latest.id}) is recorded as running, but its owning process is gone.` +
      deadOwnerNextAction(workflowName, latest.id);
  }
  const suggestion = nextActionForStatus(
    latest.status,
    workflowName,
    latest.id,
    {
      nestedWait: latest.findNestedWaits().length > 0,
      ...rejectedGateOf(workflow, latest),
    },
  );
  // a failed run's hint already names the run id; leaving it out keeps the
  // message within serve's 512-character error limit
  const id = latest.status === "failed" ? "" : ` (${latest.id})`;
  return `${base}. The latest run is ${latest.status}${id}.${suggestion}`;
}

function rejectedGateOf(
  workflow: Workflow,
  run: WorkflowRun,
): { rejectedStep?: string; rejectedJob?: string } {
  const rejected = run.failedSteps().find((s) => s.approvalRejected);
  if (!rejected) return {};
  const rejectedStep = entryTemplateOf(rejected);
  const rejectedJob = fromJobFor(
    workflow,
    run,
    rejected.jobName,
    rejectedStep,
  );
  return rejectedJob !== undefined
    ? { rejectedStep, rejectedJob }
    : { rejectedStep };
}

/**
 * a failed run with a rejected step is retried from that gate, since a plain
 * retry never re-opens it; rejectedJob is named when the step name is used in
 * more than one job
 */
export function nextActionForStatus(
  status: string,
  workflowName: string,
  runId: string,
  options: {
    nestedWait?: boolean;
    rejectedStep?: string;
    rejectedJob?: string;
  } = {},
): string {
  if (status === "suspended" && options.nestedWait) {
    // a run waiting on a nested run has no gate of its own to approve
    return ` It waits on a nested workflow run: finish that run, then resume this one with 'swamp workflow resume ${workflowName} --run ${runId}'.`;
  }
  switch (status) {
    case "running":
      return ` Wait for it to complete, or check progress with 'swamp workflow history ${workflowName}'.`;
    case "succeeded":
      return ` The workflow has already completed — inspect results with 'swamp workflow history ${workflowName}'.`;
    case "failed":
      // a full command, since approve, reject and auto-resume show this too
      if (options.rejectedStep !== undefined) {
        const job = options.rejectedJob !== undefined
          ? ` --job ${quoteShellWord(options.rejectedJob)}`
          : "";
        return ` Ask again with 'swamp workflow resume ${workflowName} --run ${runId} --from ${
          quoteShellWord(options.rejectedStep)
        }${job}'.`;
      }
      return ` Retry it with 'swamp workflow resume ${workflowName} --run ${runId}'.`;
    case "suspended":
      return ` Approve or resume the suspended run with 'swamp workflow approve ${workflowName}'.`;
    case "interrupted":
      return ` Recover the interrupted run with 'swamp workflow recover ${workflowName}'.`;
    default:
      return ` Check the run status with 'swamp workflow history ${workflowName}'.`;
  }
}
