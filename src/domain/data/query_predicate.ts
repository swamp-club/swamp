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

import { UserError } from "../errors.ts";
import { celString } from "./data_query_command.ts";
import {
  BEHAVIOR_QUERY_FUNCTION,
  BEHAVIOR_QUERY_NAME_FIELD,
  MODEL_QUERY_FUNCTION,
  MODEL_QUERY_NAME_FIELD,
} from "../terminology/behavior_aliases.ts";

export const QUERY_FIELDS = new Set([
  "id",
  "name",
  "version",
  "isLatest",
  "createdAt",
  "attributes",
  "tags",
  "modelName",
  "behaviorName",
  "modelId",
  "modelType",
  "specName",
  "dataType",
  "contentType",
  "lifetime",
  "garbageCollection",
  "lifecycle",
  "ownerType",
  "streaming",
  "size",
  "content",
  "ownerRef",
  "workflowRunId",
  "workflowName",
  "jobName",
  "stepName",
  "source",
  "ns",
]);

/**
 * a caller that mentions either field opts into explicit version handling, so
 * the implicit isLatest == true is skipped
 */
export const HISTORY_OPT_IN_FIELDS = new Set(["version", "isLatest"]);

export const CEL_BUILTINS = new Set([
  "true",
  "false",
  "null",
  "has",
  "size",
  "int",
  "uint",
  "double",
  "string",
  "bool",
  "bytes",
  "type",
  "list",
  "map",
  "duration",
  "timestamp",
  "matches",
  "contains",
  "startsWith",
  "endsWith",
]);

export interface ASTNode {
  op: string;
  args: unknown;
}

export function collectRootIdentifiers(node: ASTNode): string[] {
  if (!node || typeof node !== "object" || !("op" in node)) return [];

  const { op, args } = node;

  if (op === "id") {
    return [args as string];
  }

  // Member access: only recurse into the receiver (args[0]), not the
  // field name (args[1] is a string, not an ASTNode)
  if (op === "." || op === ".?") {
    const arr = args as [ASTNode, string];
    return collectRootIdentifiers(arr[0]);
  }

  if (op === "[]" || op === "[?]") {
    const arr = args as [ASTNode, ASTNode];
    return [
      ...collectRootIdentifiers(arr[0]),
      ...collectRootIdentifiers(arr[1]),
    ];
  }

  if (op === "call") {
    const arr = args as [string, ASTNode[]];
    return arr[1].flatMap(collectRootIdentifiers);
  }

  if (op === "rcall") {
    const arr = args as [string, ASTNode, ASTNode[]];
    return [
      ...collectRootIdentifiers(arr[1]),
      ...arr[2].flatMap(collectRootIdentifiers),
    ];
  }

  if (op === "?:") {
    const arr = args as [ASTNode, ASTNode, ASTNode];
    return arr.flatMap(collectRootIdentifiers);
  }

  if (op === "!_" || op === "-_") {
    return collectRootIdentifiers(args as ASTNode);
  }

  if (op === "list") {
    return (args as ASTNode[]).flatMap(collectRootIdentifiers);
  }

  if (op === "map") {
    const entries = args as Array<[ASTNode, ASTNode]>;
    return entries.flatMap(([key, value]) => [
      ...collectRootIdentifiers(key),
      ...collectRootIdentifiers(value),
    ]);
  }

  if (op === "value") {
    return [];
  }

  if (Array.isArray(args)) {
    return (args as unknown[]).flatMap((a) => {
      if (a && typeof a === "object" && "op" in (a as ASTNode)) {
        return collectRootIdentifiers(a as ASTNode);
      }
      return [];
    });
  }

  return [];
}

export const LATEST_RUN_FUNCTION = "latestRun";

function childNodes(node: ASTNode): ASTNode[] {
  const { op, args } = node;
  switch (op) {
    case "id":
    case "value":
      return [];
    case ".":
    case ".?":
      return [(args as [ASTNode, string])[0]];
    case "call":
      return (args as [string, ASTNode[]])[1];
    case "rcall": {
      const [, receiver, callArgs] = args as [string, ASTNode, ASTNode[]];
      return [receiver, ...callArgs];
    }
    case "!_":
    case "-_":
      return [args as ASTNode];
    case "map":
      return (args as Array<[ASTNode, ASTNode]>).flat();
    default:
      if (!Array.isArray(args)) return [];
      return (args as unknown[]).filter((a): a is ASTNode =>
        !!a && typeof a === "object" && "op" in a
      );
  }
}

