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
 * offline mode begins only at a command's start and is sticky: its commits
 * queue in the outbox for the next command to flush. A command losing serve
 * midway fails as before (exit 75). No v3 handle imports
 */

import { resolve } from "@std/path";
import type {
  HeldOfflineLease,
  OfflineContext,
} from "../../domain/datastore_v3/offline_write_policy.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { readExplicitLeases } from "./explicit_model_leases.ts";

const logger = getSwampLogger(["datastore", "v3", "offline"]);

export interface ServeClock {
  readonly offsetMs: number;
  /** How far off the measurement may be: half the round trip, plus a second. */
  readonly uncertaintyMs: number;
  readonly measuredAt: number;
}

export interface ServeOfflineState {
  readonly serveUrl: string;
  readonly since: number;
  readonly lastContactAt?: string;
  readonly clockOffsetMs?: number;
}

interface OfflineEntry extends ServeOfflineState {
  /** Model partitions a read-kind run was allowed on, as key strings. */
  readonly registered: Set<string>;
  queued: number;
  readonly txnIds: string[];
}

export type ServeOfflineNotice =
  | {
    readonly notice: "datastore_offline";
    readonly serveUrl: string;
    readonly lastContactAt?: string;
    readonly message: string;
  }
  | {
    readonly notice: "datastore_offline_queued";
    readonly serveUrl: string;
    readonly queued: number;
    readonly txnIds: readonly string[];
    readonly message: string;
  }
  | {
    readonly notice: "datastore_offline_flush";
    readonly landed: number;
    readonly waiting: number;
    readonly rejected: number;
    readonly quarantined: number;
    readonly renumbered: readonly unknown[];
    readonly latest: readonly unknown[];
    readonly latestAtEnd: readonly unknown[];
  };

let noticeWriter: ((notice: ServeOfflineNotice) => void) | undefined;

export function setServeOfflineNoticeWriter(
  writer: ((notice: ServeOfflineNotice) => void) | undefined,
): void {
  noticeWriter = writer;
}

export function emitServeOfflineNotice(notice: ServeOfflineNotice): void {
  noticeWriter?.(notice);
}

const QUEUED_MESSAGE =
  "Serve is unreachable, so this work is saved in this checkout and will be sent to serve by the next command that reaches it";

const offline = new Map<string, OfflineEntry>();

const clocks = new Map<string, ServeClock>();

const DATE_HEADER_RESOLUTION_MS = 1_000;

export function recordServeClock(
  serveUrl: string,
  dateHeader: string | null,
  sentAt: number,
  receivedAt: number,
): void {
  if (dateHeader === null) return;
  const serveAt = Date.parse(dateHeader);
  if (!Number.isFinite(serveAt)) return;
  const roundTrip = Math.max(0, receivedAt - sentAt);
  // The header names the second serve answered in: its midpoint, against
  // the midpoint of the exchange.
  const offsetMs = Math.round(
    serveAt + DATE_HEADER_RESOLUTION_MS / 2 - (sentAt + roundTrip / 2),
  );
  clocks.set(serveUrl, {
    offsetMs,
    uncertaintyMs: Math.round(roundTrip / 2) + DATE_HEADER_RESOLUTION_MS,
    measuredAt: receivedAt,
  });
}

export function serveClockOf(serveUrl: string): ServeClock | undefined {
  return clocks.get(serveUrl);
}

export function enterServeOffline(
  datastorePath: string,
  state: ServeOfflineState,
  reason: string,
): void {
  const key = resolve(datastorePath);
  if (offline.has(key)) return;
  offline.set(key, {
    ...state,
    registered: new Set(),
    queued: 0,
    txnIds: [],
  });
  const since = state.lastContactAt === undefined
    ? "never recorded"
    : state.lastContactAt;
  logger
    .warn`Could not reach serve at ${state.serveUrl}, so this command works offline from this checkout's copy (last in contact with serve: ${since}). Reads may be out of date; what it changes is saved in this checkout and sent once serve is reachable: ${reason}`;
  emitServeOfflineNotice({
    notice: "datastore_offline",
    serveUrl: state.serveUrl,
    ...(state.lastContactAt !== undefined
      ? { lastContactAt: state.lastContactAt }
      : {}),
    message: `This command works offline from this checkout's copy; reads ` +
      `may be out of date, and what it changes is saved in this checkout ` +
      `and sent once serve is reachable: ${reason}`,
  });
}

export function anyServeOffline(): boolean {
  return offline.size > 0;
}

export function serveOfflineAt(
  datastorePath: string,
): ServeOfflineState | undefined {
  return offline.get(resolve(datastorePath));
}

export function registerOfflineReadPartition(
  datastorePath: string,
  partition: PartitionKey,
): void {
  offline.get(resolve(datastorePath))?.registered.add(partition.toString());
}

export function offlineRegisteredAt(
  datastorePath: string,
): ReadonlySet<string> {
  return offline.get(resolve(datastorePath))?.registered ?? new Set();
}

/**
 * Notes the commit `txnId` queued in the outbox at `datastorePath`; the
 * first one of the command says, in log mode, that the work was saved
 * locally. Json mode says it once the command ends
 * ({@link reportQueuedOffline}).
 */
export function noteQueuedOffline(datastorePath: string, txnId: string): void {
  const entry = offline.get(resolve(datastorePath));
  if (entry === undefined) return;
  entry.queued++;
  entry.txnIds.push(txnId);
  if (entry.queued === 1) logger.warn`${QUEUED_MESSAGE}`;
}

export function reportQueuedOffline(): void {
  if (noticeWriter === undefined) return;
  for (const entry of offline.values()) {
    if (entry.queued === 0) continue;
    noticeWriter({
      notice: "datastore_offline_queued",
      serveUrl: entry.serveUrl,
      queued: entry.queued,
      txnIds: [...entry.txnIds],
      message: QUEUED_MESSAGE,
    });
  }
}

export function queuedOfflineAt(datastorePath: string): number {
  return offline.get(resolve(datastorePath))?.queued ?? 0;
}

export async function offlineContextAt(
  datastorePath: string,
  now: number = Date.now(),
): Promise<OfflineContext> {
  const state = serveOfflineAt(datastorePath);
  return {
    heldLeases: await heldOfflineLeasesAt(datastorePath),
    now,
    ...(state?.clockOffsetMs !== undefined
      ? { clockOffsetMs: state.clockOffsetMs }
      : {}),
  };
}

export async function heldOfflineLeasesAt(
  datastorePath: string,
): Promise<HeldOfflineLease[]> {
  const held: HeldOfflineLease[] = [];
  for (const lease of await readExplicitLeases(datastorePath)) {
    const model = modelOfLockKey(lease.lockKey);
    if (model !== undefined) {
      held.push({ model, expiresAt: lease.expiresAt });
    }
  }
  return held;
}

export function modelOfLockKey(
  lockKey: string,
): { readonly type: string; readonly id: string } | undefined {
  const parts = lockKey.split("/");
  if (parts[0] !== "data" || parts.length < 4 || parts.at(-1) !== ".lock") {
    return undefined;
  }
  return {
    type: parts.slice(1, -2).join("/"),
    id: parts[parts.length - 2],
  };
}

export function resetServeOffline(): void {
  offline.clear();
}

export function resetServeOfflineForTesting(): void {
  offline.clear();
  clocks.clear();
}
