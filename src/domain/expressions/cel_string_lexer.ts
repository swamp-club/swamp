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
 * mirrors the cel-js tokenizer: a backslash always skips the next character
 * whatever the r/b prefix, since a prefix only changes decoding; no imports so
 * every expression module can use it without a cycle
 */

export const LexState = {
  Code: 0,
  Single: 1,
  Double: 2,
  TripleSingle: 3,
  TripleDouble: 4,
  Comment: 5,
} as const;

export type LexState = typeof LexState[keyof typeof LexState];

export const LEX_STATE_COUNT = 6;

export const LEX_ERROR = -1;

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

export interface LexSegment {
  kind: "code" | "string" | "comment";
  start: number;
  end: number;
}

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
 * text only this rewrite exposes to a regex (an identifier after a dot) is
 * never mistaken for a root; comments are kept, so a scan over the result stays
 * conservative
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
 * only a bare global literal call with one string-literal argument is masked;
 * anything else (literal(inputs.x)) keeps its text, so a real reference is
 * never hidden
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

function closesCall(text: string, from: number, end: number): boolean {
  let i = from;
  while (i < end && WHITESPACE.test(text[i])) i++;
  return i < end && text[i] === ")";
}

/**
 * a comment between x. and literal reads as a bare call; that only ever masks a
 * string literal's text, never a reference
 */
function isBareCallee(text: string, at: number, segmentStart: number): boolean {
  if (IDENTIFIER_CHAR.test(text[at + 7] ?? "")) return false;
  let i = at - 1;
  if (i >= 0 && IDENTIFIER_CHAR.test(text[i])) return false;
  while (i >= segmentStart && WHITESPACE.test(text[i])) i--;
  return !(i >= 0 && text[i] === ".");
}
