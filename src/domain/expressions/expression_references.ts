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
 * What an expression can read beyond its own model: other models' data and
 * definitions, and the process environment. Serve uses this to authorize
 * expression text against the principal who supplies it (swamp-club#2755,
 * swamp-club#2786), so the analysis fails closed: anything it cannot pin to
 * a named model reads "any data".
 *
 * The regex extractors in `dependency_extractor.ts` order evaluation and
 * deliberately skip what they cannot name; they are not a security boundary.
 * This walks the same AST evaluation parses, so bracket access, hyphenated
 * names and `cel.bind` aliases are seen as evaluation sees them. The walk is
 * linear in the parse evaluation already does, so analyzing caller text never
 * costs more than evaluating it.
 */

import { type ASTNode, Environment } from "cel-js";
import { BINDING_MACROS, transformHyphenatedModelRefs } from "./cel_grammar.ts";
import { extractExpressions } from "./expression_parser.ts";
import { scanExpressions } from "./expression_scanner.ts";

/**
 * Data accessors whose first argument names the model they read. The other
 * accessors (`query`, `findByTag`) read across models, so any call to them
 * reads any data.
 */
export const MODEL_SCOPED_DATA_ACCESSORS: ReadonlySet<string> = new Set([
  "latest",
  "version",
  "listVersions",
  "findBySpec",
]);

/**
 * Data accessors that read across models. With
 * {@link MODEL_SCOPED_DATA_ACCESSORS} this covers every entry of
 * `DATA_NAMESPACE_ACCESSORS`; `integration/expression_accessors_rules_test.ts`
 * fails when an accessor is added to the namespace without being classified.
 */
export const CROSS_MODEL_DATA_ACCESSORS: ReadonlySet<string> = new Set([
  "query",
  "findByTag",
]);

/** `model.<name>.<accessor>` entries that hold the model's data. */
const MODEL_DATA_ACCESSORS: ReadonlySet<string> = new Set([
  "resource",
  "file",
  "execution",
]);

/** `model.<name>.<accessor>` entries that hold only definition content. */
const MODEL_DEFINITION_ACCESSORS: ReadonlySet<string> = new Set([
  "input",
  "definition",
]);

/** What one expression reads beyond its own arguments. */
export interface ExpressionReferences {
  /**
   * Models whose data the expression reads, as written: a name, a definition
   * id, or `ns:name`.
   */
  readonly dataTargets: ReadonlySet<string>;
  /** Models whose definition content (`model.X.input`) the expression reads. */
  readonly modelTargets: ReadonlySet<string>;
  /**
   * The expression reads data it does not name statically: a computed model
   * argument, a cross-model accessor, the `model` map with a computed key or
   * whole, an unknown accessor, or text that does not parse.
   */
  readonly dataWide: boolean;
  /** The expression reads the process environment. */
  readonly usesEnv: boolean;
  /** The expression reads `self` or `inputs`, so its targets can follow them. */
  readonly readsSelfOrInputs: boolean;
  /**
   * Model methods the expression runs: `model.method("<model>", "<method>")`
   * in a workflow guard or assert executes the method, as a step does.
   */
  readonly runTargets: readonly { model: string; method: string }[];
  /** The expression runs a model method whose model or method is computed. */
  readonly runsComputed: boolean;
}

/** An expression found in content, with what it reads. */
export interface AnalyzedExpression {
  /** The raw `${{ ... }}` text, as `collectAuthoredExpressions` keys it. */
  readonly raw: string;
  readonly references: ExpressionReferences;
}

const GRAMMAR = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
});

interface Accumulator {
  dataTargets: Set<string>;
  modelTargets: Set<string>;
  dataWide: boolean;
  usesEnv: boolean;
  readsSelfOrInputs: boolean;
  runTargets: { model: string; method: string }[];
  runsComputed: boolean;
}

/** Analyzes one CEL expression (the text inside `${{ }}`). */
export function analyzeExpression(celExpression: string): ExpressionReferences {
  const acc: Accumulator = {
    dataTargets: new Set(),
    modelTargets: new Set(),
    dataWide: false,
    usesEnv: false,
    readsSelfOrInputs: false,
    runTargets: [],
    runsComputed: false,
  };
  let ast: ASTNode;
  try {
    ast = GRAMMAR.parse(transformHyphenatedModelRefs(celExpression)).ast;
  } catch {
    // Text that does not parse here is not evaluated as this parses it;
    // fail closed rather than guess what it reads.
    acc.dataWide = true;
    acc.runsComputed = true;
    return acc;
  }
  visit(ast, new Set(), acc);
  return acc;
}

