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
  isFinishedRun,
  NestedRunLink,
  type NestedRunLinkDeps,
} from "../../domain/workflows/nested_run_link.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type {
  DetachedNestedRunRef,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import type { OrphanedNestedRunRefusal } from "../../domain/workflows/orphaned_nested_run.ts";
import { type SwampError, validationFailed } from "../errors.ts";

/**
 * A nested workflow run its parent stopped waiting on when the parent ended
 * (swamp-club#2736). The child was left unfinished; cancelling it is a
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

function serverSuffix(
  run: { instanceId?: string } | null | undefined,
): string {
  return run?.instanceId !== undefined ? " --server <url>" : "";
}

/**
 * The child runs the ended run's nested steps were still waiting on and that
 * have not finished, each with the command that cancels it. A child that
 * already finished, or no longer exists, needs no cancel and is left out; one
 * that cannot be read is reported, since it may still be unfinished.
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
    ).catch(() => undefined);
    if (child === null || (child && isFinishedRun(child))) continue;
    result.push({
      workflowId: detached.child.workflowId,
      workflowName: detached.child.workflowName,
      runId: detached.child.runId,
      jobName: detached.jobName,
      stepName: detached.stepName,
      cancelCommand: detachedCancelCommand(detached, child),
    });
  }
  return result;
}

/** The command that cancels a detached nested run. */
export function detachedCancelCommand(
  detached: DetachedNestedRunRef,
  child: { instanceId?: string } | null | undefined,
): string {
  return `swamp workflow cancel ${
    quoteShellWord(detached.child.workflowName)
  } --run ${detached.child.runId}${serverSuffix(child)}`;
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
    resumeCommand: `swamp workflow resume ${
      quoteShellWord(link.ref.workflowName)
    } --run ${link.ref.runId}${serverSuffix(parent)}`,
  };
}

/**
 * What a refusal to approve or reject a nested workflow step carries in its
 * `details`: the nested run's workflow, and the refusal without naming it, so
 * a server can name the nested run only to a reader of its workflow
 * (swamp-club#2736).
 */
export interface NestedWaitGateDetails {
  nestedWaitGate: {
    workflowId: string;
    workflowName: string;
    genericMessage: string;
  };
}

/**
 * For a step that waits on a nested run rather than a gate of its own, the
 * refusal to approve or reject it, naming the nested run to decide instead.
 */
export function nestedWaitGateError(
  run: WorkflowRun,
  stepName: string,
): SwampError | undefined {
  const wait = run.findNestedWaits().find((w) => w.stepName === stepName);
  if (!wait) return undefined;
  const genericMessage =
    `Step "${stepName}" waits on a nested workflow run, not on an approval of its own.`;
  if (wait.link.kind !== "valid") return validationFailed(genericMessage);
  const { workflowId, workflowName, runId } = wait.link.ref;
  const details: NestedWaitGateDetails = {
    nestedWaitGate: { workflowId, workflowName, genericMessage },
  };
  return validationFailed(
    `Step "${stepName}" waits on nested run ${runId} of workflow "${workflowName}", not on an approval of its own. ` +
      `Decide the nested run's gate ('swamp workflow approvals' lists it), resume it with 'swamp workflow resume ${workflowName} --run ${runId}', then resume this run.`,
    details,
  );
}

/** The nested run a refusal from {@link nestedWaitGateError} names, if any. */
export function nestedWaitGateOf(
  error: SwampError,
): NestedWaitGateDetails["nestedWaitGate"] | undefined {
  const details = error.details as Partial<NestedWaitGateDetails> | undefined;
  return details?.nestedWaitGate;
}

/**
 * What a refusal to continue an orphaned nested run carries in its
 * `details`: the workflow of the run above it, and the refusal without
 * naming that run, so a server can name it only to a reader of its workflow
 * (swamp-club#2867).
 */
export interface OrphanedNestedRunDetails {
  orphanedNestedRun: {
    kind: OrphanedNestedRunRefusal["kind"];
    parentWorkflowId?: string;
    parentWorkflowName?: string;
    genericMessage: string;
  };
}

/** The refusal to approve, reject or resume an orphaned nested run. */
export function orphanedNestedRunError(
  refusal: OrphanedNestedRunRefusal,
): SwampError {
  const details: OrphanedNestedRunDetails = {
    orphanedNestedRun: {
      kind: refusal.kind,
      ...(refusal.parent
        ? {
          parentWorkflowId: refusal.parent.workflowId,
          parentWorkflowName: refusal.parent.workflowName,
        }
        : {}),
      genericMessage: refusal.genericMessage,
    },
  };
  return validationFailed(refusal.message, details);
}

/** What a refusal from {@link orphanedNestedRunError} carries, if any. */
export function orphanedNestedRunOf(
  error: SwampError,
): OrphanedNestedRunDetails["orphanedNestedRun"] | undefined {
  const details = error.details as
    | Partial<OrphanedNestedRunDetails>
    | undefined;
  return details?.orphanedNestedRun;
}
