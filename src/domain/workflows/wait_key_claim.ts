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
 * Wait keys: a name a `wait_for_signal` step declares, held by at most one
 * open wait of its workflow at a time (swamp-club#3209).
 *
 * A _claim_ says which wait holds a key. Claims of one key are numbered and
 * each is created once with `putIfAbsent`, so two steps that claim a free
 * key at the same moment create the same generation and exactly one
 * succeeds. The holder of a key is the wait of its highest claim for as
 * long as that wait has no outcome.
 *
 * The highest record of a key is never deleted to be replaced: a number
 * that came back into use would let a claimant that read the old highest
 * and one that read after the delete both create a claim. The claim of a
 * deleted run is superseded first by a _release_, the next generation of
 * the same family, which names no wait and leaves the key free.
 *
 * Every record is plaintext in a store other writers can reach, so each is
 * validated on every read.
 */

import { z } from "zod";
import { generationFromKey } from "./continuation_claim.ts";
import { isWaitKey, WAIT_KEY_FORM } from "./signal_wait.ts";
import type {
  StoredWaitRecord,
  WaitOutcome,
  WaitRef,
  WaitRegistration,
} from "./signal_wait_records.ts";
import { cancelledOutcome, timedOutOutcome } from "./signal_wait_records.ts";
import type { Workflow } from "./workflow.ts";

/** Key family of key records: `wait-keys/<workflowId>/<key>/<generation>`. */
export const WAIT_KEY_RECORD_PREFIX = "wait-keys/";

/** The largest key record read back, in bytes. */
export const WAIT_KEY_RECORD_MAX_BYTES = 16 * 1024;

/**
 * How often a claimant creates the next generation before it gives up. It
 * tries again only after losing a create to a release or to a claim that
 * was settled at once, so more than two attempts means heavy contention.
 */
export const WAIT_KEY_CLAIM_ATTEMPTS = 8;

/**
 * How long a claim may stand with no registration and no outcome before
 * its wait counts as abandoned. A step registers its wait straight after
 * it claims, so a claim this old with neither record names a wait that was
 * never opened, or whose records were removed without the claim: by a
 * process that stopped in between, or by the run garbage collection of a
 * build from before key claims.
 */
export const WAIT_KEY_UNREGISTERED_GRACE_MS = 5 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  /** 1 for the first record of a key; each later record adds one. */
  generation: z.number().int().min(1),
  recordedAt: z.string().datetime(),
};

/** The record that a wait holds a key. */
export const WaitKeyClaimSchema = z.object({
  kind: z.literal("claim"),
  ...address,
  waitId: z.string().regex(UUID, "must be a lowercase UUID"),
  runId: z.string().uuid(),
  jobName: z.string().min(1),
  stepName: z.string().min(1),
  /** The deadline of the wait, so a claimant can settle an overdue holder. */
  deadline: z.string().datetime(),
});

export type WaitKeyClaim = z.infer<typeof WaitKeyClaimSchema>;

/** The record that supersedes a removed claim and leaves its key free. */
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

/** Where one key record lives. */
export type WaitKeyAddress = Pick<
  WaitKeyRecord,
  "workflowId" | "key" | "generation"
>;

/** The key prefix of every key record of a workflow. Throws for an id that is not one path segment. */
export function waitKeyWorkflowPrefix(workflowId: string): string {
  if (!isSinglePathSegment(workflowId)) {
    throw new Error(
      `Not a workflow id a wait key can be kept under: ${workflowId}`,
    );
  }
  return `${WAIT_KEY_RECORD_PREFIX}${workflowId}/`;
}

/** The key prefix of the records of one key. Throws for a malformed key. */
export function waitKeyPrefix(workflowId: string, key: string): string {
  if (!isWaitKey(key)) {
    throw new Error(`A wait key must be ${WAIT_KEY_FORM}, got ${key}.`);
  }
  return `${waitKeyWorkflowPrefix(workflowId)}${key}/`;
}

