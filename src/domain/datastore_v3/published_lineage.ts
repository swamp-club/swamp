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
 * a writer publishes the head, then the confirmation, then checks it still
 * holds the lease and acknowledges, so a confirmed lineage has a head and every
 * acknowledged commit is under a head a later lease holder reads
 */

import { padFence } from "./writer_lease.ts";
import type { ReplicationLineage } from "./replication_lineage.ts";
import type { ReplicaRoot } from "./replica_root.ts";

export const PUBLISHED_LINEAGE_FORMAT = 1;

export interface LineageStarted {
  readonly fence: number;
  readonly holder: string;
  readonly replicaRoot: string;
  readonly startedAt: string;
  /**
   * the current lineage the writer's copy held when it began this one, which it
   * continues; undefined when there was none, and in a lineage an older swamp
   * started
   */
  readonly follows?: number;
  /**
   * set by every swamp that matches endpoint spellings, so a lineage begun with
   * nothing to follow is never read as one an older swamp started
   */
  readonly chained?: true;
}

export interface LineageConfirmed {
  readonly fence: number;
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

export interface CommitIdentity {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
}

export interface LineageHead {
  readonly fence: number;
  readonly txid: string;
  readonly writerFence: number;
  readonly mark: HighWaterMark;
  readonly publishedAt: string;
}

export interface PublishedLineage {
  readonly fence: number;
  readonly started?: LineageStarted;
  readonly confirmed?: LineageConfirmed;
  readonly head?: LineageHead;
}

export interface LocalCopyState {
  readonly replicaRoot: string;
  readonly lineageFence: number;
  readonly txid: string;
}

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

export type LocalCopyDecision =
  | { readonly kind: "none" }
  | { readonly kind: "current" }
  | {
    readonly kind: "missing" | "behind" | "foreign";
    readonly lineage: CompleteLineage;
  };

/**
 * also current when its own writer's newer lineage is unconfirmed and still the
 * newest started: a head published on an older lineage since came from a fenced
 * writer and does not make the copy behind
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
 * ignoring such a start would fork the datastore: a writer would start a
 * lineage beside it and a reader would see an empty one; foreign lineages below
 * this replica's newest start are history and stay ignored
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
 * a reader whose restore fails reads a once-restored copy as it is, but a
 * never-restored copy would read as an empty datastore, so its read fails
 * instead
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
 * may continue only while no other writer can have written since: its lineage
 * was published and none started after it; otherwise it restarts at fence from
 * the state it restored
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
 * never current, nor a lineage started after it, which may yet be confirmed;
 * the caller must read each start and skip any another root started or that
 * does not parse
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
 * keeps a lineage below current that no ancestor of current saw (a fork, or an
 * older swamp writing beside an upgraded one), since its commits may be nowhere
 * else; kept ones are marked so later runs keep them
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
 * never backwards: a fenced process that publishes late, on its lineage or an
 * older one, must not make the copy look behind what it holds; a record under
 * another replica root is replaced
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

export type ChunkCollectionDecision =
  | { readonly kind: "collect" }
  | { readonly kind: "defer"; readonly reason: string };

/**
 * a restore's truncation drops commits whose chunks another copy may restore
 * from a lineage's head, so collection runs only when nothing but this copy's
 * state is restorable; unread or unparsed starts count as this root
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

export function compareTxid(a: string, b: string): number {
  const x = BigInt(`0x${requireTxid(a)}`);
  const y = BigInt(`0x${requireTxid(b)}`);
  return x < y ? -1 : x > y ? 1 : 0;
}

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

export function serializeLineageRecord(
  record: LineageStarted | LineageConfirmed | LineageHead | LocalCopyState,
): string {
  return JSON.stringify({ format: PUBLISHED_LINEAGE_FORMAT, ...record });
}
