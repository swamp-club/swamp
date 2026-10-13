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

import { type ASTNode, parse as parseCel } from "cel-js";
import {
  collectReferences,
  type References,
  transformHyphenatedModelRefs,
} from "./cel_grammar.ts";
import { lexSegments } from "./cel_string_lexer.ts";
import { isDeferredExpression } from "./deferred_expression.ts";
import { InvalidExpressionError } from "./errors.ts";
import { extractExpressions } from "./expression_parser.ts";
import { levenshteinDistance } from "../string_distance.ts";
import {
  findVaultGetCalls,
  isDynamicVaultArgument,
} from "./vault_reference_extractor.ts";

export { BINDING_MACROS, parsesAsCel } from "./cel_grammar.ts";

/**
 * Root identifiers swamp binds when it evaluates CEL (the CEL-visible keys of
 * ExpressionContext).
 */
const SWAMP_ROOT_NAMESPACES: ReadonlySet<string> = new Set([
  "model",
  "self",
  "inputs",
  "workflow",
  "vault",
  "env",
  "data",
  "workers",
  "file",
  "workflowRunId",
  "run",
  "steps",
  "webhook",
]);

/**
 * Root identifiers of other templating systems that share the `${{ ... }}`
 * syntax: the GitHub Actions contexts swamp does not bind itself, and the
 * Gitea and Forgejo equivalents of `github`. Only these pass through a
 * workflow step's arguments (see {@link unlistedForeignRoots}). This set is
 * the one place the list lives; a new root is added here, with a test.
 */
export const KNOWN_FOREIGN_ROOTS: ReadonlySet<string> = new Set([
  "github",
  "gitea",
  "forgejo",
  "matrix",
  "secrets",
  "vars",
  "needs",
  "runner",
  "job",
  "jobs",
  "strategy",
]);

/**
 * A member chain on a known foreign root, written with no spaces and holding
 * hyphens: `matrix.node-version`, `needs.build-app.outputs.sha`.
 */
const HYPHENATED_FOREIGN_REF = new RegExp(
  `(?<![A-Za-z0-9_.])(?:${[...KNOWN_FOREIGN_ROOTS].join("|")})` +
    "\\.[A-Za-z0-9_.-]*[A-Za-z0-9_]",
  "g",
);

/**
 * Reads the hyphens in a member chain on a known foreign root as part of its
 * names. Those systems have no subtraction, and name things with hyphens
 * (`matrix.node-version`), which CEL parses as `matrix.node - version` with
 * `version` a root of its own. Text inside string literals and comments is
 * left alone.
 */
function joinHyphenatedForeignRefs(celExpression: string): string {
  let out = "";
  for (const seg of lexSegments(celExpression)) {
    const text = celExpression.slice(seg.start, seg.end);
    out += seg.kind === "code"
      ? text.replace(
        HYPHENATED_FOREIGN_REF,
        (ref) => ref.replaceAll("-", "_"),
      )
      : text;
  }
  return out;
}

/** What a swamp evaluation provides, to judge whether an expression is swamp's. */
export interface SwampScope {
  /** Whether this evaluation binds the root identifier. */
  isBound(root: string): boolean;
  /**
   * Input names the definition declares in its `inputs` schema, or `"any"`
   * to attribute every `inputs.X` to swamp.
   */
  declaredInputs: ReadonlySet<string> | "any";
}

/**
 * The scope to judge `${{ ... }}` text by where no single evaluation is in
 * view: the guard on a method's global arguments, which may run on a remote
 * worker that never saw the definition's `inputs`, and `model validate`, which
 * must agree with that guard. Every namespace counts as bound and every input
 * as declared.
 *
 * {@link isSwampExpression} can only gain `true` answers as its scope widens,
 * so anything a definition pass attributes to swamp is swamp's here too.
 */
export const WIDEST_SWAMP_SCOPE: SwampScope = {
  isBound: () => true,
  declaredInputs: "any",
};

/**
 * Whether `${{ ... }}` text is another templating system's, such as GitHub
 * Actions `${{ github.sha }}`: it parses as CEL, and no swamp evaluation could
 * own it (see {@link WIDEST_SWAMP_SCOPE}).
 *
 * Text that does not parse is never foreign. That covers prose, and a
 * malformed swamp expression such as one whose string literal never closes,
 * which must stay guarded rather than reach a method as literal text.
 *
 * Text that reads the `vault` namespace is never foreign either, whatever
 * else it reads. The runtime pass resolves every such expression and then
 * evaluates it, so `${{ vault.get(t, KEY) + github.sha }}` fails on `github`
 * rather than reaching a method as written; see
 * {@link foreignRootsBesideVault}.
 */
