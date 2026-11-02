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
 * claims are created once with putIfAbsent so of two simultaneous claimants
 * exactly one wins; the highest record is never deleted, since a reused number
 * would let two claimants both create a claim
 */

import { z } from "zod";
import { generationFromKey } from "./continuation_claim.ts";
import { isWaitKey, WAIT_KEY_FORM, WaitEarlySchema } from "./signal_wait.ts";
import {
  earliestReceipt,
  earlyWaitRef,
  type PendingSignalRecords,
  type PendingSlot,
  takePendingSignal,
} from "./pending_signal.ts";
import type {
  StoredWaitRecord,
  WaitOutcome,
  WaitRef,
  WaitRegistration,
} from "./signal_wait_records.ts";
import { cancelledOutcome, timedOutOutcome } from "./signal_wait_records.ts";
import type { Workflow } from "./workflow.ts";

export const WAIT_KEY_RECORD_PREFIX = "wait-keys/";

export const WAIT_KEY_RECORD_MAX_BYTES = 16 * 1024;

/**
 * a retry follows only a lost create to a release or an at-once settled claim,
 * so more than two attempts means heavy contention
 */
export const WAIT_KEY_CLAIM_ATTEMPTS = 8;

/**
 * a step registers straight after claiming, so an old claim with neither record
 * names a wait never opened or whose records were removed without the claim
 */
export const WAIT_KEY_UNREGISTERED_GRACE_MS = 5 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isSinglePathSegment(id: string): boolean {
  return id.length > 0 && !/[\\/]/.test(id) && id !== "." && id !== "..";
}

const address = {
  workflowId: z.string().refine(
    isSinglePathSegment,
    "must be a single path segment",
  ),
  key: z.string().refine(isWaitKey),
  generation: z.number().int().min(1),
  recordedAt: z.string().datetime(),
};

export const WaitKeyClaimSchema = z.object({
  kind: z.literal("claim"),
  ...address,
  waitId: z.string().regex(UUID, "must be a lowercase UUID"),
  runId: z.string().uuid(),
  jobName: z.string().min(1),
  stepName: z.string().min(1),
  /** the wait's deadline, so a claimant can settle an overdue holder */
  deadline: z.string().datetime(),
  early: WaitEarlySchema.optional(),
});

export type WaitKeyClaim = z.infer<typeof WaitKeyClaimSchema>;

export const WaitKeyReleaseSchema = z.object({
  kind: z.literal("release"),
  ...address,
});

export type WaitKeyRelease = z.infer<typeof WaitKeyReleaseSchema>;

export const WaitKeyRecordSchema = z.discriminatedUnion("kind", [
  WaitKeyClaimSchema,
  WaitKeyReleaseSchema,
]);

export type WaitKeyRecord = z.infer<typeof WaitKeyRecordSchema>;

export type WaitKeyAddress = Pick<
  WaitKeyRecord,
  "workflowId" | "key" | "generation"
>;

export function waitKeyWorkflowPrefix(workflowId: string): string {
  if (!isSinglePathSegment(workflowId)) {
    throw new Error(
      `Not a workflow id a wait key can be kept under: ${workflowId}`,
    );
  }
  return `${WAIT_KEY_RECORD_PREFIX}${workflowId}/`;
}

export function waitKeyPrefix(workflowId: string, key: string): string {
  if (!isWaitKey(key)) {
    throw new Error(`A wait key must be ${WAIT_KEY_FORM}, got ${key}.`);
  }
  return `${waitKeyWorkflowPrefix(workflowId)}${key}/`;
}

export function waitKeyRecordKey(at: WaitKeyAddress): string {
  if (!Number.isInteger(at.generation) || at.generation < 1) {
    throw new Error(`Not a wait key generation: ${at.generation}`);
  }
  return `${waitKeyPrefix(at.workflowId, at.key)}${at.generation}`;
}

