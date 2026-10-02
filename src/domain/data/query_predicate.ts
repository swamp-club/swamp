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

/** Known root-level fields available in query predicates. */
export const QUERY_FIELDS = new Set([
  "id",
  "name",
  "version",
  "isLatest",
  "createdAt",
  "attributes",
  "tags",
  "modelName",
  "modelId",
  "modelType",
  "specName",
  "dataType",
  "contentType",
  "lifetime",
  "garbageCollection",
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
 * Fields whose presence in a predicate causes the query service to skip
 * the implicit `isLatest == true` injection. A caller that mentions either
 * field is opting into explicit version/latest handling.
 */
export const HISTORY_OPT_IN_FIELDS = new Set(["version", "isLatest"]);

/** CEL built-in identifiers that may appear as root `id` nodes. */
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

/** AST node from cel-js parse(). */
export interface ASTNode {
  op: string;
  args: unknown;
}

/**
 * Recursively collects root-level identifiers from a cel-js AST.
 *
 * Root identifiers are `{op: "id", args: "name"}` nodes that represent
 * top-level variable references (not member access names).
 */
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

  // Index access: recurse into both container and index
  if (op === "[]" || op === "[?]") {
    const arr = args as [ASTNode, ASTNode];
    return [
      ...collectRootIdentifiers(arr[0]),
      ...collectRootIdentifiers(arr[1]),
    ];
  }

  // Function call: args is [name, argNodes[]]
  if (op === "call") {
    const arr = args as [string, ASTNode[]];
    return arr[1].flatMap(collectRootIdentifiers);
  }

  // Receiver method call: args is [name, receiver, argNodes[]]
  if (op === "rcall") {
    const arr = args as [string, ASTNode, ASTNode[]];
    return [
      ...collectRootIdentifiers(arr[1]),
      ...arr[2].flatMap(collectRootIdentifiers),
    ];
  }

  // Ternary: args is [cond, trueExpr, falseExpr]
  if (op === "?:") {
    const arr = args as [ASTNode, ASTNode, ASTNode];
    return arr.flatMap(collectRootIdentifiers);
  }

  // Unary: args is a single ASTNode
  if (op === "!_" || op === "-_") {
    return collectRootIdentifiers(args as ASTNode);
  }

  // List literal: args is ASTNode[]
  if (op === "list") {
    return (args as ASTNode[]).flatMap(collectRootIdentifiers);
  }

  // Map literal: args is Array<[ASTNode, ASTNode]> (key-value tuples)
  if (op === "map") {
    const entries = args as Array<[ASTNode, ASTNode]>;
    return entries.flatMap(([key, value]) => [
      ...collectRootIdentifiers(key),
      ...collectRootIdentifiers(value),
    ]);
  }

  // Value literal: no identifiers
  if (op === "value") {
    return [];
  }

  // Binary operators and logical ops: args is [ASTNode, ASTNode]
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

/**
 * The query function that resolves a workflow's most recent run id, as
 * `swamp data get --workflow` does without `--run` (swamp-club#2957).
 */
export const LATEST_RUN_FUNCTION = "latestRun";

/** The AST nodes directly under `node`, in source order. */
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
 * Collects the distinct workflow arguments of every `latestRun(...)` call in
 * the AST. Each call must take exactly one non-empty string literal, so the
 * run can be resolved once per query rather than per row; anything else is
 * a UserError.
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
 * Extracts the workflow argument from a top-level
 * `workflowRunId == latestRun("<workflow>")` equality in the AST, for SQL
 * pushdown once the run is resolved. Walks through AND conjuncts but does
 * not descend into OR branches. Returns null if there is none.
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

/**
 * The query function that matches rows by model, resolving a model name or
 * definition id as `swamp data get <model>` does (swamp-club#2960).
 */
export const MODEL_FUNCTION = "model";

/**
 * Most distinct models one query may name with `model()`. Each is a
 * definition lookup, so a predicate cannot make the query do unbounded work.
 */
export const MAX_MODEL_REFERENCES = 32;

/**
 * Collects the distinct arguments of every `model(...)` call in the AST.
 * Each call must take exactly one non-empty string literal, so the model can
 * be resolved once per query rather than per row; anything else, or more
 * than {@link MAX_MODEL_REFERENCES} distinct models, is a UserError.
 */
export function collectModelReferences(node: ASTNode): string[] {
  const references = new Set<string>();
  const visit = (n: ASTNode) => {
    if (!n || typeof n !== "object" || !("op" in n)) return;
    if (n.op === "rcall" && (n.args as [string])[0] === MODEL_FUNCTION) {
      throw new UserError(
        `${MODEL_FUNCTION}() takes the model as its argument: ` +
          `write ${MODEL_FUNCTION}("<model>")`,
      );
    }
    if (n.op === "call" && (n.args as [string])[0] === MODEL_FUNCTION) {
      const callArgs = (n.args as [string, ASTNode[]])[1];
      const [arg] = callArgs;
      if (
        callArgs.length !== 1 || arg.op !== "value" ||
        typeof arg.args !== "string" || arg.args === ""
      ) {
        throw new UserError(
          `${MODEL_FUNCTION}() takes one model name or definition id as a ` +
            `string literal, e.g. ${MODEL_FUNCTION}("my-model")`,
        );
      }
      references.add(arg.args);
      return;
    }
    for (const child of childNodes(n)) visit(child);
  };
  visit(node);
  if (references.size > MAX_MODEL_REFERENCES) {
    throw new UserError(
      `A query may name at most ${MAX_MODEL_REFERENCES} models with ` +
        `${MODEL_FUNCTION}(); this one names ${references.size}.`,
    );
  }
  return [...references];
}

/**
 * Extracts the argument of a top-level `model("<model>")` conjunct, for SQL
 * pushdown once the model is resolved. Walks through AND conjuncts but does
 * not descend into OR branches. Returns null if there is none.
 */
export function extractModelCall(ast: ASTNode): string | null {
  for (const conjunct of topLevelConjuncts(ast)) {
    if (conjunct.op !== "call") continue;
    const [name, callArgs] = conjunct.args as [string, ASTNode[]];
    if (name !== MODEL_FUNCTION || callArgs.length !== 1) continue;
    const [arg] = callArgs;
    if (arg.op === "value" && typeof arg.args === "string") return arg.args;
  }
  return null;
}

/**
 * Checks whether the AST references the `attributes` identifier at root level.
 */
export function referencesAttributes(node: ASTNode): boolean {
  return collectRootIdentifiers(node).includes("attributes");
}

/**
 * Checks whether the AST references the `content` identifier at root level.
 */
export function referencesContent(node: ASTNode): boolean {
  return collectRootIdentifiers(node).includes("content");
}

/**
 * Checks whether a select expression reads an item's bytes: `content`, or
 * `contentEncoding`, which exists only in a projection and says how
 * `content` represents them.
 */
export function selectReadsContent(node: ASTNode): boolean {
  const ids = collectRootIdentifiers(node);
  return ids.includes("content") || ids.includes("contentEncoding");
}

/**
 * Reads a `field == literal` comparison, with the identifier on either side.
 * Returns null for any other node.
 */
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
 * Flattens the top-level AND conjuncts of a predicate. Does not descend
 * into OR branches or negations, so every conjunct returned must hold for
 * a row to match.
 */
function topLevelConjuncts(ast: ASTNode): ASTNode[] {
  if (ast.op !== "&&") return [ast];
  const [left, right] = ast.args as [ASTNode, ASTNode];
  return [...topLevelConjuncts(left), ...topLevelConjuncts(right)];
}

/**
 * Extracts a string literal from a top-level `field == "literal"` equality
 * in the AST. Walks through AND conjuncts but does not descend into OR
 * branches. Returns null if no pushdown-eligible equality is found.
 */
export function extractStringEquality(
  ast: ASTNode,
  field: string,
): string | null {
  for (const conjunct of topLevelConjuncts(ast)) {
    const eq = equalityOperands(conjunct);
    if (eq?.field === field && typeof eq.value === "string") return eq.value;
  }
  return null;
}

/**
 * Extracts a string literal from a top-level `modelName == "literal"`
 * equality in the AST. Returns null if no pushdown-eligible modelName
 * equality is found.
 */
export function extractModelNameEquality(ast: ASTNode): string | null {
  return extractStringEquality(ast, "modelName");
}

/**
 * String fields a spec-name fallback carries over from the original
 * predicate when they are compared to a string literal. Keeping them keeps
 * the fallback scoped as the original was (the same model, run or step).
 */
const FALLBACK_STRING_FIELDS = new Set([
  "id",
  "modelName",
  "modelId",
  "modelType",
  "dataType",
  "contentType",
  "lifetime",
  "ownerType",
  "ownerRef",
  "workflowRunId",
  "workflowName",
  "jobName",
  "stepName",
  "source",
  "ns",
]);

/**
 * The spec-name counterpart of a predicate that matches one data instance
 * name exactly, and the same scope matched by name.
 */
export interface SpecNameFallback {
  /** The kept conjuncts with `name == "x"` as `specName == "x"`. */
  specNamePredicate: string;
  /** The kept conjuncts as they were, `name == "x"` included. */
  namePredicate: string;
  /** Whether conjuncts that are not simple equalities were left out. */
  droppedConjuncts: boolean;
}

/**
 * Builds the spec-name counterpart of a predicate that matches one data
 * instance name exactly: the top-level `name == "x"` becomes
 * `specName == "x"`, and every other top-level equality of a string field
 * to a string literal, of `version` to an int literal, or a
 * `model("<literal>")` call, is kept. Other
 * conjuncts are dropped, so the result can match more than the original
 * would have; callers verify it matches before suggesting it, and check
 * `namePredicate` to tell whether a dropped conjunct, not the name, is what
 * excluded the data.
 *
 * Returns null when the predicate has no single top-level name equality,
 * or already mentions specName.
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
      // A model("<literal>") scope is kept like a modelName equality, so the
      // hint for the documented model() form stays on that model.
      const model = extractModelCall(conjunct);
      if (model !== null) clause = `${MODEL_FUNCTION}(${celString(model)})`;
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

/**
 * Validates that all root identifiers in the AST are known query fields
 * or CEL built-ins. Throws UserError on unknown fields.
 */
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
        `${MODEL_FUNCTION}("<model name or definition id>")`,
    );
  }
}
