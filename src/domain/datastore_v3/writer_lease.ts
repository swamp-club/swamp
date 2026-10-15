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
 * The fenced writer lease of a v3 datastore (swamp-club#3359): one writer
 * at a time, and a fence every commit names, so a writer that lost its
 * lease can never land a commit.
 *
 * The lease is built on create-only records in the datastore's control
 * plane, under `writer/`:
 *
 * - `writer/fence-<n>`: taken with `putIfAbsent`, so of any number of
 *   writers racing for fence `n` exactly one wins. It names its holder and
 *   never changes. The highest fence key is never deleted, so a fence is
 *   never reused.
 * - `writer/heartbeat-<n>`: the holder's renewals, rewritten with `put`.
 *   Only fence `n`'s holder writes it.
 * - `writer/released-<n>`: fence `n` was given up, by its holder or by
 *   `swamp datastore lock release --force`. Created once, never changed.
 *
 * The highest fence is held until it is released, its holder's process is
 * gone (same host only), or its last renewal is older than its TTL plus
 * {@link WRITER_LEASE_CLOCK_SKEW_MS}. Expiry only decides when another
 * writer may take over. Safety never depends on clocks: a holder that finds
 * a higher fence, or its own fence released, is fenced, and the commit store
 * refuses any commit whose fence is below the highest it has seen.
 *
 * No compare-and-swap is needed. Taking over is creating the next fence,
 * never rewriting the current one, so two writers that both see an expired
 * holder cannot both take its place.
 *
 * @module
 */

import type { ControlPlaneStore } from "../datastore/control_plane_store.ts";
import { UserError } from "../errors.ts";

/** The control-plane prefix of the lease's records. */
export const WRITER_LEASE_PREFIX = "writer/";

/**
 * How far apart two hosts' clocks may be before a live holder on one looks
 * expired to the other. It only delays a takeover: a holder whose lease
 * expired too early is fenced, never corrupted.
 */
export const WRITER_LEASE_CLOCK_SKEW_MS = 10_000;

/** Error code for a writer whose lease another writer took over. */
export const WRITER_FENCED_CODE = "datastore_v3_writer_fenced";

/** Digits a fence is padded to in its key, so keys sort by fence. */
const FENCE_DIGITS = 12;

/** The largest fence a key can carry. */
const MAX_FENCE = 10 ** FENCE_DIGITS - 1;

/** The store the lease's records live in: create-only puts are required. */
export type WriterLeaseStore =
  & Pick<ControlPlaneStore, "put" | "get" | "delete" | "list">
  & { putIfAbsent(key: string, data: Uint8Array): Promise<boolean> };

/** Who holds a fence. */
export interface WriterLeaseHolder {
  /** Who, e.g. "user@hostname". */
  readonly holder: string;
  readonly hostname: string;
  readonly pid: number;
}

/** A fence's record, written once when it is taken. */
export interface FenceRecord extends WriterLeaseHolder {
  readonly fence: number;
  /** Names this acquisition, for a force release that must not race. */
  readonly nonce: string;
  readonly ttlMs: number;
  /** ISO time the fence was taken. */
  readonly acquiredAt: string;
}

/** Whether a fence still keeps other writers out. */
export type WriterLeaseState = "held" | "expired" | "released";

/** What {@link WriterLease.inspect} reports about the highest fence. */
export interface WriterLeaseInspection {
  readonly fence: number;
  /** Undefined while the fence record cannot be read yet. */
  readonly record?: FenceRecord;
  /** ISO time of the holder's last renewal, or of the acquisition. */
  readonly renewedAt?: string;
  /**
   * Whether the lease still keeps other writers out: `released` when its
   * holder or a force release gave it up, `expired` when its holder is gone
   * or stopped renewing.
   */
  readonly state: WriterLeaseState;
}

/** The records under `writer/` that decide who holds the lease. */
export interface WriterLeaseRecords {
  /** The highest fence taken, or undefined when none ever was. */
  readonly fence?: number;
  /**
   * The highest fence's record: undefined when it is missing or cannot be
   * read (a holder still writing it).
   */
  readonly record?: FenceRecord;
  /** The holder's last renewal, epoch milliseconds. */
  readonly renewedAt?: number;
  /** Whether the highest fence was released. */
  readonly released: boolean;
}

/** What {@link judgeWriterLease} decides about the highest fence. */
export type WriterLeaseVerdict =
  | { readonly kind: "free" }
  | { readonly kind: "held"; readonly holderUnknown: boolean }
  | {
    readonly kind: "expired";
    readonly reason: "released" | "process-gone" | "ttl" | "unreadable";
  };

/** What {@link judgeWriterLease} judges with. */
export interface WriterLeaseJudgement {
  /** Now, epoch milliseconds, on the judging host's clock. */
  readonly now: number;
  /** The judging host's name. */
  readonly hostname: string;
  /** Whether a pid on the judging host is gone. */
  readonly processGone: (pid: number) => boolean;
  /**
   * The TTL to judge a fence by when its record cannot be read: the judging
   * writer's own.
   */
  readonly ttlMs: number;
  readonly clockSkewMs?: number;
}

/**
 * Decides whether the highest fence still keeps other writers out.
 *
 * A fence whose record cannot be read is held by an unknown holder only
 * while a heartbeat for it was written within the judging TTL: a live
 * holder writes its first heartbeat as soon as it has taken the fence, so a
 * record left half-written by a holder that crashed has none, and does not
 * keep every writer out for good. Taking over too early is safe: the slow
 * holder finds the higher fence before it writes, and the commit store
 * refuses its fence.
 */
export function judgeWriterLease(
  records: WriterLeaseRecords,
  judgement: WriterLeaseJudgement,
): WriterLeaseVerdict {
  if (records.fence === undefined) return { kind: "free" };
  if (records.released) return { kind: "expired", reason: "released" };
  const skew = judgement.clockSkewMs ?? WRITER_LEASE_CLOCK_SKEW_MS;
  const record = records.record;
  if (record === undefined) {
    return records.renewedAt !== undefined &&
        judgement.now - records.renewedAt <= judgement.ttlMs + skew
      ? { kind: "held", holderUnknown: true }
      : { kind: "expired", reason: "unreadable" };
  }
  if (
    record.hostname === judgement.hostname &&
    judgement.processGone(record.pid)
  ) {
    return { kind: "expired", reason: "process-gone" };
  }
  const renewedAt = Math.max(
    Date.parse(record.acquiredAt),
    records.renewedAt ?? 0,
  );
  if (judgement.now - renewedAt > record.ttlMs + skew) {
    return { kind: "expired", reason: "ttl" };
  }
  return { kind: "held", holderUnknown: false };
}

/** The key of fence `fence`'s record. */
export function fenceKey(fence: number): string {
  return `${WRITER_LEASE_PREFIX}fence-${padFence(fence)}`;
}

/** The key of fence `fence`'s holder's renewals. */
export function heartbeatKey(fence: number): string {
  return `${WRITER_LEASE_PREFIX}heartbeat-${padFence(fence)}`;
}

/** The key that marks fence `fence` released. */
export function releasedKey(fence: number): string {
  return `${WRITER_LEASE_PREFIX}released-${padFence(fence)}`;
}

/**
 * `fence` padded to the width its keys use, so names built from fences sort
 * by fence: the lease's keys and the replica path of a Litestream lineage.
 */
export function padFence(fence: number): string {
  requireFence(fence);
  return String(fence).padStart(FENCE_DIGITS, "0");
}

function requireFence(fence: number): void {
  if (!Number.isSafeInteger(fence) || fence < 1 || fence > MAX_FENCE) {
    throw new Error(`A writer fence must be an integer from 1: ${fence}`);
  }
}

const KEY_PATTERN = new RegExp(
  `^writer/(fence|heartbeat|released)-(\\d{${FENCE_DIGITS}})$`,
);

/**
 * A lease key's kind and fence, or undefined for any other key. Only a key
 * `fenceKey`, `heartbeatKey` or `releasedKey` could have written counts: an
 * unpadded or out-of-range key is ignored, so it can neither alias a real
 * record nor wedge the lease (swamp-club#3375).
 */
export function parseWriterLeaseKey(
  key: string,
):
  | { kind: "fence" | "heartbeat" | "released"; fence: number }
  | undefined {
  const match = KEY_PATTERN.exec(key);
  if (match === null) return undefined;
  const fence = Number(match[2]);
  if (fence < 1 || fence > MAX_FENCE) return undefined;
  return { kind: match[1] as "fence" | "heartbeat" | "released", fence };
}

/**
 * Thrown when a writer's lease was taken over or released while it held it:
 * nothing more it commits lands. With reason `published`, a replicating
 * writer found it out only after it had published its commits' head
 * (swamp-club#3482): the writer that took over may restore them, so they
 * may still land.
 */
export class WriterFencedError extends UserError {
  constructor(
    readonly fence: number | undefined,
    readonly currentFence: number | undefined,
    reason: "taken-over" | "released" | "published" = "taken-over",
  ) {
    super(fencedMessage(fence, currentFence, reason), WRITER_FENCED_CODE);
    this.name = "WriterFencedError";
  }
}

function fencedMessage(
  fence: number | undefined,
  currentFence: number | undefined,
  reason: "taken-over" | "released" | "published",
): string {
  const takenOver = "Another swamp process took over the writer lease of " +
    "the v3 datastore" +
    (currentFence !== undefined ? ` (fence ${currentFence})` : "");
  if (reason === "published") {
    return takenOver +
      (fence !== undefined ? ` while this one held fence ${fence}` : "") +
      ", after this command had published its changes to the datastore's " +
      "replica. They may still appear: the writer that took over may " +
      "restore them. Check whether they did before running the command again.";
  }
  return (reason === "released"
    ? "This swamp process's writer lease on the v3 datastore was released " +
      "(`swamp datastore lock release --force`)"
    : takenOver) +
    (fence !== undefined
      ? ` while this one held fence ${fence}`
      : " while this one wrote without a fence") +
    ". A v3 datastore takes one writer at a time, so nothing more from " +
    "this command was committed. Run the command again.";
}

/** Thrown by {@link WriterLease.acquire} when another writer holds the lease. */
export class WriterLeaseBusyError extends Error {
  constructor(
    readonly inspection: WriterLeaseInspection,
    readonly waitedMs: number,
  ) {
    super(
      `The writer lease is held` +
        (inspection.record !== undefined
          ? ` by ${inspection.record.holder} (pid ${inspection.record.pid})`
          : "") +
        ` at fence ${inspection.fence}`,
    );
    this.name = "WriterLeaseBusyError";
  }
}

/** What a {@link WriterLease} is built with. */
export interface WriterLeaseOptions {
  readonly store: WriterLeaseStore;
  /** This process, as its fence records name it. */
  readonly holder: WriterLeaseHolder;
  readonly ttlMs: number;
  /** Now, epoch milliseconds. */
  readonly now: () => number;
  /** Waits between attempts while another writer holds the lease. */
  readonly delay: (ms: number) => Promise<void>;
  /** Whether a pid on this host is gone. */
  readonly processGone: (pid: number) => boolean;
  /** A fresh nonce for each acquisition. */
  readonly nonce: () => string;
  readonly clockSkewMs?: number;
  /** The first wait between attempts; it doubles up to {@link maxRetryMs}. */
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
}

/** What {@link WriterLease.acquire} takes. */
export interface AcquireWriterLeaseOptions {
  /** How long to wait for another writer; 0 makes one attempt. */
  readonly maxWaitMs: number;
  /**
   * The highest fence any commit store has seen, so a fence is never reused
   * even when the lease's records were lost.
   */
  readonly floor?: number;
}

/**
 * The writer lease of one datastore, over its control plane. Holds no
 * state of its own: {@link acquire} returns the hold.
 */
export class WriterLease {
  readonly #options: WriterLeaseOptions;

  constructor(options: WriterLeaseOptions) {
    this.#options = options;
  }

  /**
   * Takes the next fence, waiting up to `maxWaitMs` while another writer
   * holds the lease, and taking over one whose lease expired.
   *
   * @throws WriterLeaseBusyError when another writer still holds it
   */
  async acquire(options: AcquireWriterLeaseOptions): Promise<WriterLeaseHold> {
    const o = this.#options;
    const started = o.now();
    let retry = o.retryMs ?? 250;
    for (;;) {
      let records = await this.#read();
      if (this.#judge(records).kind !== "held") {
        const next = Math.max(records.fence ?? 0, options.floor ?? 0) + 1;
        const hold = await this.#take(next);
        if (hold !== undefined) return hold;
        // Another writer took it first, or a higher fence appeared: that
        // writer holds the lease now, so wait for it like any other.
        records = await this.#read();
      }
      const waited = o.now() - started;
      if (waited >= options.maxWaitMs) {
        throw new WriterLeaseBusyError(inspectionOf(records, "held"), waited);
      }
      await o.delay(Math.min(retry, options.maxWaitMs - waited));
      retry = Math.min(retry * 2, o.maxRetryMs ?? 2_000);
    }
  }

  /** The highest fence and whether it is held, or null when none was ever taken. */
  async inspect(): Promise<WriterLeaseInspection | null> {
    const records = await this.#read();
    if (records.fence === undefined) return null;
    const verdict = this.#judge(records);
    return inspectionOf(
      records,
      verdict.kind === "held"
        ? "held"
        : verdict.kind === "expired" && verdict.reason === "released"
        ? "released"
        : "expired",
    );
  }

  /**
   * Releases the highest fence for whoever holds it, when its nonce is
   * still `nonce`. Its holder finds it released at its next renewal (within
   * a third of its TTL), and refuses its own commits from then on; until a
   * new writer raises the store's fence, the store itself still takes them.
   * Resolves false when the lease changed hands since it was inspected.
   */
  async forceRelease(nonce: string): Promise<boolean> {
    const records = await this.#read();
    if (records.fence === undefined || records.record?.nonce !== nonce) {
      return false;
    }
    await this.#options.store.putIfAbsent(
      releasedKey(records.fence),
      encode({ fence: records.fence, releasedAt: this.#isoNow(), by: "force" }),
    );
    return true;
  }

  /**
   * Creates fence `fence`, then checks that no higher fence appeared while
   * it did. Resolves undefined when another writer won.
   */
  async #take(fence: number): Promise<WriterLeaseHold | undefined> {
    const o = this.#options;
    const record: FenceRecord = {
      ...o.holder,
      fence,
      nonce: o.nonce(),
      ttlMs: o.ttlMs,
      acquiredAt: this.#isoNow(),
    };
    if (!await o.store.putIfAbsent(fenceKey(fence), encode(record))) {
      return undefined;
    }
    const hold = new WriterLeaseHold(this.#options, record);
    let renewed: "held" | "fenced";
    try {
      renewed = await hold.renew();
    } catch (error) {
      // The fence is taken: give it up rather than keep others out until
      // it expires.
      await hold.release().catch(() => {});
      throw error;
    }
    if (renewed !== "held") {
      // A writer that read the lease before this one took it created a
      // higher fence: it holds the lease.
      await hold.release();
      return undefined;
    }
    await this.#prune(fence);
    return hold;
  }

  /**
   * Deletes the records of fences older than the one before `fence`. The
   * previous fence's records stay, so a writer that read the lease before
   * this takeover cannot create the fence this one replaced.
   */
  async #prune(fence: number): Promise<void> {
    const store = this.#options.store;
    for (const key of await store.list(WRITER_LEASE_PREFIX)) {
      const parsed = parseWriterLeaseKey(key);
      if (parsed !== undefined && parsed.fence < fence - 1) {
        try {
          await store.delete(key);
        } catch {
          // Left for the next takeover.
        }
      }
    }
  }

  async #read(): Promise<WriterLeaseRecords> {
    return await readWriterLeaseRecords(this.#options.store);
  }

  #judge(records: WriterLeaseRecords): WriterLeaseVerdict {
    const o = this.#options;
    return judgeWriterLease(records, {
      now: o.now(),
      hostname: o.holder.hostname,
      processGone: o.processGone,
      ttlMs: o.ttlMs,
      ...(o.clockSkewMs !== undefined ? { clockSkewMs: o.clockSkewMs } : {}),
    });
  }

  #isoNow(): string {
    return new Date(this.#options.now()).toISOString();
  }
}

