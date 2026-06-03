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

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { generateDeviceCode } from "./device_code.ts";

Deno.test("generateDeviceCode - format matches XXXX-XXXX", () => {
  const code = generateDeviceCode();
  assertMatch(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

Deno.test("generateDeviceCode - length is 9 (4 + hyphen + 4)", () => {
  const code = generateDeviceCode();
  assertEquals(code.length, 9);
});

Deno.test("generateDeviceCode - contains no ambiguous characters", () => {
  // Generate several codes to increase confidence
  for (let i = 0; i < 50; i++) {
    const code = generateDeviceCode();
    assertEquals(code.includes("0"), false, `code ${code} contains 0`);
    assertEquals(code.includes("O"), false, `code ${code} contains O`);
    assertEquals(code.includes("1"), false, `code ${code} contains 1`);
    assertEquals(code.includes("I"), false, `code ${code} contains I`);
    assertEquals(code.includes("L"), false, `code ${code} contains L`);
  }
});

Deno.test("generateDeviceCode - multiple calls produce different results", () => {
  const codes = new Set<string>();
  for (let i = 0; i < 10; i++) {
    codes.add(generateDeviceCode());
  }
  // With 31^8 possible codes, collisions in 10 calls are astronomically unlikely
  assertNotEquals(codes.size, 1, "all codes were identical");
});