/**
 * Analyzes every `${{ }}` expression in content, keyed by raw text as
 * `collectAuthoredExpressions` keys it. `extra` adds bare CEL that is
 * evaluated without `${{ }}` (a workflow assert's `task.expr`).
 */
export function analyzeContentExpressions(
  data: unknown,
  extra: Iterable<{ raw: string; celExpression: string }> = [],
): AnalyzedExpression[] {
  const seen = new Map<string, AnalyzedExpression>();
  const add = (raw: string, cel: string) => {
    if (!seen.has(raw)) {
      seen.set(raw, { raw, references: analyzeExpression(cel) });
    }
  };
  for (const expr of extractExpressions(data)) {
    add(expr.raw, expr.celExpression);
  }
  for (const expr of extra) add(expr.raw, expr.celExpression);
  return [...seen.values()];
}

/**
 * The expressions an edit must be authorized for: every expression whose raw
 * text the stored content does not already hold, and, when `retargeted` (the
 * edit changed a value that `self` or `inputs` reads), every stored
 * expression that reads data through `self` or `inputs`, since that value can
 * point it elsewhere (swamp-club#2755). An expression with a literal target is
 * never re-checked, so an edit to an unrelated field of a model that already
 * reads other data is unaffected.
 */
export function expressionsAddedByEdit(
  before: readonly AnalyzedExpression[],
  after: readonly AnalyzedExpression[],
  retargeted: boolean,
): AnalyzedExpression[] {
  const stored = new Set(before.map((e) => e.raw));
  return after.filter((e) =>
    !stored.has(e.raw) ||
    (retargeted && e.references.dataWide && e.references.readsSelfOrInputs)
  );
}

/** Whether an edit from `before` to `after` changes any non-expression value. */
export function plainContentChanged(before: unknown, after: unknown): boolean {
  return JSON.stringify(withoutExpressions(before)) !==
    JSON.stringify(withoutExpressions(after));
}

/** `data` with every `${{ }}` span removed from its strings, keys sorted. */
function withoutExpressions(data: unknown): unknown {
  if (typeof data === "string") {
    let out = "";
    let from = 0;
    for (const span of scanExpressions(data)) {
      out += data.slice(from, span.start);
      from = span.end;
    }
    return out + data.slice(from);
  }
  if (Array.isArray(data)) return data.map(withoutExpressions);
  if (data !== null && typeof data === "object") {
    // Keys sorted, so reordering a mapping is not a change of value.
    return Object.fromEntries(
      Object.entries(data)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, withoutExpressions(v)]),
    );
  }
  return data;
}

function isFree(node: ASTNode, name: string, bound: ReadonlySet<string>) {
  return node.op === "id" && node.args === name && !bound.has(name);
}

function stringLiteral(node: ASTNode | undefined): string | undefined {
  return node?.op === "value" && typeof node.args === "string" &&
      node.args !== ""
    ? node.args
    : undefined;
}

/** Records a model named by a data accessor or `file.contents`. */
function addDataTarget(node: ASTNode | undefined, acc: Accumulator): void {
  const name = stringLiteral(node);
  if (name === undefined) {
    acc.dataWide = true;
    return;
  }
  acc.dataTargets.add(name);
}

/**
 * Records a `model[<name>]` or `model.<name>` entry, given the accessor read
 * from it (undefined when the entry is used whole).
 */
function addModelEntry(
  name: string | undefined,
  accessor: string | undefined,
  acc: Accumulator,
): void {
  if (name === undefined) {
    acc.dataWide = true;
    return;
  }
  if (accessor !== undefined && MODEL_DEFINITION_ACCESSORS.has(accessor)) {
    acc.modelTargets.add(name);
    return;
  }
  // The data accessors, an unknown accessor and the entry used whole all
  // reach the model's data.
  if (accessor === undefined || !MODEL_DATA_ACCESSORS.has(accessor)) {
    acc.modelTargets.add(name);
  }
  acc.dataTargets.add(name);
}

/** The model entry `node` selects from the free `model` map, if it does. */
function modelEntry(
  node: ASTNode,
  bound: ReadonlySet<string>,
): { name: string | undefined; keyNode?: ASTNode } | undefined {
  if (node.op === "." || node.op === ".?") {
    const [target, field] = node.args as [ASTNode, string];
    if (isFree(target, "model", bound)) return { name: field };
  }
  if (node.op === "[]" || node.op === "[?]") {
    const [target, key] = node.args as [ASTNode, ASTNode];
    if (isFree(target, "model", bound)) {
      return { name: stringLiteral(key), keyNode: key };
    }
  }
  return undefined;
}

