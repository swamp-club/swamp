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
 * How the records of signal waits follow their runs (swamp-club#3093).
 *
 * A step is settled only from its wait's stored outcome. A registration is
 * removed when its run ends. An outcome lives as long as its run record, so
 * a late retry of a signal is answered from it, and is removed with the run.
 */

import type { StepRun, WorkflowRun } from "./workflow_run.ts";
import {
  cancelledOutcome,
  isWaitExpired,
  type StoredWaitRecord,
  timedOutOutcome,
  type WaitOutcome,
  type WaitRef,
  type WaitRegistration,
} from "./signal_wait_records.ts";
import type { SignalWaitStore } from "./signal_wait_store.ts";

/**
 * How long after its deadline a record is kept when its run is confirmed
 * absent. Age alone never proves absence from a shared datastore: an
 * accepted outcome may still be needed by a run this host has not synced.
 */
export const ORPHAN_WAIT_RECORD_GRACE_MS = 24 * 60 * 60 * 1000;

/** True for a run status nothing continues from without a new attempt. */
export function isEndedRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" ||
    status === "cancelled";
}

/** The wait `step` of `run` holds, as the facts an outcome is built from. */
export function waitRefOf(
  run: WorkflowRun,
  step: StepRun,
): WaitRef | undefined {
  const wait = step.signalWait;
  if (!wait) return undefined;
  return {
    waitId: wait.id,
    workflowId: run.workflowId,
    runId: run.id,
    deadline: wait.deadline.toISOString(),
  };
}

/**
 * The outcome of a wait, settling it as timed out first when it has none
 * and its deadline has passed. A deadline is enforced here, lazily, by
 * whoever looks: the create decides between this timeout and a signal that
 * arrives at the same moment.
 */
export async function outcomeAt(
  store: SignalWaitStore,
  ref: WaitRef,
  now: Date,
): Promise<StoredWaitRecord<WaitOutcome>> {
  const stored = belongsTo(ref, await store.findOutcome(ref.waitId));
  if (stored.kind !== "absent" || !isWaitExpired(ref, now)) return stored;
  return belongsTo(ref, await store.settle(timedOutOutcome(ref, now)));
}

/** An outcome that names another run is not this wait's outcome. */
function belongsTo(
  ref: WaitRef,
  stored: StoredWaitRecord<WaitOutcome>,
): StoredWaitRecord<WaitOutcome> {
  return stored.kind === "found" && stored.record.runId !== ref.runId
    ? { kind: "unreadable" }
    : stored;
}

/**
 * Makes `registration` the wait's registration unless a readable one is
 * stored already, and returns the one that holds. A stored registration
 * that cannot be read is replaced: the caller built this one from the run
 * record, which still holds the whole wait, so a damaged file does not
 * leave a wait nothing can signal.
 */
export async function ensureRegistered(
  store: SignalWaitStore,
  registration: WaitRegistration,
): Promise<WaitRegistration> {
  const stored = await store.findRegistration(registration.waitId);
  if (stored.kind === "found") return stored.record;
  if (stored.kind === "unreadable") {
    await store.removeRegistration(registration.waitId);
  }
  await store.register(registration);
  const now = await store.findRegistration(registration.waitId);
  return now.kind === "found" ? now.record : registration;
}

/**
 * The registration a step of a run already made, if any. A process that
 * died after registering a wait and before saving its run leaves one behind;
 * the step that runs again takes that wait over instead of opening another,
 * so a signal accepted for it in between is applied, not lost.
 */
export async function findRegistrationOfStep(
  store: SignalWaitStore,
  at: { runId: string; jobName: string; stepName: string },
): Promise<WaitRegistration | undefined> {
  for (const registration of await store.listRegistrations()) {
    if (
      registration.runId === at.runId &&
      registration.jobName === at.jobName &&
      registration.stepName === at.stepName
    ) return registration;
  }
  return undefined;
}

/** A step of a run still waiting on a wait nothing has settled. */
export interface OpenWaitRef {
  jobName: string;
  stepName: string;
  wait: { id: string };
}

/**
 * The first wait of `run` that nothing has settled and whose deadline has
 * not passed. Reads only: for telling a caller what a run still waits on.
 */
