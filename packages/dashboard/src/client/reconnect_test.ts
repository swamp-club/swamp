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

import { assert, assertEquals } from "@std/assert";
import {
  backoffDelayMs,
  closeAction,
  MAX_DELAY_MS,
  probeOutcome,
} from "./reconnect.ts";

Deno.test("backoffDelayMs: the first attempt waits between 250 and 500ms", () => {
  assertEquals(backoffDelayMs(0, () => 0), 250);
  assertEquals(backoffDelayMs(0, () => 1), 500);
});

Deno.test("backoffDelayMs: doubles each attempt until the cap", () => {
  assertEquals(backoffDelayMs(1, () => 1), 1000);
  assertEquals(backoffDelayMs(2, () => 1), 2000);
  assertEquals(backoffDelayMs(5, () => 1), 16_000);
  assertEquals(backoffDelayMs(6, () => 1), MAX_DELAY_MS);
});

Deno.test("backoffDelayMs: stays within half the cap and the cap", () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const low = backoffDelayMs(attempt, () => 0);
    const high = backoffDelayMs(attempt, () => 1);
    assertEquals(low * 2, high);
    assert(high <= MAX_DELAY_MS);
  }
});

Deno.test("backoffDelayMs: very large attempts stay finite at the cap", () => {
  assertEquals(backoffDelayMs(10_000, () => 1), MAX_DELAY_MS);
  assertEquals(
    backoffDelayMs(Number.MAX_SAFE_INTEGER, () => 0),
    MAX_DELAY_MS / 2,
  );
});

Deno.test("closeAction: a revoked principal goes back to login", () => {
  assertEquals(
    closeAction({ code: 4003, opened: true, tokenPresented: true }),
    "reauth",
  );
});

Deno.test("closeAction: an expired session reconnects to re-authenticate", () => {
  assertEquals(
    closeAction({ code: 4002, opened: true, tokenPresented: true }),
    "retry",
  );
});

Deno.test("closeAction: any other close of an open socket retries", () => {
  for (const code of [1000, 1001, 1006, 1011]) {
    assertEquals(
      closeAction({ code, opened: true, tokenPresented: true }),
      "retry",
    );
    assertEquals(
      closeAction({ code, opened: true, tokenPresented: false }),
      "retry",
    );
  }
});

Deno.test("closeAction: a failed upgrade with a token probes the token", () => {
  assertEquals(
    closeAction({ code: 1006, opened: false, tokenPresented: true }),
    "probe",
  );
});

Deno.test("closeAction: a failed upgrade without a token re-checks the auth mode", () => {
  assertEquals(
    closeAction({ code: 1006, opened: false, tokenPresented: false }),
    "recheck-mode",
  );
  // No principal to revoke without a token.
  assertEquals(
    closeAction({ code: 4003, opened: true, tokenPresented: false }),
    "retry",
  );
});

Deno.test("probeOutcome: only 401 means the token was rejected", () => {
  assertEquals(probeOutcome(401), "reauth");
  for (const result of [200, 403, 429, 500, 503, "network-error"] as const) {
    assertEquals(probeOutcome(result), "retry");
  }
});
