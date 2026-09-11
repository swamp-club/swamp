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
import type { AuditAlertsResponse } from "../../serve/protocol.ts";
import { renderAuditAlerts } from "./audit_alerts_output.ts";

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

const emptyData: AuditAlertsResponse = { rules: [] };

const rulesData: AuditAlertsResponse = {
  rules: [
    {
      name: "brute-force-auth",
      description: "Multiple denied auth attempts",
      state: "armed",
      windowCount: 0,
    },
    {
      name: "secret-access-spike",
      state: "triggered",
      windowCount: 12,
      lastFiredAt: "2026-09-10T20:00:00Z",
    },
  ],
};

Deno.test("renderAuditAlerts: json mode outputs valid JSON", () => {
  const output = captureLogs(() => renderAuditAlerts(rulesData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.rules.length, 2);
  assertEquals(parsed.rules[0].name, "brute-force-auth");
});

Deno.test("renderAuditAlerts: json mode outputs empty rules array", () => {
  const output = captureLogs(() => renderAuditAlerts(emptyData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.rules.length, 0);
});

Deno.test("renderAuditAlerts: log mode shows no rules message when empty", () => {
  const output = captureLogs(() => renderAuditAlerts(emptyData, "log"));
  assertStringIncludes(output, "No alert rules configured");
});

Deno.test("renderAuditAlerts: log mode shows rule names and states", () => {
  const output = captureLogs(() => renderAuditAlerts(rulesData, "log"));
  assertStringIncludes(output, "brute-force-auth");
  assertStringIncludes(output, "secret-access-spike");
  assertStringIncludes(output, "armed");
  assertStringIncludes(output, "triggered");
});

Deno.test("renderAuditAlerts: log mode shows description when present", () => {
  const output = captureLogs(() => renderAuditAlerts(rulesData, "log"));
  assertStringIncludes(output, "Multiple denied auth attempts");
});

Deno.test("renderAuditAlerts: log mode shows lastFiredAt when present", () => {
  const output = captureLogs(() => renderAuditAlerts(rulesData, "log"));
  assertStringIncludes(output, "2026-09-10T20:00:00Z");
});
