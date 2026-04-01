// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Describes the editing context at the cursor position within a CEL expression.
 * Used to determine what autocomplete suggestions to offer.
 */
export type CursorContext =
  | { kind: "root"; prefix: string }
  | { kind: "member"; root: string; chain: string[]; prefix: string }
  | { kind: "operator"; field: string }
  | { kind: "value"; field: string; operator: string; prefix: string }
  | { kind: "unknown" };

const COMPARISON_OPERATORS = new Set([
  "==",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "in",
]);

const LOGICAL_OPERATORS = new Set(["&&", "||"]);

/**
 * Tokenizes a CEL expression substring, handling quoted strings as single tokens.
 * Returns the list of tokens with their original text.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip whitespace
    if (text[i] === " " || text[i] === "\t") {
      i++;
      continue;
    }

    // Quoted string
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === "\\") j++; // skip escaped char
        j++;
      }
      // Include closing quote if present
      if (j < text.length) j++;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }

    // Parentheses, brackets, and punctuation
    if ("()[]{}:,".includes(text[i])) {
      tokens.push(text[i]);
      i++;
      continue;
    }

    // Two-char operators: ==, !=, >=, <=, &&, ||
    if (i + 1 < text.length) {
      const twoChar = text.slice(i, i + 2);
      if (["==", "!=", ">=", "<=", "&&", "||"].includes(twoChar)) {
        tokens.push(twoChar);
        i += 2;
        continue;
      }
    }

    // Single-char operators: >, <, !
    if ("><".includes(text[i])) {
      tokens.push(text[i]);
      i++;
      continue;
    }

    // Word/identifier (includes dots for member access like tags.env)
    let j = i;
    while (
      j < text.length &&
      text[j] !== " " &&
      text[j] !== "\t" &&
      !"()[]{}:,\"'><=!&|".includes(text[j])
    ) {
      j++;
    }
    if (j > i) {
      tokens.push(text.slice(i, j));
      i = j;
    } else {
      // Skip unrecognized character
      i++;
    }
  }
  return tokens;
}

/**
 * Determines the cursor context within a CEL expression.
 *
 * Uses a token-based heuristic on the substring up to the cursor position.
 * This is more robust than parsing partial CEL (which fails on incomplete
 * expressions).
 */
export function determineCursorContext(
  expression: string,
  cursorPos: number,
): CursorContext {
  const before = expression.slice(0, cursorPos);
  const trimmed = before.trimEnd();

  // Empty or all whitespace — root context with no prefix
  if (trimmed.length === 0) {
    return { kind: "root", prefix: "" };
  }

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    return { kind: "root", prefix: "" };
  }

  const lastToken = tokens[tokens.length - 1];
  const prevToken = tokens.length >= 2 ? tokens[tokens.length - 2] : undefined;
  const prevPrevToken = tokens.length >= 3
    ? tokens[tokens.length - 3]
    : undefined;

  // Check if cursor is right after a space (user is starting a new token)
  const endsWithSpace = before.length > trimmed.length;

  if (endsWithSpace) {
    // The user has finished typing a token and pressed space.
    // What was the last complete token?

    // After a comparison operator -> value context with empty prefix
    if (COMPARISON_OPERATORS.has(lastToken) && prevToken) {
      const field = prevToken;
      return { kind: "value", field, operator: lastToken, prefix: "" };
    }

    // After a logical operator, opening paren, or colon -> root context
    // Colon appears in map literals after the key: {"key": value}
    if (
      LOGICAL_OPERATORS.has(lastToken) || lastToken === "(" ||
      lastToken === ":"
    ) {
      return { kind: "root", prefix: "" };
    }

    // After a field name -> operator context
    if (isFieldLike(lastToken)) {
      return { kind: "operator", field: lastToken };
    }

    // After a value or closing paren -> likely need a logical operator, treat as unknown
    return { kind: "unknown" };
  }

  // No trailing space — user is mid-token.

  // Token contains a dot -> member access
  if (lastToken.includes(".")) {
    const parts = lastToken.split(".");
    const root = parts[0];
    const chain = parts.slice(1, -1);
    const prefix = parts[parts.length - 1];

    return { kind: "member", root, chain, prefix };
  }

  // Previous token is a comparison operator -> value context
  if (prevToken && COMPARISON_OPERATORS.has(prevToken)) {
    const field = prevPrevToken ? prevPrevToken : "";
    // If the current token starts with a quote, strip it for the prefix
    const prefix = lastToken.startsWith('"') || lastToken.startsWith("'")
      ? lastToken.slice(1)
      : lastToken;
    return { kind: "value", field, operator: prevToken, prefix };
  }

  // Previous token is a logical operator, paren, or colon -> root context
  if (
    prevToken &&
    (LOGICAL_OPERATORS.has(prevToken) || prevToken === "(" ||
      prevToken === ":")
  ) {
    return { kind: "root", prefix: lastToken };
  }

  // First token or no recognizable previous context -> root context
  if (tokens.length === 1) {
    return { kind: "root", prefix: lastToken };
  }

  return { kind: "unknown" };
}

/** Checks if a token looks like a field reference. */
function isFieldLike(token: string): boolean {
  // Must start with a letter and contain only alphanumeric/dots
  return /^[a-zA-Z]/.test(token);
}
