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
 * The v3 commit feed over serve's WebSocket (swamp-club#4120), against a
 * real v3 datastore on port 0: a commit lands in a subscriber's stream as it
 * lands, filtered as `GET changes` filters it; a cursor below the compaction
 * point ends the stream with `commits_compacted`; a team peer reads the feed
 * whole but nothing else; and a follower's {@link FollowerFeed} applies what
 * the leader sends and keeps its copy fresh.
 */

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { parsePrincipal } from "../src/domain/access/principal.ts";
import { handleConnection } from "../src/serve/connection.ts";
import { FollowerFeed } from "../src/serve/follower_feed.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import { markPeerSocket } from "../src/serve/peer_auth.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  blobSaveOps,
  commitBody,
  partitionPath,
  post,
  type Server,
  sha256Hex,
  TOKENS,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

const PEER_TOKEN = "swamp-peer.test";

/** Serves the WebSocket over `server`'s context, with its commit feed. */
async function withFeedSocket(
  server: Server,
  fn: (wsUrl: string) => Promise<void>,
): Promise<void> {
  const store = server.v3.commitStore;
  const ctx = server.ctx as ConnectionContext;
  ctx.commitFeed = {
    datastore: server.v3,
    bound: () => store.highWaterMark().cursor,
    onMoved: (listener) => store.onHeadMoved(listener),
  };
  const http = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const token = (req.headers.get("authorization") ?? "").replace(
        /^Bearer /,
        "",
      );
      const { socket, response } = Deno.upgradeWebSocket(req);
      if (token === PEER_TOKEN) {
        markPeerSocket(socket);
        handleConnection(socket, ctx, null);
      } else {
        handleConnection(socket, ctx, parsePrincipal(TOKENS[token]));
      }
      return response;
    },
  );
  try {
    await fn(`http://127.0.0.1:${http.addr.port}`);
  } finally {
    await http.shutdown();
  }
}

interface Subscriber {
  readonly socket: WebSocket;
  readonly frames: {
    type: string;
    id: string;
    payload?: { changes: unknown[]; cursor: number; head: number };
    error?: { code: string };
  }[];
}

async function subscribe(
  wsUrl: string,
  token: string,
  cursor: number,
): Promise<Subscriber> {
  const socket = new WebSocket(wsUrl.replace("http", "ws"), {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  const subscriber: Subscriber = { socket, frames: [] };
  socket.onmessage = (event) =>
    subscriber.frames.push(JSON.parse(String(event.data)));
  await new Promise((resolve) => (socket.onopen = resolve));
  socket.send(JSON.stringify({
    type: "commits.subscribe",
    id: "feed",
    payload: { cursor },
  }));
  return subscriber;
}

async function land(server: Server): Promise<void> {
  const content = new TextEncoder().encode(crypto.randomUUID());
  const seq = Number(
    (await (await fetch(`${partitionPath(server)}?after=0`, {
      headers: { authorization: "Bearer alice-token" },
    })).json()).head,
  );
  const landed = await post(
    partitionPath(server),
    "alice-token",
    commitBody({
      expectedSeq: seq,
      txnId: crypto.randomUUID(),
      ops: await blobSaveOps(server, "vpc", seq + 1, content),
      chunks: [{ sha256: await sha256Hex(content), size: content.length }],
    }, [content]),
  );
  assertEquals(landed.status, 200, JSON.stringify(landed.json));
}

const changesOf = (subscriber: Subscriber) =>
  subscriber.frames.flatMap((frame) => frame.payload?.changes ?? []);
const lastCursor = (subscriber: Subscriber) =>
  subscriber.frames.at(-1)?.payload?.cursor ?? -1;

Deno.test({
  name:
    "commit feed: a commit reaches a subscriber as it lands; a caller who may not read it sees only the cursor move",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withFeedSocket(server, async (wsUrl) => {
        const start = server.v3.commitStore.highWaterMark().cursor;
        const alice = await subscribe(wsUrl, "alice-token", start);
        const bob = await subscribe(wsUrl, "bob-token", start);
        try {
          await waitFor(
            () => alice.frames.length > 0 && bob.frames.length > 0,
            "the first frames",
          );
          await land(server);
          const head = server.v3.commitStore.highWaterMark().cursor;
          await waitFor(
            () => changesOf(alice).length === 1,
            "the commit at alice",
          );
          await waitFor(() => lastCursor(bob) === head, "bob's cursor moved");
          assertEquals(changesOf(bob), []);
          assertEquals(lastCursor(alice), head);
        } finally {
          alice.socket.close();
          bob.socket.close();
        }
      });
    });
  },
});