export function isForeignExpression(celExpression: string): boolean {
  const roots = attributedRoots(celExpression);
  return roots !== undefined && !roots.has("vault") &&
    !isSwampExpression(celExpression, WIDEST_SWAMP_SCOPE);
}

/**
 * The root identifiers that swamp does not provide in an expression that
 * also reads the `vault` namespace, such as `github` in
 * `vault.get(t, KEY) + github.sha`. Swamp evaluates the whole expression
 * because of the vault read, so each of these fails the run. Empty for an
 * expression that does not read `vault`, or does not parse.
 */
export function foreignRootsBesideVault(celExpression: string): string[] {
  const roots = attributedRoots(celExpression);
  if (roots === undefined || !roots.has("vault")) return [];
  return [...roots].filter((root) => !SWAMP_ROOT_NAMESPACES.has(root));
}

/**
 * The free root identifiers of an expression that are neither a swamp
 * namespace nor a known foreign root (see {@link KNOWN_FOREIGN_ROOTS}), such
 * as `nonexistent` in `github.sha + nonexistent.variable`. A workflow step
 * argument passes through as another templating system's text only when
 * there are none: an unlisted root is far more likely a typo, so it fails
 * (swamp-club#3400). Empty for text that does not parse.
 *
 * A hyphenated name on a known foreign root is one name, so `version` is no
 * root of `matrix.node-version` (see {@link joinHyphenatedForeignRefs}).
 * Swamp's own reference to a deferred expression is no unlisted root either:
 * it is judged where the reference is resolved.
 */
export function unlistedForeignRoots(celExpression: string): string[] {
  const roots = attributedRoots(joinHyphenatedForeignRefs(celExpression)) ??
    attributedRoots(celExpression);
  if (roots === undefined) return [];
  return [...roots].filter((root) =>
    !SWAMP_ROOT_NAMESPACES.has(root) && !KNOWN_FOREIGN_ROOTS.has(root) &&
    !isDeferredExpression(root)
  );
}

/**
 * The error for a step argument that reads an unlisted root (see
 * {@link unlistedForeignRoots}), naming the first one, or undefined when it
 * reads none. CEL stops at the first unknown name, so its own error for
 * `github.sha + nonexistent.x` names `github`, which is allowed; this names
 * `nonexistent`, and carries CEL's error as its cause.
 */
export function unlistedForeignRootError(
  celExpression: string,
  path?: string,
  cause?: unknown,
): InvalidExpressionError | undefined {
  const [root] = unlistedForeignRoots(celExpression);
  if (root === undefined) return undefined;
  return new InvalidExpressionError(
    `Unknown variable: ${root}`,
    celExpression,
    path,
    cause instanceof Error ? cause : undefined,
  );
}

/**
 * The free root identifiers of an expression, with each `vault.get` argument
 * read as the resolver reads it, or undefined when the text does not parse.
 *
 * Parsed with the grammar {@link isSwampExpression} uses, deliberately not
 * {@link parsesAsCel}. Text only the evaluation grammar accepts (`inputs.?x`)
 * is text `isSwampExpression` cannot attribute, so it must not count as
 * foreign: it stays claimed and guarded.
 */
function attributedRoots(celExpression: string): Set<string> | undefined {
  let ast: ASTNode;
  try {
    ast = parseForAttribution(celExpression);
  } catch {
    return undefined;
  }
  const refs: References = {
    roots: new Set(),
    inputs: new Set(),
    opaqueInputs: false,
  };
  collectReferences(ast, new Set(), refs);
  return refs.roots;
}

/**
 * Whether a value (a string, or an object or array holding strings) carries
 * `${{ ... }}` text that is not foreign (see {@link isForeignExpression}).
 * After definition evaluation such text is an expression that did not
 * resolve; a value whose only `${{ ... }}` text is another templating
 * system's holds none.
 */
export function containsSwampExpression(value: unknown): boolean {
  return extractExpressions(value).some((expr) =>
    !isForeignExpression(expr.celExpression)
  );
}

/** A root identifier that nearly spells a swamp namespace. */
export interface MisspeltNamespace {
  /** The root as written, such as `input`. */
  root: string;
  /** The swamp namespace it resembles, such as `inputs`. */
  namespace: string;
}

