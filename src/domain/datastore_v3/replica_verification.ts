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

import { normalizeTxid } from "./published_lineage.ts";

/**
 * compactions rewrite files the last check never read, and checking each costs
 * a full restore; damage is found within this backstop instead
 */
export const REPLICA_VERIFY_BACKSTOP_MS = 4 * 60 * 60 * 1000;

/**
 * retry delay after a check that recorded no verdict (replica unreachable or
 * deadline passed); it says nothing about the lineage, so the backstop does not
 * apply
 */
export const REPLICA_VERIFY_RETRY_MS = 10 * 60 * 1000;

export interface ReplicaVerification {
  readonly lineageFence: number;
  readonly txid: string;
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly error?: string;
  /**
   * newest snapshot (level 9) the restore read through, if at or below txid;
   * absent when unknown or newer, so the next known snapshot counts as new
   */
  readonly snapshotTxid?: string;
}

/**
 * a snapshot above txid is read only by later restores, so it is not recorded
 * and the next decision still sees it as new
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

export interface ReplicaVerifyAttempt {
  readonly startedAtMs: number;
  /**
   * a check can run up to its 30-minute deadline, so the retry delay counts
   * from when it ended
   */
  readonly endedAtMs?: number;
  readonly txid: string | undefined;
  readonly snapshotTxid: string | undefined;
}

export interface ReplicaVerifyObservation {
  readonly lineageFence: number;
  readonly acknowledgedTxid: string | undefined;
  readonly last: ReplicaVerification | undefined;
  /**
   * an unknown snapshot is never new, nor is one above the acknowledged TXID
   * until the writer reaches it
   */
  readonly snapshotTxid: string | undefined;
  readonly lastAttempt: ReplicaVerifyAttempt | undefined;
  readonly nowMs: number;
  readonly idle: boolean;
  readonly backstopMs: number;
  readonly retryMs: number;
}

/**
 * check only when something acknowledged is uncovered and a check can change
 * the answer: no verdict, new snapshot, or backstop passed; an idling sidecar
 * never retries a tried TXID
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
  if (o.lastAttempt !== undefined) {
    const attempt = o.lastAttempt;
    if (o.idle && normalizeTxid(attempt.txid) === acknowledged) return false;
    const recorded = last !== undefined &&
      Date.parse(last.checkedAt) >= attempt.startedAtMs;
    const held = recorded
      ? o.nowMs - attempt.startedAtMs < o.backstopMs
      : o.nowMs - (attempt.endedAtMs ?? o.nowMs) < o.retryMs;
    if (held && !newSnapshotSince(attempt.snapshotTxid)) return false;
  }
  if (last === undefined) return true;
  if (newSnapshotSince(last.snapshotTxid)) return true;
  return o.nowMs - Date.parse(last.checkedAt) >= o.backstopMs;
}

export function isLineageBroken(
  record: ReplicaVerification | undefined,
  lineageFence: number,
): boolean {
  return record !== undefined && !record.ok &&
    record.lineageFence === lineageFence;
}

/**
 * an unreadable record reads as no verdict, never a broken lineage, so a
 * damaged file cannot restart the lineage on every command
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
