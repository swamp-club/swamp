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

// Architectural fitness test: DATA_NAMESPACE_ACCESSORS is the single list of
// accessors the CEL `data.*` namespace exposes, and it must not drift from the
// two places that actually define that namespace.
//
// This exists because drift already happened and went unnoticed for a long
// time. `query` and `findBySpec` joined the namespace, but the workflow-path
// validator kept its own hand-written alternation and silently rejected both
// in model global arguments. Nothing failed; the expressions were simply
// refused. A test is the only thing that catches that class of change, because
// neither surface below exists at runtime in a form a type could check.
//
// Two surfaces, deliberately, because each catches drift the other cannot:
//
//   - The cel-js registrations decide what an expression can actually CALL.
//     A function absent here is uncallable no matter what is declared.
//   - The `DataNamespace` interface declares the contract implementations
//     satisfy. A function absent here is untyped no matter what is registered.
//
// Both assertions are set equality, never subset containment. That is the
// whole defence against a vacuous pass: the empty set is contained in
// anything, so a containment assertion would survive an extraction that
// silently matched nothing after a reformat. Equality fails loudly instead,
// which is also why no raw match count is pinned here — counts would couple
// this test to arities, and arities are deliberately not pinned. Names are.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";
import { DATA_NAMESPACE_ACCESSORS } from "../src/domain/expressions/expression_parser.ts";

const CEL_EVALUATOR = join(ROOT, "src/infrastructure/cel/cel_evaluator.ts");
const MODEL_RESOLVER = join(ROOT, "src/domain/expressions/model_resolver.ts");

const expected = [...DATA_NAMESPACE_ACCESSORS].sort();

/**
 * Names registered with cel-js for the data namespace receiver.
 *
 * Matched only inside a `registerFunction(` argument, so a comment or a doc
 * string written in the shape of a qualified call cannot inject a name. The
 * same signature may be registered at several arities; this collapses them,
 * because the guard pins which accessors exist, not how many ways each is
 * callable.
 */
function registeredAccessors(source: string): string[] {
  const names = new Set<string>();
  const calls = source.matchAll(
    /registerFunction\(\s*"CelDataNamespace\.([a-zA-Z]+)\(/g,
  );
  for (const call of calls) names.add(call[1]);
  return [...names].sort();
}

/**
 * Method names declared on the `DataNamespace` interface.
 *
 * Optional members are excluded, and optionality is the rule rather than a
 * hardcoded skip: a member declared optional is by definition not part of the
 * contract every implementation satisfies. `invalidateLatest` is the current
 * one — a void-returning no-op that `buildDataNamespace` does not supply and
 * cel-js never registers, so no expression can call it.
 */
function declaredAccessors(source: string): string[] {
  const start = source.indexOf("export interface DataNamespace {");
  if (start === -1) throw new Error("DataNamespace interface not found");
  const body = source.slice(start, source.indexOf("\n}", start));
  const names = new Set<string>();
  for (const member of body.matchAll(/^ {2}([a-zA-Z]+)(\??)\(/gm)) {
    if (member[2] !== "?") names.add(member[1]);
  }
  return [...names].sort();
}

Deno.test("DATA_NAMESPACE_ACCESSORS matches the accessors registered with cel-js", async () => {
  const source = await Deno.readTextFile(CEL_EVALUATOR);
  assertEquals(
    registeredAccessors(source),
    expected,
    "Every accessor in DATA_NAMESPACE_ACCESSORS must be registered with " +
      "cel-js, and every registered accessor must be in the list. An " +
      "unregistered name cannot be called from an expression; an unlisted " +
      "registration will be rejected by the workflow-path validator.",
  );
});

Deno.test("DATA_NAMESPACE_ACCESSORS matches the DataNamespace interface", async () => {
  const source = await Deno.readTextFile(MODEL_RESOLVER);
  assertEquals(
    declaredAccessors(source),
    expected,
    "Every accessor in DATA_NAMESPACE_ACCESSORS must be a required member of " +
      "DataNamespace, and every required member must be in the list. Mark a " +
      "member optional only when no expression can call it.",
  );
});

Deno.test("declaredAccessors excludes optional members by rule, not by name", () => {
  const stub = [
    "export interface DataNamespace {",
    "  latest(a: string): Promise<string>;",
    "  somethingOptional?(a: string): void;",
    "}",
  ].join("\n");
  assertEquals(declaredAccessors(stub), ["latest"]);
});

Deno.test("registeredAccessors ignores names that appear outside a registration", () => {
  const stub = [
    "// CelDataNamespace.notReal(string): dyn  <- a comment, not a registration",
    "    this.env.registerFunction(",
    '      "CelDataNamespace.latest(string, string): dyn",',
    "      () => {},",
    "    );",
  ].join("\n");
  assertEquals(registeredAccessors(stub), ["latest"]);
});
