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

/**
 * What swamp knows about CEL's grammar: whether text parses the way
 * evaluation parses it, and which root identifiers a parsed expression reads.
 * It depends only on cel-js and the string lexer, so the expression scanner
 * and the namespace classifier can both use it without an import cycle.
 */

import { type ASTNode, Environment } from "cel-js";
import { lexSegments } from "./cel_string_lexer.ts";

/**
 * A model name with at least one hyphen, followed by a model accessor.
 *
 * The name is one `[a-zA-Z0-9_]+` run, a hyphen, then any mix of those
 * characters and hyphens. It matches exactly the names the older
 * `[a-zA-Z0-9_]+(?:-[a-zA-Z0-9_-]+)+` form matched, without that form's
 * nested quantifier over hyphens, which backtracks exponentially on a long
 * hyphenated name followed by a character that fails the match.
 */
const HYPHENATED_MODEL_REF =
  /model\.([a-zA-Z0-9_]+-[a-zA-Z0-9_-]+)\.(input|resource|file|execution|definition)/g;

/**
 * Transforms model references with hyphenated names to bracket notation.
 *
 * CEL interprets hyphens as subtraction operators, so `model.deploy-vpc.resource`
 * would be parsed as `(model.deploy) - (vpc.resource)`. This function transforms
 * hyphenated model names to bracket notation:
 *   model.deploy-vpc.resource → model["deploy-vpc"].resource
 *
 * Text inside string literals and comments is left alone, so a string such
 * as `literal('{{ model.my-app.resource.x }}')` reaches the method verbatim.
 *
 * @param expression - The CEL expression to transform
 * @returns The expression with hyphenated model names using bracket notation
 */
export function transformHyphenatedModelRefs(expression: string): string {
  if (!expression.includes("model.")) return expression;
  let out = "";
  for (const seg of lexSegments(expression)) {
    const text = expression.slice(seg.start, seg.end);
    out += seg.kind === "code"
      ? text.replace(HYPHENATED_MODEL_REF, 'model["$1"].$2')
      : text;
  }
  return out;
}

/**
 * The one function swamp adds to CEL: `literal('...')` returns its string
 * unchanged, so a value can mix a swamp expression with another service's
 * template text. Declared here so the evaluator and the type check below
 * register the same signature.
 */
export const LITERAL_FUNCTION_SIGNATURE = "literal(string): string";

/** The implementation of {@link LITERAL_FUNCTION_SIGNATURE}. */
export function literal(text: string): string {
  return text;
}

/**
 * The grammar evaluation parses. The top-level cel-js `parse` leaves optional
 * syntax (`.?`, `[?`) off, but the evaluator's environment enables it.
 */
const EVALUATION_GRAMMAR = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
});

/**
 * The evaluation grammar with swamp's own function registered, for type
 * checking. It knows CEL's standard functions and `literal`, but not the
 * namespace receivers (`data.latest`, `file.contents`), so only expressions
 * that read no root identifier are checked with it.
 */
const CONSTANT_CHECKER = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
});
CONSTANT_CHECKER.registerFunction(LITERAL_FUNCTION_SIGNATURE, literal);

/**
 * Whether an expression that reads no root identifier type-checks, so every
 * function it calls exists with those argument types: `literal('{{a}}')` does,
 * `now()` and `literal(123)` do not. Mixed int and double arithmetic, which
 * the evaluator adds overloads for, does not check here, so such a constant
 * is conservatively reported.
 */
export function typeChecksAsConstant(celExpression: string): boolean {
  try {
    return CONSTANT_CHECKER.check(transformHyphenatedModelRefs(celExpression))
      .valid;
  } catch {
    return false;
  }
}

/**
 * Parses text the way evaluation parses it: with optional syntax enabled,
 * and hyphenated model refs (`model.web-1a`) rewritten first. Returns
 * undefined when the text does not parse.
 */
function parseForEvaluation(celExpression: string): ASTNode | undefined {
  try {
    return EVALUATION_GRAMMAR.parse(transformHyphenatedModelRefs(celExpression))
      .ast;
  } catch {
    return undefined;
  }
}

/**
 * Whether text parses as CEL the way evaluation parses it: with optional
 * syntax enabled, and hyphenated model refs (`model.web-1a`) rewritten first.
 * Text that evaluates always parses here.
 */
export function parsesAsCel(celExpression: string): boolean {
  return parseForEvaluation(celExpression) !== undefined;
}

/**
 * The free root identifiers an expression reads, parsed the way evaluation
 * parses it, or undefined when the text does not parse. A constant such as
 * `literal('{{host.name}}')` or `'a' + 'b'` has none.
 */
export function freeRoots(celExpression: string): Set<string> | undefined {
  const ast = parseForEvaluation(celExpression);
  if (ast === undefined) return undefined;
  const refs: References = {
    roots: new Set(),
    inputs: new Set(),
    opaqueInputs: false,
  };
  collectReferences(ast, new Set(), refs);
  return refs.roots;
}

/**
 * Whether an expression is the empty string or null, written directly or
 * through `literal()`: a constant that carries no text at all.
 */
export function isBlankConstant(celExpression: string): boolean {
  let node = parseForEvaluation(celExpression);
  if (
    node?.op === "call" && node.args[0] === "literal" &&
    node.args[1].length === 1
  ) {
    node = node.args[1][0];
  }
  return node?.op === "value" && (node.args === "" || node.args === null);
}

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

/** What {@link collectReferences} finds in an expression. */
export interface References {
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

/**
 * Collects the free root identifiers a parsed expression reads, and which
 * inputs it names, honouring variables bound by macros and `cel.bind`.
 */
export function collectReferences(
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
