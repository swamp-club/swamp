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

// An audit subscription written in the behavior spelling receives the
// model-spelled events (swamp-club#3334).

import { assertEquals } from "@std/assert";
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { WebSocketSink } from "./websocket_sink.ts";

function event(action: string, resourceKind: string): AuditEvent {
  return createAuditEvent({
    instanceId: "i",
    category: "execution",
    stage: "response",
    outcome: "success",
    action,
    resourceKind,
    resourceName: "m",
    principalKind: "user",
    principalId: "u",
    initiatedBy: "user:u",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });
}

function socket(): { socket: WebSocket; sent: string[] } {
  const sent: string[] = [];
  return {
    socket: {
      readyState: WebSocket.OPEN,
      send(data: string) {
        sent.push(data);
      },
      close() {},
    } as unknown as WebSocket,
    sent,
  };
}

function receivedActions(sent: string[]): string[] {
  return sent.map((s) => JSON.parse(s).payload.event.action);
}

Deno.test("WebSocketSink: behavior-spelled actions and resource kind match the model-spelled events", async () => {
  const events = [
    event("model.method.run", "model"),
    event("workflow.run", "workflow"),
    event("model.create", "model"),
  ];
  const cases: [Record<string, unknown>, string[]][] = [
    [{ actions: ["behavior.method.run"] }, ["model.method.run"]],
    [{ actions: ["model.method.run"] }, ["model.method.run"]],
    [{ resourceKind: "behavior" }, ["model.method.run", "model.create"]],
    [{ resourceKind: "model" }, ["model.method.run", "model.create"]],
    [{ actions: ["behaviour.method.run"] }, []],
    [{ resourceKind: "behaviour" }, []],
  ];
  for (const [filter, expected] of cases) {
    const sink = new WebSocketSink();
    const s = socket();
    const original = structuredClone(filter);
    sink.subscribe({ id: "sub", socket: s.socket, filter });
    await sink.write(events);
    assertEquals(receivedActions(s.sent), expected, JSON.stringify(filter));
    // The caller's filter is not rewritten.
    assertEquals(filter, original);
  }
});
