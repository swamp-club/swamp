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

import type { SyntaxNode } from "./parse.ts";

const KEYWORDS = ["import", "export"];

// Statements whose leading keyword is their own, not a nested import's.
const OWN_KEYWORD = new Set([
  "ImportDeclaration",
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
]);

// Only ASCII identifier characters are certain to make the text part of a
// longer name; any other neighbour keeps the occurrence.
function isAsciiIdentifierChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) || code === 0x5f || code === 0x24;
}

/**
 * The indexes into `body` of the top-level statements that can hold an
 * import site below their top: those whose text holds an `import` or
 * `export` keyword other than their own leading one. `body` must come from
 * a parse of `source` without error recovery.
 */
export function statementsWithNestedImports(
  body: readonly SyntaxNode[],
  source: string,
): Set<number> {
  // Every node the scan reports holds an `import` or `export` keyword in its
  // span. Babel refuses an escaped keyword and an identifier directly after
  // a number unless it recovers from errors, so the keyword text is there.
  const starts: number[] = [];
  const ends: number[] = [];
  for (const statement of body) {
    if (
      typeof statement.start !== "number" || typeof statement.end !== "number"
    ) {
      return new Set(body.keys());
    }
    starts.push(statement.start);
    ends.push(statement.end);
  }
  const deep = new Set<number>();
  for (const keyword of KEYWORDS) {
    for (
      let at = source.indexOf(keyword);
      at !== -1;
      at = source.indexOf(keyword, at + 1)
    ) {
      if (
        isAsciiIdentifierChar(source.charCodeAt(at - 1)) ||
        isAsciiIdentifierChar(source.charCodeAt(at + keyword.length))
      ) {
        continue;
      }
      const index = statementAt(starts, at);
      if (index === -1 || at >= ends[index]) continue;
      if (at === starts[index] && OWN_KEYWORD.has(body[index].type)) continue;
      deep.add(index);
    }
  }
  return deep;
}

/** The last statement starting at or before `offset`; -1 when none does. */
function statementAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
