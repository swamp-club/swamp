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

import { parsesAsCel } from "./cel_grammar.ts";
import {
  LEX_ERROR,
  LEX_STATE_COUNT,
  LexState,
  lexStep,
} from "./cel_string_lexer.ts";

/**
 * One `${{ ... }}` expression in a string.
 */
export interface ExpressionSpan {
  /** Offset of the opening `${{`. */
  start: number;
  /** Offset just past the closing `}}`. */
  end: number;
  /** The expression text, `${{` and `}}` included. */
  raw: string;
  /** The CEL between the braces, trimmed. */
  inner: string;
}

/**
 * Counts the work one scan does, so tests can assert it stays linear in the
 * length of the value without timing anything.
 */
export interface ScanWork {
  /** Lexer steps taken by quote-aware walks. */
  lexSteps: number;
  /** Characters handed to the CEL parser. */
  parsedChars: number;
}

const OPENER = "${{";
const CLOSER = "}}";

/**
 * Finds every `${{ ... }}` expression in a string.
 *
 * Where an expression ends is decided the same way everywhere, because the
 * raw text of an expression keys the maps that carry its value:
 *
 * 1. The legacy boundary is the first `}}` after at least one character of
 *    expression text. Every expression swamp has ever accepted ends there.
 * 2. A quote-aware walk from the opening finds the first `}}` that is not
 *    inside a CEL string literal. A `}}` inside a `//` comment still ends the
 *    expression, so a comment only keeps a quote in it from opening a string.
 * 3. When the two agree, that is the boundary. When they differ, the legacy
 *    boundary stands if its text parses as CEL, so no expression that works
 *    today changes. Otherwise the walk's boundary is used if its text parses,
 *    as in `${{ literal('{{host.name}}') }}`. Otherwise the legacy boundary
 *    stands, so malformed text is guarded and reported as it always was.
 *
 * A walk that is rejected records the lexer states it passed through. A
 * later walk that reaches one of them is rejected at once and keeps its
 * legacy boundary. Each (position, lexer state) pair is walked at most once
 * by a rejected walk, and accepted walks cover disjoint text, so the scan —
 * parsing included — is linear in the length of the value.
 *
 * A string whose `${{` has no `}}` after it has no expression there.
 */
export function scanExpressions(
  value: string,
  work?: ScanWork,
): ExpressionSpan[] {
  const spans: ExpressionSpan[] = [];
  if (!value.includes(OPENER)) return spans;
  const rejected = new Set<number>();
  let from = 0;
  for (;;) {
    const start = value.indexOf(OPENER, from);
    if (start === -1) break;
    const open = start + OPENER.length;
    const legacy = value.indexOf(CLOSER, open + 1);
    if (legacy === -1) break;
    const close = chooseClose(value, open, legacy, rejected, work);
    const end = close + CLOSER.length;
    spans.push({
      start,
      end,
      raw: value.slice(start, end),
      inner: value.slice(open, close).trim(),
    });
    from = end;
  }
  return spans;
}

/**
 * The offset of the `}}` that ends the expression whose text starts at
 * `open`, given its legacy boundary. See {@link scanExpressions}.
 */
function chooseClose(
  value: string,
  open: number,
  legacy: number,
  rejected: Set<number>,
  work: ScanWork | undefined,
): number {
  const visited: number[] = [];
  const walked = walkToClose(value, open, rejected, visited, work);
  if (walked === legacy) return legacy;
  if (walked !== undefined) {
    if (parses(value.slice(open, legacy), work)) {
      markRejected(rejected, visited);
      return legacy;
    }
    if (parses(value.slice(open, walked), work)) return walked;
  }
  markRejected(rejected, visited);
  return legacy;
}

/**
 * Walks from `open` to the first `}}` outside a string literal, recording
 * each (position, state) pair in `visited`. Returns undefined when a string
 * never ends, the value runs out, or the walk reaches a pair a rejected walk
 * already passed through.
 */
function walkToClose(
  value: string,
  open: number,
  rejected: ReadonlySet<number>,
  visited: number[],
  work: ScanWork | undefined,
): number | undefined {
  let pos = open;
  let state: LexState = LexState.Code;
  while (pos < value.length) {
    const key = pos * LEX_STATE_COUNT + state;
    if (rejected.has(key)) return undefined;
    visited.push(key);
    if (
      (state === LexState.Code || state === LexState.Comment) &&
      pos > open && value.startsWith(CLOSER, pos)
    ) {
      return pos;
    }
    if (work) work.lexSteps++;
    [pos, state] = lexStep(value, pos, state);
    if (pos === LEX_ERROR) return undefined;
  }
  return undefined;
}

function markRejected(rejected: Set<number>, visited: number[]): void {
  for (const key of visited) rejected.add(key);
}

function parses(text: string, work: ScanWork | undefined): boolean {
  const cel = text.trim();
  if (work) work.parsedChars += cel.length;
  return parsesAsCel(cel);
}

/**
 * The expression a string consists of, or null when it is not exactly one
 * `${{ ... }}` expression. Trailing whitespace is allowed unless `exact`.
 */
export function matchSingleExpression(
  value: string,
  options: { exact?: boolean } = {},
): ExpressionSpan | null {
  if (!value.startsWith(OPENER)) return null;
  const spans = scanExpressions(value);
  const span = spans[0];
  if (span === undefined || span.start !== 0) return null;
  const rest = value.slice(span.end);
  if (options.exact ? rest !== "" : rest.trim() !== "") return null;
  return span;
}

/**
 * Whether a string is one or more `${{ ... }}` expressions with only
 * whitespace around and between them.
 */
export function isExpressionsOnly(value: string): boolean {
  const spans = scanExpressions(value);
  if (spans.length === 0) return false;
  let last = 0;
  for (const span of spans) {
    if (value.slice(last, span.start).trim() !== "") return false;
    last = span.end;
  }
  return value.slice(last).trim() === "";
}

/**
 * Replaces each expression in a string with the text `replace` returns for
 * it. Replacement is by position, so an expression whose raw text also
 * appears inside another expression's string literal is never touched there.
 */
export function replaceExpressionSpans(
  value: string,
  replace: (span: ExpressionSpan) => string,
): string {
  const spans = scanExpressions(value);
  if (spans.length === 0) return value;
  let out = "";
  let last = 0;
  for (const span of spans) {
    out += value.slice(last, span.start) + replace(span);
    last = span.end;
  }
  return out + value.slice(last);
}
