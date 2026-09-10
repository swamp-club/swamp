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

import { assert, assertStringIncludes } from "@std/assert";
import { formatCefLine } from "./cef_formatter.ts";
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";

function makeEvent(
  overrides?: Partial<Parameters<typeof createAuditEvent>[0]>,
) {
  return createAuditEvent({
    instanceId: "inst-abc",
    category: "secrets",
    stage: "response",
    outcome: "success",
    action: "vault.read-secret",
    resourceKind: "vault",
    resourceName: "api-keys",
    principalKind: "user",
    principalId: "paul",
    initiatedBy: "paul",
    sourceIp: "10.0.0.1",
    requestId: "req-1",
    ...overrides,
  });
}

Deno.test("formatCefLine: produces valid CEF header", () => {
  const line = formatCefLine(makeEvent());
  assert(line.startsWith("CEF:0|SwampClub|SwampServe|1.0|"));
});

Deno.test("formatCefLine: includes action as signature ID", () => {
  const line = formatCefLine(makeEvent());
  assertStringIncludes(line, "|vault.read-secret|");
});

Deno.test("formatCefLine: maps secrets category to severity 10", () => {
  const line = formatCefLine(makeEvent({ category: "secrets" }));
  const parts = line.split("|");
  const severity = parts[6];
  assert(severity === "10", `Expected severity 10, got ${severity}`);
});

Deno.test("formatCefLine: maps auth category to severity 6", () => {
  const line = formatCefLine(makeEvent({ category: "auth" }));
  const parts = line.split("|");
  const severity = parts[6];
  assert(severity === "6", `Expected severity 6, got ${severity}`);
});

Deno.test("formatCefLine: maps system category to severity 3", () => {
  const line = formatCefLine(
    makeEvent({ category: "system", action: "instance.start" }),
  );
  const parts = line.split("|");
  const severity = parts[6];
  assert(severity === "3", `Expected severity 3, got ${severity}`);
});

Deno.test("formatCefLine: includes principal in suser extension", () => {
  const line = formatCefLine(makeEvent());
  assertStringIncludes(line, "suser=user:paul");
});

Deno.test("formatCefLine: includes resource in dhost extension", () => {
  const line = formatCefLine(makeEvent());
  assertStringIncludes(line, "dhost=vault:api-keys");
});

Deno.test("formatCefLine: includes instanceId as cs3", () => {
  const line = formatCefLine(makeEvent());
  assertStringIncludes(line, "cs3=inst-abc");
  assertStringIncludes(line, "cs3Label=instanceId");
});

Deno.test("formatCefLine: includes grantId as cs2 when present", () => {
  const event = makeEvent({
    decision: {
      action: "vault.read-secret",
      resourceKind: "vault",
      resourceName: "api-keys",
      effect: "allow",
      grantId: "g-123",
      principalGroups: [],
    },
  });
  const line = formatCefLine(event);
  assertStringIncludes(line, "cs2=g-123");
  assertStringIncludes(line, "cs2Label=grantId");
});

Deno.test("formatCefLine: escapes pipes in header values", () => {
  const event = makeEvent({ action: "test|action" });
  const line = formatCefLine(event);
  assertStringIncludes(line, "test\\|action");
});

Deno.test("formatCefLine: escapes equals in extension values", () => {
  const event = makeEvent({ resourceName: "key=value" });
  const line = formatCefLine(event);
  assertStringIncludes(line, "key\\=value");
});

Deno.test("formatCefLine: uses action label for known actions", () => {
  const line = formatCefLine(makeEvent());
  assertStringIncludes(line, "|Vault secret read|");
});

Deno.test("formatCefLine: falls back to formatted action for unknown", () => {
  const event = makeEvent({ action: "custom.thing" });
  const line = formatCefLine(event);
  assertStringIncludes(line, "|custom thing|");
});

Deno.test("formatCefLine: includes namespace as cs1 when provided", () => {
  const line = formatCefLine(makeEvent(), { namespace: "prod-us-east" });
  assertStringIncludes(line, "cs1=prod-us-east");
  assertStringIncludes(line, "cs1Label=namespace");
});

Deno.test("formatCefLine: omits cs1 when namespace not provided", () => {
  const line = formatCefLine(makeEvent());
  assert(!line.includes("cs1="), "Should not include cs1 without namespace");
});
