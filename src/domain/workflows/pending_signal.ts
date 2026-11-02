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
 * pending records are plaintext in a store other writers can reach, so each is
 * validated on every read
 */

import { z } from "zod";
import { generationFromKey } from "./continuation_claim.ts";
import {
  earlySlots,
  isIdempotencyKey,
  isWaitKey,
  SIGNAL_ACCEPT_EARLY_MAX_SECONDS,
  SignalWait,
  WAIT_KEY_FORM,
  type WaitEarly,
} from "./signal_wait.ts";
import type {
  AcceptedWaitOutcome,
  StoredWaitRecord,
  WaitOutcome,
  WaitRef,
  WaitRegistration,
} from "./signal_wait_records.ts";

export const PENDING_SIGNAL_PREFIX = "wait-pending/";

export const PENDING_SIGNAL_MAX_BYTES = 64 * 1024;

/**
 * the age limit is judged by the sweeper's clock against another host's
 * timestamp, so the grace is wide
 */
export const PENDING_SIGNAL_LAPSE_GRACE_MS = 24 * 60 * 60 * 1000;

function isSinglePathSegment(id: string): boolean {
  return id.length > 0 && !/[\\/]/.test(id) && id !== "." && id !== "..";
}

const address = {
  workflowId: z.string().refine(
    isSinglePathSegment,
    "must be a single path segment",
  ),
  key: z.string().refine(isWaitKey),
  slot: z.number().int().min(1),
  number: z.number().int().min(1),
};

export const PendingSignalSchema = z.object({
  kind: z.literal("pending"),
  ...address,
  receiptId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  submittedBy: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  acceptEarly: z.number().positive().max(SIGNAL_ACCEPT_EARLY_MAX_SECONDS),
  /**
   * workflow ids are not unique and a run's workflow can be renamed, so only a
   * wait whose run recorded this name takes the signal
   */
  authorizedFor: z.string().min(1).optional(),
  idempotencyKey: z.string().refine(isIdempotencyKey).optional(),
});

export type PendingSignal = z.infer<typeof PendingSignalSchema>;

export const PendingLapseSchema = z.object({
  kind: z.literal("lapse"),
  ...address,
  recordedAt: z.string().datetime(),
});

export type PendingLapse = z.infer<typeof PendingLapseSchema>;

export const PendingRecordSchema = z.discriminatedUnion("kind", [
  PendingSignalSchema,
  PendingLapseSchema,
]);

export type PendingRecord = z.infer<typeof PendingRecordSchema>;

export type PendingAddress = Pick<
  PendingRecord,
  "workflowId" | "key" | "slot" | "number"
>;

export type PendingSlot = Pick<PendingRecord, "workflowId" | "key" | "slot">;

