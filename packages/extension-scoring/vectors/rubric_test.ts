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
import vectors from "./rubric.json" with { type: "json" };
import {
  composeScore,
  RUBRIC_VERSION,
  type RubricInputs,
} from "../rubric/mod.ts";

Deno.test("rubric vectors: are for the current rubric", () => {
  assertEquals(vectors.rubricVersion, RUBRIC_VERSION);
});

for (const c of vectors.cases) {
  Deno.test(`rubric vectors: ${c.name}`, () => {
    const score = composeScore(c.inputs as unknown as RubricInputs);
    assertEquals(
      {
        factors: score.factors.map((f) => ({
          id: f.id,
          label: f.label,
          earnedPoints: f.earnedPoints,
          maxPoints: f.maxPoints,
          status: f.status,
          category: f.category,
        })),
        earnedPoints: score.earnedPoints,
        maxPoints: score.maxPoints,
        provisionalPoints: score.provisionalPoints,
        percentage: score.percentage,
      },
      c.expect,
    );
  });
}
