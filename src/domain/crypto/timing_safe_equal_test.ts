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
import { timingSafeEqual } from "./timing_safe_equal.ts";

Deno.test("timingSafeEqual: equal strings return true", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
});

Deno.test("timingSafeEqual: unequal strings return false", () => {
  assertEquals(timingSafeEqual("abc", "abd"), false);
});

Deno.test("timingSafeEqual: different lengths return false", () => {
  assertEquals(timingSafeEqual("abc", "abcd"), false);
});

Deno.test("timingSafeEqual: empty strings are equal", () => {
  assertEquals(timingSafeEqual("", ""), true);
});

Deno.test("timingSafeEqual: empty vs non-empty returns false", () => {
  assertEquals(timingSafeEqual("", "x"), false);
});
