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
 * Which replication lineage holds a v3 datastore's state, as every copy of
 * `commits.db` can see it (swamp-club#3482, Phase 4 D2).
 *
 * A lineage's records live in the datastore's control plane, beside the
 * writer lease, so a copy on another machine can find them:
 *
 * - **started**, created once by the writer that began the lineage, before
 *   its sidecar uploads anything;
 * - **head**, rewritten by the lineage's writer after each sync Litestream
 *   confirmed: the TXID and swamp's high-water mark, the last commit the
 *   writer is about to acknowledge;
 * - **confirmed**, created once, after the lineage's first head.
 *
 * A writer publishes the head, then the confirmation, and only then checks
 * that it still holds the lease and acknowledges. So a confirmed lineage
 * always has a head, and every commit a writer acknowledged is under a head
 * any later lease holder reads. A writer that fails the check leaves a head
 * over commits nobody acknowledged; like the commits D1 keeps after a
 * failed sync, they stay restorable until a newer lineage is confirmed.
 *
 * The datastore's current state is the highest lineage that is started,
 * confirmed and has a head. A restore takes it up to its head, and drops
 * any commit past the high-water mark, so a zombie writer's later uploads
 * never land.
 *
 * Pure rules, no I/O. See "Phase 4D2" in
 * `design/enablers/datastore-litestream.md`.
 *
 * @module
 */

import { padFence } from "./writer_lease.ts";
import type { ReplicationLineage } from "./replication_lineage.ts";
import type { ReplicaRoot } from "./replica_root.ts";

/** The format every published lineage record carries. */
export const PUBLISHED_LINEAGE_FORMAT = 1;

/** That a writer began a lineage at `fence`. */
export interface LineageStarted {
  readonly fence: number;
  /** The writer, as the lease names it (`user@host`). */
  readonly holder: string;
  /** The replica the lineage replicates under (`replicaRootOf`). */
  readonly replicaRoot: string;
  readonly startedAt: string;
  /**
   * The current lineage the writer's copy held when it began this one: the
   * state it continues (swamp-club#3801). Undefined when there was none, and
   * in a lineage a swamp before it started.
   */
  readonly follows?: number;
  /**
   * Set by every swamp that matches endpoint spellings (swamp-club#3801), so
   * a lineage it began with nothing to follow is never read as one a swamp
   * before it started.
   */
  readonly chained?: true;
}

/** That a lineage's first sync was confirmed. */
export interface LineageConfirmed {
  readonly fence: number;
  /** The Litestream TXID of that sync, 16 hex digits. */
  readonly txid: string;
  readonly confirmedAt: string;
}

/**
 * The last commit a writer acknowledged: the commit store's cursor, and the
 * commit at it when one is stored there (compaction may have folded it). A
 * restore keeps every commit up to `cursor` and none after it.
 */
export interface HighWaterMark {
  readonly cursor: number;
  readonly commit?: CommitIdentity;
}

/** Which commit a cursor names. */
export interface CommitIdentity {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
}

/** A lineage's last acknowledged state. */
export interface LineageHead {
  readonly fence: number;
  /** The Litestream TXID the writer's last confirmed sync reached. */
  readonly txid: string;
  /** The lease fence of the writer that acknowledged it. */
  readonly writerFence: number;
  readonly mark: HighWaterMark;
  readonly publishedAt: string;
}

/** One lineage's records, as a read found them. */
export interface PublishedLineage {
  readonly fence: number;
  readonly started?: LineageStarted;
  readonly confirmed?: LineageConfirmed;
  readonly head?: LineageHead;
}

/** What a copy of `commits.db` holds: a lineage's state up to a TXID. */
export interface LocalCopyState {
  readonly replicaRoot: string;
  readonly lineageFence: number;
  readonly txid: string;
}

/** A lineage with every record the current state needs. */
export type CompleteLineage = PublishedLineage & {
  readonly started: LineageStarted;
  readonly confirmed: LineageConfirmed;
  readonly head: LineageHead;
};

/**
 * The lineage that holds the datastore's state: the highest one under
 * `replicaRoot` that was started, confirmed and has a head. Lineages under
 * another root are never trusted.
 */
export function currentLineage(
  lineages: readonly PublishedLineage[],
  replicaRoot: ReplicaRoot,
): CompleteLineage | undefined {
  let current: CompleteLineage | undefined;
  for (const lineage of lineages) {
    if (
      lineage.started !== undefined &&
      replicaRoot.matches(lineage.started.replicaRoot) &&
      lineage.confirmed !== undefined && lineage.head !== undefined &&
      lineage.head.fence === lineage.fence &&
      (current === undefined || lineage.fence > current.fence)
    ) {
      current = lineage as CompleteLineage;
    }
  }
  return current;
}

/** The highest fence any lineage under `replicaRoot` was started at. */
export function newestStartedFence(
  lineages: readonly PublishedLineage[],
  replicaRoot: ReplicaRoot,
): number | undefined {
  let newest: number | undefined;
  for (const lineage of lineages) {
    if (
      lineage.started !== undefined &&
      replicaRoot.matches(lineage.started.replicaRoot) &&
      (newest === undefined || lineage.fence > newest)
    ) {
      newest = lineage.fence;
    }
  }
  return newest;
}

/** How a copy of `commits.db` stands against the published state. */
export type LocalCopyDecision =
  /** Nothing is published: the copy, or a fresh one, is the state. */
  | { readonly kind: "none" }
  /** The copy holds the current state; nothing to download. */
  | { readonly kind: "current" }
  /** The copy is missing, behind or on another lineage: restore this one. */
  | {
    readonly kind: "missing" | "behind" | "foreign";
    readonly lineage: CompleteLineage;
  };

/**
 * Decides whether the copy must be restored before a command reads or
 * writes it.
 *
 * - `local` is undefined when the copy has no `commits.db`.
 * - The copy is current when it holds the current lineage at or past its
 *   head, or when its own writer's lineage, started after the current one
 *   and not yet confirmed, is still the newest started: that writer's
 *   commits are on their way. Its writer started it only once the copy was
 *   current under the lease, so any head published on an older lineage since
 *   came from a fenced writer, over commits nobody acknowledged, and does not
 *   make the copy behind.
 */
export function decideLocalCopy(
  local: {
    readonly copy?: LocalCopyState;
    readonly lineage?: ReplicationLineage;
  } | undefined,
  lineages: readonly PublishedLineage[],
  replicaRoot: ReplicaRoot,
): LocalCopyDecision {
  const current = currentLineage(lineages, replicaRoot);
  if (current === undefined) return { kind: "none" };
  const head = current.head;
  const restore = (kind: "missing" | "behind" | "foreign") => ({
    kind,
    lineage: current,
  });
  if (local === undefined) return restore("missing");
  const own = local.lineage;
  if (
    own !== undefined && replicaRoot.matches(own.replicaRoot) &&
    own.lineageFence > current.fence &&
    newestStartedFence(lineages, replicaRoot) === own.lineageFence
  ) {
    return { kind: "current" };
  }
  const copy = local.copy;
  if (
    copy === undefined || !replicaRoot.matches(copy.replicaRoot) ||
    copy.lineageFence !== current.fence
  ) {
    return restore("foreign");
  }
  return compareTxid(copy.txid, head.txid) >= 0
    ? { kind: "current" }
    : restore("behind");
}

/**
 * The start of a lineage under another replica root that would decide the
 * datastore's state (swamp-club#3801): one started above every lineage
 * under `replicaRoot`, or any, when none was started under it. Ignoring it
 * would fork the datastore: a writer would start a lineage beside it, and a
 * reader would see an empty datastore. Lineages under another root below
 * this replica's newest start are history (a replica target that moved) and
 * stay ignored. The highest such start, or undefined.
 */
export function outrankingForeignLineage(
  lineages: readonly PublishedLineage[],
  replicaRoot: ReplicaRoot,
): LineageStarted | undefined {
  const newestOwn = newestStartedFence(lineages, replicaRoot);
  let found: LineageStarted | undefined;
  for (const lineage of lineages) {
    const started = lineage.started;
    if (
      started !== undefined && !replicaRoot.matches(started.replicaRoot) &&
      (newestOwn === undefined || lineage.fence > newestOwn) &&
      (found === undefined || lineage.fence > found.fence)
    ) {
      found = started;
    }
  }
  return found;
}

/**
 * Whether the copy never held the datastore's state (swamp-club#3642): it
 * has no `commits.db` (`local` undefined), or neither a restore nor its own
 * writer's lineage ever recorded what it holds. An empty file a reader left
 * while it waited for another restore is such a copy. A reader whose restore
 * fails reads a copy that was restored before as it is; a copy that never
 * was would read as an empty datastore, so its read fails instead.
 */
export function copyNeverRestored(
  local: {
    readonly copy?: LocalCopyState;
    readonly lineage?: ReplicationLineage;
  } | undefined,
): boolean {
  return local === undefined ||
    (local.copy === undefined && local.lineage === undefined);
}

/**
 * Whether a writer that took the lease at `fence` may continue the lineage
 * it recorded in `previous`, given what is published. It may only while no
 * other writer can have written since: its lineage was started (published)
 * and no lineage was started after it. Otherwise it restarts at `fence`,
 * from the current state it restored.
 */
export function mayContinueLineage(
  previous: ReplicationLineage | undefined,
  lineages: readonly PublishedLineage[],
  replicaRoot: ReplicaRoot,
): boolean {
  if (previous === undefined || !replicaRoot.matches(previous.replicaRoot)) {
    return false;
  }
  const started = lineages.some((lineage) =>
    lineage.fence === previous.lineageFence &&
    lineage.started !== undefined &&
    replicaRoot.matches(lineage.started.replicaRoot)
  );
  return started &&
    newestStartedFence(lineages, replicaRoot) === previous.lineageFence;
}

/**
 * A lineage record that restarts at `fence`, keeping the one it replaces
 * for garbage collection. `previous` must not already be at `fence`.
 */
export function restartLineage(
  previous: ReplicationLineage | undefined,
  replicaRoot: ReplicaRoot,
  fence: number,
): ReplicationLineage {
  padFence(fence);
  return {
    replicaRoot: replicaRoot.value,
    lineageFence: fence,
    lastFence: fence,
    previousLineages: previous === undefined ? [] : [
      ...previous.previousLineages,
      { replicaRoot: previous.replicaRoot, fence: previous.lineageFence },
    ],
  };
}

/**
 * The lineages garbage collection may remove once `current` is confirmed:
 * every other one under `replicaRoot` below it. Never `current`, and never
 * a lineage started after it, which may yet be confirmed.
 *
 * A lineage whose start the caller did not read is included: the caller
 * must read each one's start, and skip any another root started or whose
 * start does not parse, before removing it (`collectV3Lineages` does).
 */
export function collectableLineages(
  lineages: readonly PublishedLineage[],
  abandoned: readonly number[],
  replicaRoot: ReplicaRoot,
  current: number,
): number[] {
  const fences = new Set<number>(abandoned.filter((fence) => fence < current));
  for (const lineage of lineages) {
    if (
      lineage.fence < current &&
      (lineage.started === undefined ||
        replicaRoot.matches(lineage.started.replicaRoot))
    ) {
      fences.add(lineage.fence);
    }
  }
  return [...fences].sort((a, b) => a - b);
}

/**
 * The lineages below `current` that garbage collection keeps because the
 * current state may lack their commits (swamp-club#3801). A lineage's
 * commits are in `current` when `current` descends from it: a lineage this
 * swamp started (`chained`) continues the one it `follows`, and one a swamp
 * before it started continues the highest complete lineage below it under
 * its exact root spelling, the only ones that swamp could restore.
 *
 * A lineage below `current` that an ancestor started by a swamp before
 * this superseded under another spelling was never seen by that ancestor:
 * a fork, or an older swamp writing beside an upgraded one. Its commits may
 * be nowhere else, so it is kept. Every other lineage below `current`
 * is collected as before: one `current` descends from, or one a fenced
 * writer left, whose commits nobody acknowledged.
 *
 * A collection that keeps a lineage records it (`marked`), and every later
 * one keeps it too: collecting the chain between `current` and the
 * ancestor that showed the fork would otherwise hide it from the next.
 *
 * `starts` holds the starts of the lineages collection would remove and of
 * `current`'s chain; `complete` the fences started, confirmed and headed. A
 * lineage whose start was not read is not judged here.
 */
export function lineagesKeptForFork(
  starts: ReadonlyMap<number, LineageStarted>,
  current: number,
  recorded: {
    readonly complete: ReadonlySet<number>;
    readonly marked?: ReadonlySet<number>;
  },
): Set<number> {
  const parentOf = (started: LineageStarted): number | undefined => {
    if (started.chained === true) return started.follows;
    let parent: number | undefined;
    for (const other of starts.values()) {
      if (
        other.fence < started.fence &&
        other.replicaRoot === started.replicaRoot &&
        recorded.complete.has(other.fence) &&
        (parent === undefined || other.fence > parent)
      ) {
        parent = other.fence;
      }
    }
    return parent;
  };
  const ancestors: LineageStarted[] = [];
  const onChain = new Set<number>();
  for (
    let started = starts.get(current);
    started !== undefined && !onChain.has(started.fence);
  ) {
    onChain.add(started.fence);
    ancestors.push(started);
    const parent = parentOf(started);
    started = parent === undefined ? undefined : starts.get(parent);
  }
  const kept = new Set(
    [...(recorded.marked ?? [])].filter((fence) => fence < current),
  );
  for (const started of starts.values()) {
    if (started.fence >= current || onChain.has(started.fence)) continue;
    for (const ancestor of ancestors) {
      if (
        ancestor.chained !== true && ancestor.fence > started.fence &&
        ancestor.replicaRoot !== started.replicaRoot
      ) {
        kept.add(started.fence);
      }
    }
  }
  return kept;
}

/**
 * Whether a head this copy published moves its `copy.json` forward from
 * `held` to `next` (swamp-club#3491). Never backwards: a fenced process in
 * the checkout that publishes late, on its lineage or an older one, must
 * not make the copy look behind what it holds. A record under another
 * replica root is replaced.
 */
export function copyStateAdvances(
  held: LocalCopyState | undefined,
  next: LocalCopyState,
): boolean {
  if (held === undefined || held.replicaRoot !== next.replicaRoot) return true;
  if (next.lineageFence !== held.lineageFence) {
    return next.lineageFence > held.lineageFence;
  }
  return compareTxid(held.txid, next.txid) < 0;
}

/** Whether chunks may be collected from a replicated copy. */
export type ChunkCollectionDecision =
  | { readonly kind: "collect" }
  | { readonly kind: "defer"; readonly reason: string };

/**
 * Decides whether chunk garbage collection may run against a copy that
 * holds `copy` (swamp-club#3491). A collection's reference set is the
 * copy's own commits, and a restore's truncation drops commits whose
 * chunks another copy may still restore from a lineage's head. So it runs
 * only when nothing but the copy's state is restorable: the copy holds the
 * current lineage at or past its head, and no other lineage under
 * `replicaRoot` is registered. A lineage whose start was not read, or does
 * not parse, counts as one under this root. Lineages under another root
 * are never restored, so they never defer it.
 *
 * Once the current lineage's first confirmation collected the lineages it
 * replaced, collection resumes. Until then, and on replicas whose old
 * lineages are not yet collected, it waits.
 */
export function decideChunkCollection(
  copy: LocalCopyState | undefined,
  lineages: readonly PublishedLineage[],
  replicaRoot: ReplicaRoot,
): ChunkCollectionDecision {
  const current = currentLineage(lineages, replicaRoot);
  if (current === undefined) {
    return { kind: "defer", reason: "no replication lineage is confirmed yet" };
  }
  if (
    copy === undefined || !replicaRoot.matches(copy.replicaRoot) ||
    copy.lineageFence !== current.fence ||
    compareTxid(copy.txid, current.head.txid) < 0
  ) {
    return {
      kind: "defer",
      reason: `this checkout's copy does not hold replication lineage ${
        padFence(current.fence)
      } at its head`,
    };
  }
  const other = lineages.find((lineage) =>
    lineage.fence !== current.fence &&
    (lineage.started === undefined ||
      replicaRoot.matches(lineage.started.replicaRoot))
  );
  if (other !== undefined) {
    const fence = padFence(other.fence);
    return {
      kind: "defer",
      // A record that names no root can only be removed by hand: say which.
      reason: other.started === undefined
        ? `replication lineage ${fence} has no start record that parses ` +
          `(_control/lineage/${fence}/), so it may still be restored; ` +
          `lineage collection never removes it`
        : `replication lineage ${fence} may still be restored until it is ` +
          `collected`,
    };
  }
  return { kind: "collect" };
}

/** Orders two hex TXIDs. */
export function compareTxid(a: string, b: string): number {
  const x = BigInt(`0x${requireTxid(a)}`);
  const y = BigInt(`0x${requireTxid(b)}`);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A TXID as Litestream's `restore -txid` takes it: 16 hex digits. */
export function normalizeTxid(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString(16).padStart(16, "0");
  }
  if (typeof value === "string" && /^[0-9a-fA-F]{1,16}$/.test(value)) {
    return value.toLowerCase().padStart(16, "0");
  }
  return undefined;
}

function requireTxid(txid: string): string {
  const normal = normalizeTxid(txid);
  if (normal === undefined) throw new Error(`Not a Litestream TXID: ${txid}`);
  return normal;
}

// Record parsing: every record is read from a store anyone with access to
// the datastore can write, so each field is checked and anything else is
// dropped.

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown): Fields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Fields;
  return fields.format === PUBLISHED_LINEAGE_FORMAT ? fields : undefined;
}

