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

import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import {
  cancelAndSettle,
  type EvaluatedWorkflowLookup,
  resolveSettlementWorkflow,
} from "../../domain/workflows/abort_settlement.ts";
import type { RunRecordCurrency } from "../../domain/workflows/continuation_claim.ts";
import {
  isFinishedRun,
  NestedRunLink,
} from "../../domain/workflows/nested_run_link.ts";
import { MAX_WORKFLOW_NESTING_DEPTH } from "../../domain/workflows/nested_run_ref.ts";
import {
  type OwnerLiveness,
  suspendedRunOwnerStillRuns,
} from "../../domain/workflows/orphaned_run_reaper.ts";
import { parentEndedCancelReason } from "../../domain/workflows/orphaned_nested_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import type { WorkflowRunClaims } from "../../domain/workflows/run_claim.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type {
  DetachedNestedRunRef,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import {
  detachedCancelCommand,
  type DetachedNestedRunData,
  detachedNestedRunsOf,
} from "./nested_runs.ts";

/** A nested run the cascade cancelled, or asked to stop. */
export interface CascadedNestedRunData {
  workflowId: string;
  workflowName: string;
  runId: string;
  /** The parent step that waited on it. */
  jobName: string;
  stepName: string;
}

/**
 * What became of the nested runs an ended run waited on (swamp-club#2867):
 * the ones cancelled with it, the running ones asked to stop, and the ones
 * left unfinished, each with the command that cancels it.
 */
export interface NestedCascadeResult {
  cancelledNestedRuns: CascadedNestedRunData[];
  stopRequestedNestedRuns: CascadedNestedRunData[];
  detachedNestedRuns: DetachedNestedRunData[];
}

/**
 * Cancels the nested runs an ended run waited on. Injected into the
 * operations that end a run, so a caller that must not write other runs
 * where it stands leaves it out.
 */
export type NestedCascade = (
  endedParent: WorkflowRun,
) => Promise<NestedCascadeResult>;

export interface NestedCascadeDeps {
  workflowRepo: Pick<WorkflowRepository, "findById">;
  runRepo: Pick<WorkflowRunRepository, "findById" | "save">;
  /** Claims each child while it is cancelled. */
  runClaims: WorkflowRunClaims;
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
  /**
   * With `liveness`, where a child's owner is looked up. A suspended run can
   * still have steps running under the process that suspended it, and only
   * its tracker row shows that: the record's status and pid do not.
   */
  runTracker?: RunTrackerRepository;
  liveness?: OwnerLiveness;
  /**
   * Whether this caller may settle the child. The local CLI leaves a run a
   * serve instance owns to that instance. Defaults to every run.
   */
  maySettle?: (child: WorkflowRun) => boolean;
  /**
   * Compares this host's record of a child with the datastore's. A child
   * whose record is behind may have been approved by a peer, so it is left.
   */
  runRecordCurrency?: RunRecordCurrency;
  /**
   * Fetches the record of a child this host does not have, before the child
   * is read.
   */
  fetchMissing?: (
    run: { workflowId: string; runId: string },
  ) => Promise<void>;
  /**
   * Keeps a resume off the child while it is cancelled. Returns the release,
   * or null when the child is already being driven or decided.
   */
  reserveChild?: (runId: string) => (() => void) | null;
  /**
   * Asks the process driving a running child to stop it, without waiting.
   * Returns false when nothing here drives the child.
   */
  requestStop?: (child: WorkflowRun, reason: string) => boolean;
}

/** A cascade result with nothing in it, to merge others into. */
export function emptyNestedCascade(): NestedCascadeResult {
  return {
    cancelledNestedRuns: [],
    stopRequestedNestedRuns: [],
    detachedNestedRuns: [],
  };
}

/** Appends every list of `from` to the same list of `into`. */
export function mergeNestedCascade(
  into: NestedCascadeResult,
  from: NestedCascadeResult,
): void {
  for (const run of from.cancelledNestedRuns) {
    into.cancelledNestedRuns.push(run);
  }
  for (const run of from.stopRequestedNestedRuns) {
    into.stopRequestedNestedRuns.push(run);
  }
  for (const run of from.detachedNestedRuns) into.detachedNestedRuns.push(run);
}

function cascaded(detached: DetachedNestedRunRef): CascadedNestedRunData {
  return {
    workflowId: detached.child.workflowId,
    workflowName: detached.child.workflowName,
    runId: detached.child.runId,
    jobName: detached.jobName,
    stepName: detached.stepName,
  };
}

function left(
  detached: DetachedNestedRunRef,
  child: WorkflowRun | undefined,
): DetachedNestedRunData {
  return {
    ...cascaded(detached),
    cancelCommand: detachedCancelCommand(detached, child),
  };
}

/**
 * Builds the cascade over `deps`. It follows only a link both runs agree on
 * (the parent's step names the child and the child names that step), settles
 * a suspended child under the child's own claim, and recurses into the runs
 * that child waited on. A child it cannot or may not settle is left as it
 * was and reported; one child's failure never stops the rest, and nothing
 * here changes the ended parent.
 */
export function createNestedCascade(deps: NestedCascadeDeps): NestedCascade {
  const link = new NestedRunLink(deps);

  const ownerStillRuns = (child: WorkflowRun): boolean =>
    deps.runTracker !== undefined && deps.liveness !== undefined &&
    suspendedRunOwnerStillRuns(child, deps.runTracker, deps.liveness);

  /** Cancels the child as read now, under its claim. Null when left. */
  const settle = async (
    parent: WorkflowRun,
    detached: DetachedNestedRunRef,
  ): Promise<WorkflowRun | null> => {
    const release = deps.reserveChild
      ? deps.reserveChild(detached.child.runId)
      : () => {};
    if (!release) return null;
    try {
      return await deps.runClaims.withClaim(detached.child.runId, async () => {
        const resolved = await link.resolveChild(parent, {
          jobName: detached.jobName,
          stepName: detached.stepName,
          link: { kind: "valid", ref: detached.child },
        });
        if (resolved.kind !== "resolved") return null;
        const current = resolved.child;
        if (current.status !== "suspended" || ownerStillRuns(current)) {
          return null;
        }
        if (
          deps.runRecordCurrency &&
          !(await deps.runRecordCurrency({
            workflowId: current.workflowId,
            runId: current.id,
          }))
        ) {
          return null;
        }
        const workflowId = createWorkflowId(current.workflowId);
        const workflow = await deps.workflowRepo.findById(workflowId);
        const reason = parentEndedCancelReason({
          workflowId: parent.workflowId,
          workflowName: parent.workflowName,
          runId: parent.id,
        });
        cancelAndSettle(
          current,
          await resolveSettlementWorkflow(
            current,
            workflow ?? undefined,
            deps.findEvaluatedWorkflow,
          ),
          reason,
        );
        await deps.runRepo.save(workflowId, current);
        deps.runTracker?.complete(current.id, "cancelled", reason);
        return current;
      });
    } finally {
      release();
    }
  };

  const cascade = async (
    parent: WorkflowRun,
    depth: number,
  ): Promise<NestedCascadeResult> => {
    const result = emptyNestedCascade();
    for (const detached of parent.detachedNestedRuns()) {
      let child: WorkflowRun | undefined;
      try {
        await deps.fetchMissing?.({
          workflowId: detached.child.workflowId,
          runId: detached.child.runId,
        });
        const resolved = await link.resolveChild(parent, {
          jobName: detached.jobName,
          stepName: detached.stepName,
          link: { kind: "valid", ref: detached.child },
        });
        // A child that no longer exists needs no cancel.
        if (resolved.kind === "missing") continue;
        // A run that does not link back is not this parent's to cancel. It
        // is reported while unfinished, as it was before the cascade.
        if (resolved.kind === "broken") {
          const other = await deps.runRepo.findById(
            createWorkflowId(detached.child.workflowId),
            createWorkflowRunId(detached.child.runId),
          );
          if (other && !isFinishedRun(other)) {
            result.detachedNestedRuns.push(left(detached, other));
          }
          continue;
        }
        child = resolved.child;
        if (isFinishedRun(child)) continue;

        if (deps.maySettle && !deps.maySettle(child)) {
          result.detachedNestedRuns.push(left(detached, child));
          continue;
        }
        if (child.status === "running" || child.status === "pending") {
          const reason = parentEndedCancelReason({
            workflowId: parent.workflowId,
            workflowName: parent.workflowName,
            runId: parent.id,
          });
          if (deps.requestStop?.(child, reason)) {
            result.stopRequestedNestedRuns.push(cascaded(detached));
          } else {
            result.detachedNestedRuns.push(left(detached, child));
          }
          continue;
        }
        if (child.status !== "suspended" || ownerStillRuns(child)) {
          result.detachedNestedRuns.push(left(detached, child));
          continue;
        }

        const settled = await settle(parent, detached);
        if (!settled) {
          result.detachedNestedRuns.push(left(detached, child));
          continue;
        }
        result.cancelledNestedRuns.push(cascaded(detached));
        if (depth < MAX_WORKFLOW_NESTING_DEPTH) {
          mergeNestedCascade(result, await cascade(settled, depth + 1));
        }
      } catch {
        // Unreadable, or a save that failed: it may still be unfinished.
        result.detachedNestedRuns.push(left(detached, child));
      }
    }
    return result;
  };

  return (endedParent) => cascade(endedParent, 1);
}

/**
 * The nested runs an ended run waited on, after the cascade when one is
 * given, else as they were left.
 */
export async function settleNestedRunsOf(
  deps: { runRepo: Pick<WorkflowRunRepository, "findById"> },
  cascade: NestedCascade | undefined,
  run: WorkflowRun,
): Promise<NestedCascadeResult> {
  if (cascade) return await cascade(run);
  return {
    ...emptyNestedCascade(),
    detachedNestedRuns: await detachedNestedRunsOf(deps, run),
  };
}

/** The non-empty lists of a cascade result, for an event or a JSON body. */
export function nestedCascadeFields(
  result: NestedCascadeResult,
): Partial<NestedCascadeResult> {
  return {
    ...(result.cancelledNestedRuns.length > 0
      ? { cancelledNestedRuns: result.cancelledNestedRuns }
      : {}),
    ...(result.stopRequestedNestedRuns.length > 0
      ? { stopRequestedNestedRuns: result.stopRequestedNestedRuns }
      : {}),
    ...(result.detachedNestedRuns.length > 0
      ? { detachedNestedRuns: result.detachedNestedRuns }
      : {}),
  };
}