/** The store key of one key record. */
export function waitKeyRecordKey(at: WaitKeyAddress): string {
  if (!Number.isInteger(at.generation) || at.generation < 1) {
    throw new Error(`Not a wait key generation: ${at.generation}`);
  }
  return `${waitKeyPrefix(at.workflowId, at.key)}${at.generation}`;
}

/** The address a store key of this family names, or undefined. */
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
 * Reads the record stored at `expected`. A record that is too large, does
 * not parse, or names another address than the one it is stored under is
 * unreadable, never absent.
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
  return record.workflowId === expected.workflowId &&
      record.key === expected.key &&
      record.generation === expected.generation
    ? { kind: "found", record }
    : { kind: "unreadable" };
}

/** The wait a claim names, as the facts an outcome is built from. */
export function waitRefOfClaim(claim: WaitKeyClaim): WaitRef {
  return {
    waitId: claim.waitId,
    workflowId: claim.workflowId,
    runId: claim.runId,
    deadline: claim.deadline,
  };
}

/** Who holds a key: the wait of a claim, or nobody. */
export type KeyHolding =
  | { readonly held: false }
  | { readonly held: true; readonly claim: WaitKeyClaim };

/**
 * Decides who holds a key from its highest record and the outcome of the
 * wait that record names. The key is free when it has no record, when the
 * highest is a release, and when the claimed wait has an outcome of any
 * kind, one that cannot be read included: an outcome is written once, so
 * such a wait can no longer take a signal. Only a claim whose wait has no
 * outcome holds the key.
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

/**
 * The job and step of the `wait_for_signal` step of `workflow` that declares
 * `key`, or undefined when no step of it does.
 */
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

/** The highest record of a key as read back. */
export type HighestKeyRecord =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly record: WaitKeyRecord }
  /** The highest generation is stored and cannot be read. */
  | { readonly kind: "unreadable"; readonly generation: number };

/** The store operations a claim needs. */
export interface WaitKeyRecords {
  /** The record of the highest generation of a key. */
  highestKeyRecord(workflowId: string, key: string): Promise<HighestKeyRecord>;

  /**
   * Creates `record` unless its generation exists, and returns what is
   * stored at that generation. The caller learns whether it won by
   * comparing that record with its own, never from the create itself.
   */
  createKeyRecord(
    record: WaitKeyRecord,
  ): Promise<StoredWaitRecord<WaitKeyRecord>>;

  /** Every key record that can be read. */
  listKeyRecords(): Promise<WaitKeyRecord[]>;

  removeKeyRecord(at: WaitKeyAddress): Promise<void>;

  /** Removes every key record of a workflow, with the workflow. */
  removeKeyRecordsOfWorkflow(workflowId: string): Promise<void>;

  findOutcome(waitId: string): Promise<StoredWaitRecord<WaitOutcome>>;

  settle(outcome: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>>;

  findRegistration(
    waitId: string,
  ): Promise<StoredWaitRecord<WaitRegistration>>;
}

/** The wait that asks for a key. */
export interface WaitKeyRequest {
  workflowId: string;
  key: string;
  waitId: string;
  runId: string;
  jobName: string;
  stepName: string;
  /** The deadline of the wait, as an ISO timestamp. */
  deadline: string;
}

export type WaitKeyAcquisition =
  /** The key was free and `claim` now names the asking wait. */
  | { readonly kind: "acquired"; readonly claim: WaitKeyClaim }
  /**
   * The asking step already holds the key through an earlier wait that is
   * still open: its process stopped after claiming and before the run was
   * saved. The step takes that wait over.
   */
  | { readonly kind: "own"; readonly claim: WaitKeyClaim }
  /** Another open wait holds the key. */
  | { readonly kind: "held"; readonly claim: WaitKeyClaim }
  /** The highest record of the key cannot be read, so its holder is unknown. */
  | { readonly kind: "unreadable"; readonly generation: number }
  /** Every attempt lost its create to another claimant. */
  | { readonly kind: "contended" };

/** Why a keyed wait was not opened, in words for a log line. */
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
 * The outcome of the wait `claim` names, settling it as timed out first
 * when it has none and its deadline has passed, as every reader of a wait
 * does. An outcome that names another run is not that wait's outcome.
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
  if (
    stored.kind !== "absent" ||
    now.getTime() <= new Date(ref.deadline).getTime()
  ) return stored;
  return own(await store.settle(timedOutOutcome(ref, now)));
}

