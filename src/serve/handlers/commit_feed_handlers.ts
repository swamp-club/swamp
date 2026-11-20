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
 * an empty frame goes out every few seconds so a subscriber can tell a quiet
 * feed from a dead one; the grant filter is fresh per batch so a changed grant
 * applies next; a lagging subscriber is ended resumably
 */

import {
  type CommitChange,
  CommitsCompactedError,
} from "../../domain/datastore_v3/commit_store.ts";
import { ServeNotLeaderError } from "../../domain/datastore_v3/serve_leader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  LEADER_STEPPING_DOWN_FEATURE,
  LEASE_OPS_FEATURE,
  STEP_STARTS_FEATURE,
} from "../../infrastructure/datastore_v3/serve_datastore_client.ts";
import {
  commitJSONFor,
  CommitReadFilter,
  memoized,
  serveResolver,
} from "../commit_read_filter.ts";
import { dataChangesOf } from "../data_change_feed.ts";
import type {
  DataChange,
  DataSubscribePayload,
  ServerMessage,
} from "../protocol.ts";
import { isPeerSocket } from "../peer_auth.ts";
import {
  accessCallerOf,
  callerResourceDecider,
  type ConnectionContext,
  refuseIntegrationCaller,
  send,
  sendError,
} from "./shared.ts";

export const COMMIT_FEED_HEARTBEAT_MS = 5_000;

export const COMMIT_FEED_PAGE = 500;

export const COMMIT_FEED_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export const MAX_COMMIT_FEED_SUBSCRIPTIONS = 4;

const subscriptions = new WeakMap<WebSocket, number>();

export function handleCommitsHead(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): Promise<void> {
  if (refusedIntegration(socket, ctx, requestId, principal)) {
    return Promise.resolve();
  }
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

/** the commit feed is what the datastore API serves, and refused the same way */
function refusedIntegration(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): boolean {
  if (isPeerSocket(socket)) return false;
  if (
    !refuseIntegrationCaller(
      accessCallerOf(socket, principal),
      requestId,
      "commit-feed",
      ctx,
    )
  ) return false;
  sendError(
    socket,
    requestId,
    "unauthorized",
    "Access denied: an integration token can't read the commit feed",
  );
  return true;
}

export async function handleCommitsSubscribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  signal: AbortSignal,
  principal: Principal | null,
  payload: { cursor: number; features?: readonly string[] },
): Promise<void> {
  if (refusedIntegration(socket, ctx, requestId, principal)) return;
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
  // a subscription's features are fixed when it starts, so read once: a
  // subscriber that does not name lease ops (an older follower) is sent commits
  // without them, as GET changes sends them
  const features = {
    leaseOps: payload.features?.includes(LEASE_OPS_FEATURE) === true,
    stepStarts: payload.features?.includes(STEP_STARTS_FEATURE) === true,
  };
  try {
    await followCommitFeed(socket, ctx, requestId, signal, feed, {
      type: "commits.subscribe",
      cursor: payload.cursor,
      steppingDown: payload.features?.includes(LEADER_STEPPING_DOWN_FEATURE) ===
          true
        ? ctx.steppingDown
        : undefined,
      async project(page) {
        const filter = new CommitReadFilter(feed.datastore, access, ctx);
        const changes: { cursor: number; commit: Record<string, unknown> }[] =
          [];
        for (const change of page) {
          if (await filter.readable(change)) {
            const commit = commitJSONFor(change.commit, features);
            if (commit !== undefined) {
              changes.push({
                cursor: change.cursor,
                commit: commit as Record<string, unknown>,
              });
            }
          }
        }
        return changes;
      },
    });
  } finally {
    subscriptions.set(socket, (subscriptions.get(socket) ?? 1) - 1);
  }
}

type CommitFeed = NonNullable<ConnectionContext["commitFeed"]>;

export interface FeedFollow {
  readonly type: "commits.subscribe" | "data.subscribe";
  readonly cursor: number;
  /** told once, on a page of its own, when this leader starts stepping down */
  readonly steppingDown?: ConnectionContext["steppingDown"];
  /** called per page, so a grant change applies from the next one */
  project(page: readonly CommitChange[]): Promise<unknown[]>;
}