Deno.test({
  name:
    "commit feed: a resubscribe from the last cursor picks up only what landed after it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withFeedSocket(server, async (wsUrl) => {
        await land(server);
        const after = server.v3.commitStore.highWaterMark().cursor;
        await land(server);
        const again = await subscribe(wsUrl, "alice-token", after);
        try {
          await waitFor(() => changesOf(again).length === 1, "one commit");
          const [change] = changesOf(again) as { cursor: number }[];
          assert(change.cursor > after);
        } finally {
          again.socket.close();
        }
      });
    });
  },
});

Deno.test({
  name:
    "commit feed: a cursor below the compaction point ends the stream with commits_compacted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withFeedSocket(server, async (wsUrl) => {
        await land(server);
        await land(server);
        const store = server.v3.commitStore;
        await store.compactHistory(store.highWaterMark().cursor, {
          fence: store.writerFence(),
        });
        const late = await subscribe(wsUrl, "alice-token", 0);
        try {
          await waitFor(() => late.frames.length > 0, "a frame");
          assertEquals(late.frames[0].type, "error");
          assertEquals(late.frames[0].error?.code, "commits_compacted");
        } finally {
          late.socket.close();
        }
      });
    });
  },
});

Deno.test({
  name: "commit feed: one connection holds a bounded number of subscriptions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withFeedSocket(server, async (wsUrl) => {
        const first = await subscribe(wsUrl, "alice-token", 0);
        try {
          for (let i = 1; i <= 4; i++) {
            first.socket.send(JSON.stringify({
              type: "commits.subscribe",
              id: `feed-${i}`,
              payload: { cursor: 0 },
            }));
          }
          await waitFor(
            () => first.frames.some((frame) => frame.id === "feed-4"),
            "the fifth subscription's reply",
          );
          const fifth = first.frames.find((frame) => frame.id === "feed-4");
          assertEquals(fifth?.type, "error");
          assertEquals(fifth?.error?.code, "subscription_limit");
        } finally {
          first.socket.close();
        }
      });
    });
  },
});

Deno.test({
  name:
    "commit feed: a subscription already running ends once fail-secure audit cannot record",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withFeedSocket(server, async (wsUrl) => {
        const sub = await subscribe(wsUrl, "alice-token", 0);
        try {
          await waitFor(() => sub.frames.length > 0, "the first frame");
          const ctx = server.ctx as ConnectionContext;
          Object.assign(ctx, {
            auditFailOpen: false,
            auditEmitter: { durableStalled: true },
          });
          // Checked again at the next frame, a heartbeat at the latest.
          await waitFor(
            () => sub.frames.some((frame) => frame.type === "error"),
            "the refusal",
          );
          assertEquals(
            sub.frames.find((frame) => frame.type === "error")?.error?.code,
            "audit_unavailable",
          );
        } finally {
          sub.socket.close();
        }
      });
    });
  },
});

Deno.test({
  name:
    "commit feed: a team peer reads the whole feed, and is refused any other request",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withFeedSocket(server, async (wsUrl) => {
        const start = server.v3.commitStore.highWaterMark().cursor;
        const peer = await subscribe(wsUrl, PEER_TOKEN, start);
        try {
          await land(server);
          await waitFor(() => changesOf(peer).length === 1, "the commit");
          peer.socket.send(JSON.stringify({
            type: "data.query",
            id: "q",
            payload: { predicate: "true" },
          }));
          await waitFor(
            () => peer.frames.some((frame) => frame.id === "q"),
            "the refusal",
          );
          const refusal = peer.frames.find((frame) => frame.id === "q");
          assertEquals(refusal?.type, "error");
          assertEquals(refusal?.error?.code, "forbidden");
        } finally {
          peer.socket.close();
        }
      });
    });
  },
});

Deno.test({
  name:
    "commit feed: a follower's feed applies the leader's commits in order, keeps its copy fresh, and answers the barrier",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withFeedSocket(server, async (wsUrl) => {
        const leader = {
          instanceId: "leader-1",
          fence: 1,
          address: wsUrl,
          since: "2026-10-29T12:00:00.000Z",
        };
        const link = new LeaderLink({ leader: () => leader });
        const applied: number[] = [];
        let fresh = 0;
        const feed = new FollowerFeed({
          link,
          peerToken: () => Promise.resolve(PEER_TOKEN),
          copyCursor: () => server.v3.commitStore.highWaterMark().cursor,
          apply: (changes) => {
            applied.push(...changes.map((change) => change.cursor));
            return Promise.resolve();
          },
          onFresh: () => fresh++,
        });
        try {
          feed.follow(leader);
          await waitFor(() => fresh > 0, "the first frame");
          assert(feed.current(leader));
          assert(!feed.current({ ...leader, fence: 2 }));
          await land(server);
          await waitFor(() => applied.length === 1, "the commit applied");
          await feed.barrier();
          assertEquals(
            applied,
            [server.v3.commitStore.highWaterMark().cursor],
          );
        } finally {
          await feed.stop();
          link.close();
        }
        assert(!feed.current(leader));
      });
    });
  },
});
