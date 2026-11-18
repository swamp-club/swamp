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
import { ModelType } from "../models/model_type.ts";
import {
  canonicalTypePattern,
  parseResourceSelector,
  type ResourceKind,
  resourceSelectorMatches,
  resourceSelectorToString,
  typePatternMatchesIgnoringAt,
} from "./resource_selector.ts";

// workspace holds its patterns to the workspace-name grammar; see its own properties
const KINDS: ResourceKind[] = ["workflow", "model", "data", "access", "vault"];

const arbKind = fc.constantFrom(...KINDS);

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
        fc.pre(![...KINDS, "workspace"].includes(kind));
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
        assert(resourceSelectorMatches(selector, prefix));
        assert(resourceSelectorMatches(selector, prefix + suffix));
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

const arbTypeSpelling = fc.stringOf(
  fc.constantFrom(..."abcAB01-_@/.: ".split("")),
  { minLength: 1, maxLength: 16 },
);

Deno.test("canonicalTypePattern: canonical form is a fixed point", () => {
  fc.assert(
    fc.property(
      fc.oneof(arbTypeSpelling, arbTypeSpelling.map((p) => `${p}*`)),
      (pattern) => {
        const canonical = canonicalTypePattern(pattern);
        if (canonical === null) return;
        assertEquals(canonicalTypePattern(canonical), canonical);
      },
    ),
  );
});

Deno.test("typePatternMatchesIgnoringAt: covers every type the raw pattern matched in canonical spelling", () => {
  fc.assert(
    fc.property(
      fc.oneof(arbTypeSpelling, arbTypeSpelling.map((p) => `${p}*`)),
      arbTypeSpelling,
      (pattern, rawType) => {
        let type: string;
        try {
          type = ModelType.create(rawType).normalized;
        } catch {
          return;
        }
        const canonical = canonicalTypePattern(pattern);
        if (canonical === null) return;
        if (
          resourceSelectorMatches({ kind: "model", pattern: canonical }, type)
        ) {
          assert(typePatternMatchesIgnoringAt(canonical, type));
        }
      },
    ),
  );
});

const arbWorkspaceName = fc.tuple(
  fc.constantFrom(..."abcxyz019".split("")),
  fc.stringOf(fc.constantFrom(..."abcxyz019-".split("")), { maxLength: 62 }),
).map(([first, rest]) => first + rest);

Deno.test("parseResourceSelector: a workspace name or a prefix of one round-trips", () => {
  fc.assert(
    fc.property(arbWorkspaceName, fc.boolean(), (name, wildcard) => {
      const raw = `workspace:${name}${wildcard ? "*" : ""}`;
      const parsed = parseResourceSelector(raw);
      assertEquals(parsed.kind, "workspace");
      assertEquals(resourceSelectorToString(parsed), raw);
    }),
    { numRuns: 200 },
  );
});

Deno.test("parseResourceSelector: a workspace pattern outside the name grammar is refused", () => {
  fc.assert(
    fc.property(
      arbWorkspaceName,
      fc.constantFrom(..."ABZ_@/.: ".split("")),
      fc.nat({ max: 63 }),
      fc.boolean(),
      (name, bad, at, wildcard) => {
        const index = Math.min(at, name.length);
        const pattern = name.slice(0, index) + bad + name.slice(index);
        assertThrows(
          () =>
            parseResourceSelector(
              `workspace:${pattern}${wildcard ? "*" : ""}`,
            ),
          Error,
          "a workspace pattern is a workspace name",
        );
      },
    ),
    { numRuns: 200 },
  );
});
