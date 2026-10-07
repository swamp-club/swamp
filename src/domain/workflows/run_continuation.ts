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
 * Whether a suspended run can continue without anyone deciding anything
 * more (swamp-club#3108).
 *
 * A signal settles a wait by creating its outcome record and never changes
 * the run record, so the run record alone cannot say that a run's waits are
 * settled: {@link WorkflowRun.isAwaitingResume} stays false while any wait is
 * on it. The answer needs the run record and the outcome records together,
 * which is why it lives here and not on the run.
 */

import type { SignalWaitStore } from "./signal_wait_store.ts";
import type { WorkflowRun } from "./workflow_run.ts";

/** Why a run cannot continue yet. */
export type ContinuationBlock =
  /** The run is not suspended. */
  | "not_suspended"
  /** Saved suspended while other steps still ran: something still drives it. */
  | "steps_running"
  /** A manual approval gate is still undecided. */
  | "gate_undecided"
  /** A step waits on a nested run. Such a run is never continued here. */
  | "nested_run"
  /** A wait for a signal has no outcome. */
  | "wait_unsettled"
  /** A wait, or its outcome, cannot be read. */
  | "wait_unreadable";

export type ContinuationVerdict =
  | { readonly kind: "resumable" }
  | { readonly kind: "blocked"; readonly reason: ContinuationBlock };

const RESUMABLE: ContinuationVerdict = { kind: "resumable" };

function blocked(reason: ContinuationBlock): ContinuationVerdict {
  return { kind: "blocked", reason };
}

/**
 * Decides whether `run` can be resumed as it stands: suspended, with no step
 * still running, no gate undecided, no step waiting on a nested run, and an
 * outcome of any kind (a signal, a timeout or a cancel) for every wait for a
 * signal. Read from the run record as given; the caller answers for how
 * current that record is.
 */
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
  }
  return RESUMABLE;
}
