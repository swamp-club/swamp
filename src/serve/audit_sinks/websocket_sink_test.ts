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
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { WebSocketSink } from "./websocket_sink.ts";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return createAuditEvent({
    instanceId: "test-instance",
    category: "access",
    stage: "response",
    outcome: "success",
    action: "model.run",
    resourceKind: "model",
    resourceName: "test-model",
    principalKind: "user",
    principalId: "user-1",
    initiatedBy: "user:test",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
    ...overrides,
  });
}

function mockSocket(
  readyState = WebSocket.OPEN,
): { socket: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const socket = {
    readyState,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  } as unknown as WebSocket;
  return { socket, sent };
}

Deno.test("WebSocketSink: subscribe and receive events", async () => {
  const sink = new WebSocketSink();
  const { socket, sent } = mockSocket();

  sink.subscribe({ id: "sub-1", socket, filter: {} });
  assertEquals(sink.subscriptionCount, 1);

  const event = makeEvent();
  await sink.write([event]);

  assertEquals(sent.length, 1);
  const parsed = JSON.parse(sent[0]);
  assertEquals(parsed.type, "audit.event");
  assertEquals(parsed.id, "sub-1");
  assertEquals(parsed.payload.event.id, event.id);
});

Deno.test("WebSocketSink: filter by category", async () => {
  const sink = new WebSocketSink();
  const { socket, sent } = mockSocket();

  sink.subscribe({
    id: "sub-1",
    socket,
    filter: { categories: ["secrets"] },
  });

  await sink.write([
    makeEvent({ category: "access" }),
    makeEvent({ category: "secrets" }),
  ]);

  assertEquals(sent.length, 1);
  const parsed = JSON.parse(sent[0]);
  assertEquals(parsed.payload.event.category, "secrets");
});

Deno.test("WebSocketSink: filter by principal", async () => {
  const sink = new WebSocketSink();
  const { socket, sent } = mockSocket();

  sink.subscribe({
    id: "sub-1",
    socket,
    filter: { principals: ["user-2"] },
  });

  await sink.write([
    makeEvent({ principalId: "user-1" }),
    makeEvent({ principalId: "user-2" }),
  ]);

  assertEquals(sent.length, 1);
  const parsed = JSON.parse(sent[0]);
  assertEquals(parsed.payload.event.principalId, "user-2");
});

Deno.test("WebSocketSink: filter by outcome", async () => {
  const sink = new WebSocketSink();
  const { socket, sent } = mockSocket();

  sink.subscribe({
    id: "sub-1",
    socket,
    filter: { outcomes: ["denied"] },
  });

  await sink.write([
    makeEvent({ outcome: "success" }),
    makeEvent({ outcome: "denied" }),
  ]);

  assertEquals(sent.length, 1);
});

Deno.test("WebSocketSink: filter by action", async () => {
  const sink = new WebSocketSink();
  const { socket, sent } = mockSocket();

  sink.subscribe({
    id: "sub-1",
    socket,
    filter: { actions: ["vault.get"] },
  });

  await sink.write([
    makeEvent({ action: "model.run" }),
    makeEvent({ action: "vault.get" }),
  ]);

  assertEquals(sent.length, 1);
});

Deno.test("WebSocketSink: filter by resourceKind", async () => {
  const sink = new WebSocketSink();
  const { socket, sent } = mockSocket();

  sink.subscribe({
    id: "sub-1",
    socket,
    filter: { resourceKind: "vault" },
  });

  await sink.write([
    makeEvent({ resourceKind: "model" }),
    makeEvent({ resourceKind: "vault" }),
  ]);

  assertEquals(sent.length, 1);
});

Deno.test("WebSocketSink: empty filter matches all events", async () => {
  const sink = new WebSocketSink();
  const { socket, sent } = mockSocket();

  sink.subscribe({ id: "sub-1", socket, filter: {} });

  await sink.write([makeEvent(), makeEvent(), makeEvent()]);

  assertEquals(sent.length, 3);
});

Deno.test("WebSocketSink: unsubscribe removes subscription", async () => {
  const sink = new WebSocketSink();
  const { socket, sent } = mockSocket();

  sink.subscribe({ id: "sub-1", socket, filter: {} });
  sink.unsubscribe("sub-1");
  assertEquals(sink.subscriptionCount, 0);

  await sink.write([makeEvent()]);
  assertEquals(sent.length, 0);
});

Deno.test("WebSocketSink: closed socket is auto-removed", async () => {
  const sink = new WebSocketSink();
  const { socket } = mockSocket(WebSocket.CLOSED);

  sink.subscribe({ id: "sub-1", socket, filter: {} });
  await sink.write([makeEvent()]);

  assertEquals(sink.subscriptionCount, 0);
});

Deno.test("WebSocketSink: multiple subscribers receive independently", async () => {
  const sink = new WebSocketSink();
  const { socket: socket1, sent: sent1 } = mockSocket();
  const { socket: socket2, sent: sent2 } = mockSocket();

  sink.subscribe({
    id: "sub-1",
    socket: socket1,
    filter: { categories: ["access"] },
  });
  sink.subscribe({
    id: "sub-2",
    socket: socket2,
    filter: { categories: ["secrets"] },
  });

  await sink.write([
    makeEvent({ category: "access" }),
    makeEvent({ category: "secrets" }),
  ]);

  assertEquals(sent1.length, 1);
  assertEquals(sent2.length, 1);
});

Deno.test("WebSocketSink: subscriptionsForSocket returns correct ids", () => {
  const sink = new WebSocketSink();
  const { socket: socket1 } = mockSocket();
  const { socket: socket2 } = mockSocket();

  sink.subscribe({ id: "sub-1", socket: socket1, filter: {} });
  sink.subscribe({ id: "sub-2", socket: socket1, filter: {} });
  sink.subscribe({ id: "sub-3", socket: socket2, filter: {} });

  const ids = sink.subscriptionsForSocket(socket1);
  assertEquals(ids.sort(), ["sub-1", "sub-2"]);
});

Deno.test("WebSocketSink: durable is false", () => {
  const sink = new WebSocketSink();
  assertEquals(sink.durable, false);
});

Deno.test("WebSocketSink: close clears all subscriptions", async () => {
  const sink = new WebSocketSink();
  const { socket } = mockSocket();

  sink.subscribe({ id: "sub-1", socket, filter: {} });
  sink.subscribe({ id: "sub-2", socket, filter: {} });

  await sink.close();
  assertEquals(sink.subscriptionCount, 0);
});

Deno.test("WebSocketSink: no-op when no subscriptions", async () => {
  const sink = new WebSocketSink();
  await sink.write([makeEvent()]);
  await sink.flush();
  await sink.close();
});
