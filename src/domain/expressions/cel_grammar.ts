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
 * depends only on cel-js and the string lexer so the expression scanner and the
 * namespace classifier can both use it without an import cycle
 */

import { type ASTNode, Environment } from "cel-js";
import {
  BINDING_MACROS,
  prepareVaultSource,
  rewriteHyphenatedModelRefs,
} from "./vault_call_syntax.ts";

export function transformHyphenatedModelRefs(expression: string): string {
  return rewriteHyphenatedModelRefs(expression).text;
}

/**
 * literal('...') returns its string unchanged so a value can mix a swamp
 * expression with another service's template text; declared here so evaluator
 * and type check register the same signature
 */
export const LITERAL_FUNCTION_SIGNATURE = "literal(string): string";

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
 * knows CEL's standard functions and literal, but not the namespace receivers
 * (data.latest, file.contents), so only expressions that read no root
 * identifier are checked with it
 */
const CONSTANT_CHECKER = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
});
CONSTANT_CHECKER.registerFunction(LITERAL_FUNCTION_SIGNATURE, literal);

/**
 * mixed int and double arithmetic, which the evaluator adds overloads for, does
 * not check here, so such a constant is conservatively reported
 */
export function typeChecksAsConstant(celExpression: string): boolean {
  try {
    return CONSTANT_CHECKER.check(transformHyphenatedModelRefs(celExpression))
      .valid;
  } catch {
    return false;
  }
}

function parseForEvaluation(celExpression: string): ASTNode | undefined {
  try {
    return EVALUATION_GRAMMAR.parse(prepareVaultSource(celExpression).text)
      .ast;
  } catch {
    return undefined;
  }
}

export function parsesAsCel(celExpression: string): boolean {
  return parseForEvaluation(celExpression) !== undefined;
}

export function freeRoots(celExpression: string): Set<string> | undefined {
  return expressionReferences(celExpression)?.roots;
}

export function expressionReferences(
  celExpression: string,
): References | undefined {
  const ast = parseForEvaluation(celExpression);
  if (ast === undefined) return undefined;
  const refs: References = {
    roots: new Set(),
    inputs: new Set(),
    opaqueInputs: false,
  };
  collectReferences(ast, new Set(), refs);
  return refs;
}

/** text that does not parse reads every input, so opaque is set */
export function inputNamesRead(
  celExpression: string,
): { names: Set<string>; opaque: boolean } {
  const ast = parseForEvaluation(celExpression);
  if (ast === undefined) return { names: new Set(), opaque: true };
  const refs: References = {
    roots: new Set(),
    inputs: new Set(),
    opaqueInputs: false,
    runInputs: { names: new Set(), opaque: false },
  };
  collectReferences(ast, new Set(), refs);
  return {
    names: new Set([...refs.inputs, ...refs.runInputs!.names]),
    opaque: refs.opaqueInputs || refs.runInputs!.opaque,
  };
}

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
 * escapes only what a single-quoted CEL string cannot hold: the quote, the
 * backslash and the line breaks; a }} in text sits inside the string, where the
 * scanner does not end an occurrence
 */
export function literalOccurrence(text: string): string {
  const quoted = text.replace(
    /[\\'\n\r]/g,
    (ch) => ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : `\\${ch}`,
  );
  return `\${{ literal('${quoted}') }}`;
}

/** a call whose argument is not a string constant produces no text of its own */
export function literalCallTexts(celExpression: string): string[] | undefined {
  const ast = parseForEvaluation(celExpression);
  if (ast === undefined) return undefined;
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null || !("op" in value)) {
      return;
    }
    const node = value as ASTNode;
    if (node.op === "value") return;
    if (
      node.op === "call" && node.args[0] === "literal" &&
      node.args[1].length === 1 && node.args[1][0].op === "value" &&
      typeof node.args[1][0].args === "string"
    ) {
      texts.push(node.args[1][0].args);
      return;
    }
    visit(node.args);
  };
  try {
    visit(ast);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  return texts;
}

/**
 * CEL macros whose first argument binds a local variable for the remaining
 * arguments. A variable bound this way shadows a root identifier.
 */
export { BINDING_MACROS } from "./vault_call_syntax.ts";

export interface References {
  roots: Set<string>;
  inputs: Set<string>;
  opaqueInputs: boolean;
  runInputs?: { names: Set<string>; opaque: boolean };
}

function isFreeInputs(node: ASTNode, bound: ReadonlySet<string>): boolean {
  return node.op === "id" && node.args === "inputs" && !bound.has("inputs");
}

function isFreeRun(node: ASTNode, bound: ReadonlySet<string>): boolean {
  return node.op === "id" && node.args === "run" && !bound.has("run");
}

function isRunInputs(node: ASTNode, bound: ReadonlySet<string>): boolean {
  return (node.op === "." || node.op === ".?") &&
    isFreeRun(node.args[0], bound) && node.args[1] === "inputs";
}

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
      if (node.args === "run" && out.runInputs) out.runInputs.opaque = true;
      return;
    case ".":
    case ".?":
      if (isFreeInputs(node.args[0], bound)) {
        out.roots.add("inputs");
        out.inputs.add(node.args[1]);
        return;
      }
      if (out.runInputs && isRunInputs(node.args[0], bound)) {
        out.roots.add("run");
        out.runInputs.names.add(node.args[1]);
        return;
      }
      if (out.runInputs && isFreeRun(node.args[0], bound)) {
        // `run.id` reads no input; `run.inputs` read whole reads them all.
        out.roots.add("run");
        if (node.args[1] === "inputs") out.runInputs.opaque = true;
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
      if (
        out.runInputs && isRunInputs(target, bound) && key.op === "value" &&
        typeof key.args === "string"
      ) {
        out.roots.add("run");
        out.runInputs.names.add(key.args);
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

export interface StaticAccess {
  root: string;
  segments: (string | number)[];
}

export function staticAccessPath(
  celExpression: string,
): StaticAccess | undefined {
  let node = parseForEvaluation(celExpression);
  const segments: (string | number)[] = [];
  while (node) {
    if (node.op === "id") {
      return { root: node.args as string, segments: segments.reverse() };
    }
    if (node.op === "." || node.op === ".?") {
      segments.push(node.args[1] as string);
      node = node.args[0] as ASTNode;
      continue;
    }
    if (node.op === "[]") {
      const [target, key] = node.args as [ASTNode, ASTNode];
      if (key.op !== "value") return undefined;
      if (typeof key.args === "string") segments.push(key.args);
      else if (typeof key.args === "bigint") segments.push(Number(key.args));
      else if (typeof key.args === "number") segments.push(key.args);
      else return undefined;
      node = target;
      continue;
    }
    return undefined;
  }
  return undefined;
}
