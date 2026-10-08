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
 * The tree walk (`walkRuntimeNodes` in `extension_source_ast.ts`) uses an
 * explicit stack, because `extension pull` runs this on untrusted archive
 * sources.
 */

import {
  type AstNode,
  child,
  identifierRole,
  isCall,
  isGlobalObject,
  isMember,
  isNode,
  isTypeofOperand,
  literalKey,
  memberName,
  parseExtensionSource,
  str,
  unwrap,
  type Visit,
  walkRuntimeNodes,
} from "./extension_source_ast.ts";

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

const CALL_FORMS = new Set(["call", "apply", "bind"]);
const COMPUTED_NAMES = new Set(["eval", "Function"]);

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

class Analyzer {
  private readonly findings: DynamicCodeFinding[] = [];

  run(program: AstNode): DynamicCodeFinding[] {
    walkRuntimeNodes(program, (visit) => this.check(visit));
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

  private checkEval(visit: Visit): void {
    const role = identifierRole(visit);
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
    if (isTypeofOperand(visit)) return;
    this.flag(visit.node, "eval-reference");
  }

  private checkFunction(visit: Visit): void {
    const role = identifierRole(visit);
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
    if (isTypeofOperand(visit)) return;
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
    if (identifierRole(visit) !== "property") return;
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
 * not parse is checked with the plain text check instead. `program` is the
 * result of {@link parseExtensionSource} when the caller already parsed the
 * source (null when it did not parse); omitted, the source is parsed here.
 */
export function findDynamicCodeExecution(
  source: string,
  program: AstNode | null = parseExtensionSource(source),
): DynamicCodeFinding[] {
  if (!program) return textFallback(source);
  return new Analyzer().run(program);
}
