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
 * the run record is changed only by a resume applying the stored outcome, so
 * delivering a signal never races a save of the run; both records are
 * plaintext, so each is validated on every read
 */

import { z } from "zod";
import { RequiredInputsSchemaSchema } from "../definitions/definition.ts";
import {
  isWaitKey,
  type SignalReceipt,
  SignalReceiptSchema,
  SignalWait,
  type WaitEarly,
  WaitEarlySchema,
} from "./signal_wait.ts";

export const WAIT_REGISTRATION_PREFIX = "waits/";

export const WAIT_OUTCOME_PREFIX = "wait-outcomes/";

/**
 * a registration holds a schema and an outcome a payload of at most 16 KiB, so
 * a larger record was not written by swamp
 */
export const WAIT_RECORD_MAX_BYTES = 256 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * returns undefined for anything not a UUID, so no typed value ever becomes
 * part of a key
 */
export function normalizeWaitId(raw: string): string | undefined {
  const id = raw.trim().toLowerCase();
  return UUID.test(id) ? id : undefined;
}

function requireWaitId(waitId: string): string {
  const id = normalizeWaitId(waitId);
  if (id === undefined) throw new Error(`Not a wait id: ${waitId}`);
  return id;
}

export function waitRegistrationKey(waitId: string): string {
  return `${WAIT_REGISTRATION_PREFIX}${requireWaitId(waitId)}`;
}

export function waitOutcomeKey(waitId: string): string {
  return `${WAIT_OUTCOME_PREFIX}${requireWaitId(waitId)}`;
}

export function waitIdFromKey(key: string): string | undefined {
  for (const prefix of [WAIT_REGISTRATION_PREFIX, WAIT_OUTCOME_PREFIX]) {
    if (key.startsWith(prefix)) {
      return normalizeWaitId(key.slice(prefix.length));
    }
  }
  return undefined;
}

const LowercaseUuid = z.string().regex(UUID, "must be a lowercase UUID");

/**
 * the id is used to find the run and a record comes from a store other writers
 * can reach, so it must not name a path outside the runs directory
 */
const WorkflowIdInRecord = z.string().min(1).refine(
  (id) => !/[\\/]/.test(id) && id !== "." && id !== "..",
  "must be a single path segment",
);

export const WaitRegistrationSchema = z.object({
  kind: z.literal("signal"),
  waitId: LowercaseUuid,
  workflowId: WorkflowIdInRecord,
  workflowName: z.string().min(1),
  runId: z.string().uuid(),
  jobName: z.string().min(1),
  stepName: z.string().min(1),
  deadline: z.string().datetime(),
  schema: RequiredInputsSchemaSchema,
  registeredAt: z.string().datetime(),
  key: z.string().refine(isWaitKey).optional(),
  early: WaitEarlySchema.optional(),
});

export type WaitRegistration = z.infer<typeof WaitRegistrationSchema>;

// What every outcome carries, so a sweep can judge one without its
// registration.
const outcomeBase = {
  waitId: LowercaseUuid,
  workflowId: WorkflowIdInRecord,
  runId: z.string().uuid(),
  deadline: z.string().datetime(),
  settledAt: z.string().datetime(),
};

/** How a wait was settled. Written once; the first writer wins. */
export const WaitOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("accepted"),
    ...outcomeBase,
    receipt: SignalReceiptSchema,
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("timed_out"), ...outcomeBase }),
  z.object({ kind: z.literal("cancelled"), ...outcomeBase }),
]);

export type WaitOutcome = z.infer<typeof WaitOutcomeSchema>;

export type AcceptedWaitOutcome = Extract<WaitOutcome, { kind: "accepted" }>;

/**
 * key, early and schema are carried for acceptEarly waits so the settler can
 * give the key's pending signal first, and no outcome stores them
 */
export interface WaitRef {
  waitId: string;
  workflowId: string;
  workflowName?: string;
  runId: string;
  deadline: string;
  key?: string;
  early?: WaitEarly;
  schema?: WaitRegistration["schema"];
}

export type StoredWaitRecord<T> =
  | { readonly kind: "found"; readonly record: T }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

