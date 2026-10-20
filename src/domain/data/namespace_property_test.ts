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
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  ALWAYS_LOCAL_SUBDIRS,
  DEFAULT_DATASTORE_SUBDIRS,
} from "../datastore/datastore_config.ts";

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

const LAYOUT_NAMES: readonly string[] = [
  ...DEFAULT_DATASTORE_SUBDIRS,
  ...ALWAYS_LOCAL_SUBDIRS,
];

// Only the layout directories make an existing v2 binding collide; the wider
// reserved set applies to new claims and to v3 (swamp-club#3691).
Deno.test("namespaceCollidesWithLayout: is layout-or-listed for any directory list", () => {
  fc.assert(
    fc.property(arbSlug, fc.array(arbSlug, { maxLength: 5 }), (slug, dirs) => {
      assertEquals(
        namespaceCollidesWithLayout(slug, dirs),
        LAYOUT_NAMES.includes(slug) || dirs.includes(slug),
      );
    }),
    { numRuns: 500 },
  );
});

/**
 * The first-level `.swamp/` names swamp uses, gathered independently of the
 * reserved list under test (swamp-club#3691): the first segments of the
 * infrastructure's `SWAMP_SUBDIRS`, and the names written out by hand at
 * their call sites (the package cache, start sessions, and the `~/.swamp`
 * names a checkout at the home directory shares).
 */
const SWAMP_OWNED_ORACLE: readonly string[] = [
  ...new Set([
    ...Object.values(SWAMP_SUBDIRS).map((dir) => dir.split("/")[0]),
    "cache",
    "start",
    "repos",
    "deno",
    "source",
  ]),
];

Deno.test("createNamespace: accepts no slug that names a directory swamp uses in .swamp/", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constantFrom(...SWAMP_OWNED_ORACLE), arbSlug),
      (slug) => {
        let accepted = true;
        try {
          createNamespace(slug);
        } catch {
          accepted = false;
        }
        if (accepted) {
          assertEquals(SWAMP_OWNED_ORACLE.includes(slug), false, slug);
        }
      },
    ),
    { numRuns: 300 },
  );
});
