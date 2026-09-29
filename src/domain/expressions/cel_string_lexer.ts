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
 * The one lexer for where CEL string literals and comments begin and end.
 *
 * It mirrors the cel-js tokenizer: a string opens on `'` or `"`, in its
 * triple-quoted form when the quote is repeated three times; a backslash
 * inside a string always skips the next character, whatever the string's
 * `r`/`b` prefix (a prefix only changes how escapes are decoded, never where
 * the string ends, so prefixes are ignored here); a single-quoted string may
 * not hold a line break; and `//` starts a comment that runs to the next
 * newline. This module has no imports so every other expression module can
 * depend on it without creating a cycle.
 */

/** Where the lexer is: in code, in one of the four string forms, or in a comment. */
export const LexState = {
  Code: 0,
  Single: 1,
  Double: 2,
  TripleSingle: 3,
  TripleDouble: 4,
  Comment: 5,
} as const;

/** One of the {@link LexState} values. */
export type LexState = typeof LexState[keyof typeof LexState];

/** The number of {@link LexState} values, for packing (position, state) pairs. */
export const LEX_STATE_COUNT = 6;

/** A step of the lexer that cannot continue: an unterminated string. */
export const LEX_ERROR = -1;

/**
 * Advances the lexer by one step from `pos` in `state`.
 *
 * Returns the next position and state, or `LEX_ERROR` as the position when a
 * string cannot be terminated there (a line break in a single-quoted string,
 * or the end of the text inside a string).
 */
export function lexStep(
  text: string,
  pos: number,
  state: LexState,
): [number, LexState] {
  const ch = text[pos];
  switch (state) {
    case LexState.Code:
      if (ch === "'" || ch === '"') {
        if (text[pos + 1] === ch && text[pos + 2] === ch) {
          return [
            pos + 3,
            ch === "'" ? LexState.TripleSingle : LexState.TripleDouble,
          ];
        }
        return [pos + 1, ch === "'" ? LexState.Single : LexState.Double];
      }
      if (ch === "/" && text[pos + 1] === "/") {
        return [pos + 2, LexState.Comment];
      }
      return [pos + 1, LexState.Code];
    case LexState.Single:
    case LexState.Double: {
      const quote = state === LexState.Single ? "'" : '"';
      if (ch === "\\") {
        return pos + 2 <= text.length ? [pos + 2, state] : [LEX_ERROR, state];
      }
      if (ch === quote) return [pos + 1, LexState.Code];
      if (ch === "\n" || ch === "\r") return [LEX_ERROR, state];
      return [pos + 1, state];
    }
    case LexState.TripleSingle:
    case LexState.TripleDouble: {
      const quote = state === LexState.TripleSingle ? "'" : '"';
      if (ch === "\\") {
        return pos + 2 <= text.length ? [pos + 2, state] : [LEX_ERROR, state];
      }
      if (ch === quote && text[pos + 1] === quote && text[pos + 2] === quote) {
        return [pos + 3, LexState.Code];
      }
      return [pos + 1, state];
    }
    case LexState.Comment:
      return [pos + 1, ch === "\n" ? LexState.Code : LexState.Comment];
  }
}

/** A run of CEL text that is all code, one string literal, or one comment. */
export interface LexSegment {
  kind: "code" | "string" | "comment";
  start: number;
  end: number;
}

/**
 * Splits CEL text into code, string-literal and comment segments. An
 * unterminated string runs to the end of the text.
 */
export function lexSegments(text: string): LexSegment[] {
  const segments: LexSegment[] = [];
  let pos = 0;
  let state: LexState = LexState.Code;
  let segmentStart = 0;
  const kindOf = (s: LexState): LexSegment["kind"] =>
    s === LexState.Code
      ? "code"
      : s === LexState.Comment
      ? "comment"
      : "string";
  while (pos < text.length) {
    const [next, nextState] = lexStep(text, pos, state);
    if (next === LEX_ERROR) break;
    if (nextState !== state) {
      // A string or comment's opening belongs to it; its closing quote does too.
      const boundary = state === LexState.Code ? pos : next;
      if (boundary > segmentStart) {
        segments.push({
          kind: kindOf(state),
          start: segmentStart,
          end: boundary,
        });
      }
      segmentStart = boundary;
    }
    pos = next;
    state = nextState;
  }
  if (text.length > segmentStart) {
    segments.push({
      kind: kindOf(state),
      start: segmentStart,
      end: text.length,
    });
  }
  return segments;
}

