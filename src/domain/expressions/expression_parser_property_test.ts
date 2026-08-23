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
import {
  containsExpression,
  extractCelExpression,
  extractExpressions,
  extractInputReferencesFromCel,
  replaceExpressions,
  stripExpressionFields,
  transformHyphenatedModelRefs,
  valueContainsExpression,
} from "./expression_parser.ts";

const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");

/** Bare identifiers: leading letter, then letters/digits/underscores. */
const arbIdent = fc
  .tuple(
    fc.constantFrom(...LOWER),
    fc.stringOf(fc.constantFrom(...[...LOWER, "0", "1", "2", "_"]), {
      maxLength: 6,
    }),
  )
  .map(([head, rest]) => head + rest);

/** Model names carrying at least one hyphen — the transform's domain. */
const arbHyphenModelName = fc
  .array(arbIdent, { minLength: 2, maxLength: 3 })
  .map((parts) => parts.join("-"));

const arbDepType = fc.constantFrom(
  "input",
  "resource",
  "file",
  "execution",
  "definition",
);

/**
 * Brace-free, `$`-free, pre-trimmed CEL-ish expressions. The wrapper
 * round-trip below relies on the inner text containing no `}}` and no
 * leading/trailing whitespace, which this grammar guarantees.
 */
const arbCelExpr = fc.oneof(
  arbIdent,
  fc.tuple(arbIdent, arbIdent).map(([a, b]) => `${a}.${b}`),
  fc.tuple(arbIdent, arbIdent).map(([a, b]) => `${a} + ${b}`),
  fc
    .tuple(fc.oneof(arbIdent, arbHyphenModelName), arbDepType, arbIdent)
    .map(([model, type, field]) => `model.${model}.${type}.${field}`),
);

/** Record keys are drawn from a small safe alphabet so no generated key can
 * collide with `__proto__` or other special object keys. */
const arbKey = fc.stringOf(fc.constantFrom(..."abcdefgh".split("")), {
  minLength: 1,
  maxLength: 6,
});

/** Literal text that can never form or break a `${{ ... }}` marker. */
const arbLiteral = fc.stringOf(
  fc.constantFrom(..."abc XYZ019.,_-!".split("")),
  { maxLength: 10 },
);

/** JSON-ish trees with arbitrary string leaves (expressions included by
 * chance) — `undefined`, floats, and unsafe keys excluded so structural
 * equality after a rebuild is unambiguous. */
const { tree: arbJsonTree } = fc.letrec((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.oneof(fc.string(), fc.unicodeString()),
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("tree"), { maxLength: 3 }),
    fc.dictionary(arbKey, tie("tree"), { maxKeys: 3 }),
  ),
}));

