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
import { inImportPosition } from "./imports.ts";

// The pattern inImportPosition replaces, kept here as the reference.
const IMPORT_POSITION_RE =
  /(?:^|[^.\w$])(?:(?:import|export)\b[^;]*\bfrom|import)\s*$|(?:^|[^.\w$])import\s*\(\s*$/;

const fragment = fc.constantFrom(
  "import",
  "export",
  "from",
  " ",
  "\n",
  "\t",
  ";",
  "(",
  ")",
  "{ a, b }",
  "* as x",
  ".",
  "$",
  "_",
  "x",
  "type",
  "reimport",
  "fromage",
  "\u00a0",
);

Deno.test("inImportPosition: agrees with the regular expression it replaces", () => {
  fc.assert(
    fc.property(
      fc.array(fragment, { maxLength: 24 }).map((parts) => parts.join("")),
      (code) => {
        assertEquals(inImportPosition(code), IMPORT_POSITION_RE.test(code));
      },
    ),
    { numRuns: 20_000 },
  );
});

Deno.test("inImportPosition: agrees on arbitrary text", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 60 }), (code) => {
      assertEquals(inImportPosition(code), IMPORT_POSITION_RE.test(code));
    }),
    { numRuns: 20_000 },
  );
});
