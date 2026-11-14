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
 * a synced run copy can say suspended after another host resumed; each resume
 * creates a claim for the suspension it consumes in a store every host reads,
 * so an older copy leaves the run alone
 */

import { z } from "zod";
import { UserError } from "../errors.ts";
import type { WorkflowRun } from "./workflow_run.ts";

export const CONTINUATION_CLAIM_PREFIX = "continuations/";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUSPENSION_KEY = /^[0-9a-f]{64}$/;

export const CONTINUATION_CLAIM_MAX_BYTES = 4096;

export const ContinuationClaimSchema = z.object({
  runId: z.string().regex(UUID, "must be a UUID"),
  suspensionKey: z.string().regex(SUSPENSION_KEY, "must be a SHA-256 digest"),
  generation: z.number().int().min(1),
  holder: z.string().min(1).max(256),
  claimedAt: z.string().datetime(),
});

export type ContinuationClaim = z.infer<typeof ContinuationClaimSchema>;

/** written before a cancel aborts the run, so a crash cannot lose it */
export const CancelIntentSchema = z.object({
  runId: z.string().regex(UUID, "must be a UUID"),
  requestedAt: z.string().datetime(),
  reason: z.string().max(512),
});

export type CancelIntent = z.infer<typeof CancelIntentSchema>;

export function continuationCancelKey(runId: string): string {
  return `${continuationRunPrefix(runId)}cancel`;
}

export function encodeCancelIntent(intent: CancelIntent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(intent));
}

