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
import { handleMessage, validateServerRequest } from "./connection.ts";
import type { ConnectionContext } from "./connection.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

// ── Mock WebSocket ──────────────────────────────────────────────────────

interface MockSocket {
  sent: string[];
  closed: boolean;
  readyState: number;
  send(data: string): void;
  close(): void;
}

function createMockSocket(): MockSocket {
  return {
    sent: [],
    closed: false,
    readyState: WebSocket.OPEN,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
  };
}

function parseSent(mock: MockSocket, index = 0): Record<string, unknown> {
  return JSON.parse(mock.sent[index]);
}

// Stub ConnectionContext — handleMessage only needs it for dispatch, and
// workflow/model handlers won't be reached in validation-level tests.
const stubCtx = {} as ConnectionContext;

function makeEvent(data: string): MessageEvent {
  return new MessageEvent("message", { data });
}

// ── validateServerRequest ───────────────────────────────────────────────

Deno.test("validateServerRequest accepts a valid workflow.run request", () => {
  const input = {
    type: "workflow.run",
    id: "req-1",
    payload: { workflowIdOrName: "deploy" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts a valid model.method.run request", () => {
  const input = {
    type: "model.method.run",
    id: "req-2",
    payload: { modelIdOrName: "my-model", methodName: "start" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest accepts a valid cancel request", () => {
  const input = { type: "cancel", id: "req-3" };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "object");
});

Deno.test("validateServerRequest rejects unknown type", () => {
  const input = { type: "unknown.type", id: "req-4" };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest rejects empty id", () => {
  const input = { type: "cancel", id: "" };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest rejects missing payload for workflow.run", () => {
  const input = { type: "workflow.run", id: "req-5" };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

Deno.test("validateServerRequest rejects missing methodName for model.method.run", () => {
  const input = {
    type: "model.method.run",
    id: "req-6",
    payload: { modelIdOrName: "m" },
  };
  const result = validateServerRequest(input);
  assertEquals(typeof result, "string");
});

// ── handleMessage: invalid JSON ─────────────────────────────────────────

Deno.test("handleMessage sends error for invalid JSON", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent("not json{{{"),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "invalid_request");
});

// ── handleMessage: validation failure ───────────────────────────────────

Deno.test("handleMessage sends error for invalid request shape", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "bad", id: "x" })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "invalid_request");
});

// ── handleMessage: cancel ───────────────────────────────────────────────

Deno.test("handleMessage cancel aborts the matching controller", () => {
  const mock = createMockSocket();
  const controller = new AbortController();
  const active = new Map<string, AbortController>([["req-10", controller]]);

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "cancel", id: "req-10" })),
  );

  assertEquals(controller.signal.aborted, true);
  // Cancel does not send a response
  assertEquals(mock.sent.length, 0);
});

Deno.test("handleMessage cancel for unknown id is a no-op", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "cancel", id: "nonexistent" })),
  );

  assertEquals(mock.sent.length, 0);
});

// ── handleMessage: duplicate request ID ─────────────────────────────────

Deno.test("handleMessage rejects duplicate request ID", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>([
    ["dup-1", new AbortController()],
  ]);

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({
      type: "workflow.run",
      id: "dup-1",
      payload: { workflowIdOrName: "w" },
    })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  assertEquals((msg.error as Record<string, unknown>).code, "duplicate_id");
});

// ── handleMessage: unknown type not leaked ──────────────────────────────

Deno.test("handleMessage does not leak unknown type value in error", () => {
  const mock = createMockSocket();
  const active = new Map<string, AbortController>();

  handleMessage(
    mock as unknown as WebSocket,
    stubCtx,
    active,
    makeEvent(JSON.stringify({ type: "secret.op", id: "x" })),
  );

  assertEquals(mock.sent.length, 1);
  const msg = parseSent(mock);
  assertEquals(msg.type, "error");
  // The error message should NOT contain the actual type value
  const errorMessage = String(
    (msg.error as Record<string, unknown>).message,
  );
  assertEquals(errorMessage.includes("secret.op"), false);
});
