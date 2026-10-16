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

// Architectural fitness test: every place a Secret can reach in the internal
// CEL environment and the query view has a disposition in the refusal
// inventory (design/enablers/typed-secrets.md Section 4.3).
//
// What this proves, and what it does not. It proves that the inventory in
// src/infrastructure/cel/cel_js_pins/cel_js_secret_refusal_inventory.ts
// classifies every secret-capable position of every cel-js built-in and of
// every function swamp registers, and that its maintained list of swamp's
// registrations equals what the source registers. It does not prove that the
// production environments register the refusals: Phase 3 adds that half, by
// checking that getDefinitions() on the real internal environment and the
// query view contains every refusal signature the inventory yields.
//
// Two sources, deliberately, as in expression_accessors_rules_test.ts:
//
//   - The cel-js built-ins come from the library itself, so a dependency bump
//     that adds a function reaches the classifier and fails until it has a
//     disposition.
//   - swamp's registrations come from the source text, matched only inside a
//     registerFunction( or registerOperator( call, so a comment cannot add
//     one and a registration cannot hide.
//
// Every assertion is set equality, never containment, so an extraction that
// matches nothing fails loudly instead of passing vacuously.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";
import {
  LATEST_RUN_FUNCTION,
  MODEL_FUNCTIONS,
} from "../src/domain/data/query_predicate.ts";
import { LITERAL_FUNCTION_SIGNATURE } from "../src/domain/expressions/cel_grammar.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  classifyPositions,
  type Disposition,
  functionRefusalSignatures,
  parseSignature,
  qualifiedName,
  SECRET_CAPABLE_TYPES,
  secretCapableBuiltins,
  specialDispositionNames,
  SWAMP_FUNCTION_SIGNATURES,
  SWAMP_NAMESPACE_TYPES,
  SWAMP_OPERATOR_SIGNATURES,
} from "../src/infrastructure/cel/cel_js_pins/cel_js_secret_refusal_inventory.ts";

const CEL_EVALUATOR = join(ROOT, "src/infrastructure/cel/cel_evaluator.ts");

/**
 * The string literals passed as the first argument of `method(` calls in
 * `source`. A literal elsewhere, in a comment or a doc string, does not
 * match: the call paren and the opening quote must be adjacent apart from
 * whitespace.
 */
function registeredLiterals(source: string, method: string): string[] {
  const calls = source.matchAll(new RegExp(`${method}\\(\\s*"([^"]+)"`, "g"));
  return [...new Set([...calls].map((call) => call[1]))].sort();
}

/** The signatures the query view registers from its constants. */
function queryViewSignatures(): string[] {
  return [
    `${LATEST_RUN_FUNCTION}(string): dyn`,
    ...[...MODEL_FUNCTIONS].map((fn) => `${fn}(string): bool`),
  ];
}

Deno.test("SWAMP_FUNCTION_SIGNATURES equals what the internal environment and the query view register", async () => {
  const source = await Deno.readTextFile(CEL_EVALUATOR);
  const registered = [
    ...registeredLiterals(source, "registerFunction"),
    LITERAL_FUNCTION_SIGNATURE,
    ...queryViewSignatures(),
  ].sort();
  assertEquals(
    registered,
    [...SWAMP_FUNCTION_SIGNATURES].sort(),
    "Every function swamp registers must be in SWAMP_FUNCTION_SIGNATURES, " +
      "and every listed signature must be registered. A new registration " +
      "needs a disposition for each string, dyn or list parameter.",
  );
});

Deno.test("SWAMP_OPERATOR_SIGNATURES equals the operators the internal environment registers", async () => {
  const source = await Deno.readTextFile(CEL_EVALUATOR);
  assertEquals(
    registeredLiterals(source, "registerOperator"),
    [...SWAMP_OPERATOR_SIGNATURES].sort(),
  );
  for (const signature of SWAMP_OPERATOR_SIGNATURES) {
    for (const type of SECRET_CAPABLE_TYPES) {
      assertEquals(
        signature.includes(type),
        false,
        `${signature} has a secret-capable operand and needs a refusal`,
      );
    }
  }
});

Deno.test("SWAMP_NAMESPACE_TYPES equals the receiver types the internal environment registers", async () => {
  const source = await Deno.readTextFile(CEL_EVALUATOR);
  assertEquals(
    registeredLiterals(source, "registerType"),
    [...SWAMP_NAMESPACE_TYPES].sort(),
  );
});

Deno.test("every secret-capable position of a cel-js built-in and of a swamp registration has a disposition", () => {
  const builtins = secretCapableBuiltins(createExtensionCelEnvironment()).map(
    (fn) => fn.signature,
  );
  assertEquals(builtins.length, 49);
  const counts: Record<Disposition, number> = {
    refusal: 0,
    "named-delivery": 0,
    "argument-walk": 0,
    container: 0,
    "type-name": 0,
  };
  const classify = (signatures: string[], origin: "cel-js" | "swamp") => {
    for (const signature of signatures) {
      // Throws on an unclassified position, naming it.
      for (const position of classifyPositions(signature, origin)) {
        counts[position.disposition]++;
      }
    }
  };
  classify(builtins, "cel-js");
  classify([...SWAMP_FUNCTION_SIGNATURES], "swamp");
  assertEquals(counts, {
    refusal: 75,
    "named-delivery": 3,
    "argument-walk": 3,
    container: 11,
    "type-name": 1,
  });
  assertEquals(functionRefusalSignatures(builtins, "cel-js").length, 56);
  assertEquals(
    functionRefusalSignatures([...SWAMP_FUNCTION_SIGNATURES], "swamp").length,
    41,
  );
});

Deno.test("every special disposition names a function that exists", () => {
  const names = new Set<string>();
  for (const fn of createExtensionCelEnvironment().getDefinitions().functions) {
    names.add(qualifiedName(parseSignature(fn.signature)));
  }
  for (const signature of SWAMP_FUNCTION_SIGNATURES) {
    names.add(qualifiedName(parseSignature(signature)));
  }
  const missing = specialDispositionNames().filter((name) => !names.has(name));
  assertEquals(
    missing,
    [],
    "A special disposition names a function neither cel-js nor swamp " +
      "registers; delete it or fix the name.",
  );
});

Deno.test("registeredLiterals ignores a signature that appears outside a call", () => {
  const stub = [
    '// registerFunction "CelDataNamespace.notReal(string): dyn" in a comment',
    "    this.env.registerFunction(",
    '      "CelDataNamespace.latest(string, string): dyn",',
    "      () => {},",
    "    );",
    '    env.registerOperator("double + int", () => 1);',
  ].join("\n");
  assertEquals(registeredLiterals(stub, "registerFunction"), [
    "CelDataNamespace.latest(string, string): dyn",
  ]);
  assertEquals(registeredLiterals(stub, "registerOperator"), ["double + int"]);
});
