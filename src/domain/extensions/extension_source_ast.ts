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
 * a file that does not parse yields null, and each rule falls back to its own
 * text check
 */

import { parseExtensionModule } from "@swamp-club/extension-scoring/source";

export interface AstNode {
  type: string;
  [key: string]: unknown;
}

export interface Visit {
  node: AstNode;
  key: string;
  parent: Visit | null;
}

const GLOBAL_OBJECTS = new Set([
  "globalThis",
  "window",
  "self",
  "global",
  "frames",
  "parent",
  "top",
]);

export const MAX_CHAIN = 64;

const TYPE_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeParameters",
  "implements",
  "predicate",
]);

const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
]);

// every node not listed is walked, so an unknown node resolves toward flagging;
// TSQualifiedName is absent on purpose: `import e = a.b` is a runtime
// assignment
const TYPE_ONLY_NODES = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSDeclareFunction",
  "TSDeclareMethod",
  "TSIndexSignature",
  "TSPropertySignature",
  "TSMethodSignature",
  "TSTypeAnnotation",
  "TSTypeLiteral",
  "TSTypeQuery",
  "TSTypeReference",
  "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation",
  "TSInterfaceBody",
  "TSExpressionWithTypeArguments",
  "TSTypePredicate",
  "TSLiteralType",
  "TSIndexedAccessType",
]);

export const TS_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);

export function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null &&
    typeof (value as { type?: unknown }).type === "string";
}

function isTypeOnly(node: AstNode): boolean {
  if (TYPE_ONLY_NODES.has(node.type)) return true;
  return node.type.startsWith("TS") &&
    (node.type.endsWith("Type") || node.type.endsWith("Keyword"));
}

export function parseExtensionSource(
  source: string,
  options?: { path?: string },
): AstNode | null {
  return parseModule(source, options)?.program ?? null;
}

export interface SourceComment {
  type: string;
  value: string;
  start: number;
}

/**
 * also returns the parser's comments so a caller can tell a real comment from
 * comment-like text inside a string or template literal
 */
export function parseExtensionSourceWithComments(
  source: string,
  options?: { path?: string },
): { program: AstNode; comments: SourceComment[] } | null {
  const parsed = parseModule(source, options);
  if (!parsed) return null;
  const comments: SourceComment[] = [];
  for (const comment of parsed.comments) {
    if (typeof comment.start !== "number") continue;
    comments.push({
      type: comment.type,
      value: comment.value,
      start: comment.start,
    });
  }
  return { program: parsed.program, comments };
}

function parseModule(
  source: string,
  options?: { path?: string },
):
  | {
    program: AstNode;
    comments: Array<{
      type: string;
      value: string;
      start?: number | null;
    }>;
  }
  | null {
  const parsed = parseExtensionModule(source, { path: options?.path });
  if (!parsed.ok) return null;
  return {
    program: parsed.program as AstNode,
    comments: parsed.comments.map((comment) => ({
      type: String(comment.type),
      value: String(comment.value),
      start: comment.start,
    })),
  };
}

export function str(
  node: AstNode | undefined,
  key: string,
): string | undefined {
  const value = node?.[key];
  return typeof value === "string" ? value : undefined;
}

export function child(
  node: AstNode | undefined,
  key: string,
): AstNode | undefined {
  const value = node?.[key];
  return isNode(value) ? value : undefined;
}

export function isMember(node: AstNode | undefined): boolean {
  return node?.type === "MemberExpression" ||
    node?.type === "OptionalMemberExpression";
}

export function isCall(node: AstNode | undefined): boolean {
  return node?.type === "CallExpression" ||
    node?.type === "OptionalCallExpression";
}

export function memberName(member: AstNode | undefined): string | undefined {
  const property = child(member, "property");
  if (member?.computed === true) return literalKey(property);
  return property?.type === "Identifier" ? str(property, "name") : undefined;
}

export function literalKey(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "StringLiteral") return str(node, "value");
  if (node.type === "TemplateLiteral") {
    const expressions = node.expressions;
    const quasis = node.quasis;
    if (
      Array.isArray(expressions) && expressions.length === 0 &&
      Array.isArray(quasis) && quasis.length === 1 && isNode(quasis[0])
    ) {
      const value = quasis[0].value as { cooked?: string | null };
      return value.cooked ?? undefined;
    }
  }
  return undefined;
}

