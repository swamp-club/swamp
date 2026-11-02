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
 * a step is settled only from its wait's stored outcome; an outcome lives as
 * long as its run so a late retry of a signal is answered from it
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
import { settledBy, type SignalWaitStore } from "./signal_wait_store.ts";
import { claimsReadingSlot, releaseKeyClaims } from "./wait_key_claim.ts";
import {
  applicablePendingOutcome,
  earlyWaitRef,
  heldUntil,
  PENDING_SIGNAL_LAPSE_GRACE_MS,
  type PendingAddress,
  type PendingLapse,
  type PendingSignalRecords,
  takePendingSignal,
} from "./pending_signal.ts";

/**
 * age alone never proves absence from a shared datastore: an accepted outcome
 * may still be needed by a run this host has not synced
 */
export const ORPHAN_WAIT_RECORD_GRACE_MS = 24 * 60 * 60 * 1000;

export function isEndedRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" ||
    status === "cancelled";
}

export function waitRefOf(
  run: WorkflowRun,
  step: StepRun,
): WaitRef | undefined {
  const wait = step.signalWait;
  if (!wait) return undefined;
  return {
    waitId: wait.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    runId: run.id,
    deadline: wait.deadline.toISOString(),
    ...(wait.key !== undefined && wait.early !== undefined
      ? { key: wait.key, early: wait.early, schema: wait.schema }
      : {}),
  };
}

/**
 * the deadline is enforced lazily by whoever looks; a wait with acceptEarly is
 * given its key's pending signal first, so a signal received before the
 * deadline is never timed out
 */
export async function outcomeAt(
  store: SignalWaitStore,
  ref: WaitRef,
  now: Date,
): Promise<StoredWaitRecord<WaitOutcome>> {
  const stored = belongsTo(ref, await store.findOutcome(ref.waitId));
  if (stored.kind !== "absent") return stored;
  const early = earlyWaitRef(ref);
  if (early) {
    const taken = belongsTo(ref, await takePendingSignal(store, early));
    if (taken.kind !== "absent") return taken;
  }
  if (!isWaitExpired(ref, now)) return stored;
  return belongsTo(ref, await store.settle(timedOutOutcome(ref, now)));
}

function belongsTo(
  ref: WaitRef,
  stored: StoredWaitRecord<WaitOutcome>,
): StoredWaitRecord<WaitOutcome> {
  return stored.kind === "found" && stored.record.runId !== ref.runId
    ? { kind: "unreadable" }
    : stored;
}

/**
 * an unreadable stored registration is replaced, since the run record still
 * holds the whole wait and a damaged file must not leave a wait nothing can
 * signal
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
 * a process that died after registering and before saving its run leaves one
 * behind; the re-run step takes it over so a signal accepted in between is
 * applied, not lost
 */
export async function findRegistrationOfStep(
  store: SignalWaitStore,
  at: { workflowId: string; runId: string; jobName: string; stepName: string },
): Promise<WaitRegistration | undefined> {
  for (const registration of await store.listRegistrations()) {
    if (
      registration.workflowId === at.workflowId &&
      registration.runId === at.runId &&
      registration.jobName === at.jobName &&
      registration.stepName === at.stepName
    ) return registration;
  }
  return undefined;
}

export interface OpenWaitRef {
  jobName: string;
  stepName: string;
  wait: { id: string; deadline: string; key?: string };
}

function openWaitOf(ref: WaitRef, step: StepRun): OpenWaitRef["wait"] {
  const key = step.signalWait?.key;
  return {
    id: ref.waitId,
    deadline: ref.deadline,
    ...(key !== undefined ? { key } : {}),
  };
}

/**
 * reads only; a wait whose key holds an applicable pending signal is not
 * waiting, since the resume that follows takes it under the run's claim
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
      if ((await store.findOutcome(ref.waitId)).kind !== "absent") continue;
      const early = earlyWaitRef(ref);
      if (early && await applicablePendingOutcome(store, early)) continue;
      return {
        jobName: job.jobName,
        stepName: step.stepName,
        wait: openWaitOf(ref, step),
      };
    }
  }
  return undefined;
}

/**
 * a wait with no readable registration is left alone: its run ended or was
 * deleted, so a suspended copy is behind and an outcome made for it would
 * outlive the run
 */
