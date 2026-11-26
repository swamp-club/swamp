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

import { V3StorageUnreachableError } from "../domain/datastore_v3/writer_lease.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { ServeLeader } from "../domain/datastore_v3/serve_leader.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import {
  type FeedChange,
  FOLLOWER_FEED_SILENCE_MS,
  FOLLOWER_FEED_STUCK_MS,
  FOLLOWER_UNREADY_APPLY_FAILURES,
  FOLLOWER_UNREADY_WAL_BYTES,
  FollowerFeed,
  followerUnreadyReason,
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
  let going = 0;
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
    onLeaderGoing: () => going++,
  });
  return {
    feed,
    sockets,
    going: () => going,
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

Deno.test("FollowerFeed.staleReason: names what stopped a current feed: the silence and how long, a failure, a leader change (swamp-club#4981)", async () => {
  let now = 1_000_000;
  const t = setup(() => now);
  assertEquals(t.feed.staleReason(leader("a", 1)), "it follows no leader");
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].open();
  t.sockets[0].deliver(frame([]));
  await waitFor(() => t.fresh() === 1, "a heartbeat");
  assertEquals(t.feed.staleReason(leader("a", 1)), undefined);
  assertEquals(t.feed.staleReason(leader("a", 2)), "the leader changed");
  now += FOLLOWER_FEED_SILENCE_MS + 1;
  assertEquals(
    t.feed.staleReason(leader("a", 1)),
    `no frame for ${
      FOLLOWER_FEED_SILENCE_MS + 1
    } ms, past the ${FOLLOWER_FEED_SILENCE_MS} ms allowed`,
  );
  t.sockets[0].deliver({
    type: "error",
    id: "follower-feed",
    error: { code: "commits_compacted", message: "compacted" },
  });
  await waitFor(
    () =>
      t.feed.staleReason(leader("a", 1)) !== undefined &&
      !t.feed.staleReason(leader("a", 1))!.startsWith("no frame"),
    "the failure",
  );
  assertEquals(t.feed.staleReason(leader("a", 1)), "it failed");
  await t.feed.stop();
});

Deno.test("FollowerFeed: its subscribe names lease ops and step starts, so the leader sends them to this copy (swamp-club#4168)", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].open();
  const subscribe = JSON.parse(t.sockets[0].sent[0]);
  assertEquals(subscribe.type, "commits.subscribe");
  assertEquals(subscribe.payload, {
    cursor: 0,
    features: ["lease-ops", "step-starts", "leader-stepping-down"],
  });
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

/** a feed whose applies throw `failure` while it is set */
function failingSetup() {
  const sockets: FakeSocket[] = [];
  const link = {
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return { socket, leader: leader("x", 1) };
    },
  } as unknown as LeaderLink;
  const state: { failure: Error | undefined; settled: number } = {
    failure: undefined,
    settled: 0,
  };
  const feed = new FollowerFeed({
    link,
    peerToken: () => Promise.resolve("swamp-peer.k"),
    copyCursor: () => 0,
    apply: () => {
      state.settled++;
      return state.failure === undefined
        ? Promise.resolve()
        : Promise.reject(state.failure);
    },
    onFresh: () => {},
  });
  const followAgain = async () => {
    const opened = sockets.length;
    feed.follow(leader("a", 1));
    await waitFor(() => sockets.length > opened, "a fresh socket");
    const socket = sockets.at(-1)!;
    socket.open();
    return socket;
  };
  const deliverOnNewSocket = async (cursors: number[]) => {
    const settled = state.settled;
    (await followAgain()).deliver(frame(cursors));
    await waitFor(() => state.settled > settled, "the apply to settle");
    await feed.stop();
  };
  return { feed, state, followAgain, deliverOnNewSocket };
}

const readiness = (feed: FollowerFeed, walBytes?: number) =>
  followerUnreadyReason({
    localApplyFailures: feed.localApplyFailures,
    walBytes,
  });

Deno.test("FollowerFeed.localApplyFailures: applies failing on this node in a row make /ready report it broken; one frame applied clears it (swamp-club#4679)", async () => {
  const t = failingSetup();
  t.state.failure = new Error("database or disk is full");
  for (let i = 1; i < FOLLOWER_UNREADY_APPLY_FAILURES; i++) {
    await t.deliverOnNewSocket([i]);
    assertEquals(readiness(t.feed), undefined);
  }
  await t.deliverOnNewSocket([FOLLOWER_UNREADY_APPLY_FAILURES]);
  assertEquals(t.feed.localApplyFailures, FOLLOWER_UNREADY_APPLY_FAILURES);
  assertStringIncludes(readiness(t.feed)!, "in a row on this node");
  t.state.failure = undefined;
  await t.deliverOnNewSocket([FOLLOWER_UNREADY_APPLY_FAILURES]);
  assertEquals(t.feed.localApplyFailures, 0);
  assertEquals(readiness(t.feed), undefined);
});

