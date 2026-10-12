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
import {
  auditEnabled,
  auditStatus,
  classifyAuditError,
} from "./audit_state.ts";

Deno.test("classifyAuditError: maps serve's codes", () => {
  assertEquals(classifyAuditError("audit_not_configured"), "disabled");
  assertEquals(classifyAuditError("unauthorized"), "denied");
  assertEquals(classifyAuditError("access_not_configured"), "denied");
  assertEquals(classifyAuditError("subscription_limit"), "error");
  assertEquals(classifyAuditError(undefined), "error");
});

Deno.test("auditStatus: disabled never reads as connecting, even while live is on", () => {
  assertEquals(
    auditStatus({ liveEnabled: true, streaming: false, problem: "disabled" }),
    "disabled",
  );
  assertEquals(
    auditStatus({ liveEnabled: false, streaming: false, problem: "disabled" }),
    "disabled",
  );
  assertEquals(
    auditStatus({ liveEnabled: true, streaming: false, problem: "denied" }),
    "denied",
  );
});

Deno.test("auditStatus: connecting, live, paused and error", () => {
  assertEquals(
    auditStatus({ liveEnabled: true, streaming: false, problem: null }),
    "connecting",
  );
  assertEquals(
    auditStatus({ liveEnabled: true, streaming: true, problem: null }),
    "live",
  );
  assertEquals(
    auditStatus({ liveEnabled: false, streaming: false, problem: null }),
    "paused",
  );
  assertEquals(
    auditStatus({ liveEnabled: true, streaming: false, problem: "error" }),
    "error",
  );
  assertEquals(
    auditStatus({ liveEnabled: false, streaming: false, problem: "error" }),
    "paused",
  );
});

Deno.test("auditEnabled: only a disabled log reads as off", () => {
  assertEquals(auditEnabled("disabled"), false);
  assertEquals(auditEnabled("connecting"), true);
  assertEquals(auditEnabled("denied"), true);
});