/**
 * One acquisition of the lease. It stays the holder until it releases, or
 * until a renewal or {@link assertCurrent} finds a higher fence or its own
 * fence released, after which it is {@link lost} for good.
 */
export class WriterLeaseHold {
  readonly #options: WriterLeaseOptions;
  readonly record: FenceRecord;
  #lost: WriterFencedError | undefined;
  #released = false;

  constructor(options: WriterLeaseOptions, record: FenceRecord) {
    this.#options = options;
    this.record = record;
  }

  get fence(): number {
    return this.record.fence;
  }

  /** Why this hold was lost, or undefined while it holds. */
  get lost(): WriterFencedError | undefined {
    return this.#lost;
  }

  /**
   * Renews the lease: first looks for a higher fence or its own release,
   * and only then writes its heartbeat, so a fenced holder writes nothing.
   */
  async renew(): Promise<"held" | "fenced"> {
    if (this.#lost !== undefined) return "fenced";
    if (await this.#check() !== undefined) return "fenced";
    await this.#options.store.put(
      heartbeatKey(this.fence),
      encode({
        fence: this.fence,
        nonce: this.record.nonce,
        renewedAt: new Date(this.#options.now()).toISOString(),
      }),
    );
    return "held";
  }

  /**
   * Throws when this hold is no longer the lease's: the check a writer runs
   * before it acknowledges a replicated commit.
   *
   * @throws WriterFencedError
   */
  async assertCurrent(): Promise<void> {
    const lost = this.#lost ?? await this.#check();
    if (lost !== undefined) throw lost;
  }

  /**
   * Gives the lease up: marks the fence released, then removes the
   * heartbeat. The fence record stays, so the fence is never reused.
   */
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const store = this.#options.store;
    if (this.#lost === undefined) {
      await store.putIfAbsent(
        releasedKey(this.fence),
        encode({
          fence: this.fence,
          releasedAt: new Date(this.#options.now()).toISOString(),
          by: "holder",
        }),
      );
      this.#lost = new WriterFencedError(this.fence, undefined, "released");
    }
    await store.delete(heartbeatKey(this.fence));
  }

  async #check(): Promise<WriterFencedError | undefined> {
    let highest = this.fence;
    let released = false;
    for (const key of await this.#options.store.list(WRITER_LEASE_PREFIX)) {
      const parsed = parseWriterLeaseKey(key);
      if (parsed === undefined) continue;
      if (parsed.kind === "fence" && parsed.fence > highest) {
        highest = parsed.fence;
      }
      if (parsed.kind === "released" && parsed.fence === this.fence) {
        released = true;
      }
    }
    if (highest > this.fence) {
      this.#lost = new WriterFencedError(this.fence, highest);
    } else if (released) {
      this.#lost = new WriterFencedError(this.fence, undefined, "released");
    }
    return this.#lost;
  }
}

/** Reads the records that decide who holds the lease. */
export async function readWriterLeaseRecords(
  store: Pick<WriterLeaseStore, "get" | "list">,
): Promise<WriterLeaseRecords> {
  let fence: number | undefined;
  const released = new Set<number>();
  for (const key of await store.list(WRITER_LEASE_PREFIX)) {
    const parsed = parseWriterLeaseKey(key);
    if (parsed === undefined) continue;
    if (
      parsed.kind === "fence" && (fence === undefined || parsed.fence > fence)
    ) {
      fence = parsed.fence;
    }
    if (parsed.kind === "released") released.add(parsed.fence);
  }
  if (fence === undefined) return { released: false };
  const record = parseFenceRecord(await store.get(fenceKey(fence)), fence);
  const heartbeat = parseHeartbeat(
    await store.get(heartbeatKey(fence)),
    fence,
    record?.nonce,
  );
  return {
    fence,
    ...(record !== undefined ? { record } : {}),
    ...(heartbeat !== undefined ? { renewedAt: heartbeat } : {}),
    released: released.has(fence),
  };
}

function inspectionOf(
  records: WriterLeaseRecords,
  state: WriterLeaseState,
): WriterLeaseInspection {
  const renewedAt = records.record === undefined ? undefined : new Date(
    Math.max(Date.parse(records.record.acquiredAt), records.renewedAt ?? 0),
  ).toISOString();
  return {
    fence: records.fence!,
    ...(records.record !== undefined ? { record: records.record } : {}),
    ...(renewedAt !== undefined ? { renewedAt } : {}),
    state,
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decode(data: Uint8Array | null): Record<string, unknown> | undefined {
  if (data === null) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(data));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function parseFenceRecord(
  data: Uint8Array | null,
  fence: number,
): FenceRecord | undefined {
  const value = decode(data);
  if (
    value === undefined || value.fence !== fence ||
    typeof value.holder !== "string" || typeof value.hostname !== "string" ||
    !Number.isSafeInteger(value.pid) || typeof value.nonce !== "string" ||
    !Number.isSafeInteger(value.ttlMs) ||
    typeof value.acquiredAt !== "string" ||
    Number.isNaN(Date.parse(value.acquiredAt))
  ) {
    return undefined;
  }
  return {
    fence,
    holder: value.holder,
    hostname: value.hostname,
    pid: value.pid as number,
    nonce: value.nonce,
    ttlMs: value.ttlMs as number,
    acquiredAt: value.acquiredAt,
  };
}

/**
 * A heartbeat's renewal time, when it is the current holder's. With no
 * nonce to match (the fence's record cannot be read), any heartbeat for the
 * fence counts.
 */
function parseHeartbeat(
  data: Uint8Array | null,
  fence: number,
  nonce: string | undefined,
): number | undefined {
  const value = decode(data);
  if (
    value === undefined || value.fence !== fence ||
    (nonce !== undefined && value.nonce !== nonce) ||
    typeof value.renewedAt !== "string"
  ) {
    return undefined;
  }
  const at = Date.parse(value.renewedAt);
  return Number.isNaN(at) ? undefined : at;
}