export async function settleExpiredWaits(
  store: SignalWaitStore,
  run: WorkflowRun,
  now: Date,
): Promise<number> {
  let settled = 0;
  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (!step.isSignalWait) continue;
      const ref = waitRefOf(run, step);
      if (!ref || !isWaitExpired(ref, now)) continue;
      if ((await store.findOutcome(ref.waitId)).kind !== "absent") continue;
      if ((await store.findRegistration(ref.waitId)).kind !== "found") continue;
      // A pending signal received before the deadline is not timed out.
      const early = earlyWaitRef(ref);
      if (early && (await takePendingSignal(store, early)).kind !== "absent") {
        continue;
      }
      const outcome = timedOutOutcome(ref, now);
      if (settledBy(await store.settle(outcome), outcome)) settled++;
    }
  }
  return settled;
}

/**
 * a signaller that stopped between storing its signal and reading the key again
 * leaves a wait open that nothing else would look at before its deadline
 */
export async function takePendingSignalsOfRun(
  store: SignalWaitStore,
  run: WorkflowRun,
): Promise<number> {
  let taken = 0;
  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (!step.isSignalWait) continue;
      const ref = waitRefOf(run, step);
      const early = ref && earlyWaitRef(ref);
      if (!early) continue;
      if ((await store.findOutcome(early.waitId)).kind !== "absent") continue;
      if ((await store.findRegistration(early.waitId)).kind !== "found") {
        continue;
      }
      const stored = await takePendingSignal(store, early);
      if (stored.kind === "found" && stored.record.kind === "accepted") taken++;
    }
  }
  return taken;
}

/**
 * a timed out, cancelled or unreadable wait is left waiting so the walk fails
 * its step on re-entry and failed handlers and allowFailure apply as usual
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
          wait: openWaitOf(ref, step),
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
    // applied by a resume's takeover; an outcome that cannot be applied never
    // will be, so the step fails instead of waiting for good
    if (step.canApplyWaitOutcome(stored.record)) return "open";
    step.failUnusableOutcome();
    return "failed";
  }
  step.applyWaitOutcome(stored.record);
  return "failed";
}

export async function closeStepWait(
  store: SignalWaitStore,
  run: WorkflowRun,
  step: StepRun,
  now: Date,
): Promise<void> {
  const ref = waitRefOf(run, step);
  if (!ref) return;
  // no registration means closed already or never registered; an ended run is
  // saved more than once, so this keeps repeat saves to one read
  if ((await store.findRegistration(ref.waitId)).kind === "absent") return;
  if (!step.signalWait?.receipt) {
    await store.settle(cancelledOutcome(ref, now));
  }
  await store.removeRegistration(ref.waitId);
}

/**
 * called before the save so no signal is accepted for a wait of a run already
 * recorded as over
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
 * one hook covers every writer that ends a run (cancel, reject, supersede,
 * abort, the executor) so none has to remember to close waits
 */
export function closeWaitsOfEndedRun(
  store: SignalWaitStore,
  now: () => Date = () => new Date(),
): (run: WorkflowRun) => Promise<void> {
  return async (run) => {
    if (isEndedRunStatus(run.status)) await closeRunWaits(store, run, now());
  };
}

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
 * key claims go first because a claim whose outcome is gone would read as an
 * open wait; the highest of its key is superseded by a release, not deleted
 */
