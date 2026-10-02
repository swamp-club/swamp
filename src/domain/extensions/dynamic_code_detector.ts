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
 * Detects dynamic code execution — the global `eval`, the `Function`
 * constructor, and `.constructor(...)` calls — in TypeScript/JavaScript
 * source, for the extension safety gate.
 *
 * This is a hygiene gate, not a sandbox. The source is parsed with
 * `@babel/parser`, so comments, strings, template text and regex literals
 * never count, and the rules apply to syntax-tree nodes: an `eval` or
 * `Function` identifier is flagged unless its role is positively benign (a
 * property name on an ordinary object, a class member or object-literal key,
 * a TypeScript type). A file that does not parse falls back to the plain
 * text check (`eval(` or `new Function(`), so unparseable code is never
 * treated as safe. Aliases built at runtime (`globalThis["ev" + "al"]`)
 * cannot be caught statically.
 *
 * The tree walk uses an explicit stack, because `extension pull` runs this
 * on untrusted archive sources.
 */

import { parse, type ParserPlugin } from "@babel/parser";

/** The form of dynamic code execution a finding reports. */
export type DynamicCodeKind =
  | "eval-reference"
  | "eval-computed-access"
  | "function-constructor"
  | "constructor-call"
  | "global-object-alias"
  | "aliased-eval-member"
  | "unparsed-eval-text";

/** One occurrence of dynamic code execution, 1-based line and column. */
export interface DynamicCodeFinding {
  line: number;
  column: number;
  kind: DynamicCodeKind;
}

/** The parts of a Babel AST node this module reads. */
interface AstNode {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

/** A node on the walk stack, linked to its parent. */
interface Visit {
  node: AstNode;
  key: string;
  parent: Visit | null;
}

// Global objects whose `eval` member is the global `eval`.
const GLOBAL_OBJECTS = new Set([
  "globalThis",
  "window",
  "self",
  "global",
  "frames",
  "parent",
  "top",
]);

// Global objects whose use as a value can alias the global `eval`.
const VALUE_GLOBALS = new Set(["globalThis", "window", "self"]);

const CALL_FORMS = new Set(["call", "apply", "bind"]);
const COMPUTED_NAMES = new Set(["eval", "Function"]);
const MAX_CHAIN = 64;

// Keys that hold TypeScript types, which are erased at runtime.
const TYPE_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeParameters",
  "implements",
  "predicate",
]);

// Keys that never hold child nodes worth walking.
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

// TypeScript nodes with no runtime code. Every other node, including TS
// nodes not listed here, is walked, so an unknown node resolves toward
// flagging. TSQualifiedName is deliberately absent: `import e = a.b` is a
// runtime assignment, and inside types it sits under a skipped node anyway.
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

const TS_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);

const PLUGINS: ParserPlugin[] = [
  "typescript",
  "decorators-legacy",
  "explicitResourceManagement",
  "importAttributes",
];

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null &&
    typeof (value as { type?: unknown }).type === "string";
}

function isTypeOnly(node: AstNode): boolean {
  if (TYPE_ONLY_NODES.has(node.type)) return true;
  // The remaining type nodes: TSStringKeyword, TSUnionType, TSFunctionType
  // and so on. Runtime TS nodes are expressions or declarations.
  return node.type.startsWith("TS") &&
    (node.type.endsWith("Type") || node.type.endsWith("Keyword"));
}

function parseSource(source: string): AstNode | null {
  for (const sourceType of ["module", "script"] as const) {
    try {
      const file = parse(source, {
        sourceType,
        plugins: PLUGINS,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowUndeclaredExports: true,
        allowNewTargetOutsideFunction: true,
        allowSuperOutsideMethod: true,
        errorRecovery: false,
      });
      return file.program as unknown as AstNode;
    } catch {
      // Syntax errors, and stack overflow on extreme nesting, fall through
      // to the next source type and finally to the text check.
    }
  }
  return null;
}

