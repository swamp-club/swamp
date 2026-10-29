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

/** A scripted serve: answers the head, then sends `frames` to the feed. */
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
