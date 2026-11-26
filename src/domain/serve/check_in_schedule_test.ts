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
  clampIntervalSeconds,
  jittered,
  MAX_BACKOFF_MS,
  nextCheckInDelayMs,
} from "./check_in_schedule.ts";

Deno.test("clampIntervalSeconds: keeps the hub's interval within 5 s and 1 h", () => {
  assertEquals(clampIntervalSeconds(30), 30);
  assertEquals(clampIntervalSeconds(1), 5);
  assertEquals(clampIntervalSeconds(10_000), 3600);
});

Deno.test("clampIntervalSeconds: a missing or unusable value is the default", () => {
  assertEquals(clampIntervalSeconds(undefined), 30);
  assertEquals(clampIntervalSeconds("30"), 30);
  assertEquals(clampIntervalSeconds(Number.NaN), 30);
});

Deno.test("clampIntervalSeconds: takes other bounds", () => {
  assertEquals(
    clampIntervalSeconds(30, { minSeconds: 0.05, maxSeconds: 1 }),
    1,
  );
});

Deno.test("jittered: stays within ±10 %", () => {
  assertEquals(jittered(1000, () => 0), 900);
  assertEquals(jittered(1000, () => 0.5), 1000);
  assert(jittered(1000, () => 0.999999) <= 1100);
});

Deno.test("nextCheckInDelayMs: the interval in milliseconds, jittered", () => {
  assertEquals(nextCheckInDelayMs(30, () => 0.5), 30_000);
  assertEquals(nextCheckInDelayMs(30, () => 0), 27_000);
});

Deno.test("backoffDelayMs: doubles from the interval and never passes 5 minutes", () => {
  const mid = () => 0.5;
  assertEquals(
    backoffDelayMs({ intervalSeconds: 30, failures: 1, random: mid }),
    30_000,
  );
  assertEquals(
    backoffDelayMs({ intervalSeconds: 30, failures: 2, random: mid }),
    60_000,
  );
  assertEquals(
    backoffDelayMs({ intervalSeconds: 30, failures: 4, random: mid }),
    240_000,
  );
  assertEquals(
    backoffDelayMs({ intervalSeconds: 30, failures: 5, random: mid }),
    MAX_BACKOFF_MS,
  );
  assertEquals(
    backoffDelayMs({
      intervalSeconds: 30,
      failures: 5000,
      random: () => 0.999,
    }),
    MAX_BACKOFF_MS,
  );
});

Deno.test("backoffDelayMs: honours retry-after as a floor, within the cap", () => {
  const mid = () => 0.5;
  assertEquals(
    backoffDelayMs({
      intervalSeconds: 5,
      failures: 1,
      random: mid,
      retryAfterSeconds: 60,
    }),
    60_000,
  );
  assertEquals(
    backoffDelayMs({
      intervalSeconds: 5,
      failures: 1,
      random: mid,
      retryAfterSeconds: 86_400,
    }),
    MAX_BACKOFF_MS,
  );
});

Deno.test("backoffDelayMs: never shorter than 90 % of the interval", () => {
  for (let failures = 1; failures < 20; failures++) {
    assert(
      backoffDelayMs({ intervalSeconds: 30, failures, random: () => 0 }) >=
        27_000,
    );
  }
});
