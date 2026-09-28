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
  HEALTH_RETRY_MS,
  healthRetryDelayMs,
  healthStreamOutcome,
  healthViewState,
} from "./health_state.ts";

Deno.test("healthStreamOutcome: reads a 2xx stream", () => {
  assertEquals(healthStreamOutcome(200), "ok");
});

Deno.test("healthStreamOutcome: stops when serve refuses the token", () => {
  assertEquals(healthStreamOutcome(401), "denied");
  assertEquals(healthStreamOutcome(403), "denied");
});

Deno.test("healthStreamOutcome: retries rate limits, the stream cap and server errors", () => {
  assertEquals(healthStreamOutcome(429), "retry");
  assertEquals(healthStreamOutcome(500), "retry");
  assertEquals(healthStreamOutcome(503), "retry");
});

Deno.test("healthViewState: a refused stream is denied, never empty", () => {
  assertEquals(healthViewState(null, true), "denied");
  assertEquals(healthViewState({}, true), "denied");
});

Deno.test("healthViewState: no snapshot yet is loading; a snapshot is ready", () => {
  assertEquals(healthViewState(null, false), "loading");
  assertEquals(healthViewState({}, false), "ready");
});

Deno.test("healthRetryDelayMs: waits as long as Retry-After asks", () => {
  assertEquals(healthRetryDelayMs("30"), 30_000);
});

Deno.test("healthRetryDelayMs: falls back to the default without a usable header", () => {
  assertEquals(healthRetryDelayMs(null), HEALTH_RETRY_MS);
  assertEquals(healthRetryDelayMs(""), HEALTH_RETRY_MS);
  assertEquals(
    healthRetryDelayMs("Wed, 21 Oct 2026 07:28:00 GMT"),
    HEALTH_RETRY_MS,
  );
});

Deno.test("healthRetryDelayMs: stays between the default and two minutes", () => {
  assertEquals(healthRetryDelayMs("0"), HEALTH_RETRY_MS);
  assertEquals(healthRetryDelayMs("3600"), 120_000);
});
