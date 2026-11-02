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
 * the order is the protocol: the signaller creates its record then reads the
 * key; a step creates its claim and registration then reads the slot; each
 * writes before it reads, so one sees the other
 */

import type { InputsSchema } from "../definitions/definition.ts";
import {
  heldUntil,
  type HighestPendingRecord,
  isPendingHeld,
  type PendingSignal,
  type PendingSignalRecords,
} from "./pending_signal.ts";
import { earlySlots, SignalWait } from "./signal_wait.ts";
import type { PayloadValidation } from "./signal_wait.ts";
import type { AcceptedWaitOutcome } from "./signal_wait_records.ts";
import {
  claimsReadingSlot,
  findKeyHolder,
  type HighestKeyRecord,
  WAIT_KEY_CLAIM_ATTEMPTS,
  type WaitKeyClaim,
  type WaitKeyRecords,
} from "./wait_key_claim.ts";
import type { Workflow } from "./workflow.ts";

export interface DeclaredEarlyWait {
  jobName: string;
  stepName: string;
  acceptEarly: number;
  schema: InputsSchema;
}

export function declaredEarlyWait(
  workflow: Workflow,
  key: string,
): DeclaredEarlyWait | undefined {
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task?.data;
      if (
        task?.type === "wait_for_signal" && task.key === key &&
        task.acceptEarly !== undefined
      ) {
        return {
          jobName: job.name,
          stepName: step.name,
          acceptEarly: task.acceptEarly,
          schema: task.schema,
        };
      }
    }
  }
  return undefined;
}

/**
 * no run exists yet, so no wait has captured the schema; the wait that takes
 * the signal checks it again against its own
 */
export function validateEarlyPayload(
  schema: InputsSchema,
  payload: unknown,
  now: Date,
): PayloadValidation {
  return SignalWait.fromData({
    kind: "signal",
    id: crypto.randomUUID(),
    schema,
    deadline: now.toISOString(),
  }).validatePayload(payload);
}

export interface LiveSlots {
  slot: number;
  /**
   * `slot`, and the one below when the key's highest record is a release: a
   * signal that read the key before the release wrote there, and the next
   * claim reads both.
   */
  live: number[];
}

export function liveSlotsOf(
  highest: Exclude<HighestKeyRecord, { kind: "unreadable" }>,
): LiveSlots {
  if (highest.kind === "none") return { slot: 1, live: [1] };
  const generation = highest.record.generation;
  return {
    slot: generation + 1,
    live: highest.record.kind === "release"
      ? [generation + 1, generation]
      : [generation + 1],
  };
}

export type EarlySignalDecision =
  | { readonly kind: "store"; readonly number: number }
  | { readonly kind: "already_pending"; readonly record: PendingSignal }
  | { readonly kind: "unreadable" };

/**
 * the first pending signal is kept: a second is refused while the first is
 * within its age limit, and stored over it at the next number once it is not
 */
export function decideEarlySignal(
  heads: readonly HighestPendingRecord[],
  now: Date,
): EarlySignalDecision {
  for (const head of heads) {
    if (head.kind === "unreadable") return { kind: "unreadable" };
    if (
      head.kind === "found" && head.record.kind === "pending" &&
      isPendingHeld(head.record, now)
    ) return { kind: "already_pending", record: head.record };
  }
  const own = heads[0];
  return {
    kind: "store",
    number: own === undefined || own.kind === "none"
      ? 1
      : own.kind === "found"
      ? own.record.number + 1
      : own.number + 1,
  };
}

export interface HeldPendingSignal {
  workflowId: string;
  key: string;
  receiptId: string;
  receivedAt: string;
  heldUntil: string;
  submittedBy: string;
  authorizedFor?: string;
}

/**
 * a key is listed exactly when a second signal to it would be refused
 * already_pending; unreadable keys are left out; a listed signal is one the
 * sweep neither removes nor lapses at the same now; writes nothing
 */