/**
 * Settles the wait of `claim` as cancelled when it was abandoned: the claim
 * is older than {@link WAIT_KEY_UNREGISTERED_GRACE_MS} and its wait has no
 * registration. True when the wait has an outcome afterwards.
 *
 * The outcome is what makes this safe, not the clock. It is created once,
 * like any other, so a step that was only slow and registers its wait
 * later holds a wait that is already closed: a signal for it is answered
 * closed and a resume fails the step. Two waits are never open under one
 * key. A registration that cannot be read is not absent, and is left.
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
 * Claims a key for a wait, or reports who holds it. Called before the wait
 * is registered, so a step that finds its key held opens nothing.
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
      // A claim reads as held when its outcome is gone with its run, too.
      // Such a claim was superseded before the outcome was removed, so a
      // holder still the highest record is a wait that is open.
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
    };
    const stored = await store.createKeyRecord(claim);
    if (
      stored.kind === "found" && stored.record.kind === "claim" &&
      stored.record.waitId === claim.waitId
    ) return { kind: "acquired", claim: stored.record };
    // Another claimant, or a release, took the generation. Read again: an
    // open claim there holds the key, anything else leaves it free.
  }
  return { kind: "contended" };
}

/** Who holds a key, as a reader that claims nothing finds it. */
export type KeyHolderLookup =
  /** `claim` names the open wait that holds the key. */
  | { readonly kind: "held"; readonly claim: WaitKeyClaim }
  | { readonly kind: "free" }
  /** The highest record of the key cannot be read, so its holder is unknown. */
  | { readonly kind: "unreadable"; readonly generation: number };

/**
 * Finds the wait that holds a key, for a signal addressed by key
 * (swamp-club#3210). It writes nothing: a holder past its deadline with no
 * outcome is still the holder, and whoever acts on the wait settles it, as
 * every reader of a wait does. A workflow id or a key that no record can be
 * kept under holds nothing.
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
    // A claim reads as held when its outcome is gone with its run, too.
    // Such a claim was superseded before the outcome was removed, so a
    // holder still the highest record is a wait that is open.
    const still = await store.highestKeyRecord(workflowId, key);
    if (
      still.kind === "found" &&
      still.record.generation === holding.claim.generation
    ) return { kind: "held", claim: holding.claim };
    highest = still;
  }
  // Superseded on every read: no wait held the key for long enough to be
  // named, and the next signal reads again.
  return { kind: "free" };
}

/**
 * The wait that last held a key and its outcome, when the key's highest
 * record is still that wait's claim: one that was signalled, timed out or
 * cancelled and that no later wait has claimed over. Undefined once the
 * claim is released or its outcome is removed with its run. It reads two
 * records and writes nothing, for a signal by key that found no open wait
 * and has to say whether an earlier signal already landed.
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

/** What superseding and removing claims did. */
export interface KeyClaimRemoval {
  /** Claims and superseded releases deleted. */
  removed: number;
  /** Releases created over a highest claim. */
  released: number;
}

/**
 * Removes the claims `shouldRemove` selects, with the runs they belong to.
 * A selected claim that is the highest of its key is superseded by a
 * release first, so its number is never used again; a release below the
 * highest of its key is removed in the same pass. A key whose highest
 * record cannot be read is left as it is.
 *
 * Call it before the outcomes of those runs are removed: a claim whose
 * outcome is gone reads as an open wait.
 */
export async function releaseKeyClaims(
  store: Pick<
    WaitKeyRecords,
    | "highestKeyRecord"
    | "createKeyRecord"
    | "listKeyRecords"
    | "removeKeyRecord"
  >,
  shouldRemove: (claim: WaitKeyClaim) => boolean | Promise<boolean>,
  now: Date,
): Promise<KeyClaimRemoval> {
  const result: KeyClaimRemoval = { removed: 0, released: 0 };
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
    // Records below `floor` are superseded and safe to delete.
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
    }
  }
  return result;
}
