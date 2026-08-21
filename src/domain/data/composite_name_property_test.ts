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

import { assert, assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { composeDataName } from "./composite_name.ts";

const arbBaseName = fc.stringOf(
  fc.constantFrom(..."abcdefgh0123-_.".split("")),
  { minLength: 1, maxLength: 20 },
).filter((s) => s.trim() !== "");

/** Vary values that pass every guard: non-blank, separator-free, not "."/"..". */
const arbVaryValue = fc.stringOf(
  fc.constantFrom(..."abcdefgh0123-_".split("")),
  { minLength: 1, maxLength: 12 },
);

const arbBlank = fc.stringOf(fc.constantFrom(" ", "\t", "\n"), {
  minLength: 1,
  maxLength: 4,
});

Deno.test("composeDataName: an empty vary list returns the base name unchanged", () => {
  fc.assert(
    fc.property(arbBaseName, (baseName) => {
      assertEquals(composeDataName(baseName, []), baseName);
    }),
    { numRuns: 200 },
  );
});

Deno.test("composeDataName: joins the base name and vary values with hyphens", () => {
  fc.assert(
    fc.property(
      arbBaseName,
      fc.array(arbVaryValue, { minLength: 1, maxLength: 4 }),
      (baseName, varyValues) => {
        const composed = composeDataName(baseName, varyValues);
        assert(composed.startsWith(`${baseName}-`));
        for (const value of varyValues) {
          assert(composed.includes(value));
        }
        assertEquals(
          composed.slice(baseName.length + 1).split("-").length >=
            varyValues.length,
          true,
        );
        // Deterministic for the same inputs.
        assertEquals(composeDataName(baseName, varyValues), composed);
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("composeDataName: appending a vary value extends the previous name", () => {
  fc.assert(
    fc.property(
      arbBaseName,
      fc.array(arbVaryValue, { minLength: 1, maxLength: 3 }),
      arbVaryValue,
      (baseName, varyValues, extra) => {
        assertEquals(
          composeDataName(baseName, [...varyValues, extra]),
          `${composeDataName(baseName, varyValues)}-${extra}`,
        );
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("composeDataName: rejects a blank base name", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant(""), arbBlank),
      fc.array(arbVaryValue, { maxLength: 3 }),
      (baseName, varyValues) => {
        assertThrows(
          () => composeDataName(baseName, varyValues),
          Error,
          "Base name must be a non-empty string",
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("composeDataName: rejects blank vary values", () => {
  fc.assert(
    fc.property(
      arbBaseName,
      fc.array(arbVaryValue, { maxLength: 3 }),
      fc.oneof(fc.constant(""), arbBlank),
      fc.array(arbVaryValue, { maxLength: 3 }),
      (baseName, before, blank, after) => {
        assertThrows(
          () => composeDataName(baseName, [...before, blank, ...after]),
          Error,
          "must be a non-empty string",
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("composeDataName: rejects vary values carrying a path separator", () => {
  fc.assert(
    fc.property(
      arbBaseName,
      fc.array(arbVaryValue, { maxLength: 3 }),
      arbVaryValue,
      fc.constantFrom("/", "\\"),
      arbVaryValue,
      (baseName, before, head, separator, tail) => {
        assertThrows(
          () =>
            composeDataName(baseName, [
              ...before,
              `${head}${separator}${tail}`,
            ]),
          Error,
          "path separator characters",
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("composeDataName: rejects relative path components as vary values", () => {
  fc.assert(
    fc.property(
      arbBaseName,
      fc.array(arbVaryValue, { maxLength: 3 }),
      fc.constantFrom(".", ".."),
      (baseName, before, dots) => {
        assertThrows(
          () => composeDataName(baseName, [...before, dots]),
          Error,
          "relative path component",
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("composeDataName: vary values are only validated when present", () => {
  // The blank/separator guards run per value, so an empty list skips them
  // entirely — a base name with dots is untouched.
  fc.assert(
    fc.property(arbBaseName, (baseName) => {
      assertEquals(composeDataName(`${baseName}.json`, []), `${baseName}.json`);
    }),
    { numRuns: 200 },
  );
});
