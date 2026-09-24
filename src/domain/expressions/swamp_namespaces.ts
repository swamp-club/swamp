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

import { type ASTNode, Environment, parse as parseCel } from "cel-js";
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
 * The grammar evaluation parses. The top-level cel-js `parse` leaves optional
 * syntax (`.?`, `[?`) off, but the evaluator's environment enables it.
 */
const EVALUATION_GRAMMAR = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
});

/**
 * Whether text parses as CEL the way evaluation parses it: with optional
 * syntax enabled, and hyphenated model refs (`model.web-1a`) rewritten first.
 * Text that evaluates always parses here.
 */
export function parsesAsCel(celExpression: string): boolean {
  try {
    EVALUATION_GRAMMAR.parse(transformHyphenatedModelRefs(celExpression));
    return true;
  } catch {
    return false;
  }
}

/** What a swamp evaluation provides, to judge whether an expression is swamp's. */
export interface SwampScope {
  /** Whether this evaluation binds the root identifier. */
  isBound(root: string): boolean;
  /** Input names the definition declares in its `inputs` schema. */
  declaredInputs: ReadonlySet<string>;
}

/**
 * Whether a CEL expression that failed to evaluate was written for swamp.
 *
 * The `${{ ... }}` syntax is shared with other templating systems — a shell
 * model writing a GitHub Actions file carries `${{ github.sha }}`,
 * `${{ inputs.version }}` or `${{ steps.build.outputs.sha }}` — and that text
 * has always passed through to the method as literal text. It counts as
 * swamp's only when every free root identifier is a swamp namespace bound in
 * this evaluation, and every `inputs.X` names an input the definition
 * declares. A declared input with no value is swamp's; `inputs.version` in a
 * definition that declares no `version` is not.
 *
 * Returns false when the expression cannot be parsed, or reads `inputs` in a
 * way that names no single input, so anything swamp cannot attribute keeps
 * that literal pass-through.
 */
export function isSwampExpression(
  celExpression: string,
  scope: SwampScope,
): boolean {
  let ast: ASTNode;
  try {
    ast = parseCel(transformHyphenatedModelRefs(celExpression)).ast;
  } catch {
    return false;
  }
  const refs: References = {
    roots: new Set(),
    inputs: new Set(),
    opaqueInputs: false,
  };
  collectReferences(ast, new Set(), refs);
  for (const root of refs.roots) {
    if (!SWAMP_ROOT_NAMESPACES.has(root)) return false;
    if (root === "inputs") {
      if (refs.opaqueInputs) return false;
      for (const name of refs.inputs) {
        if (!scope.declaredInputs.has(name)) return false;
      }
    } else if (!scope.isBound(root)) {
      return false;
    }
  }
  return true;
}

interface References {
  /** Free root identifiers. */
  roots: Set<string>;
  /** Names read as `inputs.X` or `inputs["X"]`. */
  inputs: Set<string>;
  /** `inputs` read bare or with a computed key. */
  opaqueInputs: boolean;
}

function isFreeInputs(node: ASTNode, bound: ReadonlySet<string>): boolean {
  return node.op === "id" && node.args === "inputs" && !bound.has("inputs");
}

function collectReferences(
  node: ASTNode,
  bound: ReadonlySet<string>,
  out: References,
): void {
  switch (node.op) {
    case "value":
      return;
    case "id":
      if (bound.has(node.args)) return;
      out.roots.add(node.args);
      if (node.args === "inputs") out.opaqueInputs = true;
      return;
    case ".":
    case ".?":
      if (isFreeInputs(node.args[0], bound)) {
        out.roots.add("inputs");
        out.inputs.add(node.args[1]);
        return;
      }
      collectReferences(node.args[0], bound, out);
      return;
    case "[]": {
      const [target, key] = node.args as [ASTNode, ASTNode];
      if (
        isFreeInputs(target, bound) && key.op === "value" &&
        typeof key.args === "string"
      ) {
        out.roots.add("inputs");
        out.inputs.add(key.args);
        return;
      }
      collectReferences(target, bound, out);
      collectReferences(key, bound, out);
      return;
    }
    case "!_":
    case "-_":
      collectReferences(node.args, bound, out);
      return;
    case "list":
      for (const a of node.args) collectReferences(a, bound, out);
      return;
    case "map":
      for (const [k, v] of node.args) {
        collectReferences(k, bound, out);
        collectReferences(v, bound, out);
      }
      return;
    case "call":
      for (const a of node.args[1]) collectReferences(a, bound, out);
      return;
    case "rcall": {
      const [name, receiver, args] = node.args;
      const first = args[0];
      if (
        name === "bind" && receiver.op === "id" && receiver.args === "cel" &&
        args.length === 3 && first?.op === "id"
      ) {
        collectReferences(args[1], bound, out);
        collectReferences(args[2], new Set(bound).add(first.args), out);
        return;
      }
      collectReferences(receiver, bound, out);
      if (BINDING_MACROS.has(name) && first?.op === "id") {
        const inner = new Set(bound).add(first.args);
        for (const a of args.slice(1)) collectReferences(a, inner, out);
        return;
      }
      for (const a of args) collectReferences(a, bound, out);
      return;
    }
    default:
      for (const a of node.args as ASTNode[]) collectReferences(a, bound, out);
  }
}
