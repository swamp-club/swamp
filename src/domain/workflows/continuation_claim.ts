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
 * Continuation claims: the record that one suspension of a run was consumed
 * by a resume (swamp-club#3108).
 *
 * A run record on a synced datastore is a cached copy, so two hosts can each
 * hold a copy that says "suspended" after one of them has resumed the run.
 * The run's lock serialises their resumes but does not refresh the copy. A
 * claim closes that gap without pulling anything: every resume creates the
 * claim of the suspension it consumes, once, in a store every host reads
 * directly. A host whose copy is older derives the same suspension key,
 * finds the claim and leaves the run alone.
 *
 * A claim is kept until its run is deleted. The holder of a claim that is
 * known dead is replaced by creating the next generation, never by deleting
 * and creating again, so two hosts that both see a dead holder cannot both
 * take its place.
 */

import { z } from "zod";
import { UserError } from "../errors.ts";
import type { WorkflowRun } from "./workflow_run.ts";

/** Key family of claims: `continuations/<runId>/<suspensionKey>/<generation>`. */
export const CONTINUATION_CLAIM_PREFIX = "continuations/";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUSPENSION_KEY = /^[0-9a-f]{64}$/;

/** The largest claim record read back, in bytes. */
export const CONTINUATION_CLAIM_MAX_BYTES = 4096;

export const ContinuationClaimSchema = z.object({
  runId: z.string().regex(UUID, "must be a UUID"),
  suspensionKey: z.string().regex(SUSPENSION_KEY, "must be a SHA-256 digest"),
  /** 1 for the first claim of a suspension; each takeover adds one. */
  generation: z.number().int().min(1),
  /** Who holds the claim: see {@link serveHolder} and {@link localHolder}. */
  holder: z.string().min(1).max(256),
  claimedAt: z.string().datetime(),
});

export type ContinuationClaim = z.infer<typeof ContinuationClaimSchema>;

/** The holder name of a `swamp serve` instance. */
export function serveHolder(instanceId: string): string {
  return `serve:${instanceId}`;
}

/** The serve instance id a holder names, or undefined for any other holder. */
export function serveInstanceOf(holder: string): string | undefined {
  return holder.startsWith("serve:") && holder.length > "serve:".length
    ? holder.slice("serve:".length)
    : undefined;
}

/** A holder name for one local command, unique to the process that asks. */
export function localHolder(): string {
  return `local:${crypto.randomUUID()}`;
}

/** The key prefix of every claim of `runId`. Throws for a non-UUID. */
export function continuationRunPrefix(runId: string): string {
  if (!UUID.test(runId)) throw new Error(`Not a run id: ${runId}`);
  return `${CONTINUATION_CLAIM_PREFIX}${runId.toLowerCase()}/`;
}

/** The key prefix of the claims of one suspension. */
export function continuationSuspensionPrefix(
  runId: string,
  suspensionKey: string,
): string {
  if (!SUSPENSION_KEY.test(suspensionKey)) {
    throw new Error(`Not a suspension key: ${suspensionKey}`);
  }
  return `${continuationRunPrefix(runId)}${suspensionKey}/`;
}

/** The key of one claim. */
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

/** The generation a claim key names, or undefined for any other key. */
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
 * Reads a stored claim. Undefined for a record that is missing, too large,
 * not a claim, or stored under a key other than its own: the store is one
 * other writers can reach.
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
 * Identifies the suspension `run` is in: a digest of every step's place,
 * status and times, the wait it holds and the decision on its gate. Every
 * host derives the same key from the same record, and a record from before
 * or after a resume derives a different one, since a resume changes at least
 * one step. Delivering a signal does not change the run record, so it does
 * not change the key.
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

/** Where continuation claims are kept. */
export interface ContinuationClaimStore {
  /** The claim of the highest generation of a suspension, if it has one. */
  find(
    runId: string,
    suspensionKey: string,
  ): Promise<ContinuationClaim | undefined>;

  /** Creates `claim` unless its generation exists. True when it was created. */
  create(claim: ContinuationClaim): Promise<boolean>;

  /** Removes `claim`, for a resume that took it and then ran nothing. */
  release(claim: ContinuationClaim): Promise<void>;

  /** Removes every claim of a run, with the run. */
  removeForRun(runId: string): Promise<void>;
}

/**
 * Removes the claims of each run in `runIds`, with the runs. One run whose
 * claims cannot be removed does not keep the others: every run is tried,
 * and the first failure is thrown after the last. An id that is not a run
 * id has no claims and is passed over.
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

/** What is known of the process a claim names. */
export type HolderLiveness = "alive" | "dead" | "unknown";

/**
 * The claims a resume takes, as one process uses them: the store, the name
 * this process holds claims under, and what it can tell of another holder.
 */
export interface ContinuationClaims {
  readonly store: ContinuationClaimStore;
  readonly holder: string;
  liveness(holder: string): Promise<HolderLiveness>;
  /**
   * False when the store turns out unable to create a record atomically. A
   * resume then takes no claim, as on a datastore with no such store.
   * Absent for a store known to be usable.
   */
  usable?(): Promise<boolean>;
}

/** Who asks for a claim, which decides when another holder's is replaced. */
export type ContinuationMode =
  /**
   * A person asked for the resume. Only a holder known to be alive refuses
   * it: a manual resume has always been allowed over a run nobody drives.
   * A serve instance is known alive only where it writes a heartbeat, which
   * is on a synced datastore; elsewhere the run's lock and record refuse a
   * second resume, not the claim.
   */
  | { readonly kind: "manual" }
  /**
   * Serve continues the run by itself. Another holder's claim is replaced
   * only when that holder is known dead and `takeover` is set, which the
   * caller does only when its copy of the run is current.
   */
  | { readonly kind: "automatic"; readonly takeover: boolean };

export type ContinuationAcquisition =
  | { readonly kind: "acquired"; readonly claim: ContinuationClaim }
  /** Another holder has the suspension; `liveness` is what is known of it. */
  | {
    readonly kind: "held";
    readonly claim: ContinuationClaim;
    readonly liveness: HolderLiveness;
  };

/**
 * Takes the claim of a suspension for `claims.holder`, or reports who has
 * it. A claim this holder already has is its own: the holder's copy of the
 * run still shows the suspension, so its earlier resume ran nothing.
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
 * Whether this host's stored record of a run is the one the datastore
 * holds. On a synced datastore each host resumes from its own copy of a run,
 * and a copy can be behind without anything in it saying so: a peer cancelled
 * the run after its last wait was signalled, or ended a run that had only
 * decided gates. Rejects when the datastore cannot be read, so a caller never
 * takes an unreachable datastore for agreement.
 */
export type RunRecordCurrency = (
  run: { workflowId: string; runId: string },
) => Promise<boolean>;

/**
 * A resume serve started by itself, refused because this host's record of
 * the run is not the one the datastore holds.
 */
export class RunRecordStaleError extends UserError {
  constructor(readonly runId: string) {
    super(
      `This copy of run ${runId} differs from the one in the datastore, so it was not resumed from here. ` +
        `Check the run before trying again (swamp workflow history get ${runId}).`,
    );
    this.name = "RunRecordStaleError";
  }
}

/**
 * A resume refused because another holder has the suspension's claim: that
 * holder is resuming the run, or already has.
 */
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
