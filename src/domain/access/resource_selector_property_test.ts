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
import {
  parseResourceSelector,
  type ResourceKind,
  resourceSelectorMatches,
  resourceSelectorToString,
} from "./resource_selector.ts";

const KINDS: ResourceKind[] = ["workflow", "model", "data", "access"];

const arbKind = fc.constantFrom(...KINDS);

/** Pattern bodies never contain '*' so wildcard placement stays explicit. */
const arbStarFreePattern = fc.stringOf(
  fc.constantFrom(..."abcdefgh0123-_@/.:".split("")),
  { minLength: 1, maxLength: 20 },
);

const arbResourceName = fc.stringOf(
  fc.constantFrom(..."abcdefgh0123-_@/.:*".split("")),
  { maxLength: 20 },
);

Deno.test("parseResourceSelector: round-trips through resourceSelectorToString", () => {
  fc.assert(
    fc.property(
      arbKind,
      fc.oneof(arbStarFreePattern, arbStarFreePattern.map((p) => `${p}*`)),
      (kind, pattern) => {
        const raw = `${kind}:${pattern}`;
        const parsed = parseResourceSelector(raw);
        assertEquals(parsed.kind, kind);
        assertEquals(parsed.pattern, pattern);
        assertEquals(resourceSelectorToString(parsed), raw);
        // Re-parsing the formatted form is a fixed point.
        assertEquals(parseResourceSelector(resourceSelectorToString(parsed)), {
          kind,
          pattern,
        });
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("parseResourceSelector: splits on the first colon only", () => {
  fc.assert(
    fc.property(arbKind, arbStarFreePattern, (kind, tail) => {
      // Patterns may legitimately contain colons; only the first one is the
      // kind separator.
      const parsed = parseResourceSelector(`${kind}:a:${tail}`);
      assertEquals(parsed.pattern, `a:${tail}`);
    }),
    { numRuns: 200 },
  );
});

Deno.test("parseResourceSelector: rejects selectors without a kind separator", () => {
  fc.assert(
    fc.property(
      fc.stringOf(fc.constantFrom(..."abcdefgh0123-_@/*".split("")), {
        maxLength: 20,
      }),
      (value) => {
        assertThrows(
          () => parseResourceSelector(value),
          Error,
          "expected",
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("parseResourceSelector: rejects an empty pattern", () => {
  fc.assert(
    fc.property(arbKind, (kind) => {
      assertThrows(
        () => parseResourceSelector(`${kind}:`),
        Error,
        "pattern cannot be empty",
      );
    }),
    { numRuns: 20 },
  );
});

Deno.test("parseResourceSelector: rejects unknown kinds", () => {
  fc.assert(
    fc.property(
      fc.stringOf(fc.constantFrom(..."abcdefgh".split("")), {
        minLength: 1,
        maxLength: 10,
      }),
      arbStarFreePattern,
      (kind, pattern) => {
        fc.pre(!(KINDS as string[]).includes(kind));
        assertThrows(
          () => parseResourceSelector(`${kind}:${pattern}`),
          Error,
          "Invalid resource kind",
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("parseResourceSelector: rejects a wildcard that is not last", () => {
  fc.assert(
    fc.property(
      arbKind,
      fc.stringOf(fc.constantFrom(..."abcdefgh0123".split("")), {
        maxLength: 8,
      }),
      fc.stringOf(fc.constantFrom(..."abcdefgh0123".split("")), {
        minLength: 1,
        maxLength: 8,
      }),
      (kind, head, tail) => {
        assertThrows(
          () => parseResourceSelector(`${kind}:${head}*${tail}`),
          Error,
          "wildcard * is only supported at the end",
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("parseResourceSelector: rejects repeated wildcards", () => {
  fc.assert(
    fc.property(arbKind, arbStarFreePattern, (kind, pattern) => {
      // Only the last character may be '*', so "ab**" fails on the first star.
      assertThrows(
        () => parseResourceSelector(`${kind}:${pattern}**`),
        Error,
        "wildcard * is only supported at the end",
      );
    }),
    { numRuns: 200 },
  );
});

Deno.test("resourceSelectorMatches: '*' matches every resource name", () => {
  fc.assert(
    fc.property(arbKind, arbResourceName, (kind, name) => {
      assert(resourceSelectorMatches({ kind, pattern: "*" }, name));
    }),
    { numRuns: 300 },
  );
});

Deno.test("resourceSelectorMatches: a wildcard-free pattern matches only itself", () => {
  fc.assert(
    fc.property(
      arbKind,
      arbStarFreePattern,
      arbResourceName,
      (kind, pattern, other) => {
        const selector = { kind, pattern };
        assert(resourceSelectorMatches(selector, pattern));
        if (other !== pattern) {
          assertEquals(resourceSelectorMatches(selector, other), false);
        }
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("resourceSelectorMatches: 'prefix*' matches exactly the prefixed names", () => {
  fc.assert(
    fc.property(
      arbKind,
      arbStarFreePattern,
      fc.stringOf(fc.constantFrom(..."abcdefgh0123-_@/".split("")), {
        maxLength: 12,
      }),
      (kind, prefix, suffix) => {
        const selector = { kind, pattern: `${prefix}*` };
        // Anything carrying the prefix matches, including the bare prefix.
        assert(resourceSelectorMatches(selector, prefix));
        assert(resourceSelectorMatches(selector, prefix + suffix));
        // A name shorter than the prefix can never carry it.
        assertEquals(
          resourceSelectorMatches(selector, prefix.slice(0, -1)),
          false,
        );
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("resourceSelectorMatches: 'prefix*' rejects names with a different first character", () => {
  fc.assert(
    fc.property(
      arbKind,
      arbStarFreePattern,
      fc.stringOf(fc.constantFrom(..."abcdefgh0123".split("")), {
        maxLength: 12,
      }),
      (kind, prefix, suffix) => {
        // "!" never appears in the generated prefix alphabet, so a name that
        // starts with it can never carry the prefix.
        assertEquals(
          resourceSelectorMatches(
            { kind, pattern: `${prefix}*` },
            `!${suffix}`,
          ),
          false,
        );
      },
    ),
    { numRuns: 300 },
  );
});
