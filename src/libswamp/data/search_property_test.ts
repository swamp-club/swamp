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

import { assert, assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { parseDuration } from "./search.ts";
import { parseDataDuration } from "../../domain/data/duration.ts";

/**
 * The swamp duration grammar is implemented twice: `parseDataDuration` in the
 * data domain and `parseDuration` in the libswamp search generators. These
 * properties pin the two to the same grammar and the same arithmetic so the
 * copies cannot drift apart.
 *
 * A libswamp-internal test may import internal module paths, which is why the
 * cross-implementation comparison lives here rather than under src/domain.
 */

const UNITS = ["m", "h", "d", "w", "mo", "y"] as const;

const arbUnit = fc.constantFrom(...UNITS);

/** Bounded so `y` durations stay inside Number.MAX_SAFE_INTEGER. */
const arbAmount = fc.integer({ min: 0, max: 100_000 });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const EXPECTED_UNIT_MS: Record<typeof UNITS[number], number> = {
  m: MINUTE,
  h: HOUR,
  d: DAY,
  w: 7 * DAY,
  mo: 30 * DAY,
  y: 365 * DAY,
};

/** Suffixes outside the grammar. */
const arbBadSuffix = fc.constantFrom(
  "x",
  "s",
  "ms",
  "min",
  "hr",
  "M",
  "H",
  "D",
  "W",
  "MO",
  "Y",
  "mm",
  "oy",
);

Deno.test("parseDuration: agrees with parseDataDuration on every valid duration", () => {
  fc.assert(
    fc.property(arbAmount, arbUnit, (amount, unit) => {
      const input = `${amount}${unit}`;
      assertEquals(parseDuration(input), parseDataDuration(input));
    }),
    { numRuns: 500 },
  );
});

Deno.test("parseDuration: agrees with parseDataDuration on rejected inputs", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.tuple(arbAmount, arbBadSuffix).map(([n, s]) => `${n}${s}`),
        arbUnit.map((u) => u as string),
        arbAmount.map((n) => `${n}`),
        fc.tuple(arbAmount, arbUnit).map(([n, u]) => ` ${n}${u}`),
        fc.tuple(arbAmount, arbUnit).map(([n, u]) => `${n}${u} `),
        fc.tuple(arbAmount, arbUnit).map(([n, u]) => `-${n}${u}`),
        fc.tuple(arbAmount, arbUnit).map(([n, u]) => `${n}.5${u}`),
        fc.constant(""),
      ),
      (input) => {
        assertThrows(() => parseDuration(input));
        assertThrows(() => parseDataDuration(input));
      },
    ),
    { numRuns: 500 },
  );
});

Deno.test("parseDataDuration: is linear in the amount", () => {
  fc.assert(
    fc.property(arbAmount, arbUnit, (amount, unit) => {
      assertEquals(
        parseDataDuration(`${amount}${unit}`),
        amount * EXPECTED_UNIT_MS[unit],
      );
      assertEquals(parseDataDuration(`0${unit}`), 0);
    }),
    { numRuns: 300 },
  );
});

Deno.test("parseDataDuration: is strictly monotonic in the amount", () => {
  fc.assert(
    fc.property(arbAmount, arbAmount, arbUnit, (a, b, unit) => {
      fc.pre(a !== b);
      const [small, large] = a < b ? [a, b] : [b, a];
      assert(
        parseDataDuration(`${small}${unit}`) <
          parseDataDuration(`${large}${unit}`),
      );
    }),
    { numRuns: 300 },
  );
});

Deno.test("parseDataDuration: units are ordered m < h < d < w < mo < y", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100_000 }), (amount) => {
      const values = UNITS.map((unit) => parseDataDuration(`${amount}${unit}`));
      for (let i = 1; i < values.length; i++) {
        assert(
          values[i - 1] < values[i],
          `${UNITS[i - 1]} should be shorter than ${UNITS[i]}`,
        );
      }
    }),
    { numRuns: 200 },
  );
});

Deno.test("parseDataDuration: 'mo' wins the alternation over 'm'", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100_000 }), (amount) => {
      // The regex alternation lists `mo` before `m`. With the order reversed
      // the `$` anchor would reject "1mo" outright, so this pins the trap.
      assertEquals(
        parseDataDuration(`${amount}mo`),
        amount * EXPECTED_UNIT_MS.mo,
      );
      assertEquals(parseDataDuration(`${amount}m`), amount * MINUTE);
      assert(
        parseDataDuration(`${amount}mo`) > parseDataDuration(`${amount}m`),
      );
      assertEquals(
        parseDuration(`${amount}mo`),
        parseDataDuration(`${amount}mo`),
      );
    }),
    { numRuns: 200 },
  );
});

Deno.test("parseDataDuration: leading zeros do not change the value", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 10_000 }),
      arbUnit,
      fc.integer({ min: 1, max: 3 }),
      (amount, unit, zeros) => {
        const padded = `${"0".repeat(zeros)}${amount}${unit}`;
        assertEquals(
          parseDataDuration(padded),
          parseDataDuration(`${amount}${unit}`),
        );
        assertEquals(parseDuration(padded), parseDataDuration(padded));
      },
    ),
    { numRuns: 300 },
  );
});
