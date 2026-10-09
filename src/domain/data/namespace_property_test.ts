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
import {
  createNamespace,
  isReservedNamespaceName,
  namespaceCollidesWithLayout,
  RESERVED_NAMESPACE_NAMES,
  restoreNamespace,
} from "./namespace.ts";

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");

/** Well-formed slugs: reserved names mixed in so both branches are hit. */
const arbSlug = fc.oneof(
  fc.constantFrom(...RESERVED_NAMESPACE_NAMES),
  fc.stringOf(fc.constantFrom(...SLUG_CHARS), { minLength: 1, maxLength: 64 })
    .filter((s) => !s.startsWith("-") && !s.endsWith("-")),
);

Deno.test("createNamespace: throws exactly when a well-formed slug is reserved", () => {
  fc.assert(
    fc.property(arbSlug, (slug) => {
      if (isReservedNamespaceName(slug)) {
        assertThrows(() => createNamespace(slug), Error, "is reserved");
      } else {
        assertEquals(createNamespace(slug) as string, slug);
      }
    }),
    { numRuns: 500 },
  );
});

Deno.test("restoreNamespace: returns every well-formed slug unchanged", () => {
  fc.assert(
    fc.property(arbSlug, (slug) => {
      assertEquals(restoreNamespace(slug) as string, slug);
    }),
    { numRuns: 500 },
  );
});

Deno.test("restoreNamespace: agrees with createNamespace on every slug it accepts", () => {
  fc.assert(
    fc.property(arbSlug.filter((s) => !isReservedNamespaceName(s)), (slug) => {
      assertEquals(restoreNamespace(slug), createNamespace(slug));
    }),
    { numRuns: 200 },
  );
});

Deno.test("namespaceCollidesWithLayout: is reserved-or-listed for any directory list", () => {
  fc.assert(
    fc.property(arbSlug, fc.array(arbSlug, { maxLength: 5 }), (slug, dirs) => {
      assertEquals(
        namespaceCollidesWithLayout(slug, dirs),
        isReservedNamespaceName(slug) || dirs.includes(slug),
      );
    }),
    { numRuns: 500 },
  );
});
