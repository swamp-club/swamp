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
 * Detects use of `Deno.Command`, the subprocess API, in TypeScript and
 * JavaScript source, for the extension safety warning `deno-command`.
 *
 * The source is read as a syntax tree, so comments, strings, template text
 * and regex literals never count, and neither do TypeScript types. Two
 * things are flagged:
 *
 * - `Command` read off `Deno`, in any spelling: `Deno.Command`,
 *   `Deno?.Command`, `Deno["Command"]`, through casts, through a global
 *   object (`globalThis.Deno.Command`), and `import C = Deno.Command`.
 *   Flagged whether it is called, constructed, stored or passed.
 * - `Deno` itself used as a value, since an alias reaches `Command`: stored
 *   (`const d = Deno`), passed, spread, destructured, `import D = Deno`, a
 *   `Deno` key destructured from a global object, a lookup call given a
 *   global object and the literal `"Deno"`, and `Deno[key]` with a key that
 *   is not a literal.
 *
 * Member reads of any other `Deno` key (`Deno.env`), `typeof Deno` and
 * `"x" in Deno` are not flagged, nor is a member named `Command` on any other
 * object: a CLI framework's `Command` class or a field named `Command` is
 * not a subprocess. `Command` read off a member named `Deno` on any receiver
 * (`g.Deno.Command`, `this.Deno.Command`) is flagged, since the receiver may
 * be the global object under another name. Not caught: other uses of such an
 * alias (`const g = globalThis; const d = g.Deno; new d.Command()`, or a
 * parameter pattern given it: `(({ Deno: d }) => ...)(globalThis)`), since
 * following them would mean flagging every member named `Deno`, and names
 * assembled at runtime
 * (`globalThis["De" + "no"]`). A file that does not parse falls back to the
 * old text check: each line containing `Deno.Command(`.
 */

import {
  type AstNode,
  child,
  identifierRole,
  isCall,
  isGlobalName,
  isGlobalObject,
  isMember,
  isNode,
  isTypeofOperand,
  LineIndex,
  literalKey,
  MAX_CHAIN,
  memberName,
  parseExtensionSource,
  str,
  TS_WRAPPERS,
  unwrap,
  type Visit,
  walkRuntimeNodes,
} from "./extension_source_ast.ts";

/** The form of `Deno.Command` use a finding reports. */
export type DenoCommandKind =
  | "command-reference"
  | "deno-value"
  | "deno-computed-access"
  | "unparsed-text";

/** One use of `Deno.Command`, 1-based line and column. */
export interface DenoCommandFinding {
  line: number;
  column: number;
  kind: DenoCommandKind;
}

const DENO = "Deno";
const COMMAND = "Command";

// Declarations whose `id` names a new binding rather than reading one. The
// shared role helper leaves these to its callers; the eval rules read them
// as references, which this rule does not need to.
const TS_DECLARATIONS = new Set([
  "TSModuleDeclaration",
  "TSEnumDeclaration",
  "TSImportEqualsDeclaration",
  "TSEnumMember",
  "TSNamespaceExportDeclaration",
]);

const IMPORT_SPECIFIERS = new Set([
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
]);

/** The old text check, used when the source does not parse. */
function textFallback(source: string): DenoCommandFinding[] {
  const findings: DenoCommandFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const column = lines[i].indexOf("Deno.Command(");
    if (column >= 0) {
      findings.push({ line: i + 1, column: column + 1, kind: "unparsed-text" });
    }
  }
  return findings;
}

/**
 * The expression is `Deno`: the bare name, or `Deno` read off a global
 * object (`globalThis.Deno`, `globalThis["Deno"]`), through casts.
 */
function isDeno(node: AstNode | undefined): boolean {
  const target = unwrap(node);
  if (!target) return false;
  if (target.type === "Identifier") return str(target, "name") === DENO;
  return isMember(target) && memberName(target) === DENO &&
    isGlobalObject(child(target, "object"));
}

/**
 * A TypeScript qualified name `Deno`, or `<anything>.Deno`, as on the left
 * of `import C = Deno.Command` or `import C = g.Deno.Command`.
 */
function isDenoQualified(node: AstNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return str(node, "name") === DENO;
  return node.type === "TSQualifiedName" &&
    str(child(node, "right"), "name") === DENO;
}

