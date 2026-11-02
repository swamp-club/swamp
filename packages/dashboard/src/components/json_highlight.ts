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

import { escapeHtml } from "./escape_html.ts";

// the string alternative consumes a whole literal first, so numbers and
// keywords only match outside strings; lookarounds keep digits in bare words
// from reading as numbers
const JSON_TOKEN =
  /("(?:[^"\\]|\\.)*")|(?<![\w.])(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.])|\b(true|false|null)\b/g;

const KEY_SUFFIX = /\s*:/y;

/**
 * text between tokens is copied unchanged, so stripping the tags and decoding
 * the entities yields the original input
 */
export function highlightJson(raw: string): string {
  let out = "";
  let last = 0;
  for (const match of raw.matchAll(JSON_TOKEN)) {
    const [token, str, num] = match;
    const start = match.index;
    const end = start + token.length;
    out += escapeHtml(raw.slice(last, start));
    let cls: string;
    if (str !== undefined) {
      KEY_SUFFIX.lastIndex = end;
      cls = KEY_SUFFIX.test(raw) ? "code-key" : "code-string";
    } else if (num !== undefined) {
      cls = "code-number";
    } else {
      cls = token === "null" ? "code-null" : "code-boolean";
    }
    out += `<span class="${cls}">${escapeHtml(token)}</span>`;
    last = end;
  }
  return out + escapeHtml(raw.slice(last));
}
