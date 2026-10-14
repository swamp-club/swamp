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
  replicaRoot: string,
): CompleteLineage | undefined {
  let current: CompleteLineage | undefined;
  for (const lineage of lineages) {
    if (
      lineage.started?.replicaRoot === replicaRoot &&
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
  replicaRoot: string,
): number | undefined {
  let newest: number | undefined;
  for (const lineage of lineages) {
    if (
      lineage.started?.replicaRoot === replicaRoot &&
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
 *   commits are on their way.
 */
export function decideLocalCopy(
  local: {
    readonly copy?: LocalCopyState;
    readonly lineage?: ReplicationLineage;
  } | undefined,
  lineages: readonly PublishedLineage[],
  replicaRoot: string,
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
    own !== undefined && own.replicaRoot === replicaRoot &&
    own.lineageFence > current.fence &&
    newestStartedFence(lineages, replicaRoot) === own.lineageFence &&
    copyAtOrPast(local.copy, current.fence, head.txid, replicaRoot)
  ) {
    return { kind: "current" };
  }
  const copy = local.copy;
  if (
    copy === undefined || copy.replicaRoot !== replicaRoot ||
    copy.lineageFence !== current.fence
  ) {
    return restore("foreign");
  }
  return compareTxid(copy.txid, head.txid) >= 0
    ? { kind: "current" }
    : restore("behind");
}

/**
 * Whether the copy holds lineage `fence` at or past `txid`, or a later
 * lineage this copy itself started from it.
 */
function copyAtOrPast(
  copy: LocalCopyState | undefined,
  fence: number,
  txid: string,
  replicaRoot: string,
): boolean {
  if (copy === undefined || copy.replicaRoot !== replicaRoot) return false;
  if (copy.lineageFence > fence) return true;
  return copy.lineageFence === fence && compareTxid(copy.txid, txid) >= 0;
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
  replicaRoot: string,
): boolean {
  if (previous === undefined || previous.replicaRoot !== replicaRoot) {
    return false;
  }
  const started = lineages.some((lineage) =>
    lineage.fence === previous.lineageFence &&
    lineage.started?.replicaRoot === replicaRoot
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
  replicaRoot: string,
  fence: number,
): ReplicationLineage {
  padFence(fence);
  return {
    replicaRoot,
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
 */
export function collectableLineages(
  lineages: readonly PublishedLineage[],
  abandoned: readonly number[],
  replicaRoot: string,
  current: number,
): number[] {
  const fences = new Set<number>(abandoned.filter((fence) => fence < current));
  for (const lineage of lineages) {
    if (
      lineage.fence < current &&
      (lineage.started === undefined ||
        lineage.started.replicaRoot === replicaRoot)
    ) {
      fences.add(lineage.fence);
    }
  }
  return [...fences].sort((a, b) => a - b);
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
  return {
    fence: r.fence,
    holder: r.holder,
    replicaRoot: r.replicaRoot,
    startedAt: r.startedAt,
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
