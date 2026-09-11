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
import type { AuditRotateKeyResponse } from "../../serve/protocol.ts";
import { renderAuditRotateKey } from "./audit_rotate_key_output.ts";

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

const successData: AuditRotateKeyResponse = {
  previousVersion: 1,
  newVersion: 2,
  message: "HMAC key rotated from version 1 to 2",
};

const noopData: AuditRotateKeyResponse = {
  previousVersion: 0,
  newVersion: 0,
  message: "HMAC is not enabled for this instance",
};

Deno.test("renderAuditRotateKey: json mode outputs valid JSON for success", () => {
  const output = captureLogs(() => renderAuditRotateKey(successData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.previousVersion, 1);
  assertEquals(parsed.newVersion, 2);
});

Deno.test("renderAuditRotateKey: json mode outputs valid JSON for no-op", () => {
  const output = captureLogs(() => renderAuditRotateKey(noopData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.previousVersion, 0);
  assertEquals(parsed.newVersion, 0);
});

Deno.test("renderAuditRotateKey: log mode shows success for rotation", () => {
  const output = captureLogs(() => renderAuditRotateKey(successData, "log"));
  assertStringIncludes(output, "HMAC key rotated");
  assertStringIncludes(output, "version 1");
  assertStringIncludes(output, "2");
});

Deno.test("renderAuditRotateKey: log mode shows warning when HMAC not enabled", () => {
  const output = captureLogs(() => renderAuditRotateKey(noopData, "log"));
  assertStringIncludes(output, "HMAC is not enabled");
});

Deno.test("renderAuditRotateKey: log mode shows message", () => {
  const output = captureLogs(() => renderAuditRotateKey(successData, "log"));
  assertStringIncludes(output, "HMAC key rotated from version 1 to 2");
});