/** The old text check, used when the source does not parse. */
function textFallback(source: string): DynamicCodeFinding[] {
  const findings: DynamicCodeFinding[] = [];
  let lineStart = 0;
  let line = 1;
  let scanned = 0;
  for (const match of source.matchAll(/eval\(|new Function\(/g)) {
    for (; scanned < match.index; scanned++) {
      if (source[scanned] === "\n") {
        line++;
        lineStart = scanned + 1;
      }
    }
    findings.push({
      line,
      column: match.index - lineStart + 1,
      kind: "unparsed-eval-text",
    });
  }
  return findings;
}

function str(node: AstNode | undefined, key: string): string | undefined {
  const value = node?.[key];
  return typeof value === "string" ? value : undefined;
}

function child(node: AstNode | undefined, key: string): AstNode | undefined {
  const value = node?.[key];
  return isNode(value) ? value : undefined;
}

function isMember(node: AstNode | undefined): boolean {
  return node?.type === "MemberExpression" ||
    node?.type === "OptionalMemberExpression";
}

function isCall(node: AstNode | undefined): boolean {
  return node?.type === "CallExpression" ||
    node?.type === "OptionalCallExpression";
}

/** The name of a non-computed member's property, or a literal computed key. */
function memberName(member: AstNode | undefined): string | undefined {
  const property = child(member, "property");
  if (member?.computed === true) return literalKey(property);
  return property?.type === "Identifier" ? str(property, "name") : undefined;
}

/** A string literal, or a template literal with no substitutions. */
function literalKey(node: AstNode | undefined): string | undefined {
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

/** Strips TS casts and parentheses: `(globalThis as any)` → `globalThis`. */
function unwrap(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  for (let i = 0; i < MAX_CHAIN && current; i++) {
    if (!TS_WRAPPERS.has(current.type)) return current;
    current = child(current, "expression");
  }
  return current;
}

/**
 * The expression is a global object: a global name, a cast of one, or a
 * chain of them (`globalThis.self`).
 */
function isGlobalObject(node: AstNode | undefined): boolean {
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

/** Walks up through TS casts and parentheses from `visit`. */
function outerExpression(visit: Visit): Visit {
  let current = visit;
  while (current.parent && TS_WRAPPERS.has(current.parent.node.type)) {
    current = current.parent;
  }
  return current;
}

type Role =
  | "property"
  | "key"
  | "pattern-key"
  | "binding"
  | "label"
  | "reference";

class Analyzer {
  private readonly findings: DynamicCodeFinding[] = [];
  /** Nodes where a global object is used as a value. */
  private readonly globalValues: AstNode[] = [];
  /** `x.eval` / `x.Function` member accesses on a non-global receiver. */
  private readonly evalMembers: AstNode[] = [];

  run(program: AstNode): DynamicCodeFinding[] {
    const stack: Visit[] = [{ node: program, key: "", parent: null }];
    while (stack.length > 0) {
      const visit = stack.pop()!;
      const node = visit.node;
      if (isTypeOnly(node)) continue;
      this.check(visit);
      for (const key of Object.keys(node)) {
        if (SKIP_KEYS.has(key) || TYPE_KEYS.has(key)) continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (let i = value.length - 1; i >= 0; i--) {
            const item = value[i];
            if (isNode(item)) stack.push({ node: item, key, parent: visit });
          }
        } else if (isNode(value)) {
          stack.push({ node: value, key, parent: visit });
        }
      }
    }
    // A member named `eval` is allowed because the receiver is usually an
    // interpreter, but once a global object escapes into a value the
    // receiver could be an alias of it. A file with both is flagged.
    if (this.globalValues.length > 0 && this.evalMembers.length > 0) {
      for (const n of this.globalValues) this.flag(n, "global-object-alias");
      for (const n of this.evalMembers) this.flag(n, "aliased-eval-member");
    }
    return this.findings.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  private flag(node: AstNode, kind: DynamicCodeKind): void {
    const start = node.loc?.start;
    this.findings.push({
      line: start?.line ?? 1,
      column: (start?.column ?? 0) + 1,
      kind,
    });
  }

  private check(visit: Visit): void {
    const node = visit.node;
    if (node.type === "Identifier") {
      const name = str(node, "name");
      if (name === "eval") this.checkEval(visit);
      else if (name === "Function") this.checkFunction(visit);
      else if (name === "constructor") this.checkConstructor(visit);
      else if (name && VALUE_GLOBALS.has(name)) this.checkGlobalValue(visit);
    } else if (isMember(node) && node.computed === true) {
      this.checkComputed(visit);
    }
  }

  /** How an identifier is used. */
  private role(visit: Visit): Role {
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

  private isTypeofOperand(visit: Visit): boolean {
    const parent = visit.parent?.node;
    return parent?.type === "UnaryExpression" && visit.key === "argument" &&
      str(parent, "operator") === "typeof";
  }

  private checkEval(visit: Visit): void {
    const role = this.role(visit);
    if (role === "property") {
      if (isGlobalObject(child(visit.parent!.node, "object"))) {
        this.flag(visit.node, "eval-reference");
      } else {
        this.evalMembers.push(visit.node);
      }
      return;
    }
    if (role === "key" || role === "label") return;
    if (this.isTypeofOperand(visit)) return;
    this.flag(visit.node, "eval-reference");
  }

  private checkFunction(visit: Visit): void {
    const role = this.role(visit);
    const node = visit.node;
    if (role === "property") {
      if (isGlobalObject(child(visit.parent!.node, "object"))) {
        this.flag(node, "function-constructor");
      } else {
        this.evalMembers.push(node);
      }
      return;
    }
    if (role === "key" || role === "label") return;
    if (this.isTypeofOperand(visit)) return;
    const parent = visit.parent?.node;
    // `x instanceof Function` compares; it cannot build code.
    if (
      parent?.type === "BinaryExpression" && visit.key === "right" &&
      str(parent, "operator") === "instanceof"
    ) {
      return;
    }
    // Reads such as `Function.prototype.toString` are allowed;
    // `Function.call`/`apply`/`bind`/`constructor`, computed access, and
    // `Function.prototype.constructor` reach the constructor.
    if (isMember(parent) && visit.key === "object") {
      const name = memberName(parent);
      if (name === "prototype") {
        const outer = visit.parent!.parent?.node;
        if (
          isMember(outer) && visit.parent!.key === "object" &&
          memberName(outer) === "constructor"
        ) {
          this.flag(node, "function-constructor");
        }
        return;
      }
      if (
        name === undefined || CALL_FORMS.has(name) || name === "constructor"
      ) {
        this.flag(node, "function-constructor");
      }
      return;
    }
    this.flag(node, "function-constructor");
  }

  /** `x.constructor(...)` (without `new`) or `x.constructor.call(...)`. */
  private checkConstructor(visit: Visit): void {
    if (this.role(visit) !== "property") return;
    if (this.isCalledWithoutNew(visit.parent!)) {
      this.flag(visit.node, "constructor-call");
    }
  }

  /** The member is the callee of a call, or of `.call`/`.apply`/`.bind`. */
  private isCalledWithoutNew(member: Visit): boolean {
    const outer = member.parent;
    if (!outer) return false;
    if (isCall(outer.node) && member.key === "callee") return true;
    if (isMember(outer.node) && member.key === "object") {
      const name = memberName(outer.node);
      return name !== undefined && CALL_FORMS.has(name) &&
        isCall(outer.parent?.node) && outer.key === "callee";
    }
    return false;
  }

  private checkComputed(visit: Visit): void {
    const property = child(visit.node, "property");
    const key = literalKey(property);
    if (key === undefined || !property) return;
    if (COMPUTED_NAMES.has(key)) {
      this.flag(property, "eval-computed-access");
    } else if (key === "constructor" && this.isCalledWithoutNew(visit)) {
      this.flag(property, "constructor-call");
    }
  }

  /**
   * Records a global object used as a value — held, passed, or indexed with
   * a computed key — as opposed to member access, `typeof` or `in`.
   */
  private checkGlobalValue(visit: Visit): void {
    if (this.role(visit) !== "reference") return;
    const outer = outerExpression(visit);
    const parent = outer.parent?.node;
    if (this.isTypeofOperand(outer)) return;
    if (
      parent?.type === "BinaryExpression" && outer.key === "right" &&
      str(parent, "operator") === "in"
    ) {
      return;
    }
    if (isMember(parent) && outer.key === "object") {
      if (parent!.computed !== true) return;
      if (literalKey(child(parent, "property")) !== undefined) return;
    }
    this.globalValues.push(visit.node);
  }
}

/**
 * Finds dynamic code execution in `source`. Never throws: a file that does
 * not parse is checked with the plain text check instead.
 */
export function findDynamicCodeExecution(
  source: string,
): DynamicCodeFinding[] {
  const program = parseSource(source);
  if (!program) return textFallback(source);
  return new Analyzer().run(program);
}