/**
 * each call must take exactly one non-empty string literal so the run resolves
 * once per query, not per row; anything else is a UserError
 */
export function collectLatestRunWorkflows(node: ASTNode): string[] {
  const workflows = new Set<string>();
  const visit = (n: ASTNode) => {
    if (!n || typeof n !== "object" || !("op" in n)) return;
    if (n.op === "rcall" && (n.args as [string])[0] === LATEST_RUN_FUNCTION) {
      throw new UserError(
        `${LATEST_RUN_FUNCTION}() takes the workflow as its argument: ` +
          `write ${LATEST_RUN_FUNCTION}("<workflow>")`,
      );
    }
    if (n.op === "call" && (n.args as [string])[0] === LATEST_RUN_FUNCTION) {
      const callArgs = (n.args as [string, ASTNode[]])[1];
      const [arg] = callArgs;
      if (
        callArgs.length !== 1 || arg.op !== "value" ||
        typeof arg.args !== "string" || arg.args === ""
      ) {
        throw new UserError(
          `${LATEST_RUN_FUNCTION}() takes one workflow name or id as a ` +
            `string literal, e.g. ${LATEST_RUN_FUNCTION}("deploy")`,
        );
      }
      workflows.add(arg.args);
      return;
    }
    for (const child of childNodes(n)) visit(child);
  };
  visit(node);
  return [...workflows];
}

/**
 * walks AND conjuncts but not OR branches, so the pushdown holds for every
 * matching row
 */
export function extractWorkflowRunIdLatestRun(ast: ASTNode): string | null {
  if (ast.op === "==") {
    const [left, right] = ast.args as [ASTNode, ASTNode];
    return latestRunEquality(left, right) ?? latestRunEquality(right, left);
  }

  if (ast.op === "&&") {
    const [left, right] = ast.args as [ASTNode, ASTNode];
    return extractWorkflowRunIdLatestRun(left) ??
      extractWorkflowRunIdLatestRun(right);
  }

  return null;
}

function latestRunEquality(field: ASTNode, call: ASTNode): string | null {
  if (field.op !== "id" || field.args !== "workflowRunId") return null;
  if (call.op !== "call") return null;
  const [name, callArgs] = call.args as [string, ASTNode[]];
  if (name !== LATEST_RUN_FUNCTION || callArgs.length !== 1) return null;
  const [arg] = callArgs;
  return arg.op === "value" && typeof arg.args === "string" ? arg.args : null;
}

export const MODEL_FUNCTION = MODEL_QUERY_FUNCTION;

export const BEHAVIOR_FUNCTION = BEHAVIOR_QUERY_FUNCTION;

export const MODEL_FUNCTIONS: ReadonlySet<string> = new Set([
  MODEL_FUNCTION,
  BEHAVIOR_FUNCTION,
]);

function modelFunctionNoun(fn: string): string {
  return fn === BEHAVIOR_FUNCTION ? "behavior" : "model";
}

export const MODEL_NAME_FIELDS: ReadonlySet<string> = new Set([
  MODEL_QUERY_NAME_FIELD,
  BEHAVIOR_QUERY_NAME_FIELD,
]);

/**
 * each model is a definition lookup, so a predicate cannot make the query do
 * unbounded work
 */
export const MAX_MODEL_REFERENCES = 32;

/**
 * one set so serve authorizes either spelling with the same resolver; each call
 * takes exactly one non-empty string literal so the model resolves once per
 * query
 */
