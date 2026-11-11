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

export type JsonPathSegment = string | number;

export interface DuplicateJsonKey {
  key: string;
  /** keys and indexes from the root to the object that repeats the key */
  path: JsonPathSegment[];
}

type Frame =
  | {
    kind: "object";
    at: JsonPathSegment;
    keys: Set<string>;
    awaitingKey: boolean;
    lastKey: string;
  }
  | { kind: "array"; at: JsonPathSegment; index: number };

/**
 * JSON.parse keeps the last of two equal keys, so a repeat is invisible once
 * parsed; content must already be accepted by JSON.parse, as malformed text
 * has no defined answer
 */
export function findDuplicateJsonKey(
  content: string,
): DuplicateJsonKey | undefined {
  // iterative, so input nested deeper than the call stack is still scanned
  const stack: Frame[] = [];
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === '"') {
      let end = i + 1;
      while (content[end] !== '"') end += content[end] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top?.kind === "object" && top.awaitingKey) {
        // decoded as JSON.parse decodes it, so escaped spellings compare equal
        const key = JSON.parse(content.slice(i, end + 1)) as string;
        if (top.keys.has(key)) {
          return { key, path: stack.slice(1).map((frame) => frame.at) };
        }
        top.keys.add(key);
        top.awaitingKey = false;
        top.lastKey = key;
      }
      i = end + 1;
      continue;
    }
    if (c === "{" || c === "[") {
      const parent = stack.at(-1);
      const at = parent === undefined
        ? ""
        : parent.kind === "object"
        ? parent.lastKey
        : parent.index;
      stack.push(
        c === "{"
          ? {
            kind: "object",
            at,
            keys: new Set(),
            awaitingKey: true,
            lastKey: "",
          }
          : { kind: "array", at, index: 0 },
      );
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      const top = stack.at(-1);
      if (top?.kind === "object") top.awaitingKey = true;
      else if (top?.kind === "array") top.index++;
    }
    i++;
  }
  return undefined;
}
