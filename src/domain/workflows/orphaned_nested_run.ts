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

import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import { UserError } from "../errors.ts";
import { quoteShellWord } from "../shell_word.ts";
import {
  cancelAndSettle,
  type EvaluatedWorkflowLookup,
  resolveSettlementWorkflow,
} from "./abort_settlement.ts";
import type { RunRecordCurrency } from "./continuation_claim.ts";
import {
  type AncestorRunRef,
  isOrphaned,
  NestedRunLink,
  type NestedRunLinkDeps,
} from "./nested_run_link.ts";
import type { WorkflowRunRepository } from "./repositories.ts";
import type { Workflow } from "./workflow.ts";
import { createWorkflowId } from "./workflow_id.ts";
import type { WorkflowRun } from "./workflow_run.ts";

/** What {@link settleOrphanedNestedRun} reads, and the one run it writes. */
export interface OrphanedNestedRunDeps
  extends Pick<NestedRunLinkDeps, "workflowRepo" | "signalWaits"> {
  runRepo: Pick<WorkflowRunRepository, "findById" | "save">;
  /** The run's own evaluated snapshot, which it is settled against. */
  findEvaluatedWorkflow?: EvaluatedWorkflowLookup;
  runTracker?: Pick<RunTrackerRepository, "complete">;
  /**
   * Compares this host's record of a run with the datastore's. With it, a
   * parent that still reads as waiting is confirmed there, so a parent a
   * peer already ended is not taken for one that waits.
   */
  runRecordCurrency?: RunRecordCurrency;
  /**
   * Fetches the record of a run above that this host does not have, before
   * it is taken for missing. Called only for a record that reads as absent.
   */
  fetchMissing?: (
    run: { workflowId: string; runId: string },
  ) => Promise<void>;
}

/**
 * Why a nested run was not continued (swamp-club#2867):
 *
 * - `orphaned`: a run above it ended, or its step moved on to another child.
 *   The run was cancelled.
 * - `unreadable`: a run above it could not be read. Nothing was written.
 * - `stale`: this host's record of a run above it is not the datastore's.
 *   Nothing was written; the same command can be tried again.
 */
export interface OrphanedNestedRunRefusal {
  readonly kind: "orphaned" | "unreadable" | "stale";
  readonly message: string;
  /** The refusal without naming the run above. */
  readonly genericMessage: string;
  /** The run above that decided, when one was named. */
  readonly parent?: AncestorRunRef;
}

/** A resume refused by {@link settleOrphanedNestedRun}. */
export class OrphanedNestedRunError extends UserError {
  constructor(readonly refusal: OrphanedNestedRunRefusal) {
    super(refusal.message);
    this.name = "OrphanedNestedRunError";
  }

  /** The refusal without naming the run above. */
  get genericMessage(): string {
    return this.refusal.genericMessage;
  }
}

/** The cancel reason recorded on a nested run cancelled with its parent. */
export function parentEndedCancelReason(parent: AncestorRunRef): string {
  return `Parent run ${parent.runId} of workflow "${parent.workflowName}" ended`;
}

/**
 * Stops a nested run from continuing once nothing waits on it
 * (swamp-club#2867). Returns undefined for a run that may continue: one
 * with no parent, or one every run above still waits on.
 *
 * An orphaned run that has not finished is cancelled and saved here: the run
 * writes its own record, never another run's. The caller holds the run's
 * claim, so nothing saves between its read and this save.
 */