export function waitKeyAddressFromKey(
  storeKey: string,
): WaitKeyAddress | undefined {
  if (!storeKey.startsWith(WAIT_KEY_RECORD_PREFIX)) return undefined;
  const parts = storeKey.slice(WAIT_KEY_RECORD_PREFIX.length).split("/");
  if (parts.length !== 3) return undefined;
  const [workflowId, key] = parts;
  const generation = generationFromKey(storeKey);
  if (
    generation === undefined || !isSinglePathSegment(workflowId) ||
    !isWaitKey(key)
  ) return undefined;
  return { workflowId, key, generation };
}

export function encodeWaitKeyRecord(record: WaitKeyRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/**
 * a record that is too large, unparseable, or at another address than it is
 * stored under is unreadable, never absent
 */
export function decodeWaitKeyRecord(
  bytes: Uint8Array | null,
  expected: WaitKeyAddress,
): StoredWaitRecord<WaitKeyRecord> {
  if (bytes === null) return { kind: "absent" };
  if (bytes.byteLength > WAIT_KEY_RECORD_MAX_BYTES) {
    return { kind: "unreadable" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: "unreadable" };
  }
  const parsed = WaitKeyRecordSchema.safeParse(raw);
  if (!parsed.success) return { kind: "unreadable" };
  const record = parsed.data;
  // A claim reads the pending slots of its own generation and no other.
  if (
    record.kind === "claim" && record.early !== undefined &&
    record.early.generation !== record.generation
  ) return { kind: "unreadable" };
  return record.workflowId === expected.workflowId &&
      record.key === expected.key &&
      record.generation === expected.generation
    ? { kind: "found", record }
    : { kind: "unreadable" };
}

export function waitRefOfClaim(claim: WaitKeyClaim): WaitRef {
  return {
    waitId: claim.waitId,
    workflowId: claim.workflowId,
    runId: claim.runId,
    deadline: claim.deadline,
    key: claim.key,
    ...(claim.early !== undefined ? { early: claim.early } : {}),
  };
}

export type KeyHolding =
  | { readonly held: false }
  | { readonly held: true; readonly claim: WaitKeyClaim };

/**
 * a wait with an outcome of any kind, even an unreadable one, does not hold the
 * key: an outcome is written once, so it can take no signal
 */
export function decideKeyHolder(
  highest: WaitKeyRecord | undefined,
  outcome: StoredWaitRecord<WaitOutcome>,
): KeyHolding {
  if (highest === undefined || highest.kind === "release") {
    return { held: false };
  }
  return outcome.kind === "absent"
    ? { held: true, claim: highest }
    : { held: false };
}

export function declaredWaitKeyStep(
  workflow: Workflow,
  key: string,
): { jobName: string; stepName: string } | undefined {
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task?.data;
      if (task?.type === "wait_for_signal" && task.key === key) {
        return { jobName: job.name, stepName: step.name };
      }
    }
  }
  return undefined;
}

/**
 * generations only grow and each is written once, so two reads answer what
 * listing every key record would; unreadable means the caller knows nothing
 * about who reads the slot
 */
export async function claimsReadingSlot(
  store: Pick<WaitKeyRecords, "findKeyRecord">,
  at: PendingSlot,
  known?: WaitKeyRecord,
): Promise<{ claims: WaitKeyClaim[]; unreadable: boolean }> {
  const claims: WaitKeyClaim[] = [];
  let unreadable = false;
  for (const generation of [at.slot, at.slot + 1]) {
    const stored: StoredWaitRecord<WaitKeyRecord> =
      known?.generation === generation
        ? { kind: "found", record: known }
        : await store.findKeyRecord({
          workflowId: at.workflowId,
          key: at.key,
          generation,
        });
    if (stored.kind === "unreadable") unreadable = true;
    if (stored.kind !== "found" || stored.record.kind !== "claim") continue;
    if (generation === at.slot || stored.record.early?.overRelease === true) {
      claims.push(stored.record);
    }
  }
  return { claims, unreadable };
}

export type HighestKeyRecord =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly record: WaitKeyRecord }
  | { readonly kind: "unreadable"; readonly generation: number };

