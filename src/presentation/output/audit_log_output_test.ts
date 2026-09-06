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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { AuditQueryResponse } from "../../serve/protocol.ts";
import { renderAuditLog } from "./audit_log_output.ts";

function captureLogs(fn: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

const sampleData: AuditQueryResponse = {
  events: [
    {
      id: "evt-1",
      timestamp: "2026-09-06T12:00:00.000Z",
      instanceId: "inst-1",
      category: "execution",
      stage: "response",
      outcome: "success",
      action: "model.method.run",
      resourceKind: "model",
      resourceName: "hello",
      principalKind: "user",
      principalId: "user-1",
      initiatedBy: "user:admin",
      sourceIp: "127.0.0.1",
      requestId: "req-1",
      version: 1,
      sequence: 1,
      digest: "abc123",
    },
    {
      id: "evt-2",
      timestamp: "2026-09-06T12:01:00.000Z",
      instanceId: "inst-1",
      category: "secrets",
      stage: "response",
      outcome: "denied",
      action: "vault.get",
      resourceKind: "vault",
      resourceName: "prod",
      principalKind: "user",
      principalId: "user-2",
      initiatedBy: "user:reader",
      sourceIp: "10.0.0.1",
      requestId: "req-2",
      version: 1,
      sequence: 2,
      digest: "def456",
    },
  ],
  total: 2,
};

Deno.test("renderAuditLog: json mode outputs valid JSON", () => {
  const output = captureLogs(() => renderAuditLog(sampleData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.events.length, 2);
  assertEquals(parsed.total, 2);
});

Deno.test("renderAuditLog: json mode preserves event fields", () => {
  const output = captureLogs(() => renderAuditLog(sampleData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.events[0].action, "model.method.run");
  assertEquals(parsed.events[1].outcome, "denied");
});

Deno.test("renderAuditLog: log mode includes action names", () => {
  const output = captureLogs(() => renderAuditLog(sampleData, "log"));
  assertStringIncludes(output, "model.method.run");
  assertStringIncludes(output, "vault.get");
});

Deno.test("renderAuditLog: log mode includes event count", () => {
  const output = captureLogs(() => renderAuditLog(sampleData, "log"));
  assertStringIncludes(output, "2 of 2");
});

Deno.test("renderAuditLog: log mode shows empty message when no events", () => {
  const emptyData: AuditQueryResponse = { events: [], total: 0 };
  const output = captureLogs(() => renderAuditLog(emptyData, "log"));
  assertStringIncludes(output, "No audit events found");
});

Deno.test("renderAuditLog: log mode includes header row", () => {
  const output = captureLogs(() => renderAuditLog(sampleData, "log"));
  assertStringIncludes(output, "TIME");
  assertStringIncludes(output, "OUTCOME");
  assertStringIncludes(output, "ACTION");
});

Deno.test("renderAuditLog: log mode includes date in timestamp", () => {
  const output = captureLogs(() => renderAuditLog(sampleData, "log"));
  // The formatter uses local time, so just check that it has MM-DD format
  // (two digits, dash, two digits pattern somewhere)
  assertEquals(output.match(/\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/) !== null, true);
});