function isFence(value: unknown): value is number {
  if (typeof value !== "number") return false;
  try {
    padFence(value);
    return true;
  } catch {
    return false;
  }
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

/** A started record, or undefined when `value` is not one. */
export function parseLineageStarted(
  value: unknown,
): LineageStarted | undefined {
  const r = fieldsOf(value);
  if (
    r === undefined || !isFence(r.fence) || !isText(r.holder) ||
    !isText(r.replicaRoot) || !isText(r.startedAt)
  ) {
    return undefined;
  }
  // A predecessor that is not a lower fence is not one: the lineage reads
  // as one a swamp before it started, which collection keeps when forked.
  const follows = isFence(r.follows) && r.follows < r.fence
    ? r.follows
    : undefined;
  return {
    fence: r.fence,
    holder: r.holder,
    replicaRoot: r.replicaRoot,
    startedAt: r.startedAt,
    ...(follows !== undefined ? { follows } : {}),
    ...(r.chained === true ? { chained: true as const } : {}),
  };
}

/** A confirmed record, or undefined when `value` is not one. */
export function parseLineageConfirmed(
  value: unknown,
): LineageConfirmed | undefined {
  const r = fieldsOf(value);
  const txid = r === undefined ? undefined : normalizeTxid(r.txid);
  if (
    r === undefined || !isFence(r.fence) || txid === undefined ||
    !isText(r.confirmedAt)
  ) {
    return undefined;
  }
  return { fence: r.fence, txid, confirmedAt: r.confirmedAt };
}

/** A head record, or undefined when `value` is not one. */
export function parseLineageHead(value: unknown): LineageHead | undefined {
  const r = fieldsOf(value);
  const txid = r === undefined ? undefined : normalizeTxid(r.txid);
  const mark = parseMark(r?.mark);
  if (
    r === undefined || !isFence(r.fence) || txid === undefined ||
    !isFence(r.writerFence) || mark === undefined || !isText(r.publishedAt)
  ) {
    return undefined;
  }
  return {
    fence: r.fence,
    txid,
    writerFence: r.writerFence,
    mark,
    publishedAt: r.publishedAt,
  };
}

function parseMark(value: unknown): HighWaterMark | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Fields;
  if (!isCount(r.cursor)) return undefined;
  if (r.commit === undefined) return { cursor: r.cursor };
  const c = r.commit as Fields;
  if (
    typeof c !== "object" || c === null || r.cursor === 0 ||
    typeof c.namespace !== "string" || !isText(c.partition) ||
    !isCount(c.seq) || !isText(c.txnId)
  ) {
    return undefined;
  }
  return {
    cursor: r.cursor,
    commit: {
      namespace: c.namespace,
      partition: c.partition,
      seq: c.seq,
      txnId: c.txnId,
    },
  };
}

/** A copy state record, or undefined when `value` is not one. */
export function parseLocalCopyState(
  value: unknown,
): LocalCopyState | undefined {
  const r = fieldsOf(value);
  const txid = r === undefined ? undefined : normalizeTxid(r.txid);
  if (
    r === undefined || !isText(r.replicaRoot) || !isFence(r.lineageFence) ||
    txid === undefined
  ) {
    return undefined;
  }
  return { replicaRoot: r.replicaRoot, lineageFence: r.lineageFence, txid };
}

/** `record` as stored, with the format it is read back by. */
export function serializeLineageRecord(
  record: LineageStarted | LineageConfirmed | LineageHead | LocalCopyState,
): string {
  return JSON.stringify({ format: PUBLISHED_LINEAGE_FORMAT, ...record });
}
