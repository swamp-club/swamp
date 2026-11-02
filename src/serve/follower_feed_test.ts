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

import { assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { ServeLeader } from "../domain/datastore_v3/serve_leader.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import {
  type FeedChange,
  FOLLOWER_FEED_SILENCE_MS,
  FOLLOWER_FEED_STUCK_MS,
  FollowerFeed,
} from "./follower_feed.ts";
import type { LeaderLink } from "./leader_link.ts";

await initializeLogging({});

class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function leader(instanceId: string, fence: number): ServeLeader {
  return {
    instanceId,
    fence,
    address: `https://${instanceId}.internal:9090`,
    since: "2026-10-29T12:00:00.000Z",
  };
}

function setup(now?: () => number) {
  const sockets: FakeSocket[] = [];
  const link = {
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return { socket, leader: leader("x", 1) };
    },
  } as unknown as LeaderLink;
  const applied: number[][] = [];
  let gate: PromiseWithResolvers<void> | undefined;
  let fresh = 0;
  const feed = new FollowerFeed({
    ...(now !== undefined ? { now } : {}),
    link,
    peerToken: () => Promise.resolve("swamp-peer.k"),
    copyCursor: () => 0,
    apply: async (changes: readonly FeedChange[]) => {
      applied.push(changes.map((change) => change.cursor));
      await gate?.promise;
    },
    onFresh: () => fresh++,
  });
  return {
    feed,
    sockets,
    applied,
    fresh: () => fresh,
    hold: () => (gate = Promise.withResolvers<void>()),
    release: () => gate?.resolve(),
  };
}

const frame = (cursors: number[]) => ({
  type: "commits.subscribe",
  id: "follower-feed",
  payload: {
    changes: cursors.map((cursor) => ({ cursor, commit: {} })),
    cursor: cursors.at(-1) ?? 0,
    head: cursors.at(-1) ?? 0,
    done: false,
  },
});

Deno.test("FollowerFeed: a frame the previous leader's socket queued is not applied and marks nothing fresh after a switch (swamp-club#4148)", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the first socket");
  t.sockets[0].open();
  t.hold();
  t.sockets[0].deliver(frame([1]));
  t.sockets[0].deliver(frame([2]));
  await waitFor(() => t.applied.length === 1, "the first apply running");
  // The node now follows another leader while cursor 1 is mid-apply.
  t.feed.follow(leader("b", 2));
  t.release();
  await waitFor(() => t.sockets.length === 2, "the new socket");
  await t.feed.stop();
  assertEquals(t.applied, [[1]]);
  assertEquals(t.fresh(), 0);
});

Deno.test("FollowerFeed: frames of the current socket apply in order and mark the copy fresh", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].open();
  t.sockets[0].deliver(frame([1]));
  t.sockets[0].deliver(frame([]));
  t.sockets[0].deliver(frame([2, 3]));
  await waitFor(() => t.fresh() === 3, "three frames");
  assertEquals(t.applied, [[1], [2, 3]]);
  assertEquals(t.feed.current(leader("a", 1)), true);
  assertEquals(t.feed.current(leader("a", 2)), false);
  await t.feed.stop();
});

Deno.test("FollowerFeed: an error frame stops the feed, and it is no longer current", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].open();
  t.sockets[0].deliver(frame([]));
  await waitFor(() => t.fresh() === 1, "a heartbeat");
  t.sockets[0].deliver({
    type: "error",
    id: "follower-feed",
    error: { code: "commits_compacted", message: "compacted" },
  });
  await waitFor(() => !t.feed.current(leader("a", 1)), "the feed stopped");
  await t.feed.stop();
});

Deno.test("FollowerFeed: its subscribe names lease ops, so the leader sends them to this copy (swamp-club#4168)", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].open();
  const subscribe = JSON.parse(t.sockets[0].sent[0]);
  assertEquals(subscribe.type, "commits.subscribe");
  assertEquals(subscribe.payload, { cursor: 0, features: ["lease-ops"] });
  await t.feed.stop();
});