export async function settleOrphanedNestedRun(
  deps: OrphanedNestedRunDeps,
  run: WorkflowRun,
  workflow: Workflow | undefined,
): Promise<OrphanedNestedRunRefusal | undefined> {
  // Only a suspended run is continued by what calls this: a failed run's
  // retry is a use of its own, an interrupted run is recovered to suspended
  // first, and a running run has an owner that settles it.
  if (run.status !== "suspended") return undefined;
  const fetchMissing = deps.fetchMissing;
  const verdict = await new NestedRunLink({
    ...deps,
    runRepo: fetchMissing
      ? {
        findById: async (workflowId, runId) => {
          const found = await deps.runRepo.findById(workflowId, runId);
          if (found) return found;
          await fetchMissing({ workflowId, runId });
          return await deps.runRepo.findById(workflowId, runId);
        },
      }
      : deps.runRepo,
  }).parentVerdict(run);
  if (verdict.kind === "none") return undefined;

  const self = `Nested run ${run.id} of workflow "${run.workflowName}"`;
  if (verdict.kind === "unreadable") {
    const cancelCommand = `swamp workflow cancel ${
      quoteShellWord(run.workflowName)
    } --run ${run.id}${run.instanceId !== undefined ? " --server <url>" : ""}`;
    return {
      kind: "unreadable",
      message:
        `${self} was not continued: ${verdict.reason}, so whether it is still waited on is unknown. ` +
        `Cancel it with '${cancelCommand}', or restore the parent run's record.`,
      genericMessage:
        `${self} was not continued: the run that started it could not be read. ` +
        `Cancel it with '${cancelCommand}'.`,
      parent: verdict.parent,
    };
  }

  if (verdict.kind === "awaited") {
    if (!deps.runRecordCurrency) return undefined;
    for (const ancestor of verdict.ancestors) {
      let current: boolean;
      try {
        current = await deps.runRecordCurrency({
          workflowId: ancestor.workflowId,
          runId: ancestor.runId,
        });
      } catch (error) {
        return {
          kind: "unreadable",
          message:
            `${self} was not continued: parent run ${ancestor.runId} of workflow "${ancestor.workflowName}" could not be read from the datastore (${
              error instanceof Error ? error.message : String(error)
            }). Try again.`,
          genericMessage:
            `${self} was not continued: the run that started it could not be read from the datastore. Try again.`,
          parent: ancestor,
        };
      }
      if (!current) {
        return {
          kind: "stale",
          message:
            `${self} was not continued: this copy of parent run ${ancestor.runId} of workflow "${ancestor.workflowName}" differs from the one in the datastore. ` +
            `Nothing was changed. Try again shortly.`,
          genericMessage:
            `${self} was not continued: this copy of the run that started it differs from the one in the datastore. ` +
            `Nothing was changed. Try again shortly.`,
          parent: ancestor,
        };
      }
    }
    return undefined;
  }

  if (!isOrphaned(verdict)) return undefined;
  const parent = verdict.parent;
  const why = verdict.kind === "ended"
    ? `parent run ${parent.runId} of workflow "${parent.workflowName}" ended (${verdict.status})`
    : `parent run ${parent.runId} of workflow "${parent.workflowName}" started another run for the step`;
  const genericWhy = verdict.kind === "ended"
    ? "the run that started it ended"
    : "the run that started it started another run for the step";

  // The cancel is written from this host's copy of the run. A copy behind
  // the datastore's may show a suspension a peer already finished, and the
  // save would replace that outcome.
  if (deps.runRecordCurrency) {
    let current: boolean;
    try {
      current = await deps.runRecordCurrency({
        workflowId: run.workflowId,
        runId: run.id,
      });
    } catch (error) {
      const failed =
        `${self} was not continued: ${why}, and the run could not be read from the datastore`;
      return {
        kind: "unreadable",
        message: `${failed} (${
          error instanceof Error ? error.message : String(error)
        }). Nothing was changed. Try again.`,
        genericMessage:
          `${self} was not continued: ${genericWhy}, and the run could not be read from the datastore. Nothing was changed. Try again.`,
        parent,
      };
    }
    if (!current) {
      return {
        kind: "stale",
        message:
          `${self} was not continued: ${why}, and this copy of the run differs from the one in the datastore. Nothing was changed. Try again shortly.`,
        genericMessage:
          `${self} was not continued: ${genericWhy}, and this copy of the run differs from the one in the datastore. Nothing was changed. Try again shortly.`,
        parent,
      };
    }
  }

  cancelAndSettle(
    run,
    deps.findEvaluatedWorkflow
      ? await resolveSettlementWorkflow(
        run,
        workflow,
        deps.findEvaluatedWorkflow,
      )
      : workflow,
    parentEndedCancelReason(parent),
  );
  await deps.runRepo.save(createWorkflowId(run.workflowId), run);
  deps.runTracker?.complete(
    run.id,
    "cancelled",
    parentEndedCancelReason(parent),
  );
  return {
    kind: "orphaned",
    message: `${self} was not continued: ${why}. It was cancelled.`,
    genericMessage:
      `${self} was not continued: ${genericWhy}. It was cancelled.`,
    parent,
  };
}
