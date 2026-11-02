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
import {
  COMPRESSION_THRESHOLD_BYTES,
  resolveConnectionCompression,
  send,
  setConnectionCompression,
} from "../src/serve/handlers/shared.ts";
import { requestServerResponse } from "../src/cli/remote_run.ts";
import type { ServerMessage } from "../src/serve/protocol.ts";

const results = Array.from(
  { length: Math.ceil(COMPRESSION_THRESHOLD_BYTES / 20) },
  (_, i) => ({ name: `workflow-${i}`, jobCount: 1 }),
);

function startServer(): { url: string; shutdown: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      setConnectionCompression(socket, resolveConnectionCompression(req.url));
      socket.onmessage = (event) => {
        const request = JSON.parse(event.data as string);
        const reply: ServerMessage = {
          type: "workflow.search",
          id: request.id,
          payload: { data: { query: "", results } },
        };
        send(socket, reply);
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

Deno.test({
  name:
    "serve compression: CLI client opts in, receives a gzip binary frame and decodes it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = startServer();
    const frameKinds: string[] = [];
    try {
      const payload = await requestServerResponse<
        { data: { results: unknown[] } }
      >(
        {
          server: server.url,
          createSocket: (url, headers) => {
            const socket = new WebSocket(url, { headers });
            socket.addEventListener("message", (event) => {
              frameKinds.push(
                typeof event.data === "string" ? "text" : "binary",
              );
            });
            return socket;
          },
        },
        { type: "workflow.search" },
      );
      assertEquals(payload.data.results, results);
      assertEquals(frameKinds, ["binary"]);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "serve compression: a client that does not opt in receives text",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = startServer();
    try {
      const socket = new WebSocket(server.url);
      const data = await new Promise<unknown>((resolve, reject) => {
        socket.onopen = () =>
          socket.send(JSON.stringify({ type: "workflow.search", id: "plain" }));
        socket.onmessage = (event) => resolve(event.data);
        socket.onerror = () => reject(new Error("socket error"));
      });
      socket.close();
      assertEquals(typeof data, "string");
      assertEquals(JSON.parse(data as string).payload.data.results, results);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "serve frame limit: an over-limit reply fails one request and the socket stays open for the next",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (event) => {
          const request = JSON.parse(event.data as string);
          send(socket, {
            type: "workflow.search",
            id: request.id,
            payload: {
              data: {
                query: request.id === "huge"
                  ? "x".repeat(64 * 1024 * 1024)
                  : "",
                results: [],
              },
            },
          });
        };
        return response;
      },
    );
    const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}`);
    try {
      const replies: Record<string, unknown>[] = [];
      const closed = Promise.withResolvers<void>();
      const received = Promise.withResolvers<void>();
      socket.onclose = () => closed.resolve();
      socket.onmessage = (event) => {
        replies.push(JSON.parse(event.data as string));
        if (replies.length === 1) {
          socket.send(JSON.stringify({ type: "workflow.search", id: "small" }));
        } else {
          received.resolve();
        }
      };
      socket.onopen = () =>
        socket.send(JSON.stringify({ type: "workflow.search", id: "huge" }));
      await Promise.race([
        received.promise,
        closed.promise.then(() => {
          throw new Error("the socket closed");
        }),
      ]);

      assertEquals(replies.map((reply) => [reply.type, reply.id]), [
        ["error", "huge"],
        ["workflow.search", "small"],
      ]);
      assertEquals(
        (replies[0].error as { code: string }).code,
        "frame_too_large",
      );
      assertEquals(socket.readyState, WebSocket.OPEN);
    } finally {
      socket.close();
      await server.shutdown();
    }
  },
});
