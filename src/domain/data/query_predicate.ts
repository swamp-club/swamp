// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  "createdAt",
  "attributes",
  "tags",
  "modelName",
  "modelType",
  "specName",
  "dataType",
  "contentType",
  "lifetime",
  "ownerType",
  "streaming",
  "size",
  "content",
]);

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