export async function removeWaitRecordsOfRuns(
  store: SignalWaitStore,
  runIds: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<number> {
  if (runIds.size === 0) return 0;
  await releaseKeyClaims(store, (claim) => runIds.has(claim.runId), now);
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
 * a failed run can be retried under the same id and its record reaches another
 * host after its wait records, so an ended record here may predate a retry
 * whose live wait must not be closed
 */
function endedAfterRegistering(
  run: WorkflowRun,
  registration: WaitRegistration,
): boolean {
  if (!isEndedRunStatus(run.status) || !run.completedAt) return false;
  return new Date(registration.registeredAt).getTime() <=
    run.completedAt.getTime();
}

export interface WaitRecordSweep {
  registrations: number;
  outcomes: number;
  keyRecords: number;
  pendingSignals: number;
}

/**
 * only the highest record of a slot is read, so the one below it is dead; the
 * highest is never deleted and no number comes back into use
 */
export async function removeSupersededPendingSignal(
  store: Pick<PendingSignalRecords, "removePendingRecord">,
  stored: PendingAddress,
): Promise<void> {
  if (stored.number <= 1) return;
  await store.removePendingRecord({
    workflowId: stored.workflowId,
    key: stored.key,
    slot: stored.slot,
    number: stored.number - 1,
  });
}

/**
 * reads key records, never a run record, so it is safe on every datastore; a
 * slot's highest record is never deleted, since a reused number would let two
 * signallers both store a signal
 */
export async function sweepPendingSignals(
  store: SignalWaitStore,
  now: Date,
): Promise<number> {
  const bySlot = new Map<string, PendingAddress[]>();
  for (const at of await store.listPendingAddresses()) {
    const id = `${at.workflowId}/${at.key}/${at.slot}`;
    bySlot.set(id, [...(bySlot.get(id) ?? []), at]);
  }
  let removed = 0;
  for (const addresses of bySlot.values()) {
    const { workflowId, key, slot } = addresses[0];
    const highest = await store.highestKeyRecord(workflowId, key);
    if (highest.kind === "unreadable") continue;
    const generation = highest.kind === "found" ? highest.record.generation : 0;
    const live = generation < slot ||
      (generation === slot && highest.kind === "found" &&
        highest.record.kind === "release");
    if (!live) {
      // a claim that reads this slot exists by now or never will: generations
      // only grow and a claim reads no further than one below its own
      const readers = await claimsReadingSlot(
        store,
        { workflowId, key, slot },
        highest.kind === "found" ? highest.record : undefined,
      );
      if (readers.unreadable || readers.claims.length > 0) continue;
      for (const at of addresses) {
        await store.removePendingRecord(at);
        removed++;
      }
      continue;
    }

    const head = await store.highestPendingRecord({ workflowId, key, slot });
    if (head.kind !== "found") continue;
    let floor = head.record.number;
    if (
      head.record.kind === "pending" &&
      now.getTime() >
        heldUntil(head.record).getTime() + PENDING_SIGNAL_LAPSE_GRACE_MS
    ) {
      const lapse: PendingLapse = {
        kind: "lapse",
        workflowId,
        key,
        slot,
        number: floor + 1,
        recordedAt: now.toISOString(),
      };
      // Whatever holds the next number supersedes the signal: this lapse,
      // or a signal stored over it in the meantime.
      if ((await store.createPendingRecord(lapse)).kind !== "found") continue;
      floor++;
    }
    for (const at of addresses) {
      if (at.number >= floor) continue;
      await store.removePendingRecord(at);
      removed++;
    }
  }
  return removed;
}

/**
 * outside a datastore whose local run records are authoritative, run records
 * say nothing true about a wait (stale failed hides a live retry), so only
 * pending signals are swept and the ending host closes the rest
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
  const swept: WaitRecordSweep = {
    registrations: 0,
    outcomes: 0,
    keyRecords: 0,
    pendingSignals: 0,
  };
  // Decided from key records alone, so it is not held to the rule below.
  swept.pendingSignals = await sweepPendingSignals(store, now);
  if (!options.localRunAbsenceIsAuthoritative) return swept;
  const orphaned = (ref: { deadline: string }) =>
    now.getTime() >
      new Date(ref.deadline).getTime() + ORPHAN_WAIT_RECORD_GRACE_MS;
  // unreadable means the run file is there but cannot be parsed: nothing is
  // known about that run, so its records are left as they are
  const lookUp = async (
    ref: { workflowId: string; runId: string },
  ): Promise<WorkflowRun | null | "unreadable"> => {
    try {
      return await findRun(ref.workflowId, ref.runId);
    } catch {
      return "unreadable";
    }
  };

  for (const registration of await store.listRegistrations()) {
    const run = await lookUp(registration);
    if (run === "unreadable") continue;
    if (run && endedAfterRegistering(run, registration)) {
      const outcome = await store.findOutcome(registration.waitId);
      if (outcome.kind === "absent") {
        await store.settle(cancelledOutcome(registration, now));
      }
      await store.removeRegistration(registration.waitId);
      swept.registrations++;
    } else if (!run && orphaned(registration)) {
      await store.removeRegistration(registration.waitId);
      swept.registrations++;
    }
  }
  // Before the outcomes: a claim left without its outcome reads as held.
  swept.keyRecords = (await releaseKeyClaims(
    store,
    async (claim) => orphaned(claim) && await lookUp(claim) === null,
    now,
  )).removed;
  for (const outcome of await store.listOutcomes()) {
    if (!orphaned(outcome)) continue;
    if (await lookUp(outcome) !== null) continue;
    await store.removeOutcome(outcome.waitId);
    swept.outcomes++;
  }
  return swept;
}
