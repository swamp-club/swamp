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
import { initializeLogging } from "../logging/logger.ts";
import { watchServeFeed } from "./serve_feed_client.ts";

await initializeLogging({});

async function withServe(
  frames: unknown[],
  fn: (url: string, seen: { auth: string | null; sent: unknown[] }) => Promise<
    void
  >,
): Promise<void> {
  const seen = { auth: null as string | null, sent: [] as unknown[] };
  const sockets: WebSocket[] = [];
  const http = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      seen.auth = req.headers.get("authorization");
      const { socket, response } = Deno.upgradeWebSocket(req);
      sockets.push(socket);
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        seen.sent.push(frame);
        if (frame.type === "commits.head") {
          socket.send(JSON.stringify({
            type: "commits.head",
            id: frame.id,
            payload: { cursor: 41 },
          }));
        } else if (frame.type === "commits.subscribe") {
          for (const f of frames) socket.send(JSON.stringify(f));
        }
      };
      return response;
    },
  );
  try {
    await fn(`http://127.0.0.1:${http.addr.port}`, seen);
  } finally {
    for (const socket of sockets) {
      if (socket.readyState <= WebSocket.OPEN) socket.close();
    }
    await http.shutdown();
  }
}

Deno.test("watchServeFeed: subscribes from serve's head with the checkout's token, and catches up when commits arrive", async () => {
  const feedFrame = (changes: unknown[]) => ({
    type: "commits.subscribe",
    id: "feed",
    payload: { changes, cursor: 42, head: 42, done: false },
  });
  await withServe(
    [feedFrame([]), feedFrame([{ cursor: 42, commit: {} }])],
    async (url, seen) => {
      let catchUps = 0;
      const watch = watchServeFeed({
        target: {
          serverUrl: url,
          token: "alice.secret",
          caCerts: undefined,
          extraHeaders: {},
        },
        catchUp: () => {
          catchUps++;
          return Promise.resolve();
        },
      });
      try {
        await waitFor(() => catchUps >= 2, "a catch-up after the commit");
        assertEquals(seen.auth, "Bearer alice.secret");
        assertEquals(seen.sent[1], {
          type: "commits.subscribe",
          id: "feed",
          payload: { cursor: 41 },
        });
      } finally {
        await watch.stop();
      }
    },
  );
});

Deno.test("watchServeFeed: a heartbeat with no commits starts no catch-up beyond the first", async () => {
  await withServe([{
    type: "commits.subscribe",
    id: "feed",
    payload: { changes: [], cursor: 41, head: 41, done: false },
  }], async (url, seen) => {
    let catchUps = 0;
    const watch = watchServeFeed({
      target: {
        serverUrl: url,
        token: undefined,
        caCerts: undefined,
        extraHeaders: {},
      },
      catchUp: () => {
        catchUps++;
        return Promise.resolve();
      },
    });
    try {
      await waitFor(() => seen.sent.length === 2, "the subscription");
      await waitFor(() => catchUps === 1, "the first catch-up");
    } finally {
      await watch.stop();
    }
    assertEquals(catchUps, 1);
    assertEquals(seen.auth, null);
  });
});

function feedOf(changes: unknown[], cursor: number) {
  return {
    type: "commits.subscribe",
    id: "feed",
    payload: { changes, cursor, head: cursor, done: false },
  };
}