export async function findUnsettledWait(
  store: SignalWaitStore,
  run: WorkflowRun,
  now: Date,
): Promise<OpenWaitRef | undefined> {
  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (!step.isSignalWait) continue;
      const ref = waitRefOf(run, step);
      if (!ref || isWaitExpired(ref, now)) continue;
      if ((await store.findOutcome(ref.waitId)).kind === "absent") {
        return {
          jobName: job.jobName,
          stepName: step.stepName,
          wait: { id: ref.waitId },
        };
      }
    }
  }
  return undefined;
}

/**
 * Applies the accepted signals of a suspended run's waits to their steps,
 * and returns the first wait that is still open, if any. Called by a resume
 * under the run's claim, the only place a wait changes the run record.
 *
 * A wait that timed out, was cancelled or cannot be read is left waiting:
 * the walk fails its step when it re-enters it (see
 * {@link settleReenteredWait}), so `failed` handlers and `allowFailure`
 * apply as for any other failed step.
 */
export async function applyAcceptedSignals(
  store: SignalWaitStore,
  run: WorkflowRun,
  now: Date,
): Promise<OpenWaitRef | undefined> {
  let open: OpenWaitRef | undefined;
  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (!step.isSignalWait) continue;
      const ref = waitRefOf(run, step);
      if (!ref) continue;
      const stored = await outcomeAt(store, ref, now);
      if (stored.kind === "absent") {
        open ??= {
          jobName: job.jobName,
          stepName: step.stepName,
          wait: { id: ref.waitId },
        };
      } else if (
        stored.kind === "found" && stored.record.kind === "accepted"
      ) {
        step.applyWaitOutcome(stored.record);
      }
    }
  }
  return open;
}

/**
 * Settles a waiting step the walk re-entered: `failed` when its wait timed
 * out, was cancelled, or holds an outcome that cannot be read or applied;
 * `open` when nothing has settled the wait yet, or a signal has and the
 * next resume applies it.
 */
export async function settleReenteredWait(
  store: SignalWaitStore,
  run: WorkflowRun,
  step: StepRun,
  now: Date,
): Promise<"open" | "failed"> {
  if (step.failUnreadableWait()) return "failed";
  const ref = waitRefOf(run, step);
  if (!ref) return "open";
  const stored = await outcomeAt(store, ref, now);
  if (stored.kind === "absent") return "open";
  if (stored.kind === "unreadable") {
    step.failUnusableOutcome();
    return "failed";
  }
  if (stored.record.kind === "accepted") {
    // Applied by a resume's takeover; one that cannot be applied never
    // will be, so the step fails instead of waiting for good.
    if (step.canApplyWaitOutcome(stored.record)) return "open";
    step.failUnusableOutcome();
    return "failed";
  }
  step.applyWaitOutcome(stored.record);
  return "failed";
}

/**
 * Closes the wait `step` holds before the step leaves it: a wait nothing
 * settled is settled as cancelled, so a signal for it is answered closed,
 * and its registration is removed. The outcome is kept.
 */
export async function closeStepWait(
  store: SignalWaitStore,
  run: WorkflowRun,
  step: StepRun,
  now: Date,
): Promise<void> {
  const ref = waitRefOf(run, step);
  if (!ref) return;
  // A wait with no registration was closed already, or never registered.
  // An ended run is saved more than once, and each save comes here, so
  // this costs one read where there is nothing left to do.
  if ((await store.findRegistration(ref.waitId)).kind === "absent") return;
  if (!step.signalWait?.receipt) {
    await store.settle(cancelledOutcome(ref, now));
  }
  await store.removeRegistration(ref.waitId);
}

/**
 * Closes every wait a run holds, for a run that has ended or is about to be
 * saved as ended. Called before that save, so no signal is accepted for a
 * wait of a run already recorded as over.
 */
export async function closeRunWaits(
  store: SignalWaitStore,
  run: WorkflowRun,
  now: Date,
): Promise<void> {
  for (const job of run.jobs) {
    for (const step of job.steps) {
      await closeStepWait(store, run, step, now);
    }
  }
}

/**
 * What a run repository does before it writes a run: a run about to be
 * saved as ended closes its waits. One hook covers every writer that ends
 * a run (cancel, reject, supersede, abort, the executor), none of which has
 * to remember it.
 */
