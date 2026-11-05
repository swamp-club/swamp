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
import { applyFlushAttempt } from "./telemetry_flush_record.ts";

const T1 = new Date("2026-11-05T10:00:00.000Z");
const T2 = new Date("2026-11-05T11:00:00.000Z");

Deno.test("applyFlushAttempt: a success records the time and the sent count", () => {
  assertEquals(
    applyFlushAttempt(null, { at: T1, ok: true, sentCount: 3 }),
    {
      lastAttemptAt: T1.toISOString(),
      lastAttemptOk: true,
      lastSuccessAt: T1.toISOString(),
      lastSentCount: 3,
    },
  );
});

Deno.test("applyFlushAttempt: a failure after a success keeps the success", () => {
  const success = applyFlushAttempt(null, { at: T1, ok: true, sentCount: 3 });
  assertEquals(
    applyFlushAttempt(success, {
      at: T2,
      ok: false,
      reason: "timeout",
      sentCount: 0,
    }),
    {
      lastAttemptAt: T2.toISOString(),
      lastAttemptOk: false,
      lastFailureReason: "timeout",
      lastSuccessAt: T1.toISOString(),
      lastSentCount: 3,
    },
  );
});

Deno.test("applyFlushAttempt: a first failure has no success fields", () => {
  assertEquals(
    applyFlushAttempt(null, { at: T2, ok: false, sentCount: 0 }),
    { lastAttemptAt: T2.toISOString(), lastAttemptOk: false },
  );
});

Deno.test("applyFlushAttempt: a success after a failure drops the failure reason", () => {
  const failure = applyFlushAttempt(null, {
    at: T1,
    ok: false,
    reason: "HTTP 500",
    sentCount: 0,
  });
  const next = applyFlushAttempt(failure, { at: T2, ok: true, sentCount: 1 });
  assertEquals(next.lastFailureReason, undefined);
  assertEquals(next.lastSentCount, 1);
});
