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
import { extractExpressions } from "./expression_parser.ts";

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
 */
export function isForeignExpression(celExpression: string): boolean {
  return parses(celExpression) &&
    !isSwampExpression(celExpression, WIDEST_SWAMP_SCOPE);
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

/**
 * Parses with the grammar {@link isSwampExpression} uses, deliberately not
 * {@link parsesAsCel}. Text only the evaluation grammar accepts (`inputs.?x`)
 * is text `isSwampExpression` cannot attribute, so it must not count as
 * foreign: it stays claimed and guarded.
 */
function parses(celExpression: string): boolean {
  try {
    parseCel(transformHyphenatedModelRefs(celExpression));
    return true;
  } catch {
    return false;
  }
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
    ast = parseCel(transformHyphenatedModelRefs(celExpression)).ast;
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
