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
import {
  type AutoDefinitionFacts,
  judgeAutoDefinition,
} from "./auto_definition_reaper.ts";
import { CONTROL_PLANE_STORED_TYPES } from "../models/control_plane_types.ts";

const CUTOFF = new Date("2026-06-01T00:00:00.000Z");
const OLD = new Date("2026-01-01T00:00:00.000Z");

const idle = (overrides: Partial<AutoDefinitionFacts> = {}) => ({
  modelType: "@swamp/ssh",
  modifiedAt: OLD,
  hasData: false,
  hasOutputs: false,
  referencedByWorkflow: false,
  ...overrides,
});

Deno.test("judgeAutoDefinition: removes an idle definition past the cutoff", () => {
  assertEquals(judgeAutoDefinition(idle(), CUTOFF), { removable: true });
});

Deno.test("judgeAutoDefinition: keeps every retention-exempt type", () => {
  for (const modelType of CONTROL_PLANE_STORED_TYPES) {
    assertEquals(
      judgeAutoDefinition(idle({ modelType }), CUTOFF),
      { removable: false, reason: "exempt" },
      modelType,
    );
  }
});

Deno.test("judgeAutoDefinition: keeps a definition modified at the cutoff or with no readable mtime", () => {
  for (const modifiedAt of [CUTOFF, null]) {
    assertEquals(
      judgeAutoDefinition(idle({ modifiedAt }), CUTOFF),
      { removable: false, reason: "recently_modified" },
    );
  }
});

Deno.test("judgeAutoDefinition: removable exactly when nothing keeps it", () => {
  fc.assert(
    fc.property(
      fc.record({
        modelType: fc.constantFrom(
          "@swamp/ssh",
          "command/shell",
          ...CONTROL_PLANE_STORED_TYPES,
        ),
        modifiedAt: fc.option(
          fc.date({
            min: new Date("2025-01-01T00:00:00.000Z"),
            max: new Date("2027-01-01T00:00:00.000Z"),
            noInvalidDate: true,
          }),
          { nil: null },
        ),
        hasData: fc.boolean(),
        hasOutputs: fc.boolean(),
        referencedByWorkflow: fc.boolean(),
      }),
      (facts) => {
        const exempt = CONTROL_PLANE_STORED_TYPES.includes(facts.modelType);
        const expected = !exempt && !facts.hasData && !facts.hasOutputs &&
          !facts.referencedByWorkflow && facts.modifiedAt !== null &&
          facts.modifiedAt.getTime() < CUTOFF.getTime();
        assertEquals(
          judgeAutoDefinition(facts, CUTOFF).removable,
          expected,
        );
      },
    ),
    { numRuns: 500 },
  );
});
