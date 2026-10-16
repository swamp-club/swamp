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
 * The arrival of a signal by key that finds no open wait, on a step that
 * sets `acceptEarly` (swamp-club#3212): the signal is stored as the key's
 * pending signal, and the key is then read again.
 *
 * The order is the protocol. The signaller creates its record and then reads
 * the key; a step creates its claim and its registration and then reads the
 * slot. Each writes before it reads, so at least one of them sees the other,
 * and whoever settles the wait later takes a signal neither of them applied.
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

/** What the definition says of a key whose step takes an early signal. */
export interface DeclaredEarlyWait {
  jobName: string;
  stepName: string;
  /** The age limit, in seconds. */
  acceptEarly: number;
  /** The schema as the definition has it; it holds no expression. */
  schema: InputsSchema;
}

/**
 * The `wait_for_signal` step of `workflow` that declares `key` and sets
 * `acceptEarly`, or undefined when no step of it does.
 */
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
 * Checks an early payload against the schema in the definition, under the
 * limits of any payload. No run exists yet, so no wait has captured the
 * schema; the wait that takes the signal checks it again against its own.
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

/** The slot a signal is stored in, and the slots a pending signal may be in. */
export interface LiveSlots {
  /** The generation the next claim of the key will have. */
  slot: number;
  /**
   * `slot`, and the one below when the key's highest record is a release: a
   * signal that read the key before the release wrote there, and the next
   * claim reads both.
   */
  live: number[];
}

/** The live slots of a key, from its highest record. */
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

/** What to do with an early signal, given the highest record of each live slot. */
export type EarlySignalDecision =
  /** Store it as this number of the slot. */
  | { readonly kind: "store"; readonly number: number }
  /** A pending signal is within its age limit. A key holds one. */
  | { readonly kind: "already_pending"; readonly record: PendingSignal }
  /** A live slot's highest record cannot be read. */
  | { readonly kind: "unreadable" };

/**
 * Decides an early signal from the highest record of each live slot, the
 * slot it would be stored in first. The first pending signal is kept: a
 * second one is refused while the first is within its age limit, and stored
 * over it, at the next number, once it is not.
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

/**
 * A pending signal held for the next wait of its key, as a listing shows it
 * (swamp-club#3214). It names the signal by its receipt and never carries
 * the payload.
 */
export interface HeldPendingSignal {
  workflowId: string;
  key: string;
  receiptId: string;
  receivedAt: string;
  /** When its age limit ends, as an ISO timestamp. */
  heldUntil: string;
  submittedBy: string;
  /** The workflow name the sender was authorized to signal, if it was. */
  authorizedFor?: string;
}

/**
 * The pending signals held at `now`, one per key at most, ordered by when
 * their age limits end (swamp-club#3214). For each key it reads the key's
 * highest record once and the highest record of each live slot
 * ({@link liveSlotsOf}), and lists the signal {@link decideEarlySignal}
 * refuses a second signal for with `already_pending`. A signal listed here
 * is one the sweep neither removes nor lapses at the same `now`, since it
 * reads only live slots and lapses only past the age limit. It writes
 * nothing.
 *
 * A key whose highest record cannot be read is left out, and so is a key
 * the decision finds unreadable: a key is listed exactly when a second
 * signal to it would be refused `already_pending`, never otherwise.
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

/** An early signal, checked and ready to be stored. */
export interface EarlySignal {
  workflowId: string;
  key: string;
  /** The payload as {@link validateEarlyPayload} accepted it. */
  payload: Record<string, unknown>;
  submittedBy: string;
  /** The age limit the definition declares, in seconds. */
  acceptEarly: number;
  /** The idempotency key the sender gave, if any. */
  idempotencyKey?: string;
  /** The workflow name the sender was authorized to signal, if it was. */
  authorizedFor?: string;
}

/** How the arrival of an early signal ended. */
export type EarlyArrival =
  /** Stored, and no wait holds the key. Held until its age limit ends. */
  | { readonly kind: "pending"; readonly record: PendingSignal }
  /** An earlier signal is pending within its age limit. Nothing was stored. */
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
  /** A step took the stored signal on opening its wait. */
  | {
    readonly kind: "taken";
    readonly claim: WaitKeyClaim;
    readonly record: PendingSignal;
  }
  /**
   * A wait of the key was settled by another copy of this signal: one from
   * the same sender under the same idempotency key, delivered to a wait
   * while this one arrived. `outcome` holds that
   * copy's receipt. This one is not stored again for the next claim.
   */
  | {
    readonly kind: "duplicate";
    readonly claim: WaitKeyClaim;
    readonly outcome: AcceptedWaitOutcome;
    /** What this signal stored before it found that out, if anything. */
    readonly record?: PendingSignal;
  }
  /** A record of the key cannot be read, so nothing can be decided. */
  | { readonly kind: "unreadable" }
  /** The key changed hands on every attempt. */
  | { readonly kind: "contended" };

/**
 * The claim whose wait took `stored`, if one did: a claim that reads the
 * signal's slot (its own generation, or the one below for a claim created
 * over a release) and whose outcome is this signal's receipt. It is looked
 * for among the claims that read the slot, not only the key's highest
 * record, because the key may have been claimed again since. Those are two
 * records of this key at most ({@link claimsReadingSlot}), so the key
 * records of other workflows are never listed (swamp-club#3308).
 *
 * A signal sent under an idempotency key has a second way to have landed
 * there: another copy of it, from the same sender under the same key, was
 * delivered to that wait while this one arrived. That outcome holds the
 * other copy's receipt, and is returned as it is.
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
 * Stores `signal` as the pending signal of its key, then reads the key
 * again. Called when no open wait holds the key. The receipt ID and the
 * received time are fixed before the first attempt, so a signal that has to
 * arrive again at a later slot is the same signal.
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

    // The key is free. Another copy of this signal may be why: delivered to
    // the wait that held the key after this copy was looked up by its
    // idempotency key. A key that reads as free has the outcome of its last
    // claim written already, so that copy is found here, before anything is
    // stored for the next claim to take.
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
      // Another signal took the number at the same moment, and is the one
      // stored. A lapse there means the sweep superseded the slot's last
      // signal in between; the next attempt stores above it.
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

    // The key has reached the slot. Its holder is read before the taker is
    // looked for: a key that reads as free, or as held by a later claim,
    // has the outcome of every claim that reads this slot written already,
    // and an outcome is written once. Looking for the taker first would let
    // a step take the signal between the two reads and be missed by both.
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

/** A signal the store already holds under an idempotency key. */
export type EarlierSignal =
  /** Held as the key's pending signal, within its age limit. */
  | { readonly kind: "pending"; readonly record: PendingSignal }
  /** A wait took it: `claim` is that wait's, and `outcome` its receipt. */
  | {
    readonly kind: "settled";
    readonly claim: WaitKeyClaim;
    readonly outcome: AcceptedWaitOutcome;
  };

/**
 * The signal already received for `key` under `idempotencyKey`, if the
 * records still say so: a retry of it is answered with that signal, and is
 * neither delivered nor held again. Looked for in the pending signal of each
 * live slot, and in the outcomes of the claims among the key's two highest
 * records: the wait that last held the key, and the one before it for a
 * retry that arrives once the next run has opened its wait. It reads at most six records and
 * writes nothing.
 *
 * A key names a signal of its sender only: another sender's signal under the
 * same key is not a match, so nobody is shown a receipt that is not theirs
 * and nobody's signal is dropped for a key someone else used.
 *
 * A key is remembered as long as its receipt is: until the run that took the
 * signal is removed, the key has been claimed twice since, or the pending
 * signal has passed its age limit untaken.
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

/**
 * The wait among the claims of a key's two highest records that a signal
 * from `sent.submittedBy` under `sent.idempotencyKey` settled, if one did.
 */
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
