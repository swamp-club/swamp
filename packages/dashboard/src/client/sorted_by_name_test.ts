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
import { extractSortedByName } from "./sorted_by_name.ts";

Deno.test("extractSortedByName: sorts by name without mutating the payload", () => {
  const results = [{ name: "b" }, { name: "c" }, { name: "a" }];
  const payload = { data: { results } };
  const sorted = extractSortedByName(payload);
  assertEquals(sorted.map((w) => w.name), ["a", "b", "c"]);
  assertEquals(results.map((w) => w.name), ["b", "c", "a"]);
});
