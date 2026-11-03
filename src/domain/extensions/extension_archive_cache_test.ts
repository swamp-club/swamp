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
import { archiveCacheKey } from "./extension_archive_cache.ts";

const HEX = "a".repeat(32) + "0123456789abcdef".repeat(2);

Deno.test("archiveCacheKey: accepts a lowercase SHA-256 hex digest", () => {
  assertEquals(archiveCacheKey(HEX), HEX);
});

Deno.test("archiveCacheKey: lowercases an uppercase digest, as verifyChecksum compares", () => {
  assertEquals(archiveCacheKey(HEX.toUpperCase()), HEX);
});

Deno.test("archiveCacheKey: refuses a missing checksum", () => {
  assertEquals(archiveCacheKey(null), null);
});

Deno.test("archiveCacheKey: refuses anything that is not exactly 64 hex characters", () => {
  for (
    const value of [
      "",
      HEX.slice(1),
      HEX + "0",
      "g".repeat(64),
      `sha256:${HEX}`,
      "../" + HEX.slice(3),
      HEX.slice(0, 60) + "/../",
      HEX.slice(0, 63) + "\n",
    ]
  ) {
    assertEquals(archiveCacheKey(value), null, value);
  }
});
