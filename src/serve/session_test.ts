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
import { RunEventBuffer } from "./run_event_buffer.ts";
import { subscribeUntilDetach } from "./handlers/shared.ts";
import type { ServerMessage } from "./protocol.ts";
import type { SessionReply } from "./session.ts";

Deno.test("subscribeUntilDetach: synchronous replay can close a session before subscription returns", async () => {
  const buffer = new RunEventBuffer(10);
  buffer.push({ kind: "progress", value: 1 });
  const controller = new AbortController();
  const messages: ServerMessage[] = [];
  let open = true;
  const reply: SessionReply = {
    kind: "session-reply",
    get open() {
      return open;
    },
    send(message) {
      messages.push(message);
      open = false;
      controller.abort();
    },
    close() {
      open = false;
      controller.abort();
    },
    flush: () => Promise.resolve(),
  };
  await subscribeUntilDetach(buffer, reply, "replayed", controller);
  buffer.push({ kind: "progress", value: 2 });
  assertEquals(messages.length, 1);
  assertEquals(messages[0].type, "event");
});

Deno.test("subscribeUntilDetach: a session pulls a large replay only as its writes flush", async () => {
  const buffer = new RunEventBuffer(1_000);
  for (let value = 0; value < 512; value++) {
    buffer.push({ kind: "progress", value });
  }
  const controller = new AbortController();
  const messages: ServerMessage[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const reply: SessionReply = {
    kind: "session-reply",
    open: true,
    send: (message) => messages.push(message),
    close: () => controller.abort(),
    flush: () => blocked,
  };
  const completion = subscribeUntilDetach(buffer, reply, "replay", controller);
  await waitFor(() => messages.length === 1, "first replay waits for flush");
  assertEquals(messages.length, 1);
  // Events arriving during replay join the same ordered stream.
  buffer.push({ kind: "progress", value: 512 });
  buffer.finish({ kind: "done" });
  release();
  await completion;
  assertEquals(messages.length, 514);
  assertEquals(messages.at(-1)?.type, "done");
  assertEquals(
    messages.slice(0, -1).map((message) =>
      message.type === "event" ? message.event.seq : undefined
    ),
    Array.from({ length: 513 }, (_, index) => index + 1),
  );
});

Deno.test("subscribeUntilDetach: a follower overtaken by retention closes its session without stopping its producer", async () => {
  const buffer = new RunEventBuffer(2);
  buffer.push({ kind: "progress", value: 1 });
  const controller = new AbortController();
  const messages: ServerMessage[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  let closeCode: number | undefined;
  const reply: SessionReply = {
    kind: "session-reply",
    open: true,
    send: (message) => messages.push(message),
    close: (code) => {
      closeCode = code;
      controller.abort();
    },
    flush: () => blocked,
  };
  const completion = subscribeUntilDetach(buffer, reply, "slow", controller);
  await waitFor(() => messages.length === 1, "first write blocked");
  for (let value = 2; value <= 4; value++) {
    buffer.push({ kind: "progress", value });
  }
  release();
  await completion;
  assertEquals(closeCode, 1013);
  assertEquals(messages.length, 1);
  assertEquals(buffer.finished, false);
  assertEquals(buffer.push({ kind: "progress", value: 5 }), 5);
});

for (const transport of ["websocket", "reply"] as const) {
  Deno.test(`subscribeUntilDetach: ${transport} omits a failed transform and still delivers later events and terminal`, async () => {
    const buffer = new RunEventBuffer(10);
    buffer.push({ kind: "progress", value: "secret-canary" });
    buffer.push({ kind: "progress", value: "visible" });
    buffer.finish({ kind: "done" });
    const controller = new AbortController();
    const messages: ServerMessage[] = [];
    let closes = 0;
    const socket = transport === "reply"
      ? {
        kind: "session-reply" as const,
        open: true,
        send: (message: ServerMessage) => messages.push(message),
        close: () => closes++,
        flush: () => Promise.resolve(),
      }
      : {
        readyState: WebSocket.OPEN,
        send: (data: string) =>
          messages.push(JSON.parse(data) as ServerMessage),
        close: () => closes++,
      } as unknown as WebSocket;
    await subscribeUntilDetach(
      buffer,
      socket,
      "observed",
      controller,
      0,
      (event) => {
        if (event.value === "secret-canary") {
          return Promise.reject(new Error("Redaction unavailable"));
        }
        return Promise.resolve(event);
      },
    );
    assertEquals(messages, [
      {
        type: "event",
        id: "observed",
        event: { kind: "progress", value: "visible", seq: 2 },
      },
      { type: "done", id: "observed" },
    ]);
    assertEquals(closes, 0);
    assertEquals(controller.signal.aborted, false);
  });
}

Deno.test("subscribeUntilDetach: a legacy WebSocket closed during synchronous replay unsubscribes", async () => {
  const buffer = new RunEventBuffer(10);
  buffer.push({ kind: "progress", value: 1 });
  const controller = new AbortController();
  const messages: ServerMessage[] = [];
  let open = true;
  const socket = {
    get readyState() {
      return open ? WebSocket.OPEN : WebSocket.CLOSED;
    },
    send(data: string) {
      messages.push(JSON.parse(data) as ServerMessage);
      open = false;
      controller.abort();
    },
  } as unknown as WebSocket;
  let detached = false;
  const completion = subscribeUntilDetach(
    buffer,
    socket,
    "replayed",
    controller,
  ).then(() => {
    detached = true;
  });
  try {
    await waitFor(() => detached, "replay closure detaches the subscriber");
    buffer.push({ kind: "progress", value: 2 });
    assertEquals(messages.length, 1);
    assertEquals(buffer.finished, false);
  } finally {
    buffer.finish({ kind: "done" });
    await completion;
  }
});
