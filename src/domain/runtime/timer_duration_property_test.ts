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

import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { UserError } from "../errors.ts";
import { MAX_TIMER_DELAY_MS, parseTimerDuration } from "./timer_duration.ts";

Deno.test("parseTimerDuration: accepted positive second durations remain within timer bounds", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: Math.floor(MAX_TIMER_DELAY_MS / 1000) * 2 }),
    (seconds) => {
      const expected = seconds * 1000;
      for (const input of [String(seconds), `${seconds}s`]) {
        if (expected <= MAX_TIMER_DELAY_MS) {
          assertEquals(parseTimerDuration(input), expected);
        } else {
          assertThrows(() => parseTimerDuration(input), UserError);
        }
      }
    },
  ));
});

Deno.test("parseTimerDuration: unit conversion respects the same inclusive ceiling", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 100_000 }),
    fc.constantFrom(
      { suffix: "m", factor: 60_000 },
      { suffix: "h", factor: 3_600_000 },
      { suffix: "d", factor: 86_400_000 },
      { suffix: "w", factor: 604_800_000 },
    ),
    (amount, unit) => {
      const input = `${amount}${unit.suffix}`;
      const expected = amount * unit.factor;
      if (expected <= MAX_TIMER_DELAY_MS) {
        assertEquals(parseTimerDuration(input), expected);
      } else {
        assertThrows(() => parseTimerDuration(input), UserError);
      }
    },
  ));
});