Deno.test("extractCelExpression: round-trips generated expressions through the ${{ }} wrapper", () => {
  fc.assert(
    fc.property(
      arbCelExpr,
      fc.constantFrom("", " ", "  "),
      (expr, ws) => {
        const wrapped = `\${{${ws}${expr}${ws}}}`;
        assertEquals(extractCelExpression(wrapped), expr);
        assert(containsExpression(wrapped));
        // The bare expression carries no wrapper, so it is not an expression.
        assertEquals(extractCelExpression(expr), null);
        assertEquals(containsExpression(expr), false);
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("extractExpressions: finds every embedded expression with its path", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbKey, { minLength: 3, maxLength: 3 }),
      arbKey,
      fc.tuple(arbCelExpr, arbCelExpr, arbCelExpr),
      arbLiteral,
      ([k1, k2, k3], k4, [e1, e2, e3], lit) => {
        const data = {
          [k1]: `\${{ ${e1} }}`,
          [k2]: [lit, `\${{ ${e2} }}`],
          [k3]: { [k4]: `${lit}\${{ ${e3} }}${lit}` },
        };
        const locations = extractExpressions(data);
        assertEquals(
          locations.map((l) => [l.path, l.celExpression]),
          [
            [k1, e1],
            [`${k2}[1]`, e2],
            [`${k3}.${k4}`, e3],
          ],
        );
        // Every raw slice is the exact wrapped text found in the data.
        assertEquals(locations[0].raw, `\${{ ${e1} }}`);
        assertEquals(locations[1].raw, `\${{ ${e2} }}`);
        assertEquals(locations[2].raw, `\${{ ${e3} }}`);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("transformHyphenatedModelRefs: rewrites hyphenated refs to bracket notation and is idempotent", () => {
  fc.assert(
    fc.property(
      arbHyphenModelName,
      arbDepType,
      arbIdent,
      arbLiteral,
      (model, type, field, lit) => {
        const expr = `${lit}model.${model}.${type}.${field}`;
        const once = transformHyphenatedModelRefs(expr);
        assertEquals(once, `${lit}model["${model}"].${type}.${field}`);
        // Idempotent: bracket notation no longer matches the transform.
        assertEquals(transformHyphenatedModelRefs(once), once);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("transformHyphenatedModelRefs: leaves hyphen-free refs unchanged", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(arbIdent, arbDepType, arbIdent), {
        minLength: 1,
        maxLength: 3,
      }),
      (atoms) => {
        const expr = atoms
          .map(([m, t, f]) => `model.${m}.${t}.${f}`)
          .join(" + ");
        assertEquals(transformHyphenatedModelRefs(expr), expr);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("stripExpressionFields: removes exactly the expression-carrying keys", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbKey, { minLength: 4, maxLength: 4 }),
      fc.tuple(arbLiteral, fc.integer({ min: -100, max: 100 })),
      fc.tuple(arbCelExpr, arbCelExpr),
      arbLiteral,
      ([plainKey1, plainKey2, exprKey1, exprKey2], [lit, num], [e1, e2], t) => {
        const data = {
          [plainKey1]: lit,
          [plainKey2]: { nested: [num, lit] },
          [exprKey1]: `${t}\${{ ${e1} }}`,
          [exprKey2]: { nested: [lit, `\${{ ${e2} }}`] },
        };
        const stripped = stripExpressionFields(data);
        assertEquals(
          Object.keys(stripped).sort(),
          [plainKey1, plainKey2].sort(),
        );
        assertEquals(stripped[plainKey1], lit);
        assertEquals(stripped[plainKey2], { nested: [num, lit] });
        // Every surviving value is expression-free.
        for (const value of Object.values(stripped)) {
          assertEquals(valueContainsExpression(value), false);
        }
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("valueContainsExpression: detects an expression at any nesting depth", () => {
  fc.assert(
    fc.property(
      arbCelExpr,
      fc.array(fc.oneof(arbKey, fc.constant(null)), { maxLength: 4 }),
      arbLiteral,
      (expr, wrappers, lit) => {
        // Wrap the leaf in alternating objects (key) and arrays (null).
        let withExpr: unknown = `\${{ ${expr} }}`;
        let plain: unknown = lit;
        for (const w of wrappers) {
          withExpr = w === null ? [withExpr] : { [w]: withExpr };
          plain = w === null ? [plain] : { [w]: plain };
        }
        assert(valueContainsExpression(withExpr));
        assertEquals(valueContainsExpression(plain), false);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("replaceExpressions: an empty values map leaves arbitrary data unchanged", () => {
  fc.assert(
    fc.property(arbJsonTree, (data) => {
      // Totality: extraction never throws on arbitrary JSON-ish data...
      const locations = extractExpressions(data);
      assert(Array.isArray(locations));
      // ...and replacement without values is a deep identity.
      assertEquals(replaceExpressions(data, new Map()), data);
    }),
    { numRuns: 300 },
  );
});

Deno.test("extractInputReferencesFromCel: dot and bracket references agree", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbIdent, { minLength: 1, maxLength: 3 }),
      (fields) => {
        const dotExpr = fields.map((f) => `inputs.${f}`).join(" + ");
        const bracketExpr = fields.map((f) => `inputs["${f}"]`).join(" + ");
        assertEquals(
          [...extractInputReferencesFromCel(dotExpr)].sort(),
          [...fields].sort(),
        );
        assertEquals(
          extractInputReferencesFromCel(bracketExpr),
          extractInputReferencesFromCel(dotExpr),
        );
        // Cross-model references are excluded from input references.
        const crossModel = fields
          .map((f) => `model.foo.input.${f}`)
          .join(" + ");
        assertEquals(extractInputReferencesFromCel(crossModel).size, 0);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("replaceExpressions: multi-expression strings interpolate every expression with stringified values", () => {
  // Regression: the single-expression fast path once matched ANY string that
  // started with "${{" and ended with "}}", so "${{ a }} and ${{ b }}" was
  // looked up whole in the values map (keyed by individual raws), missed, and
  // came back unreplaced. Strings that start AND end with expressions must go
  // through inline interpolation like any other multi-expression string.
  fc.assert(
    fc.property(
      arbIdent,
      arbIdent,
      arbLiteral,
      arbLiteral,
      arbLiteral,
      (a, b, pre, mid, post) => {
        fc.pre(a !== b);
        const rawA = `\${{ ${a} }}`;
        const rawB = `\${{ ${b} }}`;
        const values = new Map<string, unknown>([
          [rawA, "A"],
          [rawB, 42],
        ]);
        // Starts and ends with expressions — the shape the old fast path
        // swallowed whole (mid may be empty, making them adjacent).
        assertEquals(
          replaceExpressions(`${rawA}${mid}${rawB}`, values),
          `A${mid}42`,
        );
        // Literal text around the expressions interpolates the same way.
        assertEquals(
          replaceExpressions(`${pre}${rawA}${mid}${rawB}${post}`, values),
          `${pre}A${mid}42${post}`,
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("replaceExpressions: a lone expression keeps the evaluated value's type, dropping trailing whitespace", () => {
  fc.assert(
    fc.property(
      arbCelExpr,
      fc.constantFrom("", " ", "\n", " \n "),
      fc.oneof(
        fc.integer({ min: -1000, max: 1000 }),
        fc.boolean(),
        fc.constant(null),
        fc.array(fc.string(), { maxLength: 3 }),
        fc.dictionary(arbKey, fc.integer({ min: 0, max: 9 }), { maxKeys: 3 }),
      ),
      (expr, trailing, value) => {
        const raw = `\${{ ${expr} }}`;
        const values = new Map<string, unknown>([[raw, value]]);
        assertEquals(replaceExpressions(`${raw}${trailing}`, values), value);
      },
    ),
    { numRuns: 200 },
  );
});
