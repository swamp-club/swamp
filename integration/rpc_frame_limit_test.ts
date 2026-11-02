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

import { assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  FRAME_TOO_LARGE,
  MAX_RPC_FRAME_BYTES,
  RpcChannel,
  RpcError,
} from "../src/domain/remote/rpc_channel.ts";

await initializeLogging({});

interface Link {
  client: RpcChannel;
  server: RpcChannel;
  clientSocket: WebSocket;
  serverSocket: () => WebSocket;
  closes: () => number;
  received: string[];
}

async function withLink(fn: (link: Link) => Promise<void>): Promise<void> {
  let serverSocket: WebSocket | undefined;
  let server: RpcChannel | undefined;
  const ready = Promise.withResolvers<void>();
  const httpServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      serverSocket = socket;
      server = new RpcChannel({ send: (data) => socket.send(data) });
      socket.onmessage = (event) => {
        if (typeof event.data === "string") server!.handleRaw(event.data);
      };
      socket.onopen = () => ready.resolve();
      return response;
    },
  );
  const clientSocket = new WebSocket(
    `ws://127.0.0.1:${httpServer.addr.port}/`,
  );
  const client = new RpcChannel({ send: (data) => clientSocket.send(data) });
  const received: string[] = [];
  let closes = 0;
  clientSocket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    if (!client.handleRaw(event.data)) received.push(event.data);
  };
  clientSocket.onclose = () => closes++;
  const opened = new Promise<void>((resolve) => {
    clientSocket.onopen = () => resolve();
  });
  try {
    await Promise.all([opened, ready.promise]);
    await fn({
      client,
      server: server!,
      clientSocket,
      serverSocket: () => serverSocket!,
      closes: () => closes,
      received,
    });
  } finally {
    const closed = new Promise<void>((resolve) => {
      if (clientSocket.readyState === WebSocket.CLOSED) resolve();
      else clientSocket.addEventListener("close", () => resolve());
    });
    clientSocket.close();
    await closed;
    await httpServer.shutdown();
  }
}

Deno.test({
  name:
    "rpc frame limit: a reply over the limit fails only its own call and the socket stays open",
  fn: async () => {
    await withLink(async (link) => {
      link.server.register(
        "big",
        () => Promise.resolve("x".repeat(MAX_RPC_FRAME_BYTES)),
      );
      link.server.register("echo", (params) => Promise.resolve(params));
      const error = await assertRejects(
        () => link.client.call("big", {}),
        RpcError,
      );
      assertEquals(error.code, FRAME_TOO_LARGE);
      assertEquals(
        await link.client.call("echo", { after: "refusal" }),
        { after: "refusal" },
      );
      assertEquals(link.clientSocket.readyState, WebSocket.OPEN);
      assertEquals(link.closes(), 0);
    });
  },
});

Deno.test({
  name:
    "rpc frame limit: a frame of exactly MAX_RPC_FRAME_BYTES is delivered by the pinned Deno version",
  fn: async () => {
    await withLink(async (link) => {
      link.serverSocket().send("y".repeat(MAX_RPC_FRAME_BYTES));
      await waitFor(
        () => link.received.length === 1 || link.closes() > 0,
        "the at-limit frame to arrive or the socket to close",
      );
      assertEquals(link.closes(), 0);
      assertEquals(link.received[0].length, MAX_RPC_FRAME_BYTES);
    });
  },
});
