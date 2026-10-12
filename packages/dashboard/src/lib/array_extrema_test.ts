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
import { maxOf } from "./array_extrema.ts";

Deno.test("maxOf: the largest value, undefined when empty", () => {
  assertEquals(maxOf([3, -1, 7, 2]), 7);
  assertEquals(maxOf(new Set([-5, -2])), -2);
  assertEquals(maxOf([]), undefined);
});

Deno.test("maxOf: works past the size a spread call can take", () => {
  const values = Array.from({ length: 200_000 }, (_, i) => i);
  assertEquals(maxOf(values), 199_999);
});
