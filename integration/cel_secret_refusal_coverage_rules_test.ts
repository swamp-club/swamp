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
//   - swamp's registrations come from the source text of the three files
//     that register them, matched only inside a registerFunction(,
//     registerOperator( or registerType( call. A string literal, a template
//     literal built from the exported constants, and a bare constant are all
//     read; any other form fails the test, so a registration cannot hide.
//
// Every assertion is set equality, never containment, so an extraction that
// matches nothing fails loudly instead of passing vacuously.

import { assertEquals, assertThrows } from "@std/assert";
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

const REGISTERING_FILES = [
  "src/infrastructure/cel/cel_evaluator.ts",
  "src/domain/expressions/cel_grammar.ts",
  "src/domain/data/data_query_service.ts",
].map((path) => join(ROOT, path));

/**
 * What a `${name}` placeholder or a bare constant in a registration stands
 * for. `fn` is the loop variable data_query_service.ts registers the model
 * functions with, so it expands to every member of MODEL_FUNCTIONS.
 */
const BINDINGS: ReadonlyMap<string, readonly string[]> = new Map([
  ["LATEST_RUN_FUNCTION", [LATEST_RUN_FUNCTION]],
  ["LITERAL_FUNCTION_SIGNATURE", [LITERAL_FUNCTION_SIGNATURE]],
  ["fn", [...MODEL_FUNCTIONS]],
]);

/** Expand every `${name}` in a template through BINDINGS, one per combination. */
function expandTemplate(template: string): string[] {
  const placeholder = /\$\{(\w+)\}/;
  const match = placeholder.exec(template);
  if (match === null) return [template];
  const values = BINDINGS.get(match[1]);
  if (values === undefined) {
    throw new Error(`Unknown placeholder in a registration: ${match[0]}`);
  }
  return values.flatMap((value) =>
    expandTemplate(template.replace(match[0], value))
  );
}

/**
 * The first argument of every `method(` call in `source`: a string literal,
 * a template literal expanded through BINDINGS, or a bare constant looked up
 * there. The call paren and the argument must be adjacent apart from
 * whitespace, so a signature quoted in a comment does not match, and an
 * argument in any other form throws, so a registration cannot hide.
 */
function registeredSignatures(source: string, method: string): string[] {
  const calls = source.matchAll(
    new RegExp(
      `${method}\\(\\s*(?:"([^"]+)"|\`([^\`]+)\`|([A-Za-z_][A-Za-z0-9_]*))`,
      "g",
    ),
  );
  const out = new Set<string>();
  for (const [, literal, template, constant] of calls) {
    if (literal !== undefined) out.add(literal);
    else if (template !== undefined) {
      for (const expanded of expandTemplate(template)) out.add(expanded);
    } else {
      const values = BINDINGS.get(constant);
      if (values === undefined) {
        throw new Error(`Unknown constant in a registration: ${constant}`);
      }
      for (const value of values) out.add(value);
    }
  }
  return [...out].sort();
}

/** The union of `method(` registrations across the registering files. */
async function registeredAcrossFiles(method: string): Promise<string[]> {
  const out = new Set<string>();
  for (const path of REGISTERING_FILES) {
    const source = await Deno.readTextFile(path);
    for (const signature of registeredSignatures(source, method)) {
      out.add(signature);
    }
  }
  return [...out].sort();
}

Deno.test("SWAMP_FUNCTION_SIGNATURES equals what the internal environment and the query view register", async () => {
  assertEquals(
    await registeredAcrossFiles("registerFunction"),
    [...SWAMP_FUNCTION_SIGNATURES].sort(),
    "Every function swamp registers must be in SWAMP_FUNCTION_SIGNATURES, " +
      "and every listed signature must be registered. A new registration " +
      "needs a disposition for each string, dyn or list parameter.",
  );
});

Deno.test("SWAMP_OPERATOR_SIGNATURES equals the operators the internal environment registers", async () => {
  assertEquals(
    await registeredAcrossFiles("registerOperator"),
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
  assertEquals(
    await registeredAcrossFiles("registerType"),
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
  for (const signature of [...builtins, ...SWAMP_FUNCTION_SIGNATURES]) {
    // Throws on an unclassified position, naming it.
    for (const position of classifyPositions(signature)) {
      counts[position.disposition]++;
    }
  }
  assertEquals(counts, {
    refusal: 75,
    "named-delivery": 3,
    "argument-walk": 3,
    container: 11,
    "type-name": 1,
  });
  // Pins: when one changes, the failure prints the new number, and the
  // change is a decision to record in the inventory, not a number to copy.
  assertEquals(functionRefusalSignatures(builtins).length, 56);
  assertEquals(
    functionRefusalSignatures([...SWAMP_FUNCTION_SIGNATURES]).length,
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

Deno.test("registeredSignatures reads literals, templates and constants, and ignores a comment", () => {
  const stub = [
    '// registerFunction "CelDataNamespace.notReal(string): dyn" in a comment',
    "    this.env.registerFunction(",
    '      "CelDataNamespace.latest(string, string): dyn",',
    "      () => {},",
    "    );",
    "    env.registerFunction(`${fn}(string): bool`, matchesModel);",
    "    env.registerFunction(LITERAL_FUNCTION_SIGNATURE, literal);",
    '    env.registerOperator("double + int", () => 1);',
  ].join("\n");
  assertEquals(
    registeredSignatures(stub, "registerFunction"),
    [
      "CelDataNamespace.latest(string, string): dyn",
      ...[...MODEL_FUNCTIONS].map((fn) => `${fn}(string): bool`),
      LITERAL_FUNCTION_SIGNATURE,
    ].sort(),
  );
  assertEquals(registeredSignatures(stub, "registerOperator"), [
    "double + int",
  ]);
});

Deno.test("registeredSignatures fails on a form it cannot read", () => {
  assertThrows(
    () =>
      registeredSignatures(
        "env.registerFunction(buildSignature(), f);",
        "registerFunction",
      ),
    Error,
    "Unknown constant in a registration: buildSignature",
  );
  assertThrows(
    () =>
      registeredSignatures(
        "env.registerFunction(`${other}(string): dyn`, f);",
        "registerFunction",
      ),
    Error,
    "Unknown placeholder in a registration: ${other}",
  );
});
