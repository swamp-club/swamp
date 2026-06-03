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
import fc from "fast-check";
import { normalizeLifetime } from "./data_metadata.ts";
import type { Lifetime } from "./data_metadata.ts";

const UNITS = ["h", "m", "d", "w", "mo", "y"] as const;

const arbUnit = fc.constantFrom(...UNITS);

Deno.test("property: zero durations become 'workflow'", () => {
  fc.assert(
    fc.property(arbUnit, (unit) => {
      const result = normalizeLifetime(`0${unit}` as Lifetime);
      assertEquals(result, "workflow");
    }),
  );
});

Deno.test("property: zero durations with leading zeros become 'workflow'", () => {
  fc.assert(
    fc.property(arbUnit, (unit) => {
      const result = normalizeLifetime(`00${unit}` as Lifetime);
      assertEquals(result, "workflow");
    }),
  );
});

Deno.test("property: non-zero durations pass through unchanged", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 999 }),
      arbUnit,
      (n, unit) => {
        const input = `${n}${unit}` as Lifetime;
        const result = normalizeLifetime(input);
        assertEquals(result, input);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: named lifetimes pass through unchanged", () => {
  const namedLifetimes: Lifetime[] = [
    "ephemeral",
    "infinite",
    "job",
    "workflow",
  ];
  for (const lt of namedLifetimes) {
    assertEquals(normalizeLifetime(lt), lt);
  }
});
