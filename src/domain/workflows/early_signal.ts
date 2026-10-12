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
  type HighestPendingRecord,
  isPendingHeld,
  type PendingSignal,
  type PendingSignalRecords,
} from "./pending_signal.ts";
import { SignalWait } from "./signal_wait.ts";
import type { PayloadValidation } from "./signal_wait.ts";
import {
  findKeyHolder,
  findSettledKeyHolder,
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

/** An early signal, checked and ready to be stored. */
export interface EarlySignal {
  workflowId: string;
  key: string;
  /** The payload as {@link validateEarlyPayload} accepted it. */
  payload: Record<string, unknown>;
  submittedBy: string;
  /** The age limit the definition declares, in seconds. */
  acceptEarly: number;
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
  /** A record of the key cannot be read, so nothing can be decided. */
  | { readonly kind: "unreadable" }
  /** The key changed hands on every attempt. */
  | { readonly kind: "contended" };

/**
 * Stores `signal` as the pending signal of its key, then reads the key
 * again. Called when no open wait holds the key. The receipt ID and the
 * received time are fixed before the first attempt, so a signal that has to
 * arrive again at a later slot is the same signal.
 */
export async function holdEarlySignal(
  store:
    & Pick<WaitKeyRecords, "highestKeyRecord" | "findOutcome">
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

    const holding = await findKeyHolder(store, workflowId, key);
    if (holding.kind === "held") {
      return { kind: "held", claim: holding.claim, record: stored };
    }
    const settled = await findSettledKeyHolder(store, workflowId, key);
    if (
      settled && settled.outcome.kind === "accepted" &&
      settled.outcome.receipt.id === receiptId
    ) return { kind: "taken", claim: settled.claim, record: stored };
    // The slot was claimed and its wait settled some other way, with the
    // key free again: the signal is early for the next claim, and arrives
    // again at that slot.
  }
  return { kind: "contended" };
}
