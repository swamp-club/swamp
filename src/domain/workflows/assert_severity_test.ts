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
import { severityAtOrAbove } from "./assert_severity.ts";

Deno.test("severityAtOrAbove: high is at or above high", () => {
  assertEquals(severityAtOrAbove("high", "high"), true);
});

Deno.test("severityAtOrAbove: medium is below high", () => {
  assertEquals(severityAtOrAbove("medium", "high"), false);
});

Deno.test("severityAtOrAbove: low is below high", () => {
  assertEquals(severityAtOrAbove("low", "high"), false);
});

Deno.test("severityAtOrAbove: low is at or above low", () => {
  assertEquals(severityAtOrAbove("low", "low"), true);
});

Deno.test("severityAtOrAbove: high is at or above low", () => {
  assertEquals(severityAtOrAbove("high", "low"), true);
});

Deno.test("severityAtOrAbove: medium is at or above medium", () => {
  assertEquals(severityAtOrAbove("medium", "medium"), true);
});
