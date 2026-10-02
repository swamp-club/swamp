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
  return extractFieldEquality(ast, "modelName");
}

/**
 * Extracts a string literal from a top-level `name == "literal"` equality,
 * walking AND conjuncts only, exactly as {@link extractModelNameEquality}.
 * Data query follows rename forwards only for this form.
 */
export function extractNameEquality(ast: ASTNode): string | null {
  return extractFieldEquality(ast, "name");
}

function extractFieldEquality(ast: ASTNode, field: string): string | null {
  if (ast.op === "==") {
    const [left, right] = ast.args as [ASTNode, ASTNode];
    if (
      left.op === "id" && left.args === field &&
      right.op === "value" && typeof right.args === "string"
    ) {
      return right.args;
    }
    if (
      right.op === "id" && right.args === field &&
      left.op === "value" && typeof left.args === "string"
    ) {
      return left.args;
    }
    return null;
  }

  if (ast.op === "&&") {
    const [left, right] = ast.args as [ASTNode, ASTNode];
    return extractFieldEquality(left, field) ??
      extractFieldEquality(right, field);
  }

  return null;
}

/** Name of the query function that matches rows by model reference. */
export const MODEL_FUNCTION = "model";

/**
 * Most distinct model references one predicate may hold. Each is a
 * definition lookup, so a predicate cannot make the query do unbounded work.
 */
export const MAX_MODEL_REFERENCES = 32;

function isASTNode(value: unknown): value is ASTNode {
  return value !== null && typeof value === "object" && "op" in value;
}

/**
 * Returns the distinct arguments of every `model(...)` call in the AST, in
 * the order first seen. Each call must take exactly one string literal: the
 * references are resolved before evaluation, so a computed argument cannot
 * be supported. Throws UserError otherwise, or when the predicate holds more
 * than {@link MAX_MODEL_REFERENCES} distinct references.
 */
export function collectModelReferences(ast: ASTNode): string[] {
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isASTNode(value)) return;
    if (value.op === "call") {
      const [name, argNodes] = value.args as [string, ASTNode[]];
      if (name === MODEL_FUNCTION) {
        const arg = argNodes.length === 1 ? argNodes[0] : undefined;
        if (arg?.op !== "value" || typeof arg.args !== "string") {
          throw new UserError(
            `${MODEL_FUNCTION}() takes exactly one string literal: a model name or definition id, e.g. ${MODEL_FUNCTION}("my-model").`,
          );
        }
        references.add(arg.args);
      }
      visit(argNodes);
      return;
    }
    if (value.op === "rcall") {
      const [name] = value.args as [string, ASTNode, ASTNode[]];
      if (name === MODEL_FUNCTION) {
        throw new UserError(
          `${MODEL_FUNCTION}() is a function, not a method: write ${MODEL_FUNCTION}("my-model").`,
        );
      }
    }
    visit(value.args);
  };
  visit(ast);
  if (references.size > MAX_MODEL_REFERENCES) {
    throw new UserError(
      `A query predicate may reference at most ${MAX_MODEL_REFERENCES} models with ${MODEL_FUNCTION}(); this one references ${references.size}.`,
    );
  }
  return [...references];
}

/**
 * Extracts the argument of a top-level `model("literal")` conjunct, walking
 * AND conjuncts only, for SQL pushdown. Returns null when there is none.
 */
export function extractModelCall(ast: ASTNode): string | null {
  if (ast.op === "call") {
    const [name, argNodes] = ast.args as [string, ASTNode[]];
    const arg = argNodes[0];
    if (
      name === MODEL_FUNCTION && argNodes.length === 1 &&
      arg.op === "value" && typeof arg.args === "string"
    ) {
      return arg.args;
    }
    return null;
  }

  if (ast.op === "&&") {
    const [left, right] = ast.args as [ASTNode, ASTNode];
    return extractModelCall(left) ?? extractModelCall(right);
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
      } in query predicate.\nAvailable: ${available}\n` +
        `Functions: ${MODEL_FUNCTION}("<model name or definition id>")`,
    );
  }
}