// serve closes the socket after the last frame: once the client sees the
// close, it has handled every frame before it
async function catchUpsFor(
  frames: unknown[],
  options: {
    readonly appliedCursor?: () => number;
    readonly sentHere?: (txnId: string) => boolean;
  },
  locals: { count: number } = { count: 0 },
): Promise<number> {
  let catchUps = 0;
  const http = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "commits.head") {
          socket.send(JSON.stringify({
            type: "commits.head",
            id: frame.id,
            payload: { cursor: 41 },
          }));
        } else if (frame.type === "commits.subscribe") {
          for (const f of frames) socket.send(JSON.stringify(f));
          socket.close(1000, "done");
        }
      };
      return response;
    },
  );
  let closed = false;
  try {
    const watch = watchServeFeed({
      target: {
        serverUrl: `http://127.0.0.1:${http.addr.port}`,
        token: undefined,
        caCerts: undefined,
        extraHeaders: {},
      },
      catchUp: () => {
        catchUps++;
        return Promise.resolve();
      },
      catchUpLocally: () => {
        locals.count++;
        return Promise.resolve();
      },
      openSocket: (url, headers) => {
        const socket = new WebSocket(url, { headers } as unknown as string[]);
        socket.addEventListener("close", () => closed = true);
        return socket;
      },
      ...options,
    });
    try {
      await waitFor(() => closed, "serve closing the feed");
    } finally {
      await watch.stop();
    }
  } finally {
    await http.shutdown();
  }
  return catchUps;
}

const theirs = (cursor: number) =>
  feedOf([{ cursor, commit: { txnId: "theirs" } }], cursor);

Deno.test("watchServeFeed: a head the copy already applied starts no catch-up; one past it does (swamp-club#4457)", async () => {
  assertEquals(await catchUpsFor([theirs(42)], { appliedCursor: () => 41 }), 1);
  assertEquals(await catchUpsFor([theirs(42)], { appliedCursor: () => 40 }), 2);
});

Deno.test("watchServeFeed: a frame holding only commits this process sent brings up only the read model; one with another writer's catches up from serve (swamp-club#4457)", async () => {
  const sentHere = (txnId: string) => txnId === "mine";
  const own = feedOf([{ cursor: 42, commit: { txnId: "mine" } }], 42);
  const mixed = feedOf([
    { cursor: 43, commit: { txnId: "mine" } },
    { cursor: 44, commit: { txnId: "theirs" } },
  ], 44);
  const locals = { count: 0 };
  assertEquals(
    await catchUpsFor(
      [own, mixed],
      { appliedCursor: () => 41, sentHere },
      locals,
    ),
    1,
  );
  assertEquals(locals.count, 1);
  assertEquals(
    await catchUpsFor([own, theirs(43)], { appliedCursor: () => 41 }),
    2,
  );
});

Deno.test("watchServeFeed: stopping the watch cuts short a catch-up still under way, so a command's exit never waits on it", async () => {
  await withServe([], async (url) => {
    let started = false;
    let aborted = false;
    const watch = watchServeFeed({
      target: {
        serverUrl: url,
        token: undefined,
        caCerts: undefined,
        extraHeaders: {},
      },
      // a catch-up whose request serve never answers
      catchUp: (signal) => {
        started = true;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    });
    await waitFor(() => started, "the head's catch-up under way");
    await watch.stop();
    assertEquals(aborted, true);
  });
});

Deno.test("watchServeFeed: with a ready gate, a head's catch-up waits for it, then runs only if the copy is still short of that head", async () => {
  for (const reached of [true, false]) {
    await withServe([], async (url) => {
      let catchUps = 0;
      let applied = 0;
      const gate = Promise.withResolvers<void>();
      let waiting = false;
      const watch = watchServeFeed({
        target: {
          serverUrl: url,
          token: undefined,
          caCerts: undefined,
          extraHeaders: {},
        },
        appliedCursor: () => applied,
        ready: async () => {
          waiting = true;
          await gate.promise;
        },
        catchUp: () => {
          catchUps++;
          return Promise.resolve();
        },
      });
      try {
        await waitFor(() => waiting, "the head's catch-up held");
        assertEquals(catchUps, 0);
        // the command's own catch-up brought the copy to serve's head, or not
        applied = reached ? 41 : 40;
        gate.resolve();
        await waitFor(
          () => reached || catchUps === 1,
          "the held catch-up decided",
        );
      } finally {
        await watch.stop();
      }
      assertEquals(catchUps, reached ? 0 : 1);
    });
  }
});
