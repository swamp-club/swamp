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
import { ModelType } from "./model_type.ts";

// Arbitrary for non-empty strings that will normalize to something valid
const arbModelTypeInput = fc
  .stringOf(
    fc.oneof(
      fc.constant("a"),
      fc.constant("b"),
      fc.constant("c"),
      fc.constant("/"),
      fc.constant(" "),
      fc.constant("::"),
      fc.constant("."),
      fc.constant("A"),
      fc.constant("Z"),
    ),
    { minLength: 1, maxLength: 30 },
  )
  .filter((s) => {
    // Must have at least one alphanumeric char after normalization
    const normalized = s
      .toLowerCase()
      .replace(/::/g, "/")
      .replace(/\s+/g, "/")
      .replace(/\./g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/|\/$/g, "");
    return normalized.length > 0;
  });

Deno.test("property: normalization is idempotent", () => {
  fc.assert(
    fc.property(arbModelTypeInput, (s) => {
      const first = ModelType.create(s);
      const second = ModelType.create(first.normalized);
      assertEquals(first.normalized, second.normalized);
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: normalized result is always lowercase", () => {
  fc.assert(
    fc.property(arbModelTypeInput, (s) => {
      const mt = ModelType.create(s);
      assertEquals(mt.normalized, mt.normalized.toLowerCase());
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: no consecutive separators in normalized form", () => {
  fc.assert(
    fc.property(arbModelTypeInput, (s) => {
      const mt = ModelType.create(s);
      assertEquals(mt.normalized.includes("//"), false);
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: no leading or trailing separators", () => {
  fc.assert(
    fc.property(arbModelTypeInput, (s) => {
      const mt = ModelType.create(s);
      assertEquals(mt.normalized.startsWith("/"), false);
      assertEquals(mt.normalized.endsWith("/"), false);
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: equality is by normalized form", () => {
  fc.assert(
    fc.property(arbModelTypeInput, arbModelTypeInput, (a, b) => {
      const mtA = ModelType.create(a);
      const mtB = ModelType.create(b);
      assertEquals(
        mtA.equals(mtB),
        mtA.normalized === mtB.normalized,
      );
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: empty input is rejected", () => {
  assertThrows(() => ModelType.create(""));
  assertThrows(() => ModelType.create("   "));
});

Deno.test("property: toNormalized and normalized are consistent", () => {
  fc.assert(
    fc.property(arbModelTypeInput, (s) => {
      const mt = ModelType.create(s);
      assertEquals(mt.toNormalized(), mt.normalized);
      assertEquals(mt.toDirectoryPath(), mt.normalized);
    }),
    { numRuns: 100 },
  );
});