export function closeWaitsOfEndedRun(
  store: SignalWaitStore,
  now: () => Date = () => new Date(),
): (run: WorkflowRun) => Promise<void> {
  return async (run) => {
    if (isEndedRunStatus(run.status)) await closeRunWaits(store, run, now());
  };
}

/** The ids of the waits the steps of `runs` hold or held. */
export function waitIdsOf(runs: Iterable<WorkflowRun>): string[] {
  const ids: string[] = [];
  for (const run of runs) {
    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.signalWait) ids.push(step.signalWait.id);
      }
    }
  }
  return ids;
}

/** Removes the registration and the outcome of each wait. */
export async function removeWaitRecords(
  store: SignalWaitStore,
  waitIds: Iterable<string>,
): Promise<void> {
  for (const waitId of waitIds) {
    await store.removeRegistration(waitId);
    await store.removeOutcome(waitId);
  }
}

/**
 * Removes the wait records of runs that were deleted, by run id. Returns
 * how many waits had a record removed.
 */
export async function removeWaitRecordsOfRuns(
  store: SignalWaitStore,
  runIds: ReadonlySet<string>,
): Promise<number> {
  if (runIds.size === 0) return 0;
  const waitIds = new Set<string>();
  for (const registration of await store.listRegistrations()) {
    if (runIds.has(registration.runId)) waitIds.add(registration.waitId);
  }
  for (const outcome of await store.listOutcomes()) {
    if (runIds.has(outcome.runId)) waitIds.add(outcome.waitId);
  }
  await removeWaitRecords(store, waitIds);
  return waitIds.size;
}

/**
 * True when the run record here says the run ended after the wait was
 * registered. A failed run can be retried under the same id, and a run
 * record reaches another host later than its wait records do, so a record
 * here that says ended may predate a retry whose new wait is already
 * registered. Such a wait is live and must not be closed.
 */
function endedAfterRegistering(
  run: WorkflowRun,
  registration: WaitRegistration,
): boolean {
  if (!isEndedRunStatus(run.status) || !run.completedAt) return false;
  return new Date(registration.registeredAt).getTime() <=
    run.completedAt.getTime();
}

/** What a sweep removed. */
export interface WaitRecordSweep {
  registrations: number;
  outcomes: number;
}

/**
 * The safety net for wait records nothing else removed. A registration
 * whose run has ended is closed. A registration or an outcome whose run
 * cannot be found is removed only when the lookup is authoritative and
 * the wait's deadline plus {@link ORPHAN_WAIT_RECORD_GRACE_MS} has passed.
 * Without that authority, missing runs' records are kept regardless of
 * age. An outcome whose run exists is never
 * removed here: it lives as long as the run.
 */
export async function sweepWaitRecords(
  store: SignalWaitStore,
  findRun: (
    workflowId: string,
    runId: string,
  ) => Promise<WorkflowRun | null>,
  now: Date,
  options: { localRunAbsenceIsAuthoritative?: boolean } = {},
): Promise<WaitRecordSweep> {
  const swept: WaitRecordSweep = { registrations: 0, outcomes: 0 };
  const orphaned = (ref: { deadline: string }) =>
    now.getTime() >
      new Date(ref.deadline).getTime() + ORPHAN_WAIT_RECORD_GRACE_MS;

  for (const registration of await store.listRegistrations()) {
    const run = await findRun(registration.workflowId, registration.runId);
    if (run && endedAfterRegistering(run, registration)) {
      const outcome = await store.findOutcome(registration.waitId);
      if (outcome.kind === "absent") {
        await store.settle(cancelledOutcome(registration, now));
      }
      await store.removeRegistration(registration.waitId);
      swept.registrations++;
    } else if (
      !run && options.localRunAbsenceIsAuthoritative && orphaned(registration)
    ) {
      await store.removeRegistration(registration.waitId);
      swept.registrations++;
    }
  }
  if (!options.localRunAbsenceIsAuthoritative) return swept;
  for (const outcome of await store.listOutcomes()) {
    if (!orphaned(outcome)) continue;
    if (await findRun(outcome.workflowId, outcome.runId)) continue;
    await store.removeOutcome(outcome.waitId);
    swept.outcomes++;
  }
  return swept;
}
