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

// Property of classifyExtensionFile (swamp-club#3271): the layout
// generation depends on a path's segments, not on which separator joins
// them, so a lockfile written on Windows classifies like one written on
// POSIX.

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { classifyExtensionFile, PULLED_TYPE_DIRS } from "./layout.ts";

const arbSegment = fc.constantFrom(
  ".swamp",
  "config",
  "pulled-extensions",
  "extensions",
  "bundles",
  "@scope",
  "name",
  "foo.ts",
  ...PULLED_TYPE_DIRS,
);

const arbSegments = fc.array(arbSegment, { minLength: 1, maxLength: 6 });

Deno.test("classifyExtensionFile: generation is the same whichever separators join the segments", () => {
  fc.assert(
    fc.property(
      arbSegments,
      fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
      (segments, useBackslash) => {
        const slashed = segments.join("/");
        const mixed = segments.reduce((acc, seg, i) =>
          i === 0 ? seg : `${acc}${useBackslash[i - 1] ? "\\" : "/"}${seg}`
        );
        assertEquals(
          classifyExtensionFile(mixed),
          classifyExtensionFile(slashed),
        );
      },
    ),
  );
});
