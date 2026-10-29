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
 * The v3 commit feed over serve's WebSocket (swamp-club#4120).
 *
 * `commits.subscribe` reads the commit log from a cursor, then waits for
 * more and sends each batch as it lands, filtered per caller exactly as
 * `GET changes` filters it: a fresh filter per batch, so a changed grant
 * takes effect on the next one. A team peer (a follower) gets every commit
 * of serve's namespace. A replicating leader sends only what it published.
 * A frame with no changes goes out at least every few seconds, so a
 * subscriber can tell a quiet feed from a dead one. A subscriber that falls
 * behind what the socket can buffer is ended with a resumable
 * `commits_lagged` error; a cursor below the compaction point ends with
 * `commits_compacted`, as `GET changes` answers it with a 410.
 *
 * @module
 */

import { CommitsCompactedError } from "../../domain/datastore_v3/commit_store.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { CommitReadFilter } from "../commit_read_filter.ts";
import { isPeerSocket } from "../peer_auth.ts";
import {
  accessCallerOf,
  type ConnectionContext,
  send,
  sendError,
} from "./shared.ts";

/** How often a quiet feed says it is live. */
export const COMMIT_FEED_HEARTBEAT_MS = 5_000;

/** The most commits one frame reads from the log. */
export const COMMIT_FEED_PAGE = 500;

/** How much a subscriber's socket may hold unsent before it is ended. */
export const COMMIT_FEED_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** The most commit feed subscriptions one connection may hold. */
export const MAX_COMMIT_FEED_SUBSCRIPTIONS = 4;

const subscriptions = new WeakMap<WebSocket, number>();

/** `commits.head`. */
export function handleCommitsHead(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
): Promise<void> {
  const feed = ctx.commitFeed;
  if (feed === undefined) {
    sendFeedUnavailable(socket, requestId);
    return Promise.resolve();
  }
  send(socket, {
    type: "commits.head",
    id: requestId,
    payload: { cursor: feed.bound() },
  });
  return Promise.resolve();
}

/** `commits.subscribe`: runs until `signal` aborts or the feed ends. */
export async function handleCommitsSubscribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  signal: AbortSignal,
  principal: Principal | null,
  payload: { cursor: number },
): Promise<void> {
  const feed = ctx.commitFeed;
  if (feed === undefined) {
    sendFeedUnavailable(socket, requestId);
    return;
  }
  const held = subscriptions.get(socket) ?? 0;
  if (held >= MAX_COMMIT_FEED_SUBSCRIPTIONS) {
    sendError(
      socket,
      requestId,
      "subscription_limit",
      `Maximum ${MAX_COMMIT_FEED_SUBSCRIPTIONS} commit feed subscriptions per connection`,
    );
    return;
  }
  subscriptions.set(socket, held + 1);
  const access = isPeerSocket(socket)
    ? "unrestricted" as const
    : accessCallerOf(socket, principal);
  let cursor = payload.cursor;
  let wake: (() => void) | undefined;
  const off = feed.onMoved(() => wake?.());
  try {
    let lastSent = 0;
    while (!signal.aborted && socket.readyState === WebSocket.OPEN) {
      // Fail-secure audit refuses reads it cannot record, as GET changes
      // does, for a subscription already running too.
      if (auditUnavailable(ctx)) {
        sendError(
          socket,
          requestId,
          "audit_unavailable",
          "Request rejected: audit subsystem cannot durably record events (fail-secure mode)",
        );
        return;
      }
      if (socket.bufferedAmount > COMMIT_FEED_MAX_BUFFERED_BYTES) {
        sendError(
          socket,
          requestId,
          "commits_lagged",
          "The commit feed got ahead of what this connection reads; subscribe again from the last cursor",
          { cursor },
        );
        return;
      }
      const head = feed.bound();
      if (cursor < head) {
        let page;
        try {
          page = await feed.datastore.commitStore.changesSince(
            cursor,
            Math.min(COMMIT_FEED_PAGE, head - cursor),
          );
        } catch (error) {
          if (error instanceof CommitsCompactedError) {
            sendError(socket, requestId, "commits_compacted", error.message, {
              point: error.point,
            });
            return;
          }
          throw error;
        }
        const inBound = page.filter((change) => change.cursor <= head);
        const filter = new CommitReadFilter(feed.datastore, access, ctx);
        const changes: { cursor: number; commit: Record<string, unknown> }[] =
          [];
        for (const change of inBound) {
          if (await filter.readable(change)) {
            changes.push({
              cursor: change.cursor,
              commit: change.commit.toJSON() as unknown as Record<
                string,
                unknown
              >,
            });
          }
        }
        // Past filtered rows too, and past a gap up to the head.
        cursor = inBound.at(-1)?.cursor ?? head;
        if (signal.aborted) return;
        send(socket, {
          type: "commits.subscribe",
          id: requestId,
          payload: { changes, cursor, head, done: false },
        });
        lastSent = Date.now();
        continue;
      }
      const quiet = Date.now() - lastSent;
      if (quiet >= COMMIT_FEED_HEARTBEAT_MS) {
        send(socket, {
          type: "commits.subscribe",
          id: requestId,
          payload: { changes: [], cursor, head, done: false },
        });
        lastSent = Date.now();
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, COMMIT_FEED_HEARTBEAT_MS - quiet);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          wake = undefined;
          resolve();
        }
        wake = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    off();
    subscriptions.set(socket, (subscriptions.get(socket) ?? 1) - 1);
  }
}

function auditUnavailable(ctx: ConnectionContext): boolean {
  return ctx.auditEmitter !== undefined && ctx.auditFailOpen === false &&
    (ctx.auditWal?.isFull === true ||
      ctx.auditWal?.hasDroppedEvents === true ||
      ctx.auditEmitter.durableStalled);
}

function sendFeedUnavailable(socket: WebSocket, requestId: string): void {
  sendError(
    socket,
    requestId,
    "commit_feed_unavailable",
    "This swamp serve has no v3 commit log to subscribe to",
  );
}
