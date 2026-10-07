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
 * class member or object-literal key, a label, a TypeScript type). A member
 * access named `eval` or `Function` is flagged on any receiver, because the
 * receiver may be the global object and no static check can rule that out.
 * A file that does not parse as a module falls back to the old text check
 * (`eval(` or `new Function(`), so it is held to at least the old standard.
 * Aliases built at runtime (`globalThis["ev" + "al"]`) cannot be caught
 * statically.
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
  | "eval-member"
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

/** The Babel plugins extension source is parsed with. */
export const BABEL_PLUGINS: ParserPlugin[] = [
  "typescript",
  "decorators-legacy",
  "explicitResourceManagement",
  "decoratorAutoAccessors",
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
  // Module only: Deno runs extensions as modules. A script-mode retry would
  // read `<!--` as a comment, which in a module is live code.
  try {
    const file = parse(source, {
      sourceType: "module",
      plugins: BABEL_PLUGINS,
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
    // Syntax errors, and stack overflow on extreme nesting, fall back to
    // the text check.
    return null;
  }
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

/**
 * A receiver whose `constructor` is a function constructor: a function,
 * arrow or class literal, or `Object.getPrototypeOf(...)` /
 * `Reflect.getPrototypeOf(...)` of anything.
 */
function isFunctionSource(node: AstNode | undefined): boolean {
  const target = unwrap(node);
  if (!target) return false;
  if (
    ["FunctionExpression", "ArrowFunctionExpression", "ClassExpression"]
      .includes(target.type)
  ) {
    return true;
  }
  if (!isCall(target)) return false;
  const callee = unwrap(child(target, "callee"));
  return isMember(callee) && memberName(callee) === "getPrototypeOf";
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
    } else if (isMember(node)) {
      if (node.computed === true) this.checkComputed(visit);
    } else if (isCall(node) || node.type === "NewExpression") {
      this.checkGlobalLookup(node);
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
      // A member named `eval` is flagged on any receiver: the receiver may
      // be the global object (`globalThis.valueOf()`, a host-bound `this`),
      // and no static check can rule that out.
      this.flag(
        visit.node,
        isGlobalObject(child(visit.parent!.node, "object"))
          ? "eval-reference"
          : "eval-member",
      );
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
      this.flag(
        node,
        isGlobalObject(child(visit.parent!.node, "object"))
          ? "function-constructor"
          : "eval-member",
      );
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

  /**
   * `x.constructor(...)` (without `new`), `x.constructor.call(...)`, or
   * `new <function literal>.constructor(...)`.
   */
  private checkConstructor(visit: Visit): void {
    if (this.role(visit) !== "property") return;
    if (this.reachesFunctionConstructor(visit.parent!)) {
      this.flag(visit.node, "constructor-call");
    }
  }

  private reachesFunctionConstructor(member: Visit): boolean {
    if (this.isCalledWithoutNew(member)) return true;
    // `new this.constructor()` clones; with a function literal receiver the
    // same `new` builds code like `new Function(...)`.
    const outer = member.parent;
    return outer?.node.type === "NewExpression" && member.key === "callee" &&
      isFunctionSource(child(member.node, "object"));
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
    } else if (
      key === "constructor" && this.reachesFunctionConstructor(visit)
    ) {
      this.flag(property, "constructor-call");
    }
  }

  /**
   * `Reflect.get(globalThis, "eval")`, `Object.getOwnPropertyDescriptor(
   * globalThis, "Function")`: one call given both a global object and the
   * literal name reads the global the same way `globalThis["eval"]` does.
   */
  private checkGlobalLookup(call: AstNode): void {
    const args = call.arguments;
    if (!Array.isArray(args)) return;
    const nodes = args.filter(isNode);
    const hasGlobal = nodes.some((a) => isGlobalObject(a));
    if (!hasGlobal) return;
    for (const a of nodes) {
      if (COMPUTED_NAMES.has(literalKey(a) ?? "")) {
        this.flag(a, "eval-computed-access");
      }
    }
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