Deno.test("FollowerFeed.localApplyFailures: a dead leader, a dropped socket, a divergence or a network failure never counts (swamp-club#4679)", async () => {
  const t = failingSetup();
  for (let i = 0; i <= FOLLOWER_UNREADY_APPLY_FAILURES; i++) {
    const ended = await t.followAgain();
    ended.deliver({
      type: "error",
      id: "follower-feed",
      error: { code: "serve_not_leader", message: "not the leader" },
    });
    (await t.followAgain()).close();
  }
  const diverged = new Error("The commit feed diverged from this copy: seq 4");
  diverged.name = "FeedDivergedError";
  const unreachable = new Error("fetching a chunk failed", {
    cause: new Deno.errors.ConnectionReset("reset by peer"),
  });
  const throttled = new Error("applying the leader's commits failed", {
    cause: new V3StorageUnreachableError(
      "gs://bucket",
      new Error("503 SlowDown"),
    ),
  });
  for (const failure of [diverged, unreachable, throttled]) {
    t.state.failure = failure;
    for (let i = 0; i <= FOLLOWER_UNREADY_APPLY_FAILURES; i++) {
      await t.deliverOnNewSocket([i + 1]);
    }
  }
  assertEquals(t.feed.localApplyFailures, 0);
  assertEquals(readiness(t.feed), undefined);
  await t.feed.stop();
});

Deno.test("followerUnreadyReason: a takeover's restore keeps /ready 200: a stopped feed and a leaderless window past the stuck bound are no failures (swamp-club#4679)", async () => {
  let now = 1_000_000;
  const t = setup(() => now);
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].open();
  t.sockets[0].deliver(frame([1]));
  await waitFor(() => t.fresh() === 1, "a frame");
  // the tick stops the feed for the takeover's restore; no leader answers
  await t.feed.stop();
  now += FOLLOWER_FEED_STUCK_MS * 4;
  assertEquals(await t.feed.caughtUp(), "stuck");
  assertEquals(readiness(t.feed), undefined);
  assertEquals(readiness(t.feed, 0), undefined);
  t.feed.follow(undefined);
  assertEquals(readiness(t.feed, 64 * 1024 * 1024), undefined);
  await t.feed.stop();
});

Deno.test("followerUnreadyReason: a WAL past the bound reports the follower broken (swamp-club#4679)", () => {
  assertEquals(
    followerUnreadyReason({
      localApplyFailures: 0,
      walBytes: FOLLOWER_UNREADY_WAL_BYTES,
    }),
    undefined,
  );
  assertStringIncludes(
    followerUnreadyReason({
      localApplyFailures: 0,
      walBytes: FOLLOWER_UNREADY_WAL_BYTES + 1,
    })!,
    "WAL",
  );
});

Deno.test("FollowerFeed: a leader that says it is stepping down is reported, and the frame still applies", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].open();
  const stepping = frame([]);
  t.sockets[0].deliver({
    ...stepping,
    payload: { ...stepping.payload, steppingDown: true },
  });
  await waitFor(() => t.fresh() === 1, "the frame applied");
  assertEquals(t.going(), 1);
  await t.feed.stop();
});

Deno.test("FollowerFeed: the leader closing the feed is reported; the follower stopping it, or failing it itself, is not", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].open();
  t.sockets[0].close();
  assertEquals(t.going(), 1);

  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 2, "a second socket");
  t.sockets[1].open();
  t.sockets[1].deliver({ type: "commits.subscribe", id: "follower-feed" });
  await waitFor(() => !t.feed.current(leader("a", 1)), "the feed failed");
  assertEquals(t.going(), 1);

  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 3, "a third socket");
  t.sockets[2].open();
  await t.feed.stop();
  assertEquals(t.going(), 1);
});

Deno.test("FollowerFeed: a socket that never opened is a connect failure, not the leader going", async () => {
  const t = setup();
  t.feed.follow(leader("a", 1));
  await waitFor(() => t.sockets.length === 1, "the socket");
  t.sockets[0].close();
  assertEquals(t.going(), 0);
  await t.feed.stop();
});

Deno.test("FollowerFeed: a copy that cannot name its cursor opens no socket and is not current, so the tick restores it first (swamp-club#5145)", async () => {
  let opened = 0;
  let asked = 0;
  const link = {
    openSocket: () => {
      opened++;
      return { socket: new FakeSocket(), leader: leader("x", 1) };
    },
  } as unknown as LeaderLink;
  const feed = new FollowerFeed({
    link,
    peerToken: () => Promise.resolve("swamp-peer.k"),
    copyCursor: () => {
      asked++;
      throw new Error("this node's copy holds commits it never replicated");
    },
    apply: () => Promise.resolve(),
    onFresh: () => {},
  });
  const followed = leader("a", 1);
  feed.follow(followed);
  await waitFor(
    () => feed.staleReason(followed) === "it failed",
    "the failure",
  );
  assertEquals(asked, 1);
  assertEquals(opened, 0);
  assertEquals(feed.current(followed), false);
  await feed.stop();
});
