// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { isExtensionCheckStale } from "./extension_update_check_cache.ts";
import { CHECK_INTERVAL_MS } from "../update/update_check_cache.ts";

Deno.test("isExtensionCheckStale: returns true for missing entry", () => {
  assertEquals(
    isExtensionCheckStale({}, "@swamp/s3-datastore", new Date()),
    true,
  );
});

Deno.test("isExtensionCheckStale: returns true for stale entry", () => {
  const now = new Date();
  const staleTime = new Date(now.getTime() - CHECK_INTERVAL_MS - 1000);
  const cache = {
    "@swamp/s3-datastore": {
      checkedAt: staleTime.toISOString(),
      latestVersion: "2026.03.15.1",
    },
  };
  assertEquals(isExtensionCheckStale(cache, "@swamp/s3-datastore", now), true);
});

Deno.test("isExtensionCheckStale: returns false for fresh entry", () => {
  const now = new Date();
  const freshTime = new Date(now.getTime() - 1000); // 1 second ago
  const cache = {
    "@swamp/s3-datastore": {
      checkedAt: freshTime.toISOString(),
      latestVersion: "2026.03.15.1",
    },
  };
  assertEquals(isExtensionCheckStale(cache, "@swamp/s3-datastore", now), false);
});

Deno.test("isExtensionCheckStale: returns true for invalid date", () => {
  const cache = {
    "@swamp/s3-datastore": {
      checkedAt: "not-a-date",
      latestVersion: "2026.03.15.1",
    },
  };
  assertEquals(
    isExtensionCheckStale(cache, "@swamp/s3-datastore", new Date()),
    true,
  );
});

Deno.test("isExtensionCheckStale: different extensions are independent", () => {
  const now = new Date();
  const freshTime = new Date(now.getTime() - 1000);
  const cache = {
    "@swamp/s3-datastore": {
      checkedAt: freshTime.toISOString(),
      latestVersion: "2026.03.15.1",
    },
  };
  assertEquals(isExtensionCheckStale(cache, "@swamp/s3-datastore", now), false);
  assertEquals(isExtensionCheckStale(cache, "@swamp/other-store", now), true);
});