export async function listHeldPendingSignals(
  store:
    & Pick<WaitKeyRecords, "highestKeyRecord">
    & Pick<
      PendingSignalRecords,
      "highestPendingRecord" | "listPendingAddresses"
    >,
  now: Date,
): Promise<HeldPendingSignal[]> {
  const keys = new Map<string, { workflowId: string; key: string }>();
  for (const at of await store.listPendingAddresses()) {
    keys.set(JSON.stringify([at.workflowId, at.key]), {
      workflowId: at.workflowId,
      key: at.key,
    });
  }
  const held: HeldPendingSignal[] = [];
  for (const { workflowId, key } of keys.values()) {
    const highest = await store.highestKeyRecord(workflowId, key);
    if (highest.kind === "unreadable") continue;
    const heads: HighestPendingRecord[] = [];
    for (const slot of liveSlotsOf(highest).live) {
      heads.push(await store.highestPendingRecord({ workflowId, key, slot }));
    }
    // The same decision a second signal gets, so a key is listed exactly
    // when it would be refused `already_pending`.
    const decision = decideEarlySignal(heads, now);
    if (decision.kind !== "already_pending") continue;
    const pending = decision.record;
    held.push({
      workflowId,
      key,
      receiptId: pending.receiptId,
      receivedAt: pending.receivedAt,
      heldUntil: heldUntil(pending).toISOString(),
      submittedBy: pending.submittedBy,
      ...(pending.authorizedFor !== undefined
        ? { authorizedFor: pending.authorizedFor }
        : {}),
    });
  }
  return held.sort((a, b) =>
    a.heldUntil < b.heldUntil ? -1 : a.heldUntil > b.heldUntil ? 1 : 0
  );
}

export interface EarlySignal {
  workflowId: string;
  key: string;
  payload: Record<string, unknown>;
  submittedBy: string;
  acceptEarly: number;
  idempotencyKey?: string;
  authorizedFor?: string;
}

export type EarlyArrival =
  | { readonly kind: "pending"; readonly record: PendingSignal }
  | { readonly kind: "already_pending"; readonly record: PendingSignal }
  /**
   * An open wait holds the key. `record` is what this signal stored before
   * it found that out, if anything: the wait takes it when its claim reads
   * that slot, and is signalled like any open wait when it does not.
   */
  | {
    readonly kind: "held";
    readonly claim: WaitKeyClaim;
    readonly record?: PendingSignal;
  }
  | {
    readonly kind: "taken";
    readonly claim: WaitKeyClaim;
    readonly record: PendingSignal;
  }
  /**
   * another copy of this signal (same sender, same idempotency key) settled a
   * wait while this one arrived; this one is not stored again for the next
   * claim
   */
  | {
    readonly kind: "duplicate";
    readonly claim: WaitKeyClaim;
    readonly outcome: AcceptedWaitOutcome;
    readonly record?: PendingSignal;
  }
  | { readonly kind: "unreadable" }
  | { readonly kind: "contended" };

/**
 * looked for among the claims that read the slot, not only the key's highest
 * record, since the key may have been claimed again; at most two records, so
 * other workflows' key records are never listed
 */
async function findTakerOf(
  store: Pick<WaitKeyRecords, "findKeyRecord" | "findOutcome">,
  stored: PendingSignal,
): Promise<{ claim: WaitKeyClaim; outcome: AcceptedWaitOutcome } | undefined> {
  let copy: { claim: WaitKeyClaim; outcome: AcceptedWaitOutcome } | undefined;
  for (const record of (await claimsReadingSlot(store, stored)).claims) {
    if (
      record.early === undefined ||
      !earlySlots(record.early).includes(stored.slot)
    ) continue;
    const outcome = await store.findOutcome(record.waitId);
    if (
      outcome.kind !== "found" || outcome.record.runId !== record.runId ||
      outcome.record.kind !== "accepted"
    ) continue;
    const { receipt } = outcome.record;
    if (receipt.id === stored.receiptId) {
      return { claim: record, outcome: outcome.record };
    }
    if (
      stored.idempotencyKey !== undefined &&
      receipt.idempotencyKey === stored.idempotencyKey &&
      receipt.submittedBy === stored.submittedBy
    ) copy = { claim: record, outcome: outcome.record };
  }
  return copy;
}

