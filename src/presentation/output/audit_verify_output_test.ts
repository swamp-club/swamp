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
import type { AuditVerifyResponse } from "../../serve/protocol.ts";
import { renderAuditVerify } from "./audit_verify_output.ts";

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

const validData: AuditVerifyResponse = {
  valid: true,
  eventsChecked: 42,
  message: "Chain integrity verified: 42 events, sequences 1-42",
};

const brokenData: AuditVerifyResponse = {
  valid: false,
  eventsChecked: 42,
  brokenAt: 17,
  message: "Chain integrity broken at sequence 17",
};

Deno.test("renderAuditVerify: json mode outputs valid JSON for passing chain", () => {
  const output = captureLogs(() => renderAuditVerify(validData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.valid, true);
  assertEquals(parsed.eventsChecked, 42);
});

Deno.test("renderAuditVerify: json mode outputs valid JSON for broken chain", () => {
  const output = captureLogs(() => renderAuditVerify(brokenData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.valid, false);
  assertEquals(parsed.brokenAt, 17);
});

Deno.test("renderAuditVerify: log mode shows checkmark for valid chain", () => {
  const output = captureLogs(() => renderAuditVerify(validData, "log"));
  assertStringIncludes(output, "Chain integrity verified");
  assertStringIncludes(output, "42 events");
});

Deno.test("renderAuditVerify: log mode shows cross for broken chain", () => {
  const output = captureLogs(() => renderAuditVerify(brokenData, "log"));
  assertStringIncludes(output, "Chain integrity broken");
  assertStringIncludes(output, "sequence 17");
});

const hmacPassData: AuditVerifyResponse = {
  valid: true,
  eventsChecked: 42,
  hmacValid: true,
  hmacChecked: 30,
  hmacFailed: 0,
  message: "Chain integrity verified",
};

const hmacFailData: AuditVerifyResponse = {
  valid: true,
  eventsChecked: 42,
  hmacValid: false,
  hmacChecked: 30,
  hmacFailed: 3,
  message: "Chain integrity verified",
};

Deno.test("renderAuditVerify: log mode shows HMAC pass", () => {
  const output = captureLogs(() => renderAuditVerify(hmacPassData, "log"));
  assertStringIncludes(output, "HMAC integrity verified");
  assertStringIncludes(output, "30 events");
});

Deno.test("renderAuditVerify: log mode shows HMAC failure count", () => {
  const output = captureLogs(() => renderAuditVerify(hmacFailData, "log"));
  assertStringIncludes(output, "HMAC integrity failed");
  assertStringIncludes(output, "3 of 30");
});

Deno.test("renderAuditVerify: json mode includes HMAC fields", () => {
  const output = captureLogs(() => renderAuditVerify(hmacPassData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.hmacValid, true);
  assertEquals(parsed.hmacChecked, 30);
  assertEquals(parsed.hmacFailed, 0);
});

Deno.test("renderAuditVerify: log mode omits HMAC when not checked", () => {
  const output = captureLogs(() => renderAuditVerify(validData, "log"));
  assertEquals(output.includes("HMAC"), false);
});
