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
import { coerceModelType, ModelType } from "./model_type.ts";

/**
 * A deliberately wide alphabet: letters in both cases, digits, hyphens,
 * underscores, '@', every separator the normalizer collapses ('/', '.', ':',
 * space, tab, newline) and a handful of non-ASCII characters (including
 * 'İ', whose lowercase form expands to two code points).
 */
const WIDE_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  "-",
  "_",
  "@",
  "/",
  ".",
  ":",
  " ",
  "\t",
  "\n",
  "é",
  "Ä",
  "日",
  "İ",
];

const ALNUM_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
];

/** Arbitrary strings over the wide alphabet — no filter, anything goes. */
const arbWideString = fc.stringOf(fc.constantFrom(...WIDE_CHARS), {
  maxLength: 24,
});

/**
 * Strings guaranteed to survive normalization: an alphanumeric character is
 * spliced into the middle, so the normalized form can never be empty. This
 * replaces the old filter that re-implemented the production normalize regex.
 */
const arbNormalizableInput = fc
  .tuple(arbWideString, fc.constantFrom(...ALNUM_CHARS), arbWideString)
  .map(([prefix, alnum, suffix]) => prefix + alnum + suffix);

/** Strings made only of characters the normalizer collapses to separators. */
const arbSeparatorOnlyString = fc.stringOf(
  fc.constantFrom("/", ".", " ", "\t", "\n"),
  { minLength: 1, maxLength: 12 },
);

/** A path segment with no separator characters in it. */
const arbSegment = fc.stringOf(fc.constantFrom(...ALNUM_CHARS, "-", "_"), {
  minLength: 1,
  maxLength: 10,
});

Deno.test("property: any input containing an alphanumeric normalizes successfully", () => {
  fc.assert(
    fc.property(arbNormalizableInput, (s) => {
      const mt = ModelType.create(s);
      assert(mt.normalized.length > 0);
      assertEquals(mt.raw, s.trim());
    }),
    { numRuns: 300 },
  );
});

