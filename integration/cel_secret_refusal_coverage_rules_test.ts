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
// every function swamp registers, that its equality type list names every
// type cel-js uses in its own definitions, and that its maintained list of
// swamp's registrations equals what the source registers. It does not prove
// that the production environments register the refusals: Phase 3 adds that
// half, by checking that getDefinitions() on the real internal environment
// and the query view contains every refusal signature the inventory yields.
//
// Two sources, deliberately, as in expression_accessors_rules_test.ts:
//
//   - The cel-js built-ins and type names come from the library itself, so a
//     dependency bump that adds a function or a type reaches the classifier
//     and fails until it has a disposition.
//   - swamp's registrations come from the source text of the files that
//     register them, matched only inside a registerFunction(,
//     registerOperator( or registerType( call on a line that is not a
//     comment. A string literal, a template literal built from the exported
//     constants, and a bare constant are all read; any other form fails the
//     test. The set of registering files is itself pinned against a walk of
//     src/, so a registration in a fourth file cannot hide either.
//
// Every assertion is set equality, never containment, so an extraction that
// matches nothing fails loudly instead of passing vacuously.

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  ROOT,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";
import {
  LATEST_RUN_FUNCTION,
  MODEL_FUNCTIONS,
} from "../src/domain/data/query_predicate.ts";
import { LITERAL_FUNCTION_SIGNATURE } from "../src/domain/expressions/cel_grammar.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  classifyPositions,
  type Disposition,
  equalityTypes,
  functionRefusalSignatures,
  isSecretCapableType,
  parseSignature,
  qualifiedName,
  secretCapableBuiltins,
  specialDispositionNames,
  SWAMP_FUNCTION_SIGNATURES,
  SWAMP_NAMESPACE_TYPES,
  SWAMP_OPERATOR_SIGNATURES,
  typeNamesInDefinitions,
} from "../src/infrastructure/cel/cel_js_pins/cel_js_secret_refusal_inventory.ts";

/** What a `${name}` placeholder or a bare constant stands for, per file. */
type Bindings = ReadonlyMap<string, readonly string[]>;

/**
 * The production files that register CEL functions, operators or types, each
 * with the placeholders and constants its registrations may use. `fn` is the
 * loop variable data_query_service.ts registers the model functions with; a
 * `${fn}` in another file is unknown there and fails the test.
 */
const REGISTERING_FILES: ReadonlyMap<string, Bindings> = new Map([
  [
    "src/domain/data/data_query_service.ts",
    new Map([
      ["LATEST_RUN_FUNCTION", [LATEST_RUN_FUNCTION]],
      ["fn", [...MODEL_FUNCTIONS]],
    ]),
  ],
  [
    "src/domain/expressions/cel_grammar.ts",
    new Map([["LITERAL_FUNCTION_SIGNATURE", [LITERAL_FUNCTION_SIGNATURE]]]),
  ],
  [
    "src/infrastructure/cel/cel_evaluator.ts",
    new Map([["LITERAL_FUNCTION_SIGNATURE", [LITERAL_FUNCTION_SIGNATURE]]]),
  ],
]);

const METHODS = ["registerFunction", "registerOperator", "registerType"];
const REGISTRATION = new RegExp(`\\b(?:${METHODS.join("|")})\\(`);

/** `source` without its comment lines, so a commented-out call is not read. */
function withoutCommentLines(source: string): string {
  return source.split("\n").filter((line) => !isCommentLine(line)).join("\n");
}

/** Expand every `${name}` in a template through `bindings`, one per combination. */
function expandTemplate(template: string, bindings: Bindings): string[] {
  const match = /\$\{(\w+)\}/.exec(template);
  if (match === null) return [template];
  const values = bindings.get(match[1]);
  if (values === undefined) {
    throw new Error(`Unknown placeholder in a registration: ${match[0]}`);
  }
  return values.flatMap((value) =>
    expandTemplate(template.replace(match[0], value), bindings)
  );
}

/**
 * The first argument of every `method(` call in `source`: a string literal,
 * a template literal expanded through `bindings`, or a bare constant looked
 * up there. Comment lines are dropped first. Every call is matched, and an
 * argument in any other form (a single-quoted string, a call, an expression)
 * throws, so a registration cannot hide.
 */