/** undefined for a record that is missing, too large or not this run's */
export function decodeCancelIntent(
  bytes: Uint8Array | null,
  runId: string,
): CancelIntent | undefined {
  if (bytes === null || bytes.length > CONTINUATION_CLAIM_MAX_BYTES) {
    return undefined;
  }
  try {
    const parsed = CancelIntentSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return parsed.success && parsed.data.runId.toLowerCase() ===
        runId.toLowerCase()
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function serveHolder(instanceId: string): string {
  return `serve:${instanceId}`;
}

export function serveInstanceOf(holder: string): string | undefined {
  return holder.startsWith("serve:") && holder.length > "serve:".length
    ? holder.slice("serve:".length)
    : undefined;
}

export function localHolder(): string {
  return `local:${crypto.randomUUID()}`;
}

export function continuationRunPrefix(runId: string): string {
  if (!UUID.test(runId)) throw new Error(`Not a run id: ${runId}`);
  return `${CONTINUATION_CLAIM_PREFIX}${runId.toLowerCase()}/`;
}

export function continuationSuspensionPrefix(
  runId: string,
  suspensionKey: string,
): string {
  if (!SUSPENSION_KEY.test(suspensionKey)) {
    throw new Error(`Not a suspension key: ${suspensionKey}`);
  }
  return `${continuationRunPrefix(runId)}${suspensionKey}/`;
}

export function continuationClaimKey(
  claim: Pick<ContinuationClaim, "runId" | "suspensionKey" | "generation">,
): string {
  if (!Number.isInteger(claim.generation) || claim.generation < 1) {
    throw new Error(`Not a claim generation: ${claim.generation}`);
  }
  return `${
    continuationSuspensionPrefix(claim.runId, claim.suspensionKey)
  }${claim.generation}`;
}

export function generationFromKey(key: string): number | undefined {
  const last = key.slice(key.lastIndexOf("/") + 1);
  if (!/^[1-9][0-9]*$/.test(last)) return undefined;
  const generation = Number(last);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

export function encodeContinuationClaim(claim: ContinuationClaim): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(claim));
}

/**
 * undefined for a missing, oversized or non-claim record, or one stored under
 * another key, since other writers can reach the store
 */
export function decodeContinuationClaim(
  bytes: Uint8Array | null,
  expected: Pick<ContinuationClaim, "runId" | "suspensionKey" | "generation">,
): ContinuationClaim | undefined {
  if (bytes === null || bytes.byteLength > CONTINUATION_CLAIM_MAX_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  const result = ContinuationClaimSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const claim = result.data;
  return claim.runId.toLowerCase() === expected.runId.toLowerCase() &&
      claim.suspensionKey === expected.suspensionKey &&
      claim.generation === expected.generation
    ? claim
    : undefined;
}

/**
 * every host derives the same key from the same record; a resume that takes the
 * claim changes at least one step, so the key changes; delivering a signal does
 * not change the record or the key
 */
export async function suspensionKeyOf(run: WorkflowRun): Promise<string> {
  const steps = run.jobs.flatMap((job) =>
    job.steps.map((step) => [
      job.jobName,
      step.stepName,
      step.status,
      step.startedAt?.toISOString() ?? null,
      step.completedAt?.toISOString() ?? null,
      step.signalWait?.id ?? null,
      step.approvalDecision?.decidedAt ?? null,
    ])
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([run.id, run.status, steps])),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface ContinuationClaimStore {
  find(
    runId: string,
    suspensionKey: string,
  ): Promise<ContinuationClaim | undefined>;

  create(claim: ContinuationClaim): Promise<boolean>;

  release(claim: ContinuationClaim): Promise<void>;

  removeForRun(runId: string): Promise<void>;

  /** the latest request replaces an earlier one */
  recordCancel(intent: CancelIntent): Promise<void>;

  findCancel(runId: string): Promise<CancelIntent | undefined>;
}

/**
 * every run is tried so one failure does not keep the others, and the first
 * failure is thrown after the last
 */
export async function removeClaimsOfRuns(
  store: Pick<ContinuationClaimStore, "removeForRun"> | undefined,
  runIds: Iterable<string>,
): Promise<void> {
  if (!store) return;
  const failures: unknown[] = [];
  for (const runId of runIds) {
    if (!UUID.test(runId)) continue;
    try {
      await store.removeForRun(runId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}

export type HolderLiveness = "alive" | "dead" | "unknown";

export interface ContinuationClaims {
  readonly store: ContinuationClaimStore;
  readonly holder: string;
  liveness(holder: string): Promise<HolderLiveness>;
  /**
   * false when the store cannot create a record atomically; a resume then takes
   * no claim
   */
  usable?(): Promise<boolean>;
}

export type ContinuationMode =
  /**
   * only a holder known alive refuses a manual resume; serve is known alive
   * only where it writes a heartbeat (synced datastore), elsewhere the run's
   * lock and record refuse a second resume
   */
  | { readonly kind: "manual" }
  /**
   * another holder's claim is replaced only when it is known dead and takeover
   * is set, which the caller does only when its copy of the run is current
   */
  | { readonly kind: "automatic"; readonly takeover: boolean };

export type ContinuationAcquisition =
  | { readonly kind: "acquired"; readonly claim: ContinuationClaim }
  | {
    readonly kind: "held";
    readonly claim: ContinuationClaim;
    readonly liveness: HolderLiveness;
  };

/**
 * a claim this holder already has is its own: its copy of the run still shows
 * the suspension, so its earlier resume ran nothing
 */
export async function acquireContinuation(
  claims: ContinuationClaims,
  suspension: { runId: string; suspensionKey: string },
  mode: ContinuationMode,
  now: Date,
): Promise<ContinuationAcquisition> {
  const mine = (generation: number): ContinuationClaim => ({
    runId: suspension.runId,
    suspensionKey: suspension.suspensionKey,
    generation,
    holder: claims.holder,
    claimedAt: now.toISOString(),
  });

  let current = await claims.store.find(
    suspension.runId,
    suspension.suspensionKey,
  );
  if (current === undefined) {
    const first = mine(1);
    if (await claims.store.create(first)) {
      return { kind: "acquired", claim: first };
    }
    current = await claims.store.find(
      suspension.runId,
      suspension.suspensionKey,
    );
    // Created by another holder and gone again before it could be read:
    // that holder released it, and the next attempt starts clean.
    if (current === undefined) {
      return { kind: "held", claim: first, liveness: "unknown" };
    }
  }
  if (current.holder === claims.holder) {
    return { kind: "acquired", claim: current };
  }

  const liveness = await claims.liveness(current.holder);
  const replace = mode.kind === "manual"
    ? liveness !== "alive"
    : liveness === "dead" && mode.takeover;
  if (!replace) return { kind: "held", claim: current, liveness };

  const next = mine(current.generation + 1);
  if (await claims.store.create(next)) {
    return { kind: "acquired", claim: next };
  }
  const winner = await claims.store.find(
    suspension.runId,
    suspension.suspensionKey,
  );
  return {
    kind: "held",
    claim: winner ?? next,
    liveness: winner ? await claims.liveness(winner.holder) : "unknown",
  };
}

/**
 * a synced copy can be behind with nothing in it saying so (a peer cancelled or
 * ended the run); rejects when the datastore cannot be read, so an unreachable
 * datastore is never taken for agreement
 */
export type RunRecordCurrency = (
  run: { workflowId: string; runId: string },
) => Promise<boolean>;

export class RunRecordStaleError extends UserError {
  constructor(readonly runId: string) {
    super(
      `This copy of run ${runId} differs from the one in the datastore, so it was not resumed from here. ` +
        `Check the run before trying again (swamp workflow history get ${runId}).`,
    );
    this.name = "RunRecordStaleError";
  }
}

export class ContinuationHeldError extends UserError {
  constructor(
    readonly runId: string,
    readonly holder: string,
    readonly liveness: HolderLiveness,
  ) {
    const instanceId = serveInstanceOf(holder);
    const who = instanceId !== undefined
      ? `swamp serve instance ${instanceId}`
      : "another swamp command";
    super(
      `Run ${runId} is already being resumed by ${who}, or was resumed by it and this copy of the run is out of date. ` +
        `Check the run before trying again (swamp workflow history get ${runId}).`,
    );
    this.name = "ContinuationHeldError";
  }
}

// a cancel record is best effort: storage never holds up the abort or shutdown
export const CANCEL_INTENT_WRITE_TIMEOUT_MS = 5_000;

/**
 * aborts at once and records the cancel beside it, so a crash after the write
 * lands never continues a run someone stopped; a write that fails or runs past
 * its deadline is reported and dropped
 */
export class CancelIntentRecorder {
  readonly #record: (
    runId: string,
    reason: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly #onError: (runId: string, error: unknown) => void;
  readonly #timeoutMs: number;
  readonly #pending = new Set<Promise<void>>();

  constructor(
    record: (
      runId: string,
      reason: string,
      signal: AbortSignal,
    ) => Promise<void>,
    onError: (runId: string, error: unknown) => void,
    timeoutMs = CANCEL_INTENT_WRITE_TIMEOUT_MS,
  ) {
    this.#record = record;
    this.#onError = onError;
    this.#timeoutMs = timeoutMs;
  }

  abort(runId: string, controller: AbortController, reason: string): void {
    controller.abort(new Error(reason));
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `recording the cancel took longer than ${this.#timeoutMs}ms`,
        );
        deadline.abort(error);
        reject(error);
      }, this.#timeoutMs);
    });
    const recorded = Promise.resolve().then(() =>
      this.#record(runId, reason, deadline.signal)
    );
    const write: Promise<void> = Promise.race([recorded, timedOut]).then(
      () => {},
      (error) => {
        try {
          this.#onError(runId, error);
        } catch {
          // reporting must never leave the write pending
        }
      },
    ).then(() => {
      clearTimeout(timer);
      this.#pending.delete(write);
    });
    this.#pending.add(write);
  }

  /** bounded: every write ends by its deadline */
  async settled(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
}

/** the shutdown abort never passes a recorder: its runs are meant to continue */
export function abortCancelled(
  recorder: CancelIntentRecorder | undefined,
  runId: string,
  controller: AbortController,
  reason: string,
): void {
  if (recorder === undefined || !UUID.test(runId)) {
    controller.abort(new Error(reason));
    return;
  }
  recorder.abort(runId, controller, reason);
}

// for a holder not known alive; serve keeps its claim for the whole continued
// run, so a serve whose heartbeat is current is never taken over, whatever
// the claim's age
export const OPERATOR_CLAIM_STALE_MS = 5 * 60_000;

export interface OperatorRecoverClaim {
  readonly claim: ContinuationClaim;
  /** the holder an older claim was taken from */
  readonly replaced?: string;
}

/**
 * the claim serve's own continuation takes, so an operator's recover and serve
 * never both act on one interruption; undefined without a claim store
 */
export async function claimForOperatorRecover(
  claims: ContinuationClaims | undefined,
  run: WorkflowRun,
  now: Date,
): Promise<OperatorRecoverClaim | undefined> {
  if (!claims || (claims.usable && !(await claims.usable()))) return undefined;
  const suspensionKey = await suspensionKeyOf(run);
  const mine = (generation: number): ContinuationClaim => ({
    runId: run.id,
    suspensionKey,
    generation,
    holder: claims.holder,
    claimedAt: now.toISOString(),
  });
  const raced = () =>
    new UserError(
      `Another process took run ${run.id} at the same moment; retry the recover.`,
    );
  const held = await claims.store.find(run.id, suspensionKey);
  if (held === undefined) {
    const first = mine(1);
    if (await claims.store.create(first)) return { claim: first };
    throw raced();
  }
  if (held.holder === claims.holder) return { claim: held };
  if (await claims.liveness(held.holder) === "alive") {
    throw new UserError(
      `${held.holder} is continuing run ${run.id} and holds it until that run ends; see 'swamp workflow history get ${run.id}'.`,
    );
  }
  const age = now.getTime() - Date.parse(held.claimedAt);
  if (age <= OPERATOR_CLAIM_STALE_MS) {
    const waitSeconds = Math.ceil((OPERATOR_CLAIM_STALE_MS - age) / 1000);
    throw new UserError(
      `${held.holder} took run ${run.id} ${
        Math.floor(age / 1000)
      }s ago. If it has stopped, retry in ${waitSeconds}s, when a claim that old is taken over.`,
    );
  }
  const next = mine(held.generation + 1);
  if (await claims.store.create(next)) {
    return { claim: next, replaced: held.holder };
  }
  throw raced();
}
