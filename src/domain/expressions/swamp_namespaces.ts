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

import { type ASTNode, parse as parseCel } from "cel-js";
import { transformHyphenatedModelRefs } from "./expression_parser.ts";

/**
 * CEL macros whose first argument binds a local variable for the remaining
 * arguments. A variable bound this way shadows a root identifier.
 */
export const BINDING_MACROS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "all",
  "exists",
  "exists_one",
]);

/**
 * Root identifiers swamp binds when it evaluates CEL (the CEL-visible keys of
 * ExpressionContext).
 */
const SWAMP_ROOT_NAMESPACES: ReadonlySet<string> = new Set([
  "model",
  "self",
  "inputs",
  "workflow",
  "vault",
  "env",
  "data",
  "workers",
  "file",
  "workflowRunId",
  "run",
  "steps",
  "webhook",
]);

/**
 * Whether every free root identifier in a CEL expression is a swamp
 * namespace. `${{ github.sha }}` or `${{ matrix.os }}` is valid CEL written
 * for another templating system (a GitHub Actions file a shell model writes,
 * say); it fails to evaluate here only because swamp binds no such root, and
 * has always passed through to the method as literal text.
 *
 * Returns false when the expression cannot be parsed, so an expression swamp
 * cannot classify keeps that literal pass-through.
 */
export function referencesOnlySwampNamespaces(celExpression: string): boolean {
  let ast: ASTNode;
  try {
    ast = parseCel(transformHyphenatedModelRefs(celExpression)).ast;
  } catch {
    return false;
  }
  const roots = new Set<string>();
  collectFreeRoots(ast, new Set(), roots);
  for (const root of roots) {
    if (!SWAMP_ROOT_NAMESPACES.has(root)) return false;
  }
  return true;
}

function collectFreeRoots(
  node: ASTNode,
  bound: ReadonlySet<string>,
  out: Set<string>,
): void {
  switch (node.op) {
    case "value":
      return;
    case "id":
      if (!bound.has(node.args)) out.add(node.args);
      return;
    case ".":
    case ".?":
      collectFreeRoots(node.args[0], bound, out);
      return;
    case "!_":
    case "-_":
      collectFreeRoots(node.args, bound, out);
      return;
    case "list":
      for (const a of node.args) collectFreeRoots(a, bound, out);
      return;
    case "map":
      for (const [k, v] of node.args) {
        collectFreeRoots(k, bound, out);
        collectFreeRoots(v, bound, out);
      }
      return;
    case "call":
      for (const a of node.args[1]) collectFreeRoots(a, bound, out);
      return;
    case "rcall": {
      const [name, receiver, args] = node.args;
      const first = args[0];
      if (
        name === "bind" && receiver.op === "id" && receiver.args === "cel" &&
        args.length === 3 && first?.op === "id"
      ) {
        collectFreeRoots(args[1], bound, out);
        collectFreeRoots(args[2], new Set(bound).add(first.args), out);
        return;
      }
      collectFreeRoots(receiver, bound, out);
      if (BINDING_MACROS.has(name) && first?.op === "id") {
        const inner = new Set(bound).add(first.args);
        for (const a of args.slice(1)) collectFreeRoots(a, inner, out);
        return;
      }
      for (const a of args) collectFreeRoots(a, bound, out);
      return;
    }
    default:
      for (const a of node.args as ASTNode[]) collectFreeRoots(a, bound, out);
  }
}
