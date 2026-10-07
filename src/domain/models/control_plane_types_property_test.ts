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
import { normalizeModelTypeName } from "./control_plane_types.ts";
import { ModelType } from "./model_type.ts";

/**
 * Letters in both cases, digits, '-', '_', '@' and every separator the
 * ModelType normalizer folds, so generated strings exercise leading '@' and
 * '/' runs mixed with whitespace.
 */
const TYPE_CHARS = [
  ..."abcXYZ019",
  "-",
  "_",
  "@",
  "/",
  ".",
  ":",
  " ",
  "\t",
];

const typeString = fc.array(fc.constantFrom(...TYPE_CHARS), {
  minLength: 0,
  maxLength: 24,
}).map((chars) => chars.join(""));

function modelTypeNormalized(type: string): string | null {
  try {
    return ModelType.create(type).normalized;
  } catch {
    return null;
  }
}

Deno.test("normalizeModelTypeName: is unchanged by normalizing the type first", () => {
  fc.assert(
    fc.property(typeString, (type) => {
      const normalized = modelTypeNormalized(type);
      if (normalized === null) {
        assertEquals(normalizeModelTypeName(type), null);
        return;
      }
      assertEquals(
        normalizeModelTypeName(type),
        normalizeModelTypeName(normalized),
      );
    }),
  );
});

Deno.test("normalizeModelTypeName: returns a fixed point with no leading @ or /", () => {
  fc.assert(
    fc.property(typeString, (type) => {
      const key = normalizeModelTypeName(type);
      if (key === null) return;
      assert(!key.startsWith("@") && !key.startsWith("/"), key);
      assertEquals(normalizeModelTypeName(key), key);
      assertEquals(modelTypeNormalized(key), key);
    }),
  );
});

Deno.test("normalizeModelTypeName: ignores any run of leading @ and /", () => {
  fc.assert(
    fc.property(
      typeString,
      fc.array(fc.constantFrom("@", "/", " "), { maxLength: 6 }),
      (type, prefix) => {
        const key = normalizeModelTypeName(type);
        if (key === null) return;
        assertEquals(normalizeModelTypeName(`${prefix.join("")}${key}`), key);
      },
    ),
  );
});
