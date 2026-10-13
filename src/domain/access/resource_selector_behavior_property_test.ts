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

// `behavior:` is an exact synonym of `model:` in a grant selector
// (swamp-club#3334).

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  canonicalResourceSelectorString,
  parseResourceSelector,
  type ResourceSelector,
  resourceSelectorToString,
} from "./resource_selector.ts";

type Outcome = { ok: ResourceSelector } | { error: string };

function outcome(value: string): Outcome {
  try {
    return { ok: parseResourceSelector(value) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const arbPattern = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.stringOf(fc.constantFrom(..."abc0-_@/.:*".split("")), { maxLength: 20 }),
);

Deno.test("parseResourceSelector property: behavior:p parses exactly as model:p", () => {
  fc.assert(
    fc.property(arbPattern, (pattern) => {
      const model = outcome(`model:${pattern}`);
      const behavior = outcome(`behavior:${pattern}`);
      if ("ok" in model) {
        assertEquals(behavior, model);
        assertEquals(
          resourceSelectorToString((behavior as { ok: ResourceSelector }).ok),
          `model:${pattern}`,
        );
      } else {
        // The same refusal, naming the selector as written.
        assertEquals("error" in behavior, true);
      }
    }),
    { numRuns: 500 },
  );
});

Deno.test("canonicalResourceSelectorString property: identity on the model spelling, idempotent on any", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("model", "behavior", "workflow", "behaviour", "x", ""),
      arbPattern,
      (kind, pattern) => {
        const raw = `${kind}:${pattern}`;
        const canonical = canonicalResourceSelectorString(raw);
        assertEquals(canonicalResourceSelectorString(canonical), canonical);
        if (kind !== "behavior") assertEquals(canonical, raw);
        else if ("ok" in outcome(raw)) {
          assertEquals(canonical, `model:${pattern}`);
        } else assertEquals(canonical, raw);
      },
    ),
    { numRuns: 500 },
  );
});
