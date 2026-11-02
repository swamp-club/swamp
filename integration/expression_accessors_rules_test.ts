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

// DATA_NAMESPACE_ACCESSORS must equal both the cel-js registrations (callable)
// and the DataNamespace interface (typed); set equality, never containment, so
// an extraction matching nothing fails loudly

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";
import { DATA_NAMESPACE_ACCESSORS } from "../src/domain/expressions/expression_parser.ts";
import {
  CLASSIFIED_DATA_ACCESSORS,
  CROSS_MODEL_DATA_ACCESSORS,
  MODEL_SCOPED_DATA_ACCESSORS,
} from "../src/domain/expressions/expression_references.ts";

const CEL_EVALUATOR = join(ROOT, "src/infrastructure/cel/cel_evaluator.ts");
const MODEL_RESOLVER = join(ROOT, "src/domain/expressions/model_resolver.ts");

const expected = [...DATA_NAMESPACE_ACCESSORS].sort();

/**
 * matched only inside a registerFunction( argument so a comment cannot inject a
 * name; arities collapse because the guard pins which accessors exist, not how
 * many ways each is callable
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
 * optional members are excluded: a member declared optional is not part of the
 * contract every implementation satisfies, like invalidateLatest, which cel-js
 * never registers
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

// the reference analyzer must classify every accessor as naming its model or
// reading across models; an unknown one is judged as reading any data, safe but
// should be classified on purpose
Deno.test("the expression reference analyzer classifies every data accessor exactly once", () => {
  assertEquals([...CLASSIFIED_DATA_ACCESSORS].sort(), expected);
  for (const name of MODEL_SCOPED_DATA_ACCESSORS) {
    assertEquals(CROSS_MODEL_DATA_ACCESSORS.has(name), false, name);
  }
});