/** Sends an empty page every few seconds when quiet, until the caller stops it or the stream must end. */
export async function followCommitFeed(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  signal: AbortSignal,
  feed: CommitFeed,
  follow: FeedFollow,
): Promise<void> {
  let cursor = follow.cursor;
  const steppingDown = follow.steppingDown;
  let toldSteppingDown = false;
  let wake: (() => void) | undefined;
  const off = feed.onMoved(() => wake?.());
  const offSteppingDown = steppingDown?.onBegin(() => wake?.());
  try {
    let lastSent = 0;
    while (!signal.aborted && socket.readyState === WebSocket.OPEN) {
      // a follower's copy too old to read from ends the stream, as a new
      // subscribe or GET changes is refused
      const gate = ctx.followerGate;
      if (gate?.role === "follower" && gate.isStale()) {
        const refusal = new ServeNotLeaderError(gate.leader(), true);
        sendError(
          socket,
          requestId,
          refusal.code,
          refusal.message,
          refusal.leader !== undefined ? { leader: refusal.leader } : undefined,
        );
        return;
      }
      // fail-secure audit refuses reads it cannot record, as GET changes does,
      // for a subscription already running too
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
      if (steppingDown?.down === true && !toldSteppingDown) {
        send(socket, {
          type: follow.type,
          id: requestId,
          payload: {
            changes: [],
            cursor,
            head,
            done: false,
            steppingDown: true,
          },
        } as ServerMessage);
        toldSteppingDown = true;
        lastSent = Date.now();
        continue;
      }
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
        const changes = await follow.project(inBound);
        // past filtered rows too, and past a gap up to the head
        cursor = inBound.at(-1)?.cursor ?? head;
        if (signal.aborted) return;
        send(socket, {
          type: follow.type,
          id: requestId,
          payload: { changes, cursor, head, done: false },
        } as ServerMessage);
        lastSent = Date.now();
        continue;
      }
      const quiet = Date.now() - lastSent;
      if (quiet >= COMMIT_FEED_HEARTBEAT_MS) {
        send(socket, {
          type: follow.type,
          id: requestId,
          payload: { changes: [], cursor, head, done: false },
        } as ServerMessage);
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
    offSteppingDown?.();
  }
}

export const MAX_DATA_SUBSCRIPTIONS = 8;

const dataSubscriptions = new WeakMap<WebSocket, number>();

/** A serve with no v3 log answers data_feed_unavailable and the caller polls instead. */
export async function handleDataSubscribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  signal: AbortSignal,
  principal: Principal | null,
  payload: DataSubscribePayload,
): Promise<void> {
  if (refusedIntegration(socket, ctx, requestId, principal)) return;
  const feed = ctx.commitFeed;
  if (feed === undefined) {
    sendError(
      socket,
      requestId,
      "data_feed_unavailable",
      "This swamp serve's datastore has no change feed; poll for changes instead",
    );
    return;
  }
  const held = dataSubscriptions.get(socket) ?? 0;
  if (held >= MAX_DATA_SUBSCRIPTIONS) {
    sendError(
      socket,
      requestId,
      "subscription_limit",
      `Maximum ${MAX_DATA_SUBSCRIPTIONS} data subscriptions per connection`,
    );
    return;
  }
  dataSubscriptions.set(socket, held + 1);
  const access = accessCallerOf(socket, principal);
  try {
    await followCommitFeed(socket, ctx, requestId, signal, feed, {
      type: "data.subscribe",
      // no cursor means from now: a subscriber reads current data itself
      cursor: payload.cursor ?? feed.bound(),
      async project(page) {
        const resolver = memoized(serveResolver(ctx, feed.datastore));
        const readable = callerResourceDecider(access, "read", ctx);
        const changes: DataChange[] = [];
        for (const change of page) {
          const found = await dataChangesOf(
            change,
            feed.datastore.namespace,
            resolver,
            readable,
            payload,
          );
          for (const item of found) changes.push(item);
        }
        return changes;
      },
    });
  } finally {
    dataSubscriptions.set(socket, (dataSubscriptions.get(socket) ?? 1) - 1);
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
