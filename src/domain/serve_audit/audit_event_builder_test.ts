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
import { buildAuditEvent } from "./audit_event_builder.ts";

Deno.test("buildAuditEvent: populates all fields", () => {
  const event = buildAuditEvent({
    instanceId: "inst-1",
    category: "execution",
    stage: "response",
    outcome: "success",
    action: "model.method.run",
    resourceKind: "model",
    resourceName: "my-model",
    principalKind: "token",
    principalId: "tok-abc",
    initiatedBy: "token:tok-abc",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    detail: "completed in 250ms",
  });

  assertEquals(event.category, "execution");
  assertEquals(event.action, "model.method.run");
  assertEquals(event.resourceName, "my-model");
  assertEquals(event.principalKind, "token");
  assertEquals(event.initiatedBy, "token:tok-abc");
  assertEquals(event.detail, "completed in 250ms");
});

Deno.test("buildAuditEvent: sanitizes absolute paths in action", () => {
  const event = buildAuditEvent({
    instanceId: "inst-1",
    category: "data",
    stage: "response",
    outcome: "failure",
    action: "/Users/admin/secret/path",
    resourceKind: "data",
    resourceName: "output",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-2",
  });

  assertEquals(event.action, "[redacted]");
});

Deno.test("buildAuditEvent: sanitizes paths in resourceName", () => {
  const event = buildAuditEvent({
    instanceId: "inst-1",
    category: "data",
    stage: "response",
    outcome: "success",
    action: "data.get",
    resourceKind: "data",
    resourceName: "/home/user/.swamp/data/output",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-3",
  });

  assertEquals(event.resourceName, "[redacted]");
});

Deno.test("buildAuditEvent: sanitizes Windows paths", () => {
  const event = buildAuditEvent({
    instanceId: "inst-1",
    category: "data",
    stage: "response",
    outcome: "success",
    action: "data.get",
    resourceKind: "data",
    resourceName: "C:\\Users\\admin\\file",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-4",
  });

  assertEquals(event.resourceName, "[redacted]");
});

Deno.test("buildAuditEvent: sanitizes .swamp internal paths in detail", () => {
  const event = buildAuditEvent({
    instanceId: "inst-1",
    category: "data",
    stage: "response",
    outcome: "failure",
    action: "data.get",
    resourceKind: "data",
    resourceName: "output",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-5",
    detail: "file not found: /.swamp/data/output",
  });

  assertEquals(event.detail, "[redacted]");
});

Deno.test("buildAuditEvent: passes through safe values unchanged", () => {
  const event = buildAuditEvent({
    instanceId: "inst-1",
    category: "secrets",
    stage: "response",
    outcome: "success",
    action: "vault.get",
    resourceKind: "vault",
    resourceName: "prod-vault",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-6",
    detail: "key: api-token",
  });

  assertEquals(event.action, "vault.get");
  assertEquals(event.resourceName, "prod-vault");
  assertEquals(event.detail, "key: api-token");
});

Deno.test("buildAuditEvent: omits detail when undefined", () => {
  const event = buildAuditEvent({
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
    requestId: "req-7",
  });

  assertEquals(event.detail, undefined);
});