function registeredSignatures(
  source: string,
  method: string,
  bindings: Bindings,
): string[] {
  const text = withoutCommentLines(source);
  const out = new Set<string>();
  for (const call of text.matchAll(new RegExp(`\\b${method}\\(`, "g"))) {
    const rest = text.slice(call.index);
    const argument = new RegExp(
      `^${method}\\(\\s*(?:"([^"]+)"|\`([^\`]+)\`|([A-Za-z_][A-Za-z0-9_]*)\\s*[,)])`,
    ).exec(rest);
    if (argument === null) {
      throw new Error(
        `Unreadable registration argument: ${rest.slice(0, 40)}... ` +
          "(use a double-quoted literal, a template over the exported " +
          "constants, or a bare constant)",
      );
    }
    const [, literal, template, constant] = argument;
    if (literal !== undefined) out.add(literal);
    else if (template !== undefined) {
      for (const expanded of expandTemplate(template, bindings)) {
        out.add(expanded);
      }
    } else {
      const values = bindings.get(constant);
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
  for (const [path, bindings] of REGISTERING_FILES) {
    const source = await Deno.readTextFile(join(ROOT, path));
    for (const signature of registeredSignatures(source, method, bindings)) {
      out.add(signature);
    }
  }
  return [...out].sort();
}

Deno.test("REGISTERING_FILES equals the production files under src/ that register with cel-js", async () => {
  const found: string[] = [];
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(file);
    // Test helpers register on test environments; nothing else is skipped,
    // so the refusal inventory itself would be caught if it ever registered.
    if (rel.endsWith("_test_helpers.ts")) continue;
    const source = withoutCommentLines(await Deno.readTextFile(file));
    if (REGISTRATION.test(source)) found.push(rel);
  }
  assertEquals(
    found.sort(),
    [...REGISTERING_FILES.keys()].sort(),
    "A production file registers with cel-js but is not scanned. Add it to " +
      "REGISTERING_FILES and give each of its secret-capable positions a " +
      "disposition in the inventory.",
  );
});

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
    const operands = signature.split(/ [^ ]+ /);
    assertEquals(
      operands.some(isSecretCapableType),
      false,
      `${signature} has a secret-capable operand and needs a refusal`,
    );
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
  assertEquals(builtins.length, 57);
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
    "named-delivery": 6,
    "argument-walk": 3,
    container: 16,
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

Deno.test("EQUALITY_TYPES equals the type names cel-js uses in its own definitions", () => {
  assertEquals(
    typeNamesInDefinitions(createExtensionCelEnvironment()),
    [...equalityTypes([])].filter((t) => t !== "Secret").sort(),
    "A type cel-js names in a definition has no Secret == T refusal, or a " +
      "listed type is gone. Decide it in EQUALITY_TYPES.",
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

const STUB_BINDINGS: Bindings = new Map([
  ["fn", [...MODEL_FUNCTIONS]],
  ["LITERAL_FUNCTION_SIGNATURE", [LITERAL_FUNCTION_SIGNATURE]],
]);

Deno.test("registeredSignatures reads literals, templates and constants, and ignores a comment line", () => {
  const stub = [
    '// registerFunction "CelDataNamespace.notReal(string): dyn" in a comment',
    '// env.registerFunction("CelDataNamespace.commentedOut(string): dyn", f);',
    "    this.env.registerFunction(",
    '      "CelDataNamespace.latest(string, string): dyn",',
    "      () => {},",
    "    );",
    "    env.registerFunction(`${fn}(string): bool`, matchesModel);",
    "    env.registerFunction(LITERAL_FUNCTION_SIGNATURE, literal);",
    '    env.registerOperator("double + int", () => 1);',
  ].join("\n");
  assertEquals(
    registeredSignatures(stub, "registerFunction", STUB_BINDINGS),
    [
      "CelDataNamespace.latest(string, string): dyn",
      ...[...MODEL_FUNCTIONS].map((fn) => `${fn}(string): bool`),
      LITERAL_FUNCTION_SIGNATURE,
    ].sort(),
  );
  assertEquals(
    registeredSignatures(stub, "registerOperator", STUB_BINDINGS),
    ["double + int"],
  );
  assertThrows(
    () => registeredSignatures(stub, "registerFunction", new Map()),
    Error,
    "Unknown placeholder in a registration: ${fn}",
  );
});

Deno.test("registeredSignatures fails on a form it cannot read", () => {
  const read = (source: string) =>
    registeredSignatures(source, "registerFunction", STUB_BINDINGS);
  assertThrows(
    () => read("env.registerFunction(buildSignature(), f);"),
    Error,
    "Unreadable registration argument: registerFunction(buildSignature()",
  );
  assertThrows(
    () => read("env.registerFunction('single(string): dyn', f);"),
    Error,
    "Unreadable registration argument: registerFunction('single",
  );
  assertThrows(
    () => read("env.registerFunction(UNKNOWN_CONSTANT, f);"),
    Error,
    "Unknown constant in a registration: UNKNOWN_CONSTANT",
  );
});
