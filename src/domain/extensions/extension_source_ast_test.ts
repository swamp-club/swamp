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

import { assertEquals } from "@std/assert";
import {
  type AstNode,
  identifierRole,
  isGlobalObject,
  parseExtensionSource,
  type Visit,
  walkRuntimeNodes,
} from "./extension_source_ast.ts";

function identifiers(source: string): Array<[string, string]> {
  const program = parseExtensionSource(source);
  if (!program) throw new Error("did not parse");
  const found: Array<[string, string]> = [];
  walkRuntimeNodes(program, (visit) => {
    if (visit.node.type === "Identifier") {
      found.push([String(visit.node.name), identifierRole(visit)]);
    }
  });
  // Walk order is an implementation detail; compare as a sorted list.
  return found.sort((a, b) => `${a}`.localeCompare(`${b}`));
}

function expression(source: string): AstNode {
  const program = parseExtensionSource(source);
  const statement = (program?.body as AstNode[])[0];
  return statement.expression as AstNode;
}

Deno.test("parseExtensionSource: returns null for source that does not parse", () => {
  assertEquals(parseExtensionSource("const = ;"), null);
  assertEquals(parseExtensionSource("{{{"), null);
});

Deno.test("parseExtensionSource: parses TypeScript as a module", () => {
  const program = parseExtensionSource(
    'import x from "./x.ts";\nexport const y: number = x as number;\n',
  );
  assertEquals(program?.type, "Program");
});

Deno.test("walkRuntimeNodes: skips TypeScript types", () => {
  assertEquals(
    identifiers("let a: Deno.Command = b;").map(([name]) => name),
    ["a", "b"],
  );
  assertEquals(identifiers("type T = Deno.Command;"), []);
});

Deno.test("walkRuntimeNodes: visits each runtime node once with its parent and key", () => {
  const program = parseExtensionSource("f(x);")!;
  const seen: string[] = [];
  walkRuntimeNodes(program, (visit: Visit) => {
    seen.push(
      `${visit.parent?.node.type ?? "-"}.${visit.key}:${visit.node.type}`,
    );
  });
  assertEquals(seen.sort(), [
    "-.:Program",
    "CallExpression.arguments:Identifier",
    "CallExpression.callee:Identifier",
    "ExpressionStatement.expression:CallExpression",
    "Program.body:ExpressionStatement",
  ]);
});

Deno.test("identifierRole: tells properties, keys, bindings and references apart", () => {
  assertEquals(identifiers("a.b;"), [["a", "reference"], ["b", "property"]]);
  assertEquals(identifiers("const o = { k: v };"), [
    ["k", "key"],
    ["o", "binding"],
    ["v", "reference"],
  ]);
  assertEquals(identifiers("const { k: v } = o;"), [
    ["k", "pattern-key"],
    ["o", "reference"],
    ["v", "reference"],
  ]);
  assertEquals(identifiers("l: for (;;) break l;"), [
    ["l", "label"],
    ["l", "label"],
  ]);
});

Deno.test("isGlobalObject: global names, casts and chains of them", () => {
  assertEquals(isGlobalObject(expression("globalThis;")), true);
  assertEquals(isGlobalObject(expression("(self as any);")), true);
  assertEquals(isGlobalObject(expression("globalThis.window;")), true);
  assertEquals(isGlobalObject(expression('globalThis["self"];')), true);
  assertEquals(isGlobalObject(expression("config;")), false);
  assertEquals(isGlobalObject(expression("globalThis.config;")), false);
});
