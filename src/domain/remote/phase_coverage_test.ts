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
import { phaseCoverage } from "./phase_coverage.ts";
Deno.test("phaseCoverage: clips, unions nested and overlapping phases, leaves gaps explicit", () => {
  assertEquals(
    phaseCoverage(0, 100, [
      { start: -10, end: 20 },
      { start: 10, end: 30 },
      { start: 15, end: 25 },
      { start: 90, end: 110 },
    ]),
    { total: 100, covered: 40, uncovered: 60 },
  );
  assertEquals(phaseCoverage(0, 100, []), {
    total: 100,
    covered: 0,
    uncovered: 100,
  });
});