export function collectModelReferences(node: ASTNode): string[] {
  const references = new Set<string>();
  const functions = new Set<string>();
  const visit = (n: ASTNode) => {
    if (!n || typeof n !== "object" || !("op" in n)) return;
    const fn = n.op === "call" || n.op === "rcall"
      ? (n.args as [string])[0]
      : undefined;
    if (n.op === "rcall" && fn !== undefined && MODEL_FUNCTIONS.has(fn)) {
      const noun = modelFunctionNoun(fn);
      throw new UserError(
        `${fn}() takes the ${noun} as its argument: ` +
          `write ${fn}("<${noun}>")`,
      );
    }
    if (n.op === "call" && fn !== undefined && MODEL_FUNCTIONS.has(fn)) {
      const callArgs = (n.args as [string, ASTNode[]])[1];
      const [arg] = callArgs;
      if (
        callArgs.length !== 1 || arg.op !== "value" ||
        typeof arg.args !== "string" || arg.args === ""
      ) {
        const noun = modelFunctionNoun(fn);
        throw new UserError(
          `${fn}() takes one ${noun} name or definition id as a ` +
            `string literal, e.g. ${fn}("my-${noun}")`,
        );
      }
      references.add(arg.args);
      functions.add(fn);
      return;
    }
    for (const child of childNodes(n)) visit(child);
  };
  visit(node);
  if (references.size > MAX_MODEL_REFERENCES) {
    const called = [...MODEL_FUNCTIONS].filter((fn) => functions.has(fn));
    const nouns = called.length === 1 && called[0] === BEHAVIOR_FUNCTION
      ? "behaviors"
      : "models";
    throw new UserError(
      `A query may name at most ${MAX_MODEL_REFERENCES} ${nouns} with ` +
        `${called.map((fn) => `${fn}()`).join(" and ")}; ` +
        `this one names ${references.size}.`,
    );
  }
  return [...references];
}

export function calledModelFunctions(node: ASTNode): string[] {
  const called = new Set<string>();
  const visit = (n: ASTNode) => {
    if (!n || typeof n !== "object" || !("op" in n)) return;
    if (n.op === "call" || n.op === "rcall") {
      const fn = (n.args as [string])[0];
      if (MODEL_FUNCTIONS.has(fn)) called.add(fn);
    }
    for (const child of childNodes(n)) visit(child);
  };
  visit(node);
  return [...MODEL_FUNCTIONS].filter((fn) => called.has(fn));
}

function modelCallOf(
  conjunct: ASTNode,
): { fn: string; reference: string } | null {
  if (conjunct.op !== "call") return null;
  const [name, callArgs] = conjunct.args as [string, ASTNode[]];
  if (!MODEL_FUNCTIONS.has(name) || callArgs.length !== 1) return null;
  const [arg] = callArgs;
  if (arg.op === "value" && typeof arg.args === "string") {
    return { fn: name, reference: arg.args };
  }
  return null;
}

export function extractModelCall(ast: ASTNode): string | null {
  for (const conjunct of topLevelConjuncts(ast)) {
    const call = modelCallOf(conjunct);
    if (call !== null) return call.reference;
  }
  return null;
}

export function referencesAttributes(node: ASTNode): boolean {
  return collectRootIdentifiers(node).includes("attributes");
}

export function referencesContent(node: ASTNode): boolean {
  return collectRootIdentifiers(node).includes("content");
}

export function selectReadsContent(node: ASTNode): boolean {
  const ids = collectRootIdentifiers(node);
  return ids.includes("content") || ids.includes("contentEncoding");
}

function equalityOperands(
  node: ASTNode,
): { field: string; value: unknown } | null {
  if (node.op !== "==") return null;
  const [left, right] = node.args as [ASTNode, ASTNode];
  if (left.op === "id" && right.op === "value") {
    return { field: left.args as string, value: right.args };
  }
  if (right.op === "id" && left.op === "value") {
    return { field: right.args as string, value: left.args };
  }
  return null;
}

/**
 * does not descend into OR branches or negations, so every conjunct returned
 * must hold for a row to match
 */
function topLevelConjuncts(ast: ASTNode): ASTNode[] {
  if (ast.op !== "&&") return [ast];
  const [left, right] = ast.args as [ASTNode, ASTNode];
  return [...topLevelConjuncts(left), ...topLevelConjuncts(right)];
}

export function extractStringEquality(
  ast: ASTNode,
  field: string,
): string | null {
  return extractAnyStringEquality(ast, new Set([field]));
}

function isTypeTagReference(node: ASTNode): boolean {
  if (node.op === "id") return node.args === "dataType";
  if (node.op !== "." && node.op !== "[]") return false;
  const [object, key] = node.args as [ASTNode, unknown];
  if (object?.op !== "id" || object.args !== "tags") return false;
  if (node.op === ".") return key === "type";
  const keyNode = key as ASTNode;
  return keyNode?.op === "value" && keyNode.args === "type";
}

/**
 * the data_type column holds the type tag or empty, so a non-empty literal
 * pushes down exactly
 */
