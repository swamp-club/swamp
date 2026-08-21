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
import { LifetimeSchema, normalizeLifetime } from "./data_metadata.ts";
import type { Lifetime } from "./data_metadata.ts";

const UNITS = ["h", "m", "d", "w", "mo", "y"] as const;

const arbUnit = fc.constantFrom(...UNITS);

/** Suffixes that are not duration units. */
const arbNonUnit = fc
  .stringOf(fc.constantFrom(..."xqzbkv".split("")), {
    minLength: 1,
    maxLength: 3,
  });

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

Deno.test("property: normalizeLifetime is idempotent", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 999 }),
      arbUnit,
      (n, unit) => {
        const once = normalizeLifetime(`${n}${unit}` as Lifetime);
        assertEquals(normalizeLifetime(once), once);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: 'mo' is preferred over 'm' by the unit alternation", () => {
  // The regex alternation lists `mo` before `m`; if it were reversed, "0mo"
  // would fail to match (the `$` anchor rejects the trailing "o") and a
  // zero-month lifetime would slip through un-normalized.
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 999 }), (n) => {
      assertEquals(normalizeLifetime(`${n}mo` as Lifetime), `${n}mo`);
      assertEquals(normalizeLifetime(`${n}m` as Lifetime), `${n}m`);
    }),
    { numRuns: 100 },
  );
  assertEquals(normalizeLifetime("0mo" as Lifetime), "workflow");
  assertEquals(normalizeLifetime("0m" as Lifetime), "workflow");
});

Deno.test("property: unrecognized unit suffixes pass through unchanged", () => {
  // normalizeLifetime is total: anything that does not match the duration
  // grammar is returned verbatim, and LifetimeSchema is what rejects it.
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 999 }),
      arbNonUnit,
      (n, suffix) => {
        const input = `${n}${suffix}` as Lifetime;
        assertEquals(normalizeLifetime(input), input);
        assertEquals(LifetimeSchema.safeParse(input).success, false);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: negative and signed durations pass through unchanged", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 999 }),
      arbUnit,
      fc.constantFrom("-", "+"),
      (n, unit, sign) => {
        const input = `${sign}${n}${unit}` as Lifetime;
        // The `\d+` anchor rejects a leading sign, so even "-0h" is left as-is
        // rather than becoming "workflow" — LifetimeSchema then rejects it.
        assertEquals(normalizeLifetime(input), input);
        assertEquals(LifetimeSchema.safeParse(input).success, false);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: uppercase units and padded durations pass through unchanged", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 999 }),
      arbUnit,
      fc.constantFrom(" %s", "%s ", " %s "),
      (n, unit, template) => {
        const upper = `${n}${unit.toUpperCase()}` as Lifetime;
        assertEquals(normalizeLifetime(upper), upper);
        assertEquals(LifetimeSchema.safeParse(upper).success, false);

        const padded = template.replace("%s", `${n}${unit}`) as Lifetime;
        assertEquals(normalizeLifetime(padded), padded);
        assertEquals(LifetimeSchema.safeParse(padded).success, false);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: bare numbers and bare units pass through unchanged", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 999 }), arbUnit, (n, unit) => {
      assertEquals(normalizeLifetime(`${n}` as Lifetime), `${n}`);
      assertEquals(normalizeLifetime(unit as Lifetime), unit);
      assertEquals(LifetimeSchema.safeParse(`${n}`).success, false);
      assertEquals(LifetimeSchema.safeParse(unit).success, false);
    }),
    { numRuns: 100 },
  );
});
