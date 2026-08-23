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
import { CelEvaluator } from "./cel_evaluator.ts";
import { InvalidExpressionError } from "../../domain/expressions/errors.ts";
import {
  extractDependencies,
  extractModelRefs,
} from "../../domain/expressions/dependency_extractor.ts";
import {
  extractExpressions,
  replaceExpressions,
} from "../../domain/expressions/expression_parser.ts";

// One evaluator for the whole file — construction registers every namespace
// function and is the expensive part; evaluation itself carries no state
// besides the deprecation-warning dedup set.
const evaluator = new CelEvaluator();

const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");

/**
 * CEL reserved words and literal keywords are outside the domain of variable
 * identifiers (fast-check found `as`: "Reserved identifier: as"), plus macro
 * and builtin names excluded defensively. Generated identifiers must dodge
 * them all.
 */
const CEL_RESERVED = new Set([
  "as",
  "break",
  "const",
  "continue",
  "else",
  "false",
  "for",
  "function",
  "if",
  "import",
  "in",
  "let",
  "loop",
  "namespace",
  "null",
  "package",
  "return",
  "true",
  "var",
  "void",
  "while",
  // macros / builtins
  "all",
  "dyn",
  "exists",
  "filter",
  "has",
  "map",
  "matches",
  "size",
  "type",
]);

const arbIdent = fc
  .tuple(
    fc.constantFrom(...LOWER),
    fc.stringOf(fc.constantFrom(...[...LOWER, "0", "1", "2", "_"]), {
      maxLength: 6,
    }),
  )
  .map(([head, rest]) => head + rest)
  .filter((ident) => !CEL_RESERVED.has(ident));

const arbHyphenModelName = fc
  .array(arbIdent, { minLength: 2, maxLength: 3 })
  .map((parts) => parts.join("-"));

// Evaluated atoms use input/execution/definition only: model.*.resource and
// model.*.file additionally route through the deprecation-warning logger,
// which is not the surface under test here.
const arbEvalDepType = fc.constantFrom(
  "input" as const,
  "execution" as const,
  "definition" as const,
);

interface ModelAtom {
  model: string;
  type: "input" | "execution" | "definition";
  field: string;
}

const arbModelAtom: fc.Arbitrary<ModelAtom> = fc.record({
  model: fc.oneof(arbIdent, arbHyphenModelName),
  type: arbEvalDepType,
  field: arbIdent,
});

/** Valid-by-construction CEL expressions (brace-free, pre-trimmed). */
const arbCelExpr = fc.oneof(
  arbIdent,
  fc.tuple(arbIdent, arbIdent).map(([a, b]) => `${a} + ${b}`),
  fc
    .tuple(arbIdent, arbEvalDepType, arbIdent)
    .map(([m, t, f]) => `model.${m}.${t}.${f}`),
);

/** Record keys are drawn from a small safe alphabet so no generated key can
 * collide with `__proto__` or the reserved namespace keys (file, data,
 * workers, modelMethod) that wrapNamespaces intercepts. */
const arbKey = fc.stringOf(fc.constantFrom(..."abcdefgh".split("")), {
  minLength: 1,
  maxLength: 6,
});

const arbJsonValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }),
);

/** Arbitrary — mostly malformed — expression text: raw fuzz plus near-miss
 * mutations of valid grammar output. */
const arbAnyExpressionText = fc.oneof(
  fc.string(),
  fc.unicodeString(),
  fc.tuple(arbCelExpr, fc.string({ maxLength: 5 })).map(([e, junk]) =>
    e + junk
  ),
);

const arbContext = fc.dictionary(arbKey, arbJsonValue, { maxKeys: 3 });

const arbLetters = fc.stringOf(fc.constantFrom(...LOWER), { maxLength: 6 });

Deno.test("CelEvaluator.evaluate: returns a value or throws InvalidExpressionError for arbitrary input", () => {
  // Crash guard for user-authored expressions: no unhandled non-typed error
  // may escape, whatever the input string or context shape.
  fc.assert(
    fc.property(arbAnyExpressionText, arbContext, (expression, context) => {
      try {
        evaluator.evaluate(expression, context);
      } catch (error) {
        assert(error instanceof InvalidExpressionError);
        assertEquals(error.expression, expression);
      }
    }),
    { numRuns: 300 },
  );
});

