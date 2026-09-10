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
import { formatRfc5424 } from "./syslog_sink.ts";
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
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    ...overrides,
  });
}

Deno.test("formatRfc5424: produces valid priority for secrets/success", () => {
  const msg = formatRfc5424(makeEvent(), "test-host");
  assert(msg.startsWith("<38>1 "), `Expected <38>1, got: ${msg.slice(0, 20)}`);
});

Deno.test("formatRfc5424: maps auth/denied to facility 4 severity 4", () => {
  const event = makeEvent({
    category: "auth",
    action: "auth.login",
    outcome: "denied",
  });
  const msg = formatRfc5424(event, "test-host");
  assert(msg.startsWith("<36>1 "), `Expected <36>1, got: ${msg.slice(0, 20)}`);
});

Deno.test("formatRfc5424: maps system/failure to facility 3 severity 3", () => {
  const event = makeEvent({
    category: "system",
    action: "instance.start",
    outcome: "failure",
  });
  const msg = formatRfc5424(event, "test-host");
  assert(msg.startsWith("<27>1 "), `Expected <27>1, got: ${msg.slice(0, 20)}`);
});

Deno.test("formatRfc5424: includes hostname and app-name", () => {
  const msg = formatRfc5424(makeEvent(), "my-host");
  assertStringIncludes(msg, "my-host swamp-serve");
});

Deno.test("formatRfc5424: includes instanceId as procid", () => {
  const msg = formatRfc5424(makeEvent(), "test-host");
  assertStringIncludes(msg, "swamp-serve inst-abc audit");
});

Deno.test("formatRfc5424: includes structured data with action", () => {
  const msg = formatRfc5424(makeEvent(), "test-host");
  assertStringIncludes(msg, '[swamp action="vault.read-secret"');
});

Deno.test("formatRfc5424: includes principal in structured data", () => {
  const msg = formatRfc5424(makeEvent(), "test-host");
  assertStringIncludes(msg, 'principal="user:paul"');
});

Deno.test("formatRfc5424: includes resource in structured data", () => {
  const msg = formatRfc5424(makeEvent(), "test-host");
  assertStringIncludes(msg, 'resource="vault:api-keys"');
});

Deno.test("formatRfc5424: includes grantId when present", () => {
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
  const msg = formatRfc5424(event, "test-host");
  assertStringIncludes(msg, 'grantId="g-123"');
});

Deno.test("formatRfc5424: escapes quotes in structured data", () => {
  const event = makeEvent({ resourceName: 'key"with"quotes' });
  const msg = formatRfc5424(event, "test-host");
  assertStringIncludes(msg, 'key\\"with\\"quotes');
});

Deno.test("formatRfc5424: escapes backslash in structured data", () => {
  const event = makeEvent({ resourceName: "path\\to\\key" });
  const msg = formatRfc5424(event, "test-host");
  assertStringIncludes(msg, "path\\\\to\\\\key");
});

Deno.test("formatRfc5424: escapes close bracket in structured data", () => {
  const event = makeEvent({ resourceName: "key]bracket" });
  const msg = formatRfc5424(event, "test-host");
  assertStringIncludes(msg, "key\\]bracket");
});