/**
 * The expression is a member named `Deno` on any receiver (`g.Deno`,
 * `this.Deno`). Reading `Command` off it is flagged, as the text check did
 * for `g.Deno.Command(`; the receiver may be the global object under
 * another name. A bare `x.Deno` is not flagged.
 */
function isDenoMember(node: AstNode | undefined): boolean {
  const target = unwrap(node);
  return isMember(target) && memberName(target) === DENO;
}

/** Inside `import type X = ...`, which is erased at run time. */
function inTypeOnlyImportEquals(visit: Visit): boolean {
  for (let v: Visit | null = visit; v; v = v.parent) {
    if (v.node.type === "TSImportEqualsDeclaration") {
      return str(v.node, "importKind") === "type";
    }
  }
  return false;
}

/** An identifier in a position that declares a name rather than reading one. */
function isBindingSite(visit: Visit): boolean {
  const parent = visit.parent?.node;
  if (!parent) return false;
  const key = visit.key;
  if (parent.type === "TSParameterProperty" && key === "parameter") {
    return true;
  }
  // `export * as Deno from "./x.ts"` names a namespace of that module.
  if (parent.type === "ExportNamespaceSpecifier" && key === "exported") {
    return true;
  }
  // `export { Deno } from "./x.ts"` names the other module's export.
  if (
    parent.type === "ExportSpecifier" && key === "local" &&
    child(visit.parent?.parent?.node, "source") !== undefined
  ) {
    return true;
  }
  if (TS_DECLARATIONS.has(parent.type) && key === "id") return true;
  if (IMPORT_SPECIFIERS.has(parent.type) && key === "local") return true;
  if (parent.type === "CatchClause" && key === "param") return true;
  if (parent.type === "RestElement" && key === "argument") return true;
  if (parent.type === "ArrayPattern" && key === "elements") return true;
  if (parent.type === "AssignmentPattern" && key === "left") return true;
  // The value of a pattern property is the name it binds: `{ Deno: d }`
  // binds `d`, shorthand `{ Deno }` binds `Deno`.
  return parent.type === "ObjectProperty" && key === "value" &&
    visit.parent?.parent?.node.type === "ObjectPattern";
}

/** A pattern property's key name: `Deno` in `{ Deno: d }` or `{ ["Deno"]: d }`. */
function propertyKeyName(property: AstNode): string | undefined {
  const key = child(property, "key");
  return property.computed === true
    ? literalKey(key)
    : str(key, "name") ?? literalKey(key);
}

/**
 * The pattern destructures a global object: it is bound from one directly
 * (`const { ... } = globalThis`), or it is nested under global-object keys
 * of such a pattern (`const { self: { ... } } = globalThis`).
 */
function destructuresGlobalObject(pattern: Visit): boolean {
  let current = pattern;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const property = current.parent;
    const outer = property?.parent;
    if (
      property?.node.type !== "ObjectProperty" || current.key !== "value" ||
      outer?.node.type !== "ObjectPattern" ||
      !isGlobalName(propertyKeyName(property.node))
    ) {
      return isGlobalObject(patternSource(current));
    }
    current = outer;
  }
  return false;
}

/** The expression a pattern destructures: `const <pattern> = <source>`. */
function patternSource(pattern: Visit): AstNode | undefined {
  const owner = pattern.parent;
  if (!owner) return undefined;
  const node = owner.node;
  if (node.type === "VariableDeclarator" && pattern.key === "id") {
    return child(node, "init");
  }
  if (
    (node.type === "AssignmentExpression" ||
      node.type === "AssignmentPattern") && pattern.key === "left"
  ) {
    return child(node, "right");
  }
  return undefined;
}

class Analyzer {
  private readonly findings: DenoCommandFinding[] = [];

  constructor(private readonly lines: LineIndex) {}