export interface WaitKeyRecords
  extends Pick<PendingSignalRecords, "highestPendingRecord"> {
  highestKeyRecord(workflowId: string, key: string): Promise<HighestKeyRecord>;

  /**
   * learn whether you won by comparing the returned record with your own, never
   * from the create itself
   */
  createKeyRecord(
    record: WaitKeyRecord,
  ): Promise<StoredWaitRecord<WaitKeyRecord>>;

  findKeyRecord(at: WaitKeyAddress): Promise<StoredWaitRecord<WaitKeyRecord>>;

  listKeyRecords(): Promise<WaitKeyRecord[]>;

  removeKeyRecord(at: WaitKeyAddress): Promise<void>;

  removeKeyRecordsOfWorkflow(workflowId: string): Promise<void>;

  findOutcome(waitId: string): Promise<StoredWaitRecord<WaitOutcome>>;

  settle(outcome: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>>;

  findRegistration(
    waitId: string,
  ): Promise<StoredWaitRecord<WaitRegistration>>;
}

export interface WaitKeyRequest {
  workflowId: string;
  key: string;
  waitId: string;
  runId: string;
  jobName: string;
  stepName: string;
  deadline: string;
  acceptEarly?: number;
}

export type WaitKeyAcquisition =
  | { readonly kind: "acquired"; readonly claim: WaitKeyClaim }
  /**
   * the step's process stopped after claiming and before the run was saved; the
   * step takes that open wait over
   */
  | { readonly kind: "own"; readonly claim: WaitKeyClaim }
  | { readonly kind: "held"; readonly claim: WaitKeyClaim }
  | { readonly kind: "unreadable"; readonly generation: number }
  | { readonly kind: "contended" };

export function waitKeyRefusal(
  key: string,
  refusal: Exclude<WaitKeyAcquisition, { kind: "acquired" | "own" }>,
): string {
  switch (refusal.kind) {
    case "held":
      return `key ${key} is held by the open wait ${refusal.claim.waitId} of step ${refusal.claim.stepName} in run ${refusal.claim.runId}`;
    case "unreadable":
      return `record ${refusal.generation} of key ${key} cannot be read, so its holder is unknown`;
    case "contended":
      return `key ${key} was claimed by other waits ${WAIT_KEY_CLAIM_ATTEMPTS} times in a row`;
  }
}

/**
 * the claim does not hold the schema the wait captured, so giving it the
 * pending signal needs the wait's registration; without one nothing is taken
 */
async function outcomeOfClaim(
  store: WaitKeyRecords,
  claim: WaitKeyClaim,
  now: Date,
): Promise<StoredWaitRecord<WaitOutcome>> {
  const ref = waitRefOfClaim(claim);
  const own = (
    stored: StoredWaitRecord<WaitOutcome>,
  ): StoredWaitRecord<WaitOutcome> =>
    stored.kind === "found" && stored.record.runId !== ref.runId
      ? { kind: "unreadable" }
      : stored;
  const stored = own(await store.findOutcome(ref.waitId));
  if (stored.kind !== "absent") return stored;
  if (claim.early !== undefined) {
    const registration = await store.findRegistration(claim.waitId);
    const early = registration.kind === "found" &&
        registration.record.workflowId === claim.workflowId &&
        registration.record.key === claim.key
      ? earlyWaitRef({
        ...ref,
        schema: registration.record.schema,
        workflowName: registration.record.workflowName,
      })
      : undefined;
    if (early) {
      const taken = own(await takePendingSignal(store, early));
      if (taken.kind !== "absent") return taken;
    }
  }
  if (now.getTime() <= new Date(ref.deadline).getTime()) return stored;
  return own(await store.settle(timedOutOutcome(ref, now)));
}

/**
 * the once-created outcome makes this safe, not the clock: a slow step that
 * registers later holds an already closed wait, so two waits are never open
 * under one key; an unreadable registration is left
 */
async function settleAbandoned(
  store: WaitKeyRecords,
  claim: WaitKeyClaim,
  now: Date,
): Promise<boolean> {
  const age = now.getTime() - new Date(claim.recordedAt).getTime();
  if (!(age > WAIT_KEY_UNREGISTERED_GRACE_MS)) return false;
  if ((await store.findRegistration(claim.waitId)).kind !== "absent") {
    return false;
  }
  const stored = await store.settle(
    cancelledOutcome(waitRefOfClaim(claim), now),
  );
  return stored.kind !== "absent";
}

/**
 * called before the wait is registered, so a step that finds its key held opens
 * nothing
 */
export async function claimWaitKey(
  store: WaitKeyRecords,
  request: WaitKeyRequest,
  now: Date,
): Promise<WaitKeyAcquisition> {
  for (let attempt = 0; attempt < WAIT_KEY_CLAIM_ATTEMPTS; attempt++) {
    const highest = await store.highestKeyRecord(
      request.workflowId,
      request.key,
    );
    if (highest.kind === "unreadable") return highest;
    const record = highest.kind === "found" ? highest.record : undefined;
    const holding = decideKeyHolder(
      record,
      record?.kind === "claim"
        ? await outcomeOfClaim(store, record, now)
        : { kind: "absent" },
    );
    if (holding.held) {
      // a claim whose outcome is gone with its run was superseded first, so a
      // holder still the highest record is an open wait
      const still = await store.highestKeyRecord(
        request.workflowId,
        request.key,
      );
      if (
        still.kind !== "found" ||
        still.record.generation !== holding.claim.generation
      ) continue;
      const mine = holding.claim.runId === request.runId &&
        holding.claim.jobName === request.jobName &&
        holding.claim.stepName === request.stepName;
      if (mine) return { kind: "own", claim: holding.claim };
      if (await settleAbandoned(store, holding.claim, now)) continue;
      return { kind: "held", claim: holding.claim };
    }

    const claim: WaitKeyClaim = {
      kind: "claim",
      workflowId: request.workflowId,
      key: request.key,
      generation: (record?.generation ?? 0) + 1,
      recordedAt: now.toISOString(),
      waitId: request.waitId,
      runId: request.runId,
      jobName: request.jobName,
      stepName: request.stepName,
      deadline: request.deadline,
      ...(request.acceptEarly !== undefined
        ? {
          early: {
            generation: (record?.generation ?? 0) + 1,
            overRelease: record?.kind === "release",
            from: earliestReceipt(now, request.acceptEarly),
          },
        }
        : {}),
    };
    const stored = await store.createKeyRecord(claim);
    if (
      stored.kind === "found" && stored.record.kind === "claim" &&
      stored.record.waitId === claim.waitId
    ) return { kind: "acquired", claim: stored.record };
    // another claimant or a release took the generation: read again, where an
    // open claim holds the key and anything else leaves it free
  }
  return { kind: "contended" };
}

export type KeyHolderLookup =
  | { readonly kind: "held"; readonly claim: WaitKeyClaim }
  | { readonly kind: "free" }
  | { readonly kind: "unreadable"; readonly generation: number };

/**
 * writes nothing: a holder past its deadline with no outcome is still the
 * holder, and whoever acts on the wait settles it
 */
export async function findKeyHolder(
  store: Pick<WaitKeyRecords, "highestKeyRecord" | "findOutcome">,
  workflowId: string,
  key: string,
): Promise<KeyHolderLookup> {
  if (!isSinglePathSegment(workflowId) || !isWaitKey(key)) {
    return { kind: "free" };
  }
  let highest = await store.highestKeyRecord(workflowId, key);
  for (let attempt = 0; attempt < WAIT_KEY_CLAIM_ATTEMPTS; attempt++) {
    if (highest.kind === "unreadable") return highest;
    const record = highest.kind === "found" ? highest.record : undefined;
    if (record?.kind !== "claim") return { kind: "free" };
    const stored = await store.findOutcome(record.waitId);
    const holding = decideKeyHolder(
      record,
      // An outcome that names another run is not that wait's outcome.
      stored.kind === "found" && stored.record.runId !== record.runId
        ? { kind: "unreadable" }
        : stored,
    );
    if (!holding.held) return { kind: "free" };
    // a claim whose outcome is gone with its run was superseded first, so a
    // holder still the highest record is an open wait
    const still = await store.highestKeyRecord(workflowId, key);
    if (
      still.kind === "found" &&
      still.record.generation === holding.claim.generation
    ) return { kind: "held", claim: holding.claim };
    highest = still;
  }
  // superseded on every read: no wait held the key long enough to be named, and
  // the next signal reads again
  return { kind: "free" };
}

/**
 * reads two records and writes nothing, for a signal by key that found no open
 * wait and must say whether an earlier signal already landed
 */
export async function findSettledKeyHolder(
  store: Pick<WaitKeyRecords, "highestKeyRecord" | "findOutcome">,
  workflowId: string,
  key: string,
): Promise<{ claim: WaitKeyClaim; outcome: WaitOutcome } | undefined> {
  if (!isSinglePathSegment(workflowId) || !isWaitKey(key)) return undefined;
  const highest = await store.highestKeyRecord(workflowId, key);
  if (highest.kind !== "found" || highest.record.kind !== "claim") {
    return undefined;
  }
  const claim = highest.record;
  const stored = await store.findOutcome(claim.waitId);
  // An outcome that names another run is not that wait's outcome.
  return stored.kind === "found" && stored.record.runId === claim.runId
    ? { claim, outcome: stored.record }
    : undefined;
}

export interface KeyClaimRemoval {
  removed: number;
  released: number;
}

/**
 * a highest claim is superseded by a release first so its number is never
 * reused; call before the runs' outcomes are removed, since a claim whose
 * outcome is gone reads as an open wait
 */
export async function releaseKeyClaims(
  store:
    & Pick<
      WaitKeyRecords,
      | "highestKeyRecord"
      | "createKeyRecord"
      | "listKeyRecords"
      | "removeKeyRecord"
    >
    & Pick<
      PendingSignalRecords,
      "listPendingAddresses" | "removePendingRecord"
    >,
  shouldRemove: (claim: WaitKeyClaim) => boolean | Promise<boolean>,
  now: Date,
): Promise<KeyClaimRemoval> {
  const result: KeyClaimRemoval = { removed: 0, released: 0 };
  const orphanedSlots = new Set<string>();
  const byKey = new Map<string, WaitKeyRecord[]>();
  for (const record of await store.listKeyRecords()) {
    const id = `${record.workflowId}/${record.key}`;
    byKey.set(id, [...(byKey.get(id) ?? []), record]);
  }
  for (const records of byKey.values()) {
    const selected: WaitKeyRecord[] = [];
    for (const record of records) {
      if (record.kind === "release" || await shouldRemove(record)) {
        selected.push(record);
      }
    }
    if (selected.length === 0) continue;
    const { workflowId, key } = records[0];
    const highest = await store.highestKeyRecord(workflowId, key);
    if (highest.kind !== "found") continue;
    let floor = highest.record.generation;
    if (
      highest.record.kind === "claim" &&
      selected.some((record) => record.generation === floor)
    ) {
      const release: WaitKeyRelease = {
        kind: "release",
        workflowId,
        key,
        generation: floor + 1,
        recordedAt: now.toISOString(),
      };
      // Whatever holds the next generation supersedes the claim: this
      // release, or a claim that got there first.
      const stored = await store.createKeyRecord(release);
      if (stored.kind === "absent") continue;
      if (
        stored.kind === "found" && stored.record.kind === "release" &&
        stored.record.recordedAt === release.recordedAt
      ) result.released++;
      floor++;
    }
    for (const record of selected) {
      if (record.generation >= floor) continue;
      await store.removeKeyRecord(record);
      result.removed++;
      if (record.kind !== "claim") continue;
      orphanedSlots.add(`${workflowId}/${key}/${record.generation}`);
      if (record.early?.overRelease) {
        orphanedSlots.add(`${workflowId}/${key}/${record.generation - 1}`);
      }
    }
  }
  if (orphanedSlots.size > 0) {
    for (const at of await store.listPendingAddresses()) {
      if (orphanedSlots.has(`${at.workflowId}/${at.key}/${at.slot}`)) {
        await store.removePendingRecord(at);
      }
    }
  }
  return result;
}