/**
 * Whether `root` is `namespace` with one slip of the hand: a letter dropped
 * or added, two adjacent letters swapped, or, in a namespace of five letters
 * or more, one letter replaced. Replacing a letter in a short namespace
 * (`env`, `run`, `self`, `data`, `file`) reaches unrelated words such as
 * `date`, so that does not count.
 */
function isSlipOf(root: string, namespace: string): boolean {
  if (root === namespace) return false;
  if (root.length !== namespace.length) {
    return levenshteinDistance(root, namespace) === 1;
  }
  const differing: number[] = [];
  for (let i = 0; i < root.length; i++) {
    if (root[i] !== namespace[i]) differing.push(i);
  }
  if (differing.length === 1) return namespace.length >= 5;
  if (differing.length !== 2) return false;
  const [a, b] = differing;
  return b === a + 1 && root[a] === namespace[b] && root[b] === namespace[a];
}

/**
 * The first free root identifier of a CEL expression that is not a swamp
 * namespace but nearly spells one (see {@link isSlipOf}): `input` for
 * `inputs`, `modle` for `model`. Such a root is unlisted (see
 * {@link unlistedForeignRoots}), so the expression fails either way; this
 * only supplies the "Did you mean" hint.
 *
 * The known foreign roots are never named, and are near no namespace anyway.
 * Neither are ordinary words such as `node`, `stats` or `date`.
 *
 * Returns undefined for text that does not parse.
 */
export function misspeltSwampNamespace(
  celExpression: string,
): MisspeltNamespace | undefined {
  let ast: ASTNode;
  try {
    ast = parseCel(transformHyphenatedModelRefs(celExpression)).ast;
  } catch {
    return undefined;
  }
  const refs: References = {
    roots: new Set(),
    inputs: new Set(),
    opaqueInputs: false,
  };
  collectReferences(ast, new Set(), refs);
  for (const root of refs.roots) {
    if (SWAMP_ROOT_NAMESPACES.has(root) || KNOWN_FOREIGN_ROOTS.has(root)) {
      continue;
    }
    for (const namespace of SWAMP_ROOT_NAMESPACES) {
      if (isSlipOf(root, namespace)) return { root, namespace };
    }
  }
  return undefined;
}

/**
 * Whether an evaluation failed because the expression read a known foreign
 * root (see {@link KNOWN_FOREIGN_ROOTS}): CEL's "Unknown variable" error,
 * naming such a root, or swamp's own reference to a deferred expression,
 * which is left raw as before. Any other failure of an expression that mentions a
 * foreign root is a real error. In `has(inputs.cache) ? data.latest("m", "d") : github.sha`,
 * a datastore error from `data.latest` must surface, not turn the whole
 * expression into literal text.
 */
export function failedOnForeignRoot(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    const match = /Unknown variable: ([A-Za-z_][A-Za-z0-9_]*)/.exec(
      current.message,
    );
    if (match) {
      return KNOWN_FOREIGN_ROOTS.has(match[1]) ||
        isDeferredExpression(match[1]);
    }
  }
  return false;
}

/**
 * Parses an expression to attribute its free root identifiers, reading each
 * `vault.get` argument the way the resolver does. The resolver rewrites
 * `vault.get(vaultName, secretKey)` before CEL ever sees it, so no argument
 * reaches a method as text:
 *
 * - A quoted argument is a literal name. It is kept as written, except that
 *   a backtick-quoted one, which the resolver's matcher accepts and CEL
 *   cannot parse, is parsed as a string constant.
 * - An unquoted argument with no `.` is used verbatim as a literal name, so
 *   `t` and `KEY` in `vault.get(t, KEY)` are names, not identifiers CEL would
 *   look up. It is parsed as a string constant.
 * - One holding a `.` is evaluated as CEL. `inputs.vaultName` keeps its
 *   roots, so an undeclared input is still judged by the scope. One that
 *   reads nothing swamp provides (`db.password`, `github.repo`) fails that
 *   evaluation rather than passing through, so it is no sign of another
 *   templating system and is parsed as a string constant too; see
 *   {@link unresolvableVaultArguments}.
 *
 * Throws when the text does not parse.
 */
function parseForAttribution(celExpression: string): ASTNode {
  let text = "";
  let last = 0;
  for (const call of findVaultGetCalls(celExpression)) {
    // Groups: [1]=quote1, [2]=quoted vault, [3]=unquoted vault,
    //         [4]=quote2, [5]=quoted key,   [6]=unquoted key
    const vaultName = attributedVaultArg(call[1], call[2], call[3]);
    const secretKey = attributedVaultArg(call[4], call[5], call[6]);
    text += celExpression.slice(last, call.index) +
      `vault.get(${vaultName}, ${secretKey})`;
    last = call.index + call[0].length;
  }
  text += celExpression.slice(last);
  return parseCel(transformHyphenatedModelRefs(text)).ast;
}