function visit(
  node: ASTNode,
  bound: ReadonlySet<string>,
  acc: Accumulator,
): void {
  if (!node || typeof node !== "object" || !("op" in node)) return;
  switch (node.op) {
    case "value":
      return;
    case "id": {
      const name = node.args as string;
      if (bound.has(name)) return;
      if (name === "env") acc.usesEnv = true;
      if (name === "self" || name === "inputs") acc.readsSelfOrInputs = true;
      // The data, model and file namespaces used anywhere other than as an
      // accessor receiver (bare, aliased with cel.bind, passed to a macro)
      // can reach any model.
      if (name === "data" || name === "model" || name === "file") {
        acc.dataWide = true;
      }
      return;
    }
    case ".":
    case ".?": {
      const [target, field] = node.args as [ASTNode, string];
      const entry = modelEntry(target, bound);
      if (entry) {
        addModelEntry(entry.name, field, acc);
        if (entry.keyNode) visit(entry.keyNode, bound, acc);
        return;
      }
      const own = modelEntry(node, bound);
      if (own) {
        addModelEntry(own.name, undefined, acc);
        return;
      }
      visit(target, bound, acc);
      return;
    }
    case "[]":
    case "[?]": {
      const [target, key] = node.args as [ASTNode, ASTNode];
      const entry = modelEntry(target, bound);
      if (entry) {
        addModelEntry(entry.name, stringLiteral(key), acc);
        if (entry.keyNode) visit(entry.keyNode, bound, acc);
        visit(key, bound, acc);
        return;
      }
      const own = modelEntry(node, bound);
      if (own) {
        addModelEntry(own.name, undefined, acc);
        visit(key, bound, acc);
        return;
      }
      visit(target, bound, acc);
      visit(key, bound, acc);
      return;
    }
    case "rcall": {
      const [name, receiver, args] = node.args as [string, ASTNode, ASTNode[]];
      if (isFree(receiver, "data", bound)) {
        if (MODEL_SCOPED_DATA_ACCESSORS.has(name)) {
          addDataTarget(args[0], acc);
        } else {
          // query, findByTag, and any accessor this module does not know.
          acc.dataWide = true;
        }
        for (const a of args) visit(a, bound, acc);
        return;
      }
      if (isFree(receiver, "file", bound)) {
        if (name === "contents") addDataTarget(args[0], acc);
        else acc.dataWide = true;
        for (const a of args) visit(a, bound, acc);
        return;
      }
      if (isFree(receiver, "model", bound)) {
        // model.method("<model>", "<method>", ...) in a workflow guard or
        // assert runs the method and returns its output.
        const model = stringLiteral(args[0]);
        const method = stringLiteral(args[1]);
        if (name === "method" && model !== undefined && method !== undefined) {
          acc.runTargets.push({ model, method });
          acc.dataTargets.add(model);
        } else {
          acc.runsComputed = true;
          acc.dataWide = true;
        }
        for (const a of args) visit(a, bound, acc);
        return;
      }
      const first = args[0];
      if (
        name === "bind" && isFree(receiver, "cel", bound) &&
        args.length === 3 && first?.op === "id"
      ) {
        visit(args[1], bound, acc);
        visit(args[2], new Set(bound).add(first.args as string), acc);
        return;
      }
      visit(receiver, bound, acc);
      if (BINDING_MACROS.has(name) && first?.op === "id") {
        const inner = new Set(bound).add(first.args as string);
        for (const a of args.slice(1)) visit(a, inner, acc);
        return;
      }
      for (const a of args) visit(a, bound, acc);
      return;
    }
    case "call":
      for (const a of (node.args as [string, ASTNode[]])[1]) {
        visit(a, bound, acc);
      }
      return;
    case "!_":
    case "-_":
      visit(node.args as ASTNode, bound, acc);
      return;
    case "map":
      for (const [k, v] of node.args as Array<[ASTNode, ASTNode]>) {
        visit(k, bound, acc);
        visit(v, bound, acc);
      }
      return;
    default: {
      const args = node.args as unknown;
      if (!Array.isArray(args)) return;
      for (const a of args) {
        if (a && typeof a === "object" && "op" in a) {
          visit(a as ASTNode, bound, acc);
        }
      }
    }
  }
}

/**
 * Every data accessor this module classifies. A fitness rule pins it against
 * `DATA_NAMESPACE_ACCESSORS`, so a new accessor cannot skip the check.
 */
export const CLASSIFIED_DATA_ACCESSORS: readonly string[] = [
  ...MODEL_SCOPED_DATA_ACCESSORS,
  ...CROSS_MODEL_DATA_ACCESSORS,
];
