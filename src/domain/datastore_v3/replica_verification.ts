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

/** How often, at most, a sidecar restores its lineage to check it. */
export const REPLICA_VERIFY_INTERVAL_MS = 10 * 60 * 1000;

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
  /** When the last check this sidecar ran started, if it ran one. */
  readonly lastStartedAtMs: number | undefined;
  /**
   * The TXID that check restored. A check can end without a verdict (the
   * replica could not be reached), and is then tried again only after the
   * interval, never again at an idle exit.
   */
  readonly lastAttemptedTxid: string | undefined;
  readonly nowMs: number;
  /** Whether the sidecar is about to stop for being idle. */
  readonly idle: boolean;
  readonly intervalMs: number;
}

/**
 * Whether a sidecar restores its lineage now: only when the writer has
 * acknowledged something the last verdict did not cover, and at most once
 * per interval, except that a sidecar about to idle out checks what it
 * replicated since, once. A verdict on another lineage covers nothing.
 */
export function shouldVerifyReplica(o: ReplicaVerifyObservation): boolean {
  if (o.acknowledgedTxid === undefined) return false;
  const acknowledged = normalizeTxid(o.acknowledgedTxid);
  if (acknowledged === undefined) return false;
  const covered = o.last !== undefined &&
    o.last.lineageFence === o.lineageFence &&
    normalizeTxid(o.last.txid) === acknowledged;
  if (covered) return false;
  const attempted = o.lastAttemptedTxid !== undefined &&
    normalizeTxid(o.lastAttemptedTxid) === acknowledged;
  if (o.idle) return !attempted;
  if (o.lastStartedAtMs === undefined) return true;
  return o.nowMs - o.lastStartedAtMs >= o.intervalMs;
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
  return {
    lineageFence: record.lineageFence,
    txid,
    checkedAt: record.checkedAt,
    ok: record.ok,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}