  run(program: AstNode): DenoCommandFinding[] {
    walkRuntimeNodes(program, (visit) => this.check(visit));
    return this.findings.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  private flag(node: AstNode, kind: DenoCommandKind): void {
    const offset = typeof node.start === "number" ? node.start : 0;
    this.findings.push({ ...this.lines.position(offset), kind });
  }

  private check(visit: Visit): void {
    const node = visit.node;
    if (isMember(node)) {
      this.checkMember(visit);
    } else if (node.type === "Identifier" && str(node, "name") === DENO) {
      this.checkDenoIdentifier(visit);
    } else if (node.type === "TSQualifiedName") {
      if (!inTypeOnlyImportEquals(visit)) this.checkQualifiedName(node);
    } else if (node.type === "ObjectProperty") {
      this.checkPatternKey(visit);
    } else if (isCall(node) || node.type === "NewExpression") {
      this.checkGlobalLookup(node);
    }
  }

  /** `Deno.Command`, `Deno[key]`, and `globalThis.Deno` used as a value. */
  private checkMember(visit: Visit): void {
    const node = visit.node;
    const object = child(node, "object");
    const name = memberName(node);
    const property = child(node, "property") ?? node;
    if (
      name === COMMAND && (isDeno(object) || isDenoMember(object)) &&
      !isTypeofOperand(visit)
    ) {
      this.flag(property, "command-reference");
    } else if (
      name === undefined && node.computed === true && isDeno(object)
    ) {
      this.flag(property, "deno-computed-access");
    }
    if (memberName(node) === DENO && isGlobalObject(child(node, "object"))) {
      this.checkDenoValue(visit, child(node, "property") ?? node);
    }
  }

  private checkDenoIdentifier(visit: Visit): void {
    if (isBindingSite(visit) || inTypeOnlyImportEquals(visit)) return;
    // `globalThis.Deno` in a qualified name (`import D = globalThis.Deno`)
    // is `Deno` read off a global object, judged like the member form.
    const parent = visit.parent;
    if (parent?.node.type === "TSQualifiedName" && visit.key === "right") {
      if (isGlobalObject(child(parent.node, "left"))) {
        this.checkDenoValue(parent, visit.node);
      }
      return;
    }
    const role = identifierRole(visit);
    // `x.Deno` is handled as a member; keys, labels and declared names
    // read nothing.
    if (role !== "reference") return;
    this.checkDenoValue(visit, visit.node);
  }

  /**
   * `Deno` (bare or off a global object) at `visit`: flagged unless it is
   * read from (`Deno.env`, `Deno[key]` - checked as a member), tested
   * (`typeof Deno`, `"x" in Deno`), or the left of a qualified name.
   */
  private checkDenoValue(visit: Visit, at: AstNode): void {
    let current = visit;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const parent = current.parent;
      if (!parent || !TS_WRAPPERS.has(parent.node.type)) break;
      current = parent;
    }
    const parent = current.parent?.node;
    if (isMember(parent) && current.key === "object") return;
    if (isTypeofOperand(current)) return;
    if (
      parent?.type === "BinaryExpression" && current.key === "right" &&
      str(parent, "operator") === "in"
    ) {
      return;
    }
    if (parent?.type === "TSQualifiedName" && current.key === "left") return;
    this.flag(at, "deno-value");
  }

  /** `import C = Deno.Command`, `import C = globalThis.Deno.Command`. */
  private checkQualifiedName(node: AstNode): void {
    const right = child(node, "right");
    if (
      str(right, "name") === COMMAND && isDenoQualified(child(node, "left"))
    ) {
      this.flag(right!, "command-reference");
    }
  }

  /**
   * `const { Deno: d } = globalThis`, `const { self: { Deno: d } } =
   * globalThis`: a `Deno` key read off a global object.
   */
  private checkPatternKey(visit: Visit): void {
    const pattern = visit.parent;
    if (pattern?.node.type !== "ObjectPattern") return;
    const key = child(visit.node, "key");
    if (propertyKeyName(visit.node) !== DENO || !key) return;
    if (destructuresGlobalObject(pattern)) this.flag(key, "deno-value");
  }

  /**
   * `Reflect.get(globalThis, "Deno")`: one call given both a global object
   * and the literal name reads `Deno` the way `globalThis["Deno"]` does.
   */
  private checkGlobalLookup(call: AstNode): void {
    const args = call.arguments;
    if (!Array.isArray(args)) return;
    const nodes = args.filter(isNode);
    if (!nodes.some((a) => isGlobalObject(a))) return;
    for (const a of nodes) {
      if (literalKey(a) === DENO) this.flag(a, "deno-value");
    }
  }
}

/**
 * Finds uses of `Deno.Command` in `source`. Never throws: a file that does
 * not parse is checked with the old text check instead. `program` is the
 * result of {@link parseExtensionSource} when the caller already parsed the
 * source (null when it did not parse); omitted, the source is parsed here.
 */
export function findDenoCommandUse(
  source: string,
  program: AstNode | null = parseExtensionSource(source),
): DenoCommandFinding[] {
  if (!program) return textFallback(source);
  return new Analyzer(new LineIndex(source)).run(program);
}
