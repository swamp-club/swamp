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
 * Extracts a string literal from a top-level `modelName == "literal"`
 * equality in the AST. Walks through AND conjuncts but does not descend
 * into OR branches. Returns null if no pushdown-eligible modelName
 * equality is found.
 */
export function extractModelNameEquality(ast: ASTNode): string | null {
  if (ast.op === "==") {
    const [left, right] = ast.args as [ASTNode, ASTNode];
    if (
      left.op === "id" && left.args === "modelName" &&
      right.op === "value" && typeof right.args === "string"
    ) {
      return right.args;
    }
    if (
      right.op === "id" && right.args === "modelName" &&
      left.op === "value" && typeof left.args === "string"
    ) {
      return left.args;
    }
    return null;
  }

  if (ast.op === "&&") {
    const [left, right] = ast.args as [ASTNode, ASTNode];
    return extractModelNameEquality(left) ??
      extractModelNameEquality(right);
  }

  return null;
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
      } in query predicate.\nAvailable: ${available}`,
    );
  }
}