Deno.test("property: separator-only inputs are rejected", () => {
  fc.assert(
    fc.property(arbSeparatorOnlyString, (s) => {
      // Every character collapses to '/', which is then stripped, leaving an
      // empty normalized form.
      assertThrows(() => ModelType.create(s));
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: normalization is idempotent", () => {
  fc.assert(
    fc.property(arbNormalizableInput, (s) => {
      const first = ModelType.create(s);
      const second = ModelType.create(first.normalized);
      assertEquals(second.normalized, first.normalized);
      // A third pass cannot drift either.
      assertEquals(
        ModelType.create(second.normalized).normalized,
        first.normalized,
      );
    }),
    { numRuns: 300 },
  );
});

Deno.test("property: normalized form carries no separator noise", () => {
  fc.assert(
    fc.property(arbNormalizableInput, (s) => {
      const n = ModelType.create(s).normalized;
      assertEquals(n, n.toLowerCase());
      assertEquals(n.includes("//"), false);
      assertEquals(n.includes("."), false);
      assertEquals(n.includes("::"), false);
      assertEquals(/\s/.test(n), false);
      assertEquals(n.startsWith("/"), false);
      assertEquals(n.endsWith("/"), false);
    }),
    { numRuns: 300 },
  );
});

Deno.test("property: equality is by normalized form", () => {
  fc.assert(
    fc.property(arbNormalizableInput, arbNormalizableInput, (a, b) => {
      const mtA = ModelType.create(a);
      const mtB = ModelType.create(b);
      assertEquals(mtA.equals(mtB), mtA.normalized === mtB.normalized);
      // Equality survives re-normalizing either side.
      assertEquals(mtA.equals(ModelType.create(mtA.normalized)), true);
    }),
    { numRuns: 300 },
  );
});

Deno.test("property: empty input is rejected", () => {
  assertThrows(() => ModelType.create(""));
  assertThrows(() => ModelType.create("   "));
  assertThrows(() => ModelType.create("\t\n"));
});

Deno.test("property: toNormalized and toDirectoryPath match normalized", () => {
  fc.assert(
    fc.property(arbNormalizableInput, (s) => {
      const mt = ModelType.create(s);
      assertEquals(mt.toNormalized(), mt.normalized);
      assertEquals(mt.toDirectoryPath(), mt.normalized);
      assertEquals(mt.toString(), mt.raw);
      // coerceModelType is the identity on an existing ModelType.
      assertEquals(coerceModelType(mt), mt);
      assertEquals(coerceModelType(s).normalized, mt.normalized);
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: getSegmentCount counts non-empty path segments", () => {
  fc.assert(
    fc.property(
      fc.array(arbSegment, { minLength: 1, maxLength: 5 }),
      (segments) => {
        assertEquals(
          ModelType.getSegmentCount(segments.join("/")),
          segments.length,
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: getSegmentCount ignores empty segments and the '@' prefix", () => {
  fc.assert(
    fc.property(
      fc.array(arbSegment, { minLength: 1, maxLength: 5 }),
      (segments) => {
        const joined = segments.join("/");
        const noisy = `/${segments.join("//")}/`;
        assertEquals(ModelType.getSegmentCount(noisy), segments.length);
        // "@ns/a" and "ns/a" have the same segment count — the '@' marks the
        // namespace, it is not a segment of its own.
        assertEquals(
          ModelType.getSegmentCount(`@${joined}`),
          ModelType.getSegmentCount(joined),
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: getUserNamespace returns the segment after '@'", () => {
  fc.assert(
    fc.property(
      arbSegment,
      fc.array(arbSegment, { maxLength: 3 }),
      (namespace, rest) => {
        const type = [`@${namespace}`, ...rest].join("/");
        assert(ModelType.isUserNamespace(type));
        assertEquals(ModelType.getUserNamespace(type), namespace);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: getUserNamespace is undefined without an '@' prefix", () => {
  fc.assert(
    fc.property(
      fc.array(arbSegment, { minLength: 1, maxLength: 4 }),
      (segments) => {
        const type = segments.join("/");
        assertEquals(ModelType.isUserNamespace(type), false);
        assertEquals(ModelType.getUserNamespace(type), undefined);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: getUserNamespace of a bare '@' is the empty string", () => {
  // Documents the edge: "@" is a user namespace with an empty namespace name.
  assertEquals(ModelType.getUserNamespace("@"), "");
  assertEquals(ModelType.getSegmentCount("@"), 0);
});

Deno.test("property: isReservedCollective flags swamp and si in any position form", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("swamp", "si"),
      fc.array(arbSegment, { maxLength: 3 }),
      (reserved, rest) => {
        assert(ModelType.isReservedCollective([reserved, ...rest].join("/")));
        assert(
          ModelType.isReservedCollective([`@${reserved}`, ...rest].join("/")),
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: isReservedCollective ignores non-reserved first segments", () => {
  fc.assert(
    fc.property(
      arbSegment,
      fc.array(arbSegment, { maxLength: 3 }),
      (first, rest) => {
        fc.pre(first !== "swamp" && first !== "si");
        assertEquals(
          ModelType.isReservedCollective([first, ...rest].join("/")),
          false,
        );
        assertEquals(
          ModelType.isReservedCollective([`@${first}`, ...rest].join("/")),
          false,
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: isReservedCollective matches whole segments only", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("swamp", "si"),
      arbSegment,
      fc.array(arbSegment, { maxLength: 2 }),
      (reserved, suffix, rest) => {
        // "swampish/foo" is not reserved — only an exact first segment is.
        const extended = `${reserved}${suffix}`;
        fc.pre(extended !== "swamp" && extended !== "si");
        assertEquals(
          ModelType.isReservedCollective([extended, ...rest].join("/")),
          false,
        );
      },
    ),
    { numRuns: 200 },
  );
});