function attributedVaultArg(
  quote: string | undefined,
  quoted: string | undefined,
  bare: string | undefined,
): string {
  // The matcher takes a backtick-quoted name, which CEL has no syntax for.
  if (quoted !== undefined) {
    return quote === "`" ? "''" : `${quote}${quoted}${quote}`;
  }
  return bare !== undefined && readsOnlySwampBindings(bare) ? bare : "''";
}

/** Whether an unquoted `vault.get` argument is CEL over swamp's namespaces. */
function readsOnlySwampBindings(bareToken: string): boolean {
  return isDynamicVaultArgument(bareToken) &&
    isSwampExpression(bareToken, WIDEST_SWAMP_SCOPE);
}

/**
 * The unquoted `vault.get` arguments in an expression that the resolver
 * evaluates as CEL (they hold a `.`) but that read nothing swamp provides,
 * such as `db.password` in `vault.get(t, db.password)`. Each fails when the
 * expression is resolved, so a secret key that contains a dot must be quoted.
 */
export function unresolvableVaultArguments(celExpression: string): string[] {
  const args: string[] = [];
  for (const call of findVaultGetCalls(celExpression)) {
    for (const bare of [call[3], call[6]]) {
      if (
        bare !== undefined && isDynamicVaultArgument(bare) &&
        !isSwampExpression(bare, WIDEST_SWAMP_SCOPE)
      ) args.push(bare);
    }
  }
  return args;
}

/**
 * Whether evaluating a CEL expression could read anything swamp binds: some
 * free root identifier is a swamp namespace (`vault`, `data`, `self`,
 * `inputs`, ...). Fails closed — text the attribution grammar cannot parse
 * (prose, a malformed expression, `inputs.?x`) counts as reading one.
 *
 * Unlike {@link isForeignExpression}, a single swamp root is enough, so
 * `${{ github.sha || data.latest("x", "y") }}` reads a swamp binding even
 * though `github` is not swamp's.
 */
export function readsSwampBinding(celExpression: string): boolean {
  let ast: ASTNode;
  try {
    ast = parseForAttribution(celExpression);
  } catch {
    return true;
  }
  const refs: References = {
    roots: new Set(),
    inputs: new Set(),
    opaqueInputs: false,
  };
  collectReferences(ast, new Set(), refs);
  for (const root of refs.roots) {
    if (SWAMP_ROOT_NAMESPACES.has(root)) return true;
  }
  return false;
}

/**
 * Whether a CEL expression that failed to evaluate was written for swamp.
 *
 * The `${{ ... }}` syntax is shared with other templating systems — a shell
 * model writing a GitHub Actions file carries `${{ github.sha }}`,
 * `${{ inputs.version }}` or `${{ steps.build.outputs.sha }}` — and that text
 * has always passed through to the method as literal text. It counts as
 * swamp's only when every free root identifier is a swamp namespace bound in
 * this evaluation, and every `inputs.X` names an input the definition
 * declares. A declared input with no value is swamp's; `inputs.version` in a
 * definition that declares no `version` is not.
 *
 * Returns false when the expression cannot be parsed, or reads `inputs` in a
 * way that names no single input (unless the scope declares `"any"` input), so
 * anything swamp cannot attribute keeps that literal pass-through.
 */
export function isSwampExpression(
  celExpression: string,
  scope: SwampScope,
): boolean {
  let ast: ASTNode;
  try {
    ast = parseForAttribution(celExpression);
  } catch {
    return false;
  }
  const refs: References = {
    roots: new Set(),
    inputs: new Set(),
    opaqueInputs: false,
  };
  collectReferences(ast, new Set(), refs);
  for (const root of refs.roots) {
    if (!SWAMP_ROOT_NAMESPACES.has(root)) return false;
    if (root === "inputs") {
      // Every input counts as declared, so `inputs` read whole or with a
      // computed key is swamp's too.
      if (scope.declaredInputs === "any") continue;
      if (refs.opaqueInputs) return false;
      for (const name of refs.inputs) {
        if (!scope.declaredInputs.has(name)) return false;
      }
    } else if (!scope.isBound(root)) {
      return false;
    }
  }
  return true;
}