Deno.test("CelEvaluator.evaluateAsync: rejects only with InvalidExpressionError for arbitrary input", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbAnyExpressionText,
      arbContext,
      async (expression, context) => {
        try {
          await evaluator.evaluateAsync(expression, context);
        } catch (error) {
          assert(error instanceof InvalidExpressionError);
          assertEquals(
            (error as InvalidExpressionError).expression,
            expression,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("CelEvaluator.validate: total on arbitrary input and true for grammar-valid expressions", () => {
  fc.assert(
    fc.property(arbAnyExpressionText, (expression) => {
      const result = evaluator.validate(expression);
      assertEquals(typeof result.valid, "boolean");
      if (!result.valid) {
        assertEquals(typeof result.error, "string");
      }
    }),
    { numRuns: 200 },
  );
  fc.assert(
    fc.property(arbCelExpr, (expression) => {
      assertEquals(evaluator.validate(expression), { valid: true });
    }),
    { numRuns: 100 },
  );
});

Deno.test("CelEvaluator.evaluate: dependency extraction agrees with evaluation", () => {
  fc.assert(
    fc.property(
      fc.array(arbModelAtom, { minLength: 1, maxLength: 3 }),
      fc.array(arbLetters, { minLength: 3, maxLength: 3 }),
      fc.nat(),
      (atoms, valuePool, victimSeed) => {
        const expression = atoms
          .map((a) => `model.${a.model}.${a.type}.${a.field}`)
          .join(" + ");

        // The extractor reports exactly the generated model refs and
        // (model, type) pairs, deduplicated.
        assertEquals(
          [...new Set(atoms.map((a) => a.model))].sort(),
          extractModelRefs(expression).sort(),
        );
        assertEquals(
          [...new Set(atoms.map((a) => `${a.model}:${a.type}`))].sort(),
          extractDependencies(expression)
            .map((d) => `${d.modelRef}:${d.type}`)
            .sort(),
        );

        // A context providing exactly the extracted dependencies evaluates
        // successfully (later duplicate atoms overwrite earlier values, so
        // the expected result reads from the final context).
        const model: Record<
          string,
          Record<string, Record<string, string>>
        > = {};
        atoms.forEach((a, i) => {
          model[a.model] ??= {};
          model[a.model][a.type] ??= {};
          model[a.model][a.type][a.field] = valuePool[i % valuePool.length];
        });
        const expected = atoms
          .map((a) => model[a.model][a.type][a.field])
          .join("");
        assertEquals(evaluator.evaluate(expression, { model }), expected);

        // Removing any one referenced model makes evaluation fail with the
        // typed error — the extracted dependency set is not over-reported.
        const victim = atoms[victimSeed % atoms.length].model;
        const withoutVictim = Object.fromEntries(
          Object.entries(model).filter(([name]) => name !== victim),
        );
        try {
          evaluator.evaluate(expression, { model: withoutVictim });
          assert(false, `expected missing model ${victim} to fail`);
        } catch (error) {
          assert(error instanceof InvalidExpressionError);
        }
      },
    ),
    { numRuns: 150 },
  );
});

Deno.test("CelEvaluator.evaluate: integer arithmetic matches JS on safe integers", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.integer({ min: -1000, max: 1000 }),
      (a, b) => {
        // Literal ints exercise the bigint → number coercion path.
        const sum = evaluator.evaluate(`${a} + ${b}`, {});
        assertEquals(typeof sum, "number");
        assertEquals(sum, a + b);
        assertEquals(evaluator.evaluate(`${a} * ${b}`, {}), a * b);
        // Context-provided JS numbers exercise the double path.
        assertEquals(evaluator.evaluate("a + b", { a, b }), a + b);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("CelEvaluator.evaluate: whole-string interpolation preserves the evaluated type", () => {
  fc.assert(
    fc.property(
      arbIdent,
      fc.oneof(
        fc.integer({ min: -1000, max: 1000 }),
        fc.boolean(),
        arbLetters,
      ),
      (ident, value) => {
        const data = `\${{ ${ident} }}`;
        const [location] = extractExpressions(data);
        const values = new Map<string, unknown>([
          [
            location.raw,
            evaluator.evaluate(location.celExpression, { [ident]: value }),
          ],
        ]);
        // The evaluated value is substituted as-is — numbers stay numbers,
        // booleans stay booleans.
        assertEquals(replaceExpressions(data, values), value);
      },
    ),
    { numRuns: 150 },
  );
});

Deno.test("CelEvaluator.evaluate: embedded interpolation yields the literal text with values substituted, stably", () => {
  const arbLiteral = fc.stringOf(
    fc.constantFrom(..."abc XYZ019.,_-!".split("")),
    { maxLength: 8 },
  );
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          arbLiteral,
          arbIdent,
          fc.oneof(arbLetters, fc.integer({ min: 0, max: 999 })),
        ),
        { minLength: 1, maxLength: 3 },
      ),
      arbLiteral,
      (pieces, lastLiteral) => {
        const data = pieces
          .map(([lit, ident]) => `${lit}\${{ ${ident} }}`)
          .join("") + lastLiteral;
        // Strings that both start with "${{" and end with "}}" hit the
        // single-expression fast path in replaceExpressions and are returned
        // unreplaced — see the BUG CANDIDATE property in
        // expression_parser_property_test.ts. Out of scope here.
        fc.pre(!(data.startsWith("${{") && /\}\}\s*$/.test(data)));

        const context: Record<string, unknown> = {};
        for (const [, ident, value] of pieces) {
          context[ident] = value; // duplicates: last write wins
        }

        const locations = extractExpressions(data);
        assertEquals(locations.length, pieces.length);
        const values = new Map<string, unknown>(
          locations.map((l) => [
            l.raw,
            evaluator.evaluate(l.celExpression, context),
          ]),
        );
        const result = replaceExpressions(data, values);

        const expected = pieces
          .map(([lit, ident]) => `${lit}${String(context[ident])}`)
          .join("") + lastLiteral;
        assertEquals(result, expected);

        // Stability: the interpolated text carries no expressions, so
        // re-running the pipeline is the identity.
        assertEquals(extractExpressions(result), []);
        assertEquals(replaceExpressions(result, values), result);
      },
    ),
    { numRuns: 150 },
  );
});
