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
import { CHECK_INTERVAL_MS, isCacheStale } from "./update_check_cache.ts";

Deno.test("isCacheStale returns true when cache is null", () => {
  assertEquals(isCacheStale(null, new Date()), true);
});

Deno.test("isCacheStale returns true when checkedAt is invalid", () => {
  const cache = { latestVersion: "1.0.0", checkedAt: "not-a-date" };
  assertEquals(isCacheStale(cache, new Date()), true);
});

Deno.test("isCacheStale returns false when cache is fresh", () => {
  const now = new Date("2026-03-01T12:00:00Z");
  const cache = {
    latestVersion: "1.0.0",
    checkedAt: "2026-03-01T06:00:00Z", // 6 hours ago
  };
  assertEquals(isCacheStale(cache, now), false);
});

Deno.test("isCacheStale returns true when cache is exactly 24h old", () => {
  const now = new Date("2026-03-02T12:00:00Z");
  const cache = {
    latestVersion: "1.0.0",
    checkedAt: "2026-03-01T12:00:00Z", // exactly 24h ago
  };
  assertEquals(isCacheStale(cache, now), true);
});

Deno.test("isCacheStale returns true when cache is older than 24h", () => {
  const now = new Date("2026-03-03T12:00:00Z");
  const cache = {
    latestVersion: "1.0.0",
    checkedAt: "2026-03-01T12:00:00Z", // 48h ago
  };
  assertEquals(isCacheStale(cache, now), true);
});

Deno.test("isCacheStale returns false when cache is just under 24h old", () => {
  const checkedAt = new Date("2026-03-01T12:00:00Z");
  const now = new Date(checkedAt.getTime() + CHECK_INTERVAL_MS - 1);
  const cache = {
    latestVersion: "1.0.0",
    checkedAt: checkedAt.toISOString(),
  };
  assertEquals(isCacheStale(cache, now), false);
});
