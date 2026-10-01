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

import {
  NestedRunLink,
  type NestedRunLinkDeps,
} from "../../domain/workflows/nested_run_link.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";

/**
 * A nested workflow run its parent stopped waiting on when the parent ended
 * (swamp-club#2736). The child was left suspended; cancelling it is a
 * separate step.
 */
export interface DetachedNestedRunData {
  workflowId: string;
  workflowName: string;
  runId: string;
  /** The parent step that waited on it. */
  jobName: string;
  stepName: string;
  /** The command that cancels the child (the --server form when serve owns it). */
  cancelCommand: string;
}

/** The parent run still waiting on a nested run that just finished. */
export interface AwaitingParentData {
  workflowId: string;
  workflowName: string;
  runId: string;
  /** The command that resumes the parent. */
  resumeCommand: string;
}

function serverSuffix(run: { instanceId?: string } | null): string {
  return run?.instanceId !== undefined ? " --server <url>" : "";
}

/**
 * The child runs the ended run's nested steps were still waiting on, each
 * with the command that cancels it.
 */
export async function detachedNestedRunsOf(
  deps: Pick<NestedRunLinkDeps, "runRepo">,
  run: WorkflowRun,
): Promise<DetachedNestedRunData[]> {
  const result: DetachedNestedRunData[] = [];
  for (const detached of run.detachedNestedRuns()) {
    const child = await deps.runRepo.findById(
      createWorkflowId(detached.child.workflowId),
      createWorkflowRunId(detached.child.runId),
    ).catch(() => null);
    result.push({
      workflowId: detached.child.workflowId,
      workflowName: detached.child.workflowName,
      runId: detached.child.runId,
      jobName: detached.jobName,
      stepName: detached.stepName,
      cancelCommand:
        `swamp workflow cancel ${detached.child.workflowName} --run ${detached.child.runId}${
          serverSuffix(child)
        }`,
    });
  }
  return result;
}

/**
 * The parent run still waiting on this run, when there is one, with the
 * command that resumes it.
 */
export async function awaitingParentOf(
  deps: NestedRunLinkDeps,
  run: WorkflowRun,
): Promise<AwaitingParentData | undefined> {
  const link = run.parentRun;
  if (link?.kind !== "valid") return undefined;
  if (!(await new NestedRunLink(deps).isAwaitedByParent(run))) {
    return undefined;
  }
  const parent = await deps.runRepo.findById(
    createWorkflowId(link.ref.workflowId),
    createWorkflowRunId(link.ref.runId),
  );
  return {
    workflowId: link.ref.workflowId,
    workflowName: link.ref.workflowName,
    runId: link.ref.runId,
    resumeCommand:
      `swamp workflow resume ${link.ref.workflowName} --run ${link.ref.runId}${
        serverSuffix(parent)
      }`,
  };
}

/**
 * For a step that waits on a nested run rather than a gate of its own, the
 * refusal to approve or reject it, naming the nested run to decide instead.
 */
export function nestedWaitGateMessage(
  run: WorkflowRun,
  stepName: string,
): string | undefined {
  const wait = run.findNestedWaits().find((w) => w.stepName === stepName);
  if (!wait) return undefined;
  if (wait.link.kind !== "valid") {
    return `Step "${stepName}" waits on a nested workflow run, not on an approval of its own.`;
  }
  const { workflowName, runId } = wait.link.ref;
  return `Step "${stepName}" waits on nested run ${runId} of workflow "${workflowName}", not on an approval of its own. ` +
    `Decide the nested run's gate ('swamp workflow approvals' lists it), resume it with 'swamp workflow resume ${workflowName} --run ${runId}', then resume this run.`;
}
