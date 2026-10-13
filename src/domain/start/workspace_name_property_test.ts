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

import fc from "fast-check";
import { parseWorkspaceName, suggestWorkspaceName } from "./workspace_name.ts";

/** Names a suggestion can collide with: real draws, suffixed draws and noise. */
const arbTaken = fc.array(
  fc.oneof(
    fc.constant(""),
    fc.string({ maxLength: 20 }),
    fc.tuple(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }))
      .map(([r]) => suggestWorkspaceName(new Set(), () => r)),
    fc.tuple(
      fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
      fc.integer({ min: 2, max: 20 }),
    ).map(([r, n]) => `${suggestWorkspaceName(new Set(), () => r)}-${n}`),
  ),
  { maxLength: 40 },
).map((names) => new Set(names));

const arbRandom = fc.array(
  fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
  { minLength: 1, maxLength: 20 },
).map((values) => {
  let i = 0;
  return () => values[i++ % values.length];
});

Deno.test("suggestWorkspaceName: always returns a valid name that is not taken", () => {
  fc.assert(
    fc.property(arbTaken, arbRandom, (taken, random) => {
      const name = suggestWorkspaceName(taken, random);
      return parseWorkspaceName(name) === name && !taken.has(name);
    }),
  );
});
