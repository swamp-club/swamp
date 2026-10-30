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
 * A serve-mode checkout's offline mode (swamp-club#4195): the process's
 * record of which v3 local roots could not reach serve when their command
 * started, and serve's clock as last measured. A module of its own with no
 * v3 handle imports, so the client, the lock, the sink and the command
 * entries can all ask it without an import cycle.
 *
 * - **Entered only at a command's start.** The writer hold's catch-up
 *   ({@link enterServeOffline}) is the one place offline mode begins: a
 *   command that started online and then loses serve fails as before
 *   (exit 75), since the offline rules never judged its work.
 * - **Sticky.** Once entered, it lasts until the command ends: its commits
 *   queue in the outbox, even ones serve could take again, and the next
 *   command flushes them.
 * - **Serve's clock.** Every reply's `Date` header measures serve's clock
 *   against this one ({@link recordServeClock}); offline, the last measured
 *   offset judges a lease's expiry and corrects an offline write's time.
 * - **Said in both output modes.** Log mode says it through the logger. In
 *   json mode, where the logger is silent, the CLI sets a notice writer
 *   ({@link setServeOfflineNoticeWriter}) and each notice is one JSON
 *   object on stderr, as other json-mode warnings are: going offline, the
 *   work a command queued (said once, as the command ends, since its
 *   result is printed before its commits queue), and what a flush did.
 *
 * @module
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

/** Serve's clock against this one, as measured from a reply. */
export interface ServeClock {
  /** Serve's clock minus the local one, in milliseconds. */
  readonly offsetMs: number;
  /** How far off the measurement may be: half the round trip, plus a second. */
  readonly uncertaintyMs: number;
  /** When it was measured, by the local clock (epoch milliseconds). */
  readonly measuredAt: number;
}

/** What a checkout knows of serve while it works offline. */
export interface ServeOfflineState {
  /** The serve that could not be reached. */
  readonly serveUrl: string;
  /** When offline mode began, by the local clock (epoch milliseconds). */
  readonly since: number;
  /** When the checkout last reached serve, as its state recorded it. */
  readonly lastContactAt?: string;
  /** Serve's clock minus the local one at the last contact. */
  readonly clockOffsetMs?: number;
}

interface OfflineEntry extends ServeOfflineState {
  /** Model partitions a read-kind run was allowed on, as key strings. */
  readonly registered: Set<string>;
  /** Commits queued in the outbox by this command. */
  queued: number;
  /** The txnIds of the commits queued, in order. */
  readonly txnIds: string[];
}

/** What a serve-mode checkout says about working offline, in json mode. */
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
    /** Which version holds each name's latest once the flush ends. */
    readonly latestAtEnd: readonly unknown[];
  };

/** Where json-mode notices go; undefined in log mode. */
let noticeWriter: ((notice: ServeOfflineNotice) => void) | undefined;

/**
 * Sets where offline notices go for this invocation: the CLI sets one in
 * json mode and none in log mode, where the logger says them.
 */
export function setServeOfflineNoticeWriter(
  writer: ((notice: ServeOfflineNotice) => void) | undefined,
): void {
  noticeWriter = writer;
}

/** Hands `notice` to the json-mode writer, when one is set. */
export function emitServeOfflineNotice(notice: ServeOfflineNotice): void {
  noticeWriter?.(notice);
}

const QUEUED_MESSAGE =
  "Serve is unreachable, so this work is saved in this checkout and will be sent to serve by the next command that reaches it";

/** Offline local roots of this process, by resolved path. */
const offline = new Map<string, OfflineEntry>();

/** The last clock measured per serve origin in this process. */
const clocks = new Map<string, ServeClock>();

/** The resolution of a reply's `Date` header, in milliseconds. */
const DATE_HEADER_RESOLUTION_MS = 1_000;

/**
 * Records serve's clock from a reply's `Date` header: `sentAt` and
 * `receivedAt` are the local clock around the exchange. A header that does
 * not parse is ignored.
 */
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

/** Serve's clock as this process last measured it, if it did. */
export function serveClockOf(serveUrl: string): ServeClock | undefined {
  return clocks.get(serveUrl);
}

/**
 * Puts the local root `datastorePath` in offline mode for the rest of the
 * command; a root already offline keeps its state. Says so once.
 */
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

/** Whether any local root of this command works offline. */
export function anyServeOffline(): boolean {
  return offline.size > 0;
}

/** The offline state of the local root `datastorePath`, when offline. */
export function serveOfflineAt(
  datastorePath: string,
): ServeOfflineState | undefined {
  return offline.get(resolve(datastorePath));
}

/**
 * Notes that a read-kind run was allowed on `partition` offline, so the
 * commit sink's backstop queues what it records.
 */
export function registerOfflineReadPartition(
  datastorePath: string,
  partition: PartitionKey,
): void {
  offline.get(resolve(datastorePath))?.registered.add(partition.toString());
}

/** The model partitions registered for read-kind runs at `datastorePath`. */
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

/**
 * Says, in json mode, what each offline root of this command queued: run
 * as the command ends, before offline mode is forgotten.
 */
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

/** How many commits this command queued offline at `datastorePath`. */
export function queuedOfflineAt(datastorePath: string): number {
  return offline.get(resolve(datastorePath))?.queued ?? 0;
}

/**
 * What the offline rules judge with at `datastorePath`: the explicit
 * leases the checkout recorded and serve's clock offset.
 */
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

/**
 * The explicit model leases the checkout at `datastorePath` recorded, as
 * the offline rules read them: the behavior each covers and its end.
 */
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

/** The behavior a model lock key (`data/{type}/{id}/.lock`) names. */
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

/** Forgets every root's offline mode: a command ends. */
export function resetServeOffline(): void {
  offline.clear();
}

/** Forgets offline mode and measured clocks, as a new process starts. */
export function resetServeOfflineForTesting(): void {
  offline.clear();
  clocks.clear();
}