export function unwrap(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  for (let i = 0; i < MAX_CHAIN && current; i++) {
    if (!TS_WRAPPERS.has(current.type)) return current;
    current = child(current, "expression");
  }
  return current;
}

export function isGlobalName(name: string | undefined): boolean {
  return name !== undefined && GLOBAL_OBJECTS.has(name);
}

export function isGlobalObject(node: AstNode | undefined): boolean {
  let current = unwrap(node);
  for (let i = 0; i < MAX_CHAIN && current; i++) {
    if (current.type === "Identifier") {
      return GLOBAL_OBJECTS.has(str(current, "name") ?? "");
    }
    if (!isMember(current)) return false;
    const name = memberName(current);
    if (name === undefined || !GLOBAL_OBJECTS.has(name)) return false;
    current = unwrap(child(current, "object"));
  }
  return false;
}

export type Role =
  | "property"
  | "key"
  | "pattern-key"
  | "binding"
  | "label"
  | "reference";

export function identifierRole(visit: Visit): Role {
  const parent = visit.parent?.node;
  const key = visit.key;
  if (!parent) return "reference";
  // `#eval` is a private name, never the global.
  if (parent.type === "PrivateName") return "key";
  if (isMember(parent) && key === "property" && parent.computed !== true) {
    return "property";
  }
  if (
    key === "key" && parent.computed !== true &&
    [
      "ObjectProperty",
      "ObjectMethod",
      "ClassMethod",
      "ClassProperty",
      "ClassAccessorProperty",
      "TSEnumMember",
    ].includes(parent.type)
  ) {
    // A key in a destructuring pattern reads that property off the value.
    return visit.parent?.parent?.node.type === "ObjectPattern"
      ? "pattern-key"
      : "key";
  }
  if (
    key === "label" &&
    ["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(
      parent.type,
    )
  ) {
    return "label";
  }
  if (
    (parent.type === "ImportSpecifier" && key === "imported") ||
    (parent.type === "ExportSpecifier" && key === "exported")
  ) {
    return "key";
  }
  if (
    key === "id" &&
    [
      "VariableDeclarator",
      "FunctionDeclaration",
      "FunctionExpression",
      "ClassDeclaration",
      "ClassExpression",
    ].includes(parent.type)
  ) {
    return "binding";
  }
  if (
    key === "params" &&
    (parent.type.includes("Function") ||
      ["ObjectMethod", "ClassMethod", "ClassPrivateMethod"].includes(
        parent.type,
      ))
  ) {
    return "binding";
  }
  return "reference";
}

export function isTypeofOperand(visit: Visit): boolean {
  const parent = visit.parent?.node;
  return parent?.type === "UnaryExpression" && visit.key === "argument" &&
    str(parent, "operator") === "typeof";
}

/**
 * uses an explicit stack because extension pull runs it on untrusted archive
 * sources
 */
export function walkRuntimeNodes(
  program: AstNode,
  visit: (visit: Visit) => void,
): void {
  const stack: Visit[] = [{ node: program, key: "", parent: null }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const node = current.node;
    if (isTypeOnly(node)) continue;
    visit(current);
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key) || TYPE_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          const item = value[i];
          if (isNode(item)) stack.push({ node: item, key, parent: current });
        }
      } else if (isNode(value)) {
        stack.push({ node: value, key, parent: current });
      }
    }
  }
}

/**
 * lines break on \n alone, as in the analyzer, other line checks and acceptance
 * parser, so a file with other terminators cannot move a finding or
 * comment-site barrier off its line
 */
export class LineIndex {
  private readonly newlines: number[] = [];

  constructor(source: string) {
    for (
      let i = source.indexOf("\n");
      i >= 0;
      i = source.indexOf("\n", i + 1)
    ) {
      this.newlines.push(i);
    }
  }

  position(offset: number): { line: number; column: number } {
    let low = 0;
    let high = this.newlines.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.newlines[mid] < offset) low = mid + 1;
      else high = mid;
    }
    const lineStart = low === 0 ? 0 : this.newlines[low - 1] + 1;
    return { line: low + 1, column: offset - lineStart + 1 };
  }
}