function headAsks(socket: FakeSocket): string[] {
  return socket.sent.map((data) => JSON.parse(data))
    .filter((sent) => sent.type === "commits.head")
    .map((sent) => sent.id as string);
}

Deno.test("FollowerFeed.barrier: false while the feed is down, as a node just restarted finds it (swamp-club#4254)", async () => {
  const t = setup();
  assertEquals(await t.feed.barrier(), false);
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  assertEquals(await t.feed.barrier(), false);
  assertEquals(headAsks(t.sockets[0]), []);
  await t.feed.stop();
});

Deno.test("FollowerFeed.barrier: true once the copy applied the head the leader named (swamp-club#4254)", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  const socket = t.sockets[0];
  socket.open();
  socket.deliver(frame([1]));
  await waitFor(() => t.fresh() === 1, "the first frame");
  const caughtUp = t.feed.barrier();
  await waitFor(() => headAsks(socket).length === 1, "the head asked");
  socket.deliver({
    type: "commits.head",
    id: headAsks(socket)[0],
    payload: { cursor: 3 },
  });
  socket.deliver(frame([2, 3]));
  assertEquals(await caughtUp, true);
  await t.feed.stop();
});

Deno.test("FollowerFeed.barrier: false when the feed ends before the copy reaches the leader's head (swamp-club#4254)", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  const socket = t.sockets[0];
  socket.open();
  socket.deliver(frame([1]));
  await waitFor(() => t.fresh() === 1, "the first frame");
  const caughtUp = t.feed.barrier();
  await waitFor(() => headAsks(socket).length === 1, "the head asked");
  socket.deliver({
    type: "commits.head",
    id: headAsks(socket)[0],
    payload: { cursor: 5 },
  });
  socket.deliver({ type: "error", id: "follower-feed", error: { code: "x" } });
  assertEquals(await caughtUp, false);
  await t.feed.stop();
});

Deno.test("FollowerFeed.caughtUp: a caller never shares a head asked before it arrived; callers arriving meanwhile share the next ask (swamp-club#4254)", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  const socket = t.sockets[0];
  socket.open();
  socket.deliver(frame([1]));
  await waitFor(() => t.fresh() === 1, "the first frame");
  const first = t.feed.caughtUp();
  await waitFor(() => headAsks(socket).length === 1, "the first ask");
  // Arrived after the first ask: the leader may have committed since, so
  // these wait for an ask of their own, which they share.
  const second = t.feed.caughtUp();
  const third = t.feed.caughtUp();
  socket.deliver({
    type: "commits.head",
    id: headAsks(socket)[0],
    payload: { cursor: 1 },
  });
  assertEquals(await first, "caught-up");
  await waitFor(() => headAsks(socket).length === 2, "the second ask");
  socket.deliver({
    type: "commits.head",
    id: headAsks(socket)[1],
    payload: { cursor: 2 },
  });
  socket.deliver(frame([2]));
  assertEquals(await Promise.all([second, third]), ["caught-up", "caught-up"]);
  assertEquals(headAsks(socket).length, 2);
  await t.feed.stop();
});

Deno.test("FollowerFeed.caughtUp: catching up while the feed was live lately, stuck once it has not been for the bound (swamp-club#4254)", async () => {
  let now = 1_000_000;
  const t = setup(() => now);
  assertEquals(await t.feed.caughtUp(), "stuck");
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  assertEquals(await t.feed.caughtUp(), "catching-up");
  now += FOLLOWER_FEED_STUCK_MS + 1;
  assertEquals(await t.feed.caughtUp(), "stuck");
  t.sockets[0].open();
  t.sockets[0].deliver(frame([1]));
  await waitFor(() => t.fresh() === 1, "a frame");
  now += FOLLOWER_FEED_SILENCE_MS + 1;
  assertEquals(await t.feed.caughtUp(), "catching-up");
  now += FOLLOWER_FEED_STUCK_MS;
  assertEquals(await t.feed.caughtUp(), "stuck");
  await t.feed.stop();
});
