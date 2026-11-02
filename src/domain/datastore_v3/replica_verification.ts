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
 * The writer's check that its replication lineage can be restored
 * (swamp-club#3935). A reader finds a replica it cannot restore only when it
 * clones or refreshes, and then nobody but the writer can use the datastore.
 * So the writer's sidecar restores its own lineage, the way a reader would,
 * and records the verdict; a lineage found broken is never continued, and
 * the next writer restarts it from its intact copy.
 *
 * Pure rules, no I/O. See "Verifying the replica" in
 * `design/enablers/datastore-litestream.md`.
 *
 * @module
 */

import { normalizeTxid } from "./published_lineage.ts";

/**
 * The longest a lineage goes unchecked while its writer keeps acknowledging
 * (swamp-club#4261). A compaction writes new LTX files and deletes the ones
 * it merged, so later restores read through files the last check never
 * read; checking after every compacted level would cost a full restore an
 * hour or more. Damage a compaction introduces is found within this
 * backstop instead, and until then the writer's intact copy is what a
 * lineage found broken restarts from.
 */
export const REPLICA_VERIFY_BACKSTOP_MS = 4 * 60 * 60 * 1000;

/** The verdict of one check of a lineage, recorded beside `commits.db`. */
export interface ReplicaVerification {
  /** The lineage that was restored. */
  readonly lineageFence: number;
  /** The TXID the writer had acknowledged, which the check restored. */
  readonly txid: string;
  /** When the check finished, as an ISO time. */
  readonly checkedAt: string;
  /** Whether the restore passed SQLite's integrity check. */
  readonly ok: boolean;
  /** Why it failed; present only when `ok` is false. */
  readonly error?: string;
  /**
   * The newest snapshot (Litestream level 9) the check's restore read
   * through, by its max TXID: the replica's newest when the check started,
   * if it is at or below `txid`. Absent when it was not known or was newer,
   * and in verdicts recorded before swamp-club#4261; then the next known
   * snapshot counts as new, which costs one more check.
   */
  readonly snapshotTxid?: string;
}

/**
 * The snapshot a restore at `txid` reads through, by its max TXID: the
 * replica's newest, `snapshotTxid`, only when it is at or below `txid`. A
 * newer one was written after the writer's last acknowledgement and is
 * read only by later restores, so neither a verdict nor a sidecar's own
 * attempt records it, and the next decision still sees it as new.
 */
export function snapshotReadAt(
  snapshotTxid: string | undefined,
  txid: string | undefined,
): string | undefined {
  const snapshot = normalizeTxid(snapshotTxid);
  const restored = normalizeTxid(txid);
  return snapshot !== undefined && restored !== undefined &&
      snapshot <= restored
    ? snapshot
    : undefined;
}

/** A check this sidecar started, whatever it ended with. */
export interface ReplicaVerifyAttempt {
  readonly startedAtMs: number;
  /**
   * The snapshot it read through ({@link snapshotReadAt}), if one was
   * known.
   */
  readonly snapshotTxid: string | undefined;
}

/** What a sidecar knows when it decides whether to check its lineage now. */
export interface ReplicaVerifyObservation {
  /** The lineage the sidecar replicates. */
  readonly lineageFence: number;
  /**
   * The TXID the writer last acknowledged on that lineage, or undefined when
   * it acknowledged none (or on another lineage).
   */
  readonly acknowledgedTxid: string | undefined;
  /** The last recorded verdict, whatever lineage it names. */
  readonly last: ReplicaVerification | undefined;
  /**
   * The newest snapshot on the replica, by its max TXID, or undefined when
   * it is not known. An unknown snapshot is never a new one, and neither is
   * one above the acknowledged TXID until the writer reaches it.
   */
  readonly snapshotTxid: string | undefined;
  /** The last check this sidecar started, if it started one. */
  readonly lastAttempt: ReplicaVerifyAttempt | undefined;
  readonly nowMs: number;
  /** {@link REPLICA_VERIFY_BACKSTOP_MS} outside tests. */
  readonly backstopMs: number;
}

/**
 * Whether a sidecar restores its lineage now (swamp-club#4261): only when
 * the writer has acknowledged something the last verdict does not cover,
 * and only when a check can change the answer — the lineage has no verdict
 * yet, the replica holds a snapshot the last verdict did not read through,
 * or the backstop has passed since that verdict was recorded. New
 * acknowledgements alone never start one, so neither a serve that writes
 * all day nor a run of short-lived CLI sidecars restores on a timer.
 *
 * A sidecar never starts a second check within the backstop of its own
 * last one unless a new snapshot appeared since, so one whose check ended
 * without a verdict still reaches its idle exit.
 */
export function shouldVerifyReplica(o: ReplicaVerifyObservation): boolean {
  if (o.acknowledgedTxid === undefined) return false;
  const acknowledged = normalizeTxid(o.acknowledgedTxid);
  if (acknowledged === undefined) return false;
  const last = o.last !== undefined && o.last.lineageFence === o.lineageFence
    ? o.last
    : undefined;
  if (last !== undefined && normalizeTxid(last.txid) === acknowledged) {
    return false;
  }
  // Only a snapshot a restore at the acknowledged TXID reads through: one
  // written ahead of it is new only once the writer passes it.
  const marker = snapshotReadAt(o.snapshotTxid, acknowledged);
  const newSnapshotSince = (seen: string | undefined): boolean =>
    marker !== undefined &&
    (seen === undefined || normalizeTxid(seen) !== marker);
  if (
    o.lastAttempt !== undefined &&
    o.nowMs - o.lastAttempt.startedAtMs < o.backstopMs &&
    !newSnapshotSince(o.lastAttempt.snapshotTxid)
  ) {
    return false;
  }
  if (last === undefined) return true;
  if (newSnapshotSince(last.snapshotTxid)) return true;
  return o.nowMs - Date.parse(last.checkedAt) >= o.backstopMs;
}

/**
 * Whether `record` says the lineage begun at `lineageFence` cannot be
 * restored. A verdict on any other lineage, a passing one, or none says
 * nothing about it.
 */
export function isLineageBroken(
  record: ReplicaVerification | undefined,
  lineageFence: number,
): boolean {
  return record !== undefined && !record.ok &&
    record.lineageFence === lineageFence;
}

/**
 * Parses a recorded verdict, or returns undefined when it is not one. An
 * unreadable record reads as no verdict, never as a broken lineage, so a
 * damaged file cannot restart the lineage on every command.
 */
export function parseReplicaVerification(
  value: unknown,
): ReplicaVerification | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const txid = normalizeTxid(record.txid);
  if (
    typeof record.lineageFence !== "number" ||
    !Number.isSafeInteger(record.lineageFence) || record.lineageFence <= 0 ||
    txid === undefined ||
    typeof record.checkedAt !== "string" ||
    Number.isNaN(Date.parse(record.checkedAt)) ||
    typeof record.ok !== "boolean" ||
    (record.error !== undefined && typeof record.error !== "string")
  ) {
    return undefined;
  }
  const snapshotTxid = record.snapshotTxid === undefined
    ? undefined
    : normalizeTxid(record.snapshotTxid);
  if (record.snapshotTxid !== undefined && snapshotTxid === undefined) {
    return undefined;
  }
  return {
    lineageFence: record.lineageFence,
    txid,
    checkedAt: record.checkedAt,
    ok: record.ok,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(snapshotTxid !== undefined ? { snapshotTxid } : {}),
  };
}