/**
 * receipt ID and received time are fixed before the first attempt, so a signal
 * that has to arrive again at a later slot is the same signal
 */
export async function holdEarlySignal(
  store:
    & Pick<
      WaitKeyRecords,
      "highestKeyRecord" | "findKeyRecord" | "findOutcome"
    >
    & Pick<
      PendingSignalRecords,
      "highestPendingRecord" | "createPendingRecord"
    >,
  signal: EarlySignal,
  now: Date,
): Promise<EarlyArrival> {
  const { workflowId, key } = signal;
  const receiptId = crypto.randomUUID();
  const receivedAt = now.toISOString();
  let stored: PendingSignal | undefined;
  for (let attempt = 0; attempt < WAIT_KEY_CLAIM_ATTEMPTS; attempt++) {
    const highest = await store.highestKeyRecord(workflowId, key);
    if (highest.kind === "unreadable") return { kind: "unreadable" };
    const holder = await findKeyHolder(store, workflowId, key);
    if (holder.kind === "unreadable") return { kind: "unreadable" };
    if (holder.kind === "held") {
      return {
        kind: "held",
        claim: holder.claim,
        ...(stored ? { record: stored } : {}),
      };
    }

    // the key is free; another copy of this signal may be why, delivered to the
    // wait that held it; a free key has its last outcome written already, so
    // that copy is found here before anything is stored
    if (signal.idempotencyKey !== undefined) {
      const landed = await settledUnderKey(
        store,
        { workflowId, key },
        highest,
        {
          idempotencyKey: signal.idempotencyKey,
          submittedBy: signal.submittedBy,
        },
      );
      if (landed) {
        return {
          kind: "duplicate",
          ...landed,
          ...(stored ? { record: stored } : {}),
        };
      }
    }

    const { slot, live } = liveSlotsOf(highest);
    const heads: HighestPendingRecord[] = [];
    for (const each of live) {
      heads.push(
        await store.highestPendingRecord({ workflowId, key, slot: each }),
      );
    }
    const decision = decideEarlySignal(heads, now);
    if (decision.kind !== "store") return decision;

    const record: PendingSignal = {
      kind: "pending",
      workflowId,
      key,
      slot,
      number: decision.number,
      receiptId,
      receivedAt,
      submittedBy: signal.submittedBy,
      payload: signal.payload,
      acceptEarly: signal.acceptEarly,
      ...(signal.idempotencyKey !== undefined
        ? { idempotencyKey: signal.idempotencyKey }
        : {}),
      ...(signal.authorizedFor !== undefined
        ? { authorizedFor: signal.authorizedFor }
        : {}),
    };
    const created = await store.createPendingRecord(record);
    if (created.kind !== "found") return { kind: "unreadable" };
    if (
      created.record.kind !== "pending" ||
      created.record.receiptId !== receiptId
    ) {
      // another signal took the number at the same moment and is the one
      // stored; a lapse means the sweep superseded the slot's last signal, and
      // the next attempt stores above it
      if (created.record.kind === "pending") {
        return { kind: "already_pending", record: created.record };
      }
      continue;
    }
    stored = created.record;

    // The second read. A step that claimed the key before this record
    // existed has not seen it; this read sees that claim.
    const again = await store.highestKeyRecord(workflowId, key);
    if (again.kind === "unreadable") return { kind: "pending", record: stored };
    const generation = again.kind === "found" ? again.record.generation : 0;
    if (
      generation < slot ||
      (generation === slot && again.kind === "found" &&
        again.record.kind === "release")
    ) return { kind: "pending", record: stored };

    // the holder is read before the taker: looking for the taker first would
    // let a step take the signal between the two reads and be missed by both
    const holding = await findKeyHolder(store, workflowId, key);
    if (holding.kind === "unreadable") return { kind: "unreadable" };
    // A claim that reads the slot may have taken this signal, with the key
    // held or settled again since: a signal a wait took is never delivered
    // or stored a second time.
    const taker = await findTakerOf(store, stored);
    if (taker) {
      return taker.outcome.receipt.id === stored.receiptId
        ? { kind: "taken", claim: taker.claim, record: stored }
        : { kind: "duplicate", ...taker, record: stored };
    }
    if (holding.kind === "held") {
      return { kind: "held", claim: holding.claim, record: stored };
    }
    // The slot was claimed and its wait settled some other way, with the
    // key free again: the signal is early for the next claim, and arrives
    // again at that slot.
  }
  return { kind: "contended" };
}

