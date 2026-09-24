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

import { expressionSpans } from "../expressions/expression_parser.ts";
import {
  isSwampExpression,
  type SwampScope,
} from "../expressions/swamp_namespaces.ts";

/**
 * The ways template text can look like a swamp expression with its syntax
 * slightly wrong.
 */
export type TemplateSyntaxForm =
  /** `{{ ... }}` with no leading `$` */
  | "bare-double-brace"
  /** `${ ... }` with a single brace */
  | "single-brace"
  /** `{{ ... }}` inside a `${{ ... }}` expression, which cuts it short */
  | "inside-expression";

/**
 * One match of template-like text in a definition.
 */
export interface TemplateSyntaxFinding {
  /** Path to the value (e.g. "globalArguments.message") */
  path: string;
  /** The matched text (e.g. "{{host.name}}") */
  text: string;
  /** Which form matched */
  form: TemplateSyntaxForm;
}

/**
 * Result of scanning a definition for template-like text.
 */
export interface TemplateSyntaxScan {
  /**
   * Text swamp would claim as its own expression once the syntax is fixed:
   * a dropped `$` or a missing brace.
   */
  malformed: TemplateSyntaxFinding[];
  /**
   * Another service's template syntax (Datadog `{{host.name}}`, shell
   * `${HOME}`), passed to the method unchanged.
   */
  foreign: TemplateSyntaxFinding[];
}

/**
 * What the scan needs to know about the definition and its model type.
 */
export interface TemplateSyntaxScanOptions {
  /** Input names the definition declares in its `inputs` schema. */
  declaredInputs: ReadonlySet<string>;
  /**
   * Whether a path lies inside a field the model type declares as foreign
   * template text. Such fields report only `inside-expression` findings,
   * which are broken swamp expressions rather than foreign text.
   */
  isDeclaredForeign?: (path: string) => boolean;
}

const PATTERNS: ReadonlyArray<{ form: TemplateSyntaxForm; pattern: RegExp }> = [
  {
    // {{...}} without the $ prefix (negative lookbehind ensures no $ before)
    form: "bare-double-brace",
    pattern: /(?<!\$)\{\{(?!\{)([^}]+)\}\}/g,
  },
  {
    // ${...} with single braces
    form: "single-brace",
    pattern: /\$\{(?!\{)([^}]+)\}/g,
  },
];

/**
 * Scans definition data for template-like text and classifies each match.
 *
 * A match is malformed exactly when, with the syntax corrected to
 * `${{ ... }}`, swamp would claim it as its own expression (see
 * {@link isSwampExpression}). Everything else is another service's template
 * syntax. Every match in every string is reported, and the two forms are
 * matched independently, so one value can yield both kinds of finding.
 *
 * A `{{ ... }}` that starts inside a `${{ ... }}` expression is always
 * malformed (`inside-expression`), even in a declared field: an expression
 * ends at the first `}}`, so the text cuts it short and it cannot evaluate.
 * A `${ ... }` inside an expression is ordinary CEL string content, as in
 * `${{ "${HOME}" }}`, and is not reported.
 *
 * Every swamp root counts as bound. A runtime pass binds `run`, `steps`,
 * `workflow` and `webhook` only inside a workflow, but one definition can run
 * both directly and as a workflow step, so validation takes the stricter
 * view. This is deliberate, not drift from the runtime scope.
 *
 * Scan the authored definition, never evaluated values, so text that an
 * evaluation produced is not flagged.
 *
 * @param data - Definition data to scan (e.g. `{ globalArguments, methods }`)
 * @param options - Declared inputs and declared foreign template fields
 */
export function scanTemplateSyntax(
  data: unknown,
  options: TemplateSyntaxScanOptions,
): TemplateSyntaxScan {
  const scope: SwampScope = {
    isBound: () => true,
    declaredInputs: options.declaredInputs,
  };
  const result: TemplateSyntaxScan = { malformed: [], foreign: [] };
  scanRecursive(data, "", false, scope, options.isDeclaredForeign, result);
  return result;
}

function scanRecursive(
  data: unknown,
  path: string,
  insideDeclared: boolean,
  scope: SwampScope,
  isDeclaredForeign: ((path: string) => boolean) | undefined,
  result: TemplateSyntaxScan,
): void {
  const declared = insideDeclared ||
    (path !== "" && (isDeclaredForeign?.(path) ?? false));
  if (typeof data === "string") {
    scanString(data, path, declared, scope, result);
  } else if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const itemPath = path ? `${path}[${i}]` : `[${i}]`;
      scanRecursive(
        data[i],
        itemPath,
        declared,
        scope,
        isDeclaredForeign,
        result,
      );
    }
  } else if (data !== null && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      const propPath = path ? `${path}.${key}` : key;
      scanRecursive(
        value,
        propPath,
        declared,
        scope,
        isDeclaredForeign,
        result,
      );
    }
  }
}

function scanString(
  value: string,
  path: string,
  declared: boolean,
  scope: SwampScope,
  result: TemplateSyntaxScan,
): void {
  const spans = expressionSpans(value);
  const insideExpression = (index: number) =>
    spans.some(([start, end]) => index >= start && index < end);
  for (const { form, pattern } of PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      if (insideExpression(match.index)) {
        if (form === "bare-double-brace") {
          result.malformed.push({
            path,
            text: match[0],
            form: "inside-expression",
          });
        }
        continue;
      }
      if (declared) continue;
      const finding = { path, text: match[0], form };
      if (isSwampExpression(match[1].trim(), scope)) {
        result.malformed.push(finding);
      } else {
        result.foreign.push(finding);
      }
    }
  }
}
