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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { dispatchTraceCarrier, traceCarrier } from "./observability.ts";
import { phaseCoverage } from "./phase_coverage.ts";

Deno.test("traceCarrier: arbitrary metadata never throws and valid carriers round-trip", () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    const parsed = traceCarrier(value);
    if (parsed) {
      assertEquals(traceCarrier(JSON.parse(JSON.stringify(parsed))), parsed);
    }
  }));
  fc.assert(fc.property(fc.uuid(), fc.uuid(), (trace, span) => {
    const value = {
      traceparent: `00-${trace.replaceAll("-", "")}-${
        span.replaceAll("-", "").slice(0, 16)
      }-01`,
    };
    assertEquals(traceCarrier(value), value);
    assertEquals(dispatchTraceCarrier(value, value), value);
    assertEquals(dispatchTraceCarrier(undefined, value), undefined);
  }));
});

Deno.test("phaseCoverage: bounded union is invariant under permutation and duplicate intervals", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.integer({ min: -100, max: 200 }),
          fc.integer({ min: -100, max: 200 }),
        ),
      ),
      (pairs) => {
        const intervals = pairs.map(([a, b]) => ({
          start: Math.min(a, b),
          end: Math.max(a, b),
        }));
        const result = phaseCoverage(0, 100, intervals);
        assert(result.covered >= 0 && result.covered <= 100);
        assertEquals(result.covered + result.uncovered, 100);
        assertEquals(phaseCoverage(0, 100, [...intervals].reverse()), result);
        assertEquals(
          phaseCoverage(0, 100, [...intervals, ...intervals]),
          result,
        );
      },
    ),
  );
});
