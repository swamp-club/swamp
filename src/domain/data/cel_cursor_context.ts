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

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === " " || text[i] === "\t") {
      i++;
      continue;
    }

    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === "\\") j++;
        j++;
      }
      if (j < text.length) j++;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }

    if ("()[]{}:,".includes(text[i])) {
      tokens.push(text[i]);
      i++;
      continue;
    }

    if (i + 1 < text.length) {
      const twoChar = text.slice(i, i + 2);
      if (["==", "!=", ">=", "<=", "&&", "||"].includes(twoChar)) {
        tokens.push(twoChar);
        i += 2;
        continue;
      }
    }

    if ("><".includes(text[i])) {
      tokens.push(text[i]);
      i++;
      continue;
    }

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
      i++;
    }
  }
  return tokens;
}

/**
 * a token-based heuristic on the text up to the cursor, since parsing partial
 * CEL fails on incomplete expressions
 */
export function determineCursorContext(
  expression: string,
  cursorPos: number,
): CursorContext {
  const before = expression.slice(0, cursorPos);
  const trimmed = before.trimEnd();

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

  const endsWithSpace = before.length > trimmed.length;

  if (endsWithSpace) {
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

    if (isFieldLike(lastToken)) {
      return { kind: "operator", field: lastToken };
    }

    return { kind: "unknown" };
  }

  if (lastToken.includes(".")) {
    const parts = lastToken.split(".");
    const root = parts[0];
    const chain = parts.slice(1, -1);
    const prefix = parts[parts.length - 1];

    return { kind: "member", root, chain, prefix };
  }

  if (prevToken && COMPARISON_OPERATORS.has(prevToken)) {
    const field = prevPrevToken ? prevPrevToken : "";
    const prefix = lastToken.startsWith('"') || lastToken.startsWith("'")
      ? lastToken.slice(1)
      : lastToken;
    return { kind: "value", field, operator: prevToken, prefix };
  }

  if (
    prevToken &&
    (LOGICAL_OPERATORS.has(prevToken) || prevToken === "(" ||
      prevToken === ":")
  ) {
    return { kind: "root", prefix: lastToken };
  }

  if (tokens.length === 1) {
    return { kind: "root", prefix: lastToken };
  }

  return { kind: "unknown" };
}

function isFieldLike(token: string): boolean {
  return /^[a-zA-Z]/.test(token);
}
