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
  parsesAsCel,
  type SwampScope,
} from "../expressions/swamp_namespaces.ts";

export type TemplateSyntaxForm =
  | "bare-double-brace"
  | "single-brace"
  | "inside-expression"
  | "unclosed-expression";

export interface TemplateSyntaxFinding {
  path: string;
  text: string;
  form: TemplateSyntaxForm;
}

export interface TemplateSyntaxScan {
  malformed: TemplateSyntaxFinding[];
  foreign: TemplateSyntaxFinding[];
}

export interface TemplateSyntaxScanOptions {
  declaredInputs: ReadonlySet<string>;
  isDeclaredForeign?: (path: string) => boolean;
}

const PATTERNS: ReadonlyArray<{ form: TemplateSyntaxForm; pattern: RegExp }> = [
  {
    // {{...}} without the $ prefix (negative lookbehind ensures no $ before)
    form: "bare-double-brace",
    pattern: /(?<!\$)\{\{(?!\{)([^}]+)\}\}/g,
  },
  {
    form: "single-brace",
    pattern: /\$\{(?!\{)([^}]+)\}/g,
  },
];

const EXPRESSION_OPENER = /\$\{\{/g;

/**
 * How many later `}}` an expression that does not parse is tried against
 * before it counts as unclosed. Bounds the parses one expression costs.
 */
const MAX_CLOSING_ATTEMPTS = 16;

/**
 * a match is malformed exactly when, with syntax corrected to ${{ }}, swamp
 * would claim it; the rest is foreign. Every match is reported. Scan the
 * authored definition, never evaluated values.
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
  const diagnoses = spans.map((_, k) => diagnoseSpan(value, spans, k));
  const spanAt = (index: number) =>
    spans.findIndex(([start, end]) => index >= start && index < end);
  const reported = new Set<number>();
  for (const { form, pattern } of PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      const span = spanAt(match.index);
      if (span !== -1) {
        if (form === "bare-double-brace" && diagnoses[span] === "cut-short") {
          reported.add(span);
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
  const lastClose = value.lastIndexOf("}}");
  let coveredUntil = 0;
  for (const opener of value.matchAll(EXPRESSION_OPENER)) {
    if (opener.index < coveredUntil) continue;
    const span = spanAt(opener.index);
    if (span === -1) {
      // Outside every span, a `${{` has no `}}` after it, or is `${{}}`.
      if (lastClose >= opener.index + 3) continue;
      const lineEnd = value.indexOf("\n", opener.index);
      coveredUntil = lineEnd === -1 ? value.length : lineEnd;
      result.malformed.push({
        path,
        text: value.slice(opener.index, coveredUntil),
        form: "unclosed-expression",
      });
      continue;
    }
    const [start, end] = spans[span];
    if (start !== opener.index) continue;
    if (diagnoses[span] === "unclosed") {
      result.malformed.push({
        path,
        text: value.slice(start, end),
        form: "unclosed-expression",
      });
    } else if (diagnoses[span] === "cut-short" && !reported.has(span)) {
      // Braces that match no `{{ ... }}`, such as a nested `${{ ... }}`,
      // are reported from their first `{{`.
      const brace = value.indexOf("{{", start + 2);
      const from = brace === -1
        ? start
        : value[brace - 1] === "$"
        ? brace - 1
        : brace;
      result.malformed.push({
        path,
        text: value.slice(from, end),
        form: "inside-expression",
      });
    }
  }
}

/**
 * judges a span that does not parse as CEL but looks cut short; later }} are
 * tried only before the next expression, at most MAX_CLOSING_ATTEMPTS, so
 * parses stay linear in the value
 */
function diagnoseSpan(
  value: string,
  spans: Array<[number, number]>,
  k: number,
): "cut-short" | "unclosed" | undefined {
  const [start, end] = spans[k];
  const inner = value.slice(start + 3, end - 2);
  // A `{{` from the opening's second brace on counts, so `${{{` does too.
  const runsOn = value.slice(start + 2, end - 2).includes("{{") ||
    hasLoneClosingBrace(inner);
  if (!runsOn || parsesAsCel(inner)) return undefined;
  const limit = k + 1 < spans.length ? spans[k + 1][0] : value.length;
  let close = value.indexOf("}}", end);
  for (
    let attempt = 0;
    attempt < MAX_CLOSING_ATTEMPTS && close !== -1 && close < limit;
    attempt++
  ) {
    if (parsesAsCel(value.slice(start + 3, close))) return "cut-short";
    close = value.indexOf("}}", close + 1);
  }
  return "unclosed";
}

/**
 * Whether the text before the first `}` is valid CEL, as when `}` was typed
 * for `}}` in `${{ self.name } && ls }}`. A `}` inside a string or a map
 * literal leaves an unterminated string or brace before it, so it never
 * counts.
 */
function hasLoneClosingBrace(inner: string): boolean {
  const brace = inner.indexOf("}");
  return brace !== -1 && parsesAsCel(inner.slice(0, brace));
}
