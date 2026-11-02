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

/**
 * a signal settles a wait by creating its outcome and never changes the run
 * record, so the run record alone cannot say its waits are settled
 */

import type { SignalWaitStore } from "./signal_wait_store.ts";
import type { WorkflowRun } from "./workflow_run.ts";

export type ContinuationBlock =
  | "not_suspended"
  | "steps_running"
  | "gate_undecided"
  | "nested_run"
  | "wait_unsettled"
  | "wait_unreadable"
  /**
   * only a run being saved as ended cancels its waits, so a suspended record
   * with one is a stale copy or a failed ending save: neither is continued
   */
  | "run_ended";

export type ContinuationVerdict =
  | { readonly kind: "resumable" }
  | { readonly kind: "blocked"; readonly reason: ContinuationBlock };

const RESUMABLE: ContinuationVerdict = { kind: "resumable" };

function blocked(reason: ContinuationBlock): ContinuationVerdict {
  return { kind: "blocked", reason };
}

export async function decideContinuation(
  run: WorkflowRun,
  outcomes: Pick<SignalWaitStore, "findOutcome">,
): Promise<ContinuationVerdict> {
  if (run.status !== "suspended") return blocked("not_suspended");
  if (run.jobs.some((j) => j.steps.some((s) => s.status === "running"))) {
    return blocked("steps_running");
  }
  if (run.findWaitingApprovalStep() !== undefined) {
    return blocked("gate_undecided");
  }
  if (run.findNestedWaits().length > 0) return blocked("nested_run");
  for (const ref of run.findSignalWaits()) {
    if (!ref.wait) return blocked("wait_unreadable");
    const outcome = await outcomes.findOutcome(ref.wait.id);
    if (outcome.kind === "absent") return blocked("wait_unsettled");
    if (outcome.kind === "unreadable") return blocked("wait_unreadable");
    if (outcome.record.kind === "cancelled") return blocked("run_ended");
  }
  return RESUMABLE;
}
