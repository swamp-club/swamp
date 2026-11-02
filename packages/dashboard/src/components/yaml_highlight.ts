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

// Leading indentation and any "- " sequence markers.
const LINE_PREFIX = /^\s*(?:-(?:\s+|$))*/;

// A mapping key: a quoted string or a plain scalar, ending at the first colon
// followed by whitespace or the end of the line.
const KEY = /("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#][^#]*?)(\s*:)(?=\s|$)/y;

// A value that is exactly one scalar token, split from any trailing comment.
const DOUBLE_QUOTED = /^"(?:[^"\\]|\\.)*"/;
const SINGLE_QUOTED = /^'(?:[^']|'')*'/;
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const BOOLEAN = /^(?:true|false)$/;
const NULL = /^(?:null|~)$/;

// "|" or ">" with optional chomping and indentation indicators.
const BLOCK_SCALAR = /^[|>][-+]?\d*[-+]?$/;

/**
 * Wraps YAML keys, scalars and comments in highlight spans. Every character
 * of the input is copied through in order, so stripping the tags and
 * decoding the entities always yields the original input. Lines inside a
 * block scalar ("key: |") are string content and are left unhighlighted.
 */
export function highlightYaml(raw: string): string {
  // Column that block-scalar content must be indented past, or -1.
  let blockIndent = -1;
  return raw.split("\n").map((line) => {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === "" || indent > blockIndent) {
        return escapeHtml(line);
      }
      blockIndent = -1;
    }
    if (line.trimStart().startsWith("#")) {
      return `<span class="code-comment">${escapeHtml(line)}</span>`;
    }

    const prefix = LINE_PREFIX.exec(line)![0];
    let out = escapeHtml(prefix);
    let pos = prefix.length;
    // A block scalar's content belongs to the key, or to the last "- ".
    let owner = prefix.lastIndexOf("-") >= 0 ? prefix.lastIndexOf("-") : indent;

    KEY.lastIndex = pos;
    const key = KEY.exec(line);
    if (key) {
      out += span("code-key", key[1]) + escapeHtml(key[2]);
      owner = pos;
      pos = KEY.lastIndex;
    }

    const rest = line.slice(pos);
    const lead = rest.length - rest.trimStart().length;
    const value = rest.slice(lead);
    out += escapeHtml(rest.slice(0, lead));
    const [scalar, tail] = splitComment(value);
    if (BLOCK_SCALAR.test(scalar.trimEnd())) blockIndent = owner;
    out += highlightScalar(scalar);
    const hash = tail.indexOf("#");
    if (hash >= 0) {
      out += escapeHtml(tail.slice(0, hash)) +
        span("code-comment", tail.slice(hash));
    } else {
      out += escapeHtml(tail);
    }
    return out;
  }).join("\n");
}

// Splits a value into its scalar part and the rest of the line, which is
// whitespace followed by an optional comment.
function splitComment(value: string): [string, string] {
  const quoted = DOUBLE_QUOTED.exec(value) ?? SINGLE_QUOTED.exec(value);
  const from = quoted ? quoted[0].length : 0;
  const comment = value.slice(from).search(/(?:^|\s)#/);
  const end = comment >= 0 ? from + comment : value.length;
  const scalar = value.slice(0, end).trimEnd();
  return [scalar, value.slice(scalar.length)];
}

function highlightScalar(scalar: string): string {
  const quoted = DOUBLE_QUOTED.exec(scalar) ?? SINGLE_QUOTED.exec(scalar);
  if (quoted?.[0] === scalar) return span("code-string", scalar);
  if (NUMBER.test(scalar)) return span("code-number", scalar);
  if (BOOLEAN.test(scalar)) return span("code-boolean", scalar);
  if (NULL.test(scalar)) return span("code-null", scalar);
  return escapeHtml(scalar);
}

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}
