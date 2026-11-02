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
  freeRoots,
  type References,
  transformHyphenatedModelRefs,
} from "./cel_grammar.ts";
import { lexSegments } from "./cel_string_lexer.ts";
import { isDeferredExpression } from "./deferred_expression.ts";
import { InvalidExpressionError } from "./errors.ts";
import { extractExpressions } from "./expression_parser.ts";
import { levenshteinDistance } from "../string_distance.ts";
import {
  isDynamicVaultArgument,
  vaultCallsForAnalysis,
} from "./vault_reference_extractor.ts";

export { BINDING_MACROS, parsesAsCel } from "./cel_grammar.ts";

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

const HYPHENATED_FOREIGN_REF = new RegExp(
  `(?<![A-Za-z0-9_.])(?:${[...KNOWN_FOREIGN_ROOTS].join("|")})` +
    "\\.[A-Za-z0-9_.-]*[A-Za-z0-9_]",
  "g",
);

/**
 * foreign systems have no subtraction and name things with hyphens, which CEL
 * would parse as matrix.node - version; string literals and comments are left
 * alone
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

export interface SwampScope {
  isBound(root: string): boolean;
  declaredInputs: ReadonlySet<string> | "any";
}

/**
 * for guards that may run on a remote worker that never saw the definition's
 * inputs, and for model validate, which must agree: every namespace is bound
 * and every input declared, widening only to more true answers
 */
export const WIDEST_SWAMP_SCOPE: SwampScope = {
  isBound: () => true,
  declaredInputs: "any",
};

/**
 * text that does not parse is never foreign, so a malformed swamp expression
 * stays guarded; text reading vault is never foreign, since the runtime pass
 * evaluates it and fails on github
 */
export function isForeignExpression(celExpression: string): boolean {
  const roots = attributedRoots(celExpression);
  return roots !== undefined && !roots.has("vault") &&
    !isSwampExpression(celExpression, WIDEST_SWAMP_SCOPE);
}

export function foreignRootsBesideVault(celExpression: string): string[] {
  const roots = attributedRoots(celExpression);
  if (roots === undefined || !roots.has("vault")) return [];
  return [...roots].filter((root) => !SWAMP_ROOT_NAMESPACES.has(root));
}

/**
 * a step argument passes through as foreign text only with no unlisted root,
 * since one is far more likely a typo; swamp's own deferred-expression
 * reference is judged where it is resolved
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
 * uses the isSwampExpression grammar, not parsesAsCel: text only the evaluation
 * grammar accepts cannot be attributed, so it must not count as foreign and
 * stays guarded
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

export function containsSwampExpression(value: unknown): boolean {
  return extractExpressions(value).some((expr) =>
    !isForeignExpression(expr.celExpression)
  );
}

export interface MisspeltNamespace {
  root: string;
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
 * only supplies the Did you mean hint, since an unlisted root fails anyway;
 * known foreign roots and ordinary words like node, stats or date are never
 * named
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
 * only an unknown-variable error naming a foreign root (or swamp's deferred
 * reference) counts; any other failure, such as a data.latest datastore error,
 * must surface rather than become literal text
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
 * the resolver rewrites vault.get before CEL sees it, so quoted and bare-token
 * arguments are literal names parsed as string constants; computed ones are
 * evaluated as CEL, unresolvable ones too
 */
function parseForAttribution(celExpression: string): ASTNode {
  let text = "";
  let last = 0;
  for (const call of vaultCallsForAnalysis(celExpression)) {
    const vaultName = attributedVaultArg(call.args[0]);
    const secretKey = attributedVaultArg(call.args[1]);
    text += celExpression.slice(last, call.start) +
      `vault.get(${vaultName}, ${secretKey})`;
    last = call.end;
  }
  text += celExpression.slice(last);
  return parseCel(transformHyphenatedModelRefs(text)).ast;
}

function attributedVaultArg(arg: { text: string; literal?: string }): string {
  if (arg.literal !== undefined) return JSON.stringify(arg.literal);
  return readsOnlySwampBindings(arg.text) ? arg.text : "''";
}

function readsOnlySwampBindings(bareToken: string): boolean {
  return isDynamicVaultArgument(bareToken) &&
    isSwampExpression(bareToken, WIDEST_SWAMP_SCOPE);
}

/**
 * The unquoted `vault.get` arguments in an expression that the resolver
 * evaluates as CEL but that read nothing swamp provides,
 * such as `db.password` in `vault.get(t, db.password)`. Each fails when the
 * expression is resolved, so a secret key that contains a dot must be quoted.
 */
export function unresolvableVaultArguments(celExpression: string): string[] {
  const args: string[] = [];
  for (const call of vaultCallsForAnalysis(celExpression)) {
    for (const arg of call.args) {
      if (
        arg.literal === undefined && isDynamicVaultArgument(arg.text) &&
        !isSwampExpression(arg.text, WIDEST_SWAMP_SCOPE)
      ) args.push(arg.text);
    }
  }
  return args;
}

/**
 * fails closed: text the attribution grammar cannot parse counts as reading a
 * swamp binding; one swamp root is enough, unlike isForeignExpression
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
 * hyphenated foreign names count as one name when deciding what the text reads,
 * but foreignness is judged as written, as a run judges it, since CEL reads
 * needs.build-vault.x as a vault read
 */
export function storedTextRefusal(celExpression: string): string | undefined {
  const joined = joinHyphenatedForeignRefs(celExpression);
  try {
    if (freeRoots(joined) === undefined) {
      return "does not parse as an expression";
    }
    if (readsSwampBinding(joined)) return "reads a swamp namespace";
    if (!isForeignExpression(celExpression)) {
      const hyphenated = isForeignExpression(joined)
        ? hyphenatedForeignRef(celExpression)
        : undefined;
      return hyphenated === undefined
        ? "cannot be attributed to another templating system"
        : `holds a hyphenated name CEL reads as subtraction (${
          hyphenated.replaceAll("-", " - ")
        }), so a run would refuse it`;
    }
  } catch (error) {
    // Walking a deeply nested expression can exhaust the stack.
    if (error instanceof RangeError) return "nests too deeply to analyse";
    throw error;
  }
  return undefined;
}

function hyphenatedForeignRef(celExpression: string): string | undefined {
  const refs: string[] = [];
  for (const seg of lexSegments(celExpression)) {
    if (seg.kind !== "code") continue;
    const text = celExpression.slice(seg.start, seg.end);
    for (const [ref] of text.matchAll(HYPHENATED_FOREIGN_REF)) {
      if (ref.includes("-")) refs.push(ref);
    }
  }
  return refs.find((ref) => !isForeignExpression(ref)) ?? refs[0];
}

const MAX_REFUSED_TEXT_LENGTH = 120;

/** the text is cut short when long, since it can be data */
export function refusedOccurrenceLine(
  path: string,
  raw: string,
  reason: string,
): string {
  if (raw.length <= MAX_REFUSED_TEXT_LENGTH) {
    return `  ${path}: ${raw} (${reason})`;
  }
  // Never cut between the two halves of a surrogate pair.
  const last = raw.charCodeAt(MAX_REFUSED_TEXT_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff
    ? MAX_REFUSED_TEXT_LENGTH - 1
    : MAX_REFUSED_TEXT_LENGTH;
  return `  ${path}: ${
    raw.slice(0, end)
  }… (${raw.length} characters) (${reason})`;
}

/**
 * text is swamp's only when every free root is a bound swamp namespace and
 * every inputs.X names a declared input; anything unattributable keeps the
 * literal pass-through, as other systems share this syntax
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
