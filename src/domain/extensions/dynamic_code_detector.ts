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
 * a hygiene gate, not a sandbox: runtime-built aliases cannot be caught
 * statically; the walk uses an explicit stack because pull runs this on
 * untrusted archives
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
  LineIndex,
  literalKey,
  memberName,
  parseExtensionSource,
  str,
  unwrap,
  type Visit,
  walkRuntimeNodes,
} from "./extension_source_ast.ts";

export type DynamicCodeKind =
  | "eval-reference"
  | "eval-computed-access"
  | "function-constructor"
  | "constructor-call"
  | "eval-member"
  | "unparsed-eval-text";

export interface DynamicCodeFinding {
  line: number;
  column: number;
  kind: DynamicCodeKind;
}

const CALL_FORMS = new Set(["call", "apply", "bind"]);
const COMPUTED_NAMES = new Set(["eval", "Function"]);

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

  constructor(private readonly lines: LineIndex) {}

  run(program: AstNode): DynamicCodeFinding[] {
    walkRuntimeNodes(program, (visit) => this.check(visit));
    return this.findings.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  private flag(node: AstNode, kind: DynamicCodeKind): void {
    const offset = typeof node.start === "number" ? node.start : 0;
    this.findings.push({ ...this.lines.position(offset), kind });
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
      // a member named eval is flagged on any receiver: it may be the global
      // object and no static check can rule that out
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

export function findDynamicCodeExecution(
  source: string,
  program: AstNode | null = parseExtensionSource(source),
): DynamicCodeFinding[] {
  if (!program) return textFallback(source);
  return new Analyzer(new LineIndex(source)).run(program);
}
