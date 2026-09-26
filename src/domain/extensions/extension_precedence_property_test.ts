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
import {
  compareExtensionPrecedence,
  type ExtensionContributor,
} from "./extension_precedence.ts";

const arbContributor: fc.Arbitrary<ExtensionContributor> = fc.record({
  sourcePath: fc.stringOf(fc.constantFrom(..."/abz_.-".split("")), {
    minLength: 1,
    maxLength: 8,
  }),
  pulled: fc.boolean(),
});

/**
 * Replays the attach loop's decision rule: the first contributor claims the
 * member, and each later one replaces the holder only when it outranks it.
 */
function winnerByAttachOrder(
  order: readonly ExtensionContributor[],
): ExtensionContributor {
  let holder = order[0];
  for (const c of order.slice(1)) {
    if (compareExtensionPrecedence(c, holder) < 0) holder = c;
  }
  return holder;
}

Deno.test("compareExtensionPrecedence: is antisymmetric and transitive", () => {
  fc.assert(
    fc.property(arbContributor, arbContributor, arbContributor, (a, b, c) => {
      assertEquals(
        Math.sign(compareExtensionPrecedence(a, b)),
        -Math.sign(compareExtensionPrecedence(b, a)),
      );
      if (
        compareExtensionPrecedence(a, b) <= 0 &&
        compareExtensionPrecedence(b, c) <= 0
      ) {
        assert(compareExtensionPrecedence(a, c) <= 0);
      }
    }),
  );
});

Deno.test("compareExtensionPrecedence: the winner does not depend on attach order", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbContributor, {
        minLength: 1,
        maxLength: 6,
        selector: (c) => c.sourcePath,
      }),
      fc.nat(),
      (contributors, seed) => {
        const expected = [...contributors].sort(compareExtensionPrecedence)[0];
        // Deterministic shuffle driven by the generated seed.
        const shuffled = [...contributors];
        let s = seed;
        for (let i = shuffled.length - 1; i > 0; i--) {
          s = (s * 1103515245 + 12345) % 2147483648;
          const j = s % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        assertEquals(winnerByAttachOrder(shuffled), expected);
      },
    ),
  );
});
