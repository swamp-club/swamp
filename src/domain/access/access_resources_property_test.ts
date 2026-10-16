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
import { assertEquals } from "@std/assert";
import { tagsChanged } from "./access_resources.ts";

const tagSet = fc.dictionary(
  fc.string({ maxLength: 6 }),
  fc.string({ maxLength: 6 }),
  { maxKeys: 6 },
);

Deno.test("tagsChanged: a tag set never differs from a reordered copy of itself", () => {
  fc.assert(
    fc.property(tagSet, (tags) => {
      const reordered = Object.fromEntries(Object.entries(tags).reverse());
      assertEquals(tagsChanged(tags, reordered), false);
    }),
  );
});

Deno.test("tagsChanged: is symmetric and agrees with entry-set equality", () => {
  fc.assert(
    fc.property(tagSet, tagSet, (a, b) => {
      const key = (t: Record<string, string>) =>
        JSON.stringify(Object.entries(t).sort(([x], [y]) => x < y ? -1 : 1));
      assertEquals(tagsChanged(a, b), key(a) !== key(b));
      assertEquals(tagsChanged(a, b), tagsChanged(b, a));
    }),
  );
});