export function extractTypeTagEquality(ast: ASTNode): string | null {
  for (const conjunct of topLevelConjuncts(ast)) {
    if (conjunct.op !== "==") continue;
    const [left, right] = conjunct.args as [ASTNode, ASTNode];
    for (const [field, value] of [[left, right], [right, left]]) {
      if (
        value.op === "value" && typeof value.args === "string" &&
        value.args !== "" && isTypeTagReference(field)
      ) {
        return value.args;
      }
    }
  }
  return null;
}

function extractAnyStringEquality(
  ast: ASTNode,
  fields: ReadonlySet<string>,
): string | null {
  for (const conjunct of topLevelConjuncts(ast)) {
    const eq = equalityOperands(conjunct);
    if (eq && fields.has(eq.field) && typeof eq.value === "string") {
      return eq.value;
    }
  }
  return null;
}

/**
 * whichever comes first, so respelling one as the other pushes down the same
 * literal
 */
export function extractModelNameEquality(ast: ASTNode): string | null {
  return extractAnyStringEquality(ast, MODEL_NAME_FIELDS);
}

/** keeps the fallback scoped as the original was (same model, run or step) */
const FALLBACK_STRING_FIELDS = new Set([
  "id",
  "modelName",
  "behaviorName",
  "modelId",
  "modelType",
  "dataType",
  "contentType",
  "lifetime",
  "lifecycle",
  "ownerType",
  "ownerRef",
  "workflowRunId",
  "workflowName",
  "jobName",
  "stepName",
  "source",
  "ns",
]);

export interface SpecNameFallback {
  specNamePredicate: string;
  namePredicate: string;
  droppedConjuncts: boolean;
}

/**
 * other conjuncts are dropped, so the result can match more than the original;
 * callers verify it before suggesting it and check namePredicate to tell
 * whether a dropped conjunct excluded the data
 */
export function buildSpecNameFallback(ast: ASTNode): SpecNameFallback | null {
  if (collectRootIdentifiers(ast).includes("specName")) return null;

  const kept: string[] = [];
  const specNameClauses: string[] = [];
  let nameEqualities = 0;
  let droppedConjuncts = false;
  for (const conjunct of topLevelConjuncts(ast)) {
    const eq = equalityOperands(conjunct);
    let clause: string | null = null;
    if (eq?.field === "name") {
      if (typeof eq.value !== "string") return null;
      nameEqualities++;
      kept.push(`name == ${celString(eq.value)}`);
      specNameClauses.push(`specName == ${celString(eq.value)}`);
      continue;
    } else if (
      eq && FALLBACK_STRING_FIELDS.has(eq.field) &&
      typeof eq.value === "string"
    ) {
      clause = `${eq.field} == ${celString(eq.value)}`;
    } else if (eq?.field === "version" && typeof eq.value === "bigint") {
      clause = `version == ${eq.value}`;
    } else {
      // a model literal scope is kept like a modelName equality so the hint
      // stays on that model; a behavior scope is kept as typed
      const call = modelCallOf(conjunct);
      if (call !== null) {
        clause = `${call.fn}(${celString(call.reference)})`;
      }
    }
    if (clause === null) {
      droppedConjuncts = true;
    } else {
      kept.push(clause);
      specNameClauses.push(clause);
    }
  }
  if (nameEqualities !== 1) return null;
  return {
    specNamePredicate: specNameClauses.join(" && "),
    namePredicate: kept.join(" && "),
    droppedConjuncts,
  };
}

export function validateFieldReferences(identifiers: string[]): void {
  const unknown = identifiers.filter(
    (id) => !QUERY_FIELDS.has(id) && !CEL_BUILTINS.has(id),
  );
  if (unknown.length > 0) {
    const unique = [...new Set(unknown)];
    const available = [...QUERY_FIELDS].sort().join(", ");
    throw new UserError(
      `Unknown field${unique.length > 1 ? "s" : ""} ${
        unique.map((f) => `"${f}"`).join(", ")
      } in query predicate.\nAvailable: ${available}\n` +
        `Functions: ${LATEST_RUN_FUNCTION}("<workflow>"), ` +
        `${MODEL_FUNCTION}("<model name or definition id>"), ` +
        `${BEHAVIOR_FUNCTION}("<behavior name or definition id>")`,
    );
  }
}
