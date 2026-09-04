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

import { assertEquals, assertMatch } from "@std/assert";
import { createAuditEvent } from "./audit_event.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

Deno.test("createAuditEvent: generates UUID id and ISO timestamp", () => {
  const event = createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "success",
    action: "access.check",
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
  });

  assertMatch(event.id, UUID_PATTERN);
  assertMatch(event.timestamp, ISO_PATTERN);
  assertEquals(event.category, "auth");
  assertEquals(event.stage, "response");
  assertEquals(event.outcome, "success");
  assertEquals(event.action, "access.check");
  assertEquals(event.instanceId, "inst-1");
  assertEquals(event.requestId, "req-1");
  assertEquals(event.sourceIp, "127.0.0.1");
});

Deno.test("createAuditEvent: preserves principal and detail fields", () => {
  const event = createAuditEvent({
    instanceId: "inst-1",
    category: "execution",
    stage: "response",
    outcome: "failure",
    action: "model.method.run",
    resourceKind: "model",
    resourceName: "my-model",
    principalKind: "token",
    principalId: "tok-abc",
    initiatedBy: "token:tok-abc",
    sourceIp: "127.0.0.1",
    requestId: "req-2",
    detail: "timeout after 30s",
  });

  assertEquals(event.principalKind, "token");
  assertEquals(event.principalId, "tok-abc");
  assertEquals(event.initiatedBy, "token:tok-abc");
  assertEquals(event.detail, "timeout after 30s");
});

Deno.test("createAuditEvent: generates unique ids", () => {
  const a = createAuditEvent({
    instanceId: "inst-1",
    category: "admin",
    stage: "response",
    outcome: "success",
    action: "serve.reload",
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-4",
  });
  const b = createAuditEvent({
    instanceId: "inst-1",
    category: "admin",
    stage: "response",
    outcome: "success",
    action: "serve.reload",
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-5",
  });

  if (a.id === b.id) {
    throw new Error("Expected unique ids");
  }
});