export type EarlierSignal =
  | { readonly kind: "pending"; readonly record: PendingSignal }
  | {
    readonly kind: "settled";
    readonly claim: WaitKeyClaim;
    readonly outcome: AcceptedWaitOutcome;
  };

/**
 * a key names a signal of its sender only, so nobody is shown a receipt that is
 * not theirs and nobody's signal is dropped for a key someone else used
 */
export async function findSignalByIdempotencyKey(
  store:
    & Pick<WaitKeyRecords, "highestKeyRecord" | "findKeyRecord" | "findOutcome">
    & Pick<PendingSignalRecords, "highestPendingRecord">,
  at: { workflowId: string; key: string },
  sent: { idempotencyKey: string; submittedBy: string },
  now: Date,
): Promise<EarlierSignal | undefined> {
  const { idempotencyKey, submittedBy } = sent;
  const { workflowId, key } = at;
  const highest = await store.highestKeyRecord(workflowId, key);
  // Whoever acts on the key next reports a record that cannot be read.
  if (highest.kind === "unreadable") return undefined;

  for (const slot of liveSlotsOf(highest).live) {
    const head = await store.highestPendingRecord({ workflowId, key, slot });
    if (
      head.kind === "found" && head.record.kind === "pending" &&
      head.record.idempotencyKey === idempotencyKey &&
      head.record.submittedBy === submittedBy &&
      isPendingHeld(head.record, now)
    ) return { kind: "pending", record: head.record };
  }

  const landed = await settledUnderKey(store, at, highest, sent);
  return landed ? { kind: "settled", ...landed } : undefined;
}

async function settledUnderKey(
  store: Pick<WaitKeyRecords, "findKeyRecord" | "findOutcome">,
  at: { workflowId: string; key: string },
  highest: Exclude<HighestKeyRecord, { kind: "unreadable" }>,
  sent: { idempotencyKey: string; submittedBy: string },
): Promise<{ claim: WaitKeyClaim; outcome: AcceptedWaitOutcome } | undefined> {
  const { workflowId, key } = at;
  const { idempotencyKey, submittedBy } = sent;
  if (highest.kind === "none") return undefined;
  const generation = highest.record.generation;
  for (const each of [generation, generation - 1]) {
    if (each < 1) break;
    const stored = each === generation
      ? highest
      : await store.findKeyRecord({ workflowId, key, generation: each });
    if (stored.kind !== "found" || stored.record.kind !== "claim") continue;
    const claim = stored.record;
    const outcome = await store.findOutcome(claim.waitId);
    if (
      outcome.kind === "found" && outcome.record.kind === "accepted" &&
      // An outcome that names another run is not that wait's outcome.
      outcome.record.runId === claim.runId &&
      outcome.record.workflowId === workflowId &&
      outcome.record.receipt.idempotencyKey === idempotencyKey &&
      outcome.record.receipt.submittedBy === submittedBy
    ) return { claim, outcome: outcome.record };
  }
  return undefined;
}