/**
 * Replaces every CEL string literal with `""` and normalises member access,
 * so `self . tags .? env` reads `self.tags.env`. Text that only this rewrite
 * exposes to a regex (an identifier after a `.`) is then never mistaken for
 * a root. Comments are kept, so a scan over the result stays conservative.
 * Linear in the length of the text.
 */
export function stripStringLiterals(celExpression: string): string {
  let out = "";
  for (const seg of lexSegments(celExpression)) {
    if (seg.kind === "string") {
      out += '""';
      continue;
    }
    const text = celExpression.slice(seg.start, seg.end);
    out += seg.kind === "code" ? normaliseMemberAccess(text) : text;
  }
  return out;
}

const WHITESPACE = /\s/;

/**
 * Collapses whitespace around a `.` or `.?` member access to a bare `.`.
 * Each whitespace run is examined once, so the pass is linear.
 */
function normaliseMemberAccess(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (WHITESPACE.test(ch)) {
      let j = i;
      while (j < code.length && WHITESPACE.test(code[j])) j++;
      if (code[j] !== ".") out += code.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ".") {
      out += ".";
      i++;
      while (i < code.length && WHITESPACE.test(code[i])) i++;
      if (code[i] === "?") {
        i++;
        while (i < code.length && WHITESPACE.test(code[i])) i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;

/**
 * Blanks the argument of every `literal('...')` call, so regexes that look
 * for references (`self.x`, `env.X`, `vault.get(...)`) never read the text a
 * `literal()` passes through.
 *
 * Only a call whose callee is the bare global `literal` — not `x.literal`,
 * not `my_literal` — and whose only argument is one string literal is
 * masked. Anything else (`literal(inputs.x)`) keeps its text, so a real
 * reference is never hidden. Linear in the length of the text.
 */
export function maskLiteralCalls(celExpression: string): string {
  if (!celExpression.includes("literal")) return celExpression;
  const segments = lexSegments(celExpression);
  const masks: Array<[number, number]> = [];
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    if (seg.kind !== "code") continue;
    const code = celExpression.slice(seg.start, seg.end);
    let from = 0;
    for (;;) {
      const at = code.indexOf("literal", from);
      if (at === -1) break;
      from = at + 7;
      const abs = seg.start + at;
      if (!isBareCallee(celExpression, abs, seg.start)) continue;
      // `literal`, optional whitespace and `(` must end this code segment,
      // followed by exactly one string segment and then `)`.
      if (!opensCallAtSegmentEnd(celExpression, abs + 7, seg.end)) continue;
      const str = segments[k + 1];
      const after = segments[k + 2];
      if (str?.kind !== "string") continue;
      if (
        after?.kind !== "code" ||
        !closesCall(celExpression, after.start, after.end)
      ) {
        continue;
      }
      masks.push([str.start, str.end]);
    }
  }
  if (masks.length === 0) return celExpression;
  let out = "";
  let last = 0;
  for (const [start, end] of masks) {
    out += celExpression.slice(last, start) + '""';
    last = end;
  }
  return out + celExpression.slice(last);
}

/**
 * Whether the text from `from` to `end` is optional whitespace, `(`, optional
 * whitespace and an optional raw-string prefix — the opening of a call whose
 * argument is the string literal starting at `end`.
 */
function opensCallAtSegmentEnd(
  text: string,
  from: number,
  end: number,
): boolean {
  let i = from;
  while (i < end && WHITESPACE.test(text[i])) i++;
  if (text[i] !== "(") return false;
  i++;
  while (i < end && WHITESPACE.test(text[i])) i++;
  if (i < end && (text[i] === "r" || text[i] === "R")) i++;
  return i === end;
}

/** Whether the text from `from` is optional whitespace then `)`. */
function closesCall(text: string, from: number, end: number): boolean {
  let i = from;
  while (i < end && WHITESPACE.test(text[i])) i++;
  return i < end && text[i] === ")";
}

/**
 * Whether `literal` at `at` names the global function: it is not part of a
 * longer identifier, and is not a member reached through `.`.
 */
function isBareCallee(text: string, at: number, segmentStart: number): boolean {
  if (IDENTIFIER_CHAR.test(text[at + 7] ?? "")) return false;
  let i = at - 1;
  if (i >= 0 && IDENTIFIER_CHAR.test(text[i])) return false;
  while (i >= segmentStart && WHITESPACE.test(text[i])) i--;
  return !(i >= 0 && text[i] === ".");
}
