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
import { type FeedChange, FollowerFeed } from "./follower_feed.ts";
import type { LeaderLink } from "./leader_link.ts";

await initializeLogging({});

/** A socket the test drives: it opens at once and records what is sent. */
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

function setup() {
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
