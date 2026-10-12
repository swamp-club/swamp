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
 * Pending signals: a signal by key that arrived while no wait held the key,
 * kept for the next wait of a step that sets `acceptEarly` (swamp-club#3212).
 *
 * A pending signal is stored in a _slot_, the generation the next claim of
 * its key will have, under a number that counts the pending signals of that
 * slot. Each record is created once with `putIfAbsent`. A slot belongs to one
 * claim, so a signal a wait took is never taken by a later wait, and neither
 * a slot nor a number comes back into use: key generations do not, and the
 * highest record of a slot is never deleted to be replaced. A pending signal
 * no wait took is superseded by a _lapse_, the next number of the same slot,
 * which holds no payload.
 *
 * Every record is plaintext in a store other writers can reach, so each is
 * validated on every read.
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

/** Key family: `wait-pending/<workflowId>/<key>/<slot>/<number>`. */
export const PENDING_SIGNAL_PREFIX = "wait-pending/";

/** The largest pending record read back, in bytes: a payload is at most 16 KiB. */
export const PENDING_SIGNAL_MAX_BYTES = 64 * 1024;

/**
 * How long after its age limit a pending signal no wait took is kept before
 * the sweep lapses it. The limit is judged by the sweeper's clock against a
 * time another host stamped, so the margin is wide.
 */
export const PENDING_SIGNAL_LAPSE_GRACE_MS = 24 * 60 * 60 * 1000;

/** True for a workflow id that is one path segment, as a key needs. */
function isSinglePathSegment(id: string): boolean {
  return id.length > 0 && !/[\\/]/.test(id) && id !== "." && id !== "..";
}

const address = {
  workflowId: z.string().refine(
    isSinglePathSegment,
    "must be a single path segment",
  ),
  key: z.string().refine(isWaitKey),
  /** The generation of the key claim the record is meant for. */
  slot: z.number().int().min(1),
  /** 1 for the first record of a slot; each later record adds one. */
  number: z.number().int().min(1),
};

/** A signal held for the next wait of its key. */
export const PendingSignalSchema = z.object({
  kind: z.literal("pending"),
  ...address,
  /** The ID of the receipt the sender was given, and the wait's outcome keeps. */
  receiptId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  submittedBy: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  /** The age limit the definition declared when the signal arrived, in seconds. */
  acceptEarly: z.number().positive().max(SIGNAL_ACCEPT_EARLY_MAX_SECONDS),
  /**
   * The workflow name the sender was authorized to signal, when the signal
   * came through a caller that authorizes. Workflow IDs are not unique and a
   * workflow can be renamed while a run of it is in flight, so only a wait
   * whose run recorded this name takes the signal: the sender was never
   * authorized for a wait under another.
   */
  authorizedFor: z.string().min(1).optional(),
  /** The idempotency key the sender gave, if any; the receipt keeps it. */
  idempotencyKey: z.string().refine(isIdempotencyKey).optional(),
});

export type PendingSignal = z.infer<typeof PendingSignalSchema>;

/** The record that supersedes a pending signal no wait took. */
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

/** Where one pending record lives. */
export type PendingAddress = Pick<
  PendingRecord,
  "workflowId" | "key" | "slot" | "number"
>;

/** A slot of a key. */
export type PendingSlot = Pick<PendingRecord, "workflowId" | "key" | "slot">;

function requirePositiveInteger(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Not a pending signal ${what}: ${value}`);
  }
  return value;
}

/** The key prefix of every pending record of a workflow. Throws for an id that is not one path segment. */
export function pendingWorkflowPrefix(workflowId: string): string {
  if (!isSinglePathSegment(workflowId)) {
    throw new Error(
      `Not a workflow id a pending signal can be kept under: ${workflowId}`,
    );
  }
  return `${PENDING_SIGNAL_PREFIX}${workflowId}/`;
}

/** The key prefix of the records of one slot. Throws for a malformed key. */
export function pendingSlotPrefix(at: PendingSlot): string {
  if (!isWaitKey(at.key)) {
    throw new Error(`A wait key must be ${WAIT_KEY_FORM}, got ${at.key}.`);
  }
  return `${pendingWorkflowPrefix(at.workflowId)}${at.key}/${
    requirePositiveInteger(at.slot, "slot")
  }/`;
}

/** The store key of one pending record. */
export function pendingRecordKey(at: PendingAddress): string {
  return `${pendingSlotPrefix(at)}${
    requirePositiveInteger(at.number, "number")
  }`;
}

/** The address a store key of this family names, or undefined. */
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
 * Reads the record stored at `expected`. A record that is too large, does
 * not parse, or names another address than the one it is stored under is
 * unreadable, never absent. So is a payload that does not survive parsing
 * unchanged: parsing drops a key such as `__proto__`, and a payload a signal
 * could never have sent must not be taken in part.
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

/** The highest record of a slot as read back. */
export type HighestPendingRecord =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly record: PendingRecord }
  /** The highest number is stored and cannot be read. */
  | { readonly kind: "unreadable"; readonly number: number };

/** The store operations pending signals need. */
export interface PendingSignalRecords {
  /** The record of the highest number of a slot. */
  highestPendingRecord(at: PendingSlot): Promise<HighestPendingRecord>;

  /**
   * Creates `record` unless its number exists, and returns what is stored at
   * that number. The caller learns whether it won by comparing that record
   * with its own, never from the create itself.
   */
  createPendingRecord(
    record: PendingRecord,
  ): Promise<StoredWaitRecord<PendingRecord>>;

  findPendingRecord(
    at: PendingAddress,
  ): Promise<StoredWaitRecord<PendingRecord>>;

  /** The address of every pending record, readable or not. */
  listPendingAddresses(): Promise<PendingAddress[]>;

  removePendingRecord(at: PendingAddress): Promise<void>;

  /** Removes every pending record of a workflow, with the workflow. */
  removePendingRecordsOfWorkflow(workflowId: string): Promise<void>;
}

/** A wait that can be given its key's pending signal. */
export interface EarlyWaitRef extends WaitRef {
  key: string;
  early: WaitEarly;
  schema: WaitRegistration["schema"];
}

/** `ref` as an {@link EarlyWaitRef} when its step set `acceptEarly`. */
export function earlyWaitRef(ref: WaitRef): EarlyWaitRef | undefined {
  return ref.key !== undefined && ref.early !== undefined &&
      ref.schema !== undefined
    ? ref as EarlyWaitRef
    : undefined;
}

/**
 * The earliest time a signal may have been received to be taken by a wait
 * whose key was claimed at `claimedAt` by a step with `acceptEarly` seconds.
 */
export function earliestReceipt(claimedAt: Date, acceptEarly: number): string {
  return new Date(claimedAt.getTime() - acceptEarly * 1000).toISOString();
}

/** True while `pending` is within its own age limit at `now`. */
export function isPendingHeld(pending: PendingSignal, now: Date): boolean {
  return now.getTime() <= heldUntil(pending).getTime();
}

/** When the age limit of `pending` ends. */
export function heldUntil(pending: PendingSignal): Date {
  return new Date(
    new Date(pending.receivedAt).getTime() + pending.acceptEarly * 1000,
  );
}

/**
 * True when `pending` is in a slot the wait reads and was received no
 * earlier than the wait allows and no later than its deadline. `wait` is the
 * wait itself or the claim of its key: both keep `early` and the deadline, so
 * a signaller that finds only the claim decides this part as the step will
 * (swamp-club#3307). {@link pendingOutcome} decides the rest.
 */
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
 * The outcome a pending signal gives a wait, or undefined when it does not
 * apply. Decided from stored facts alone, so every reader reaches the same
 * answer whenever it looks: the record names the wait's workflow and key in a
 * slot the wait's claim reads, the wait's run recorded the workflow name its
 * sender was authorized for, it was received no earlier than the wait
 * allows and no later than its deadline, and the schema the wait captured
 * allows the payload. The outcome is the same whoever builds it.
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
    },
    payload: validation.payload,
  };
}

/**
 * Gives a wait the pending signal of its key, if one applies, by creating
 * the wait's outcome, and returns the outcome that is stored: `absent` when
 * no pending signal applies and nothing settled the wait. The wait's own
 * slot is read first. A slot whose highest record cannot be read gives
 * nothing.
 */
export async function takePendingSignal(
  store: Pick<PendingSignalRecords, "highestPendingRecord"> & {
    settle(outcome: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>>;
  },
  ref: EarlyWaitRef,
): Promise<StoredWaitRecord<WaitOutcome>> {
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
    if (outcome) return await store.settle(outcome);
  }
  return { kind: "absent" };
}