function requirePositiveInteger(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Not a pending signal ${what}: ${value}`);
  }
  return value;
}

export function pendingWorkflowPrefix(workflowId: string): string {
  if (!isSinglePathSegment(workflowId)) {
    throw new Error(
      `Not a workflow id a pending signal can be kept under: ${workflowId}`,
    );
  }
  return `${PENDING_SIGNAL_PREFIX}${workflowId}/`;
}

export function pendingSlotPrefix(at: PendingSlot): string {
  if (!isWaitKey(at.key)) {
    throw new Error(`A wait key must be ${WAIT_KEY_FORM}, got ${at.key}.`);
  }
  return `${pendingWorkflowPrefix(at.workflowId)}${at.key}/${
    requirePositiveInteger(at.slot, "slot")
  }/`;
}

export function pendingRecordKey(at: PendingAddress): string {
  return `${pendingSlotPrefix(at)}${
    requirePositiveInteger(at.number, "number")
  }`;
}

export function pendingAddressFromKey(
  storeKey: string,
): PendingAddress | undefined {
  if (!storeKey.startsWith(PENDING_SIGNAL_PREFIX)) return undefined;
  const parts = storeKey.slice(PENDING_SIGNAL_PREFIX.length).split("/");
  if (parts.length !== 4) return undefined;
  const [workflowId, key] = parts;
  const slot = generationFromKey(parts[2]);
  const number = generationFromKey(parts[3]);
  if (
    slot === undefined || number === undefined ||
    !isSinglePathSegment(workflowId) || !isWaitKey(key)
  ) return undefined;
  return { workflowId, key, slot, number };
}

export function encodePendingRecord(record: PendingRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/**
 * a record that is too large, unparseable, at another address, or altered by
 * parsing (e.g. a dropped __proto__ key) is unreadable, never absent
 */
export function decodePendingRecord(
  bytes: Uint8Array | null,
  expected: PendingAddress,
): StoredWaitRecord<PendingRecord> {
  if (bytes === null) return { kind: "absent" };
  if (bytes.byteLength > PENDING_SIGNAL_MAX_BYTES) {
    return { kind: "unreadable" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: "unreadable" };
  }
  const parsed = PendingRecordSchema.safeParse(raw);
  if (!parsed.success) return { kind: "unreadable" };
  const record = parsed.data;
  if (
    record.workflowId !== expected.workflowId ||
    record.key !== expected.key || record.slot !== expected.slot ||
    record.number !== expected.number
  ) return { kind: "unreadable" };
  if (
    record.kind === "pending" &&
    JSON.stringify((raw as { payload: unknown }).payload) !==
      JSON.stringify(record.payload)
  ) return { kind: "unreadable" };
  return { kind: "found", record };
}

export type HighestPendingRecord =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly record: PendingRecord }
  | { readonly kind: "unreadable"; readonly number: number };

export interface PendingSignalRecords {
  highestPendingRecord(at: PendingSlot): Promise<HighestPendingRecord>;

  /**
   * learn whether you won by comparing the returned record with your own, never
   * from the create itself
   */
  createPendingRecord(
    record: PendingRecord,
  ): Promise<StoredWaitRecord<PendingRecord>>;

  findPendingRecord(
    at: PendingAddress,
  ): Promise<StoredWaitRecord<PendingRecord>>;

  listPendingAddresses(): Promise<PendingAddress[]>;

  removePendingRecord(at: PendingAddress): Promise<void>;

  removePendingRecordsOfWorkflow(workflowId: string): Promise<void>;
}

export interface PendingSignalTaken {
  readonly waitId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly key: string;
  readonly receiptId: string;
}

/**
 * two readers taking at the same moment are both told, so a listener hears of a
 * take at least once
 */
export type PendingSignalTakenListener = (taken: PendingSignalTaken) => void;

export interface EarlyWaitRef extends WaitRef {
  key: string;
  early: WaitEarly;
  schema: WaitRegistration["schema"];
}

export function earlyWaitRef(ref: WaitRef): EarlyWaitRef | undefined {
  return ref.key !== undefined && ref.early !== undefined &&
      ref.schema !== undefined
    ? ref as EarlyWaitRef
    : undefined;
}

export function earliestReceipt(claimedAt: Date, acceptEarly: number): string {
  return new Date(claimedAt.getTime() - acceptEarly * 1000).toISOString();
}

export function isPendingHeld(pending: PendingSignal, now: Date): boolean {
  return now.getTime() <= heldUntil(pending).getTime();
}

export function heldUntil(pending: PendingSignal): Date {
  return new Date(
    new Date(pending.receivedAt).getTime() + pending.acceptEarly * 1000,
  );
}

export function isReceivedForWait(
  pending: Pick<PendingSignal, "slot" | "receivedAt">,
  wait: { early: WaitEarly; deadline: string },
): boolean {
  if (!earlySlots(wait.early).includes(pending.slot)) return false;
  const received = new Date(pending.receivedAt).getTime();
  return received >= new Date(wait.early.from).getTime() &&
    received <= new Date(wait.deadline).getTime();
}

/**
 * decided from stored facts alone, so every reader reaches the same answer
 * whenever it looks
 */
export function pendingOutcome(
  pending: PendingSignal,
  ref: EarlyWaitRef,
): AcceptedWaitOutcome | undefined {
  if (pending.workflowId !== ref.workflowId || pending.key !== ref.key) {
    return undefined;
  }
  if (
    pending.authorizedFor !== undefined &&
    pending.authorizedFor !== ref.workflowName
  ) return undefined;
  if (!isReceivedForWait(pending, ref)) return undefined;
  const validation = SignalWait.fromData({
    kind: "signal",
    id: ref.waitId,
    schema: ref.schema,
    deadline: ref.deadline,
  }).validatePayload(pending.payload);
  if (!validation.valid) return undefined;
  return {
    kind: "accepted",
    waitId: ref.waitId,
    workflowId: ref.workflowId,
    runId: ref.runId,
    deadline: ref.deadline,
    settledAt: pending.receivedAt,
    receipt: {
      id: pending.receiptId,
      waitId: ref.waitId,
      receivedAt: pending.receivedAt,
      submittedBy: pending.submittedBy,
      ...(pending.idempotencyKey !== undefined
        ? { idempotencyKey: pending.idempotencyKey }
        : {}),
      heldAsPending: true,
    },
    payload: validation.payload,
  };
}

export async function applicablePendingOutcome(
  store: Pick<PendingSignalRecords, "highestPendingRecord">,
  ref: EarlyWaitRef,
): Promise<AcceptedWaitOutcome | undefined> {
  for (const slot of earlySlots(ref.early)) {
    const highest = await store.highestPendingRecord({
      workflowId: ref.workflowId,
      key: ref.key,
      slot,
    });
    if (highest.kind !== "found" || highest.record.kind !== "pending") {
      continue;
    }
    const outcome = pendingOutcome(highest.record, ref);
    if (outcome) return outcome;
  }
  return undefined;
}

export async function takePendingSignal(
  store: Pick<PendingSignalRecords, "highestPendingRecord"> & {
    settle(outcome: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>>;
    pendingTaken?: PendingSignalTakenListener;
  },
  ref: EarlyWaitRef,
): Promise<StoredWaitRecord<WaitOutcome>> {
  const outcome = await applicablePendingOutcome(store, ref);
  if (!outcome) return { kind: "absent" };
  const stored = await store.settle(outcome);
  if (
    store.pendingTaken && stored.kind === "found" &&
    stored.record.kind === "accepted" &&
    stored.record.receipt.id === outcome.receipt.id
  ) {
    // The signal is taken whatever the listener does with the news.
    try {
      store.pendingTaken({
        waitId: ref.waitId,
        workflowId: ref.workflowId,
        runId: ref.runId,
        key: ref.key,
        receiptId: outcome.receipt.id,
      });
    } catch {
      // Nothing to undo: the outcome is stored.
    }
  }
  return stored;
}