export function encodeWaitRecord(
  record: WaitRegistration | WaitOutcome,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

function decode<T>(
  bytes: Uint8Array | null,
  schema: z.ZodType<T>,
  waitId: string,
): StoredWaitRecord<T> {
  if (bytes === null) return { kind: "absent" };
  if (bytes.length > WAIT_RECORD_MAX_BYTES) return { kind: "unreadable" };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: "unreadable" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { kind: "unreadable" };
  // A record stored under one wait's key that names another is not that
  // wait's record.
  if ((parsed.data as { waitId: string }).waitId !== waitId.toLowerCase()) {
    return { kind: "unreadable" };
  }
  return { kind: "found", record: parsed.data };
}

export function decodeWaitRegistration(
  bytes: Uint8Array | null,
  waitId: string,
): StoredWaitRecord<WaitRegistration> {
  return decode(bytes, WaitRegistrationSchema, waitId);
}

/**
 * a payload that does not survive parsing unchanged (a dropped __proto__ key)
 * is unreadable, since a payload a signal could never have sent must not be
 * applied in part
 */
export function decodeWaitOutcome(
  bytes: Uint8Array | null,
  waitId: string,
): StoredWaitRecord<WaitOutcome> {
  const stored = decode(bytes, WaitOutcomeSchema, waitId);
  if (stored.kind !== "found" || stored.record.kind !== "accepted") {
    return stored;
  }
  const raw = JSON.parse(new TextDecoder().decode(bytes!)) as {
    payload: unknown;
  };
  return JSON.stringify(raw.payload) === JSON.stringify(stored.record.payload)
    ? stored
    : { kind: "unreadable" };
}

export function registrationOf(
  at: {
    workflowId: string;
    workflowName: string;
    runId: string;
    jobName: string;
    stepName: string;
  },
  wait: SignalWait,
  now: Date,
): WaitRegistration {
  return {
    kind: "signal",
    waitId: wait.id,
    workflowId: at.workflowId,
    workflowName: at.workflowName,
    runId: at.runId,
    jobName: at.jobName,
    stepName: at.stepName,
    deadline: wait.deadline.toISOString(),
    schema: structuredClone(wait.schema),
    registeredAt: now.toISOString(),
    ...(wait.key !== undefined ? { key: wait.key } : {}),
    ...(wait.early !== undefined ? { early: { ...wait.early } } : {}),
  };
}

export function timedOutOutcome(ref: WaitRef, now: Date): WaitOutcome {
  return { kind: "timed_out", ...pick(ref), settledAt: now.toISOString() };
}

export function cancelledOutcome(ref: WaitRef, now: Date): WaitOutcome {
  return { kind: "cancelled", ...pick(ref), settledAt: now.toISOString() };
}

function pick(ref: WaitRef): WaitRef {
  return {
    waitId: ref.waitId,
    workflowId: ref.workflowId,
    runId: ref.runId,
    deadline: ref.deadline,
  };
}

export function isWaitExpired(ref: { deadline: string }, now: Date): boolean {
  return now.getTime() > new Date(ref.deadline).getTime();
}

export type SignalDecisionRefusal =
  | { readonly kind: "expired"; readonly deadline: Date }
  | { readonly kind: "invalid_payload"; readonly errors: string[] };

export type SignalDecision =
  | { readonly accepted: true; readonly outcome: AcceptedWaitOutcome }
  | { readonly accepted: false; readonly refusal: SignalDecisionRefusal };

function waitOf(registration: {
  waitId: string;
  schema: WaitRegistration["schema"];
  deadline: string;
}): SignalWait {
  return SignalWait.fromData({
    kind: "signal",
    id: registration.waitId,
    schema: registration.schema,
    deadline: registration.deadline,
  });
}

/**
 * nothing is stored here; the returned outcome holds the wait only once it has
 * been created in the store
 */
export function decideSignal(
  registration: WaitRegistration,
  payload: unknown,
  submittedBy: string,
  now: Date,
  idempotencyKey?: string,
): SignalDecision {
  if (isWaitExpired(registration, now)) {
    return {
      accepted: false,
      refusal: { kind: "expired", deadline: new Date(registration.deadline) },
    };
  }
  const validation = waitOf(registration).validatePayload(payload);
  if (!validation.valid) {
    return {
      accepted: false,
      refusal: { kind: "invalid_payload", errors: validation.errors },
    };
  }
  const receipt: SignalReceipt = {
    id: crypto.randomUUID(),
    waitId: registration.waitId,
    receivedAt: now.toISOString(),
    submittedBy,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
  return {
    accepted: true,
    outcome: {
      kind: "accepted",
      ...pick(registration),
      settledAt: now.toISOString(),
      receipt,
      payload: validation.payload,
    },
  };
}
