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

// Plain only when no YAML 1.2 core type or indicator can claim the text.
const PLAIN = /^[A-Za-z_/][A-Za-z0-9_./@-]*$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n)$/i;
// The 8-4-4-4-12 hex shape matches no number, boolean or timestamp form.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// JSON leaves these raw; YAML forbids them in a stream or reads them as breaks.
const RAW_IN_JSON = /[\x7f-\x9f\u2028\u2029\ufeff\ufffe\uffff]/;
const RAW_IN_JSON_ALL = new RegExp(RAW_IN_JSON.source, "g");
// YAML caps an implicit key here; strict parsers refuse a longer one.
const MAX_IMPLICIT_KEY = 1024;

function escapeRaw(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function writeString(text: string): string {
  if ((PLAIN.test(text) && !RESERVED.test(text)) || UUID.test(text)) {
    return text;
  }
  // A JSON string literal is a YAML 1.2 double-quoted scalar.
  const quoted = JSON.stringify(text);
  return RAW_IN_JSON.test(quoted)
    ? quoted.replace(RAW_IN_JSON_ALL, escapeRaw)
    : quoted;
}

function isEmptyObject(value: object): boolean {
  for (const key in value) if (Object.hasOwn(value, key)) return false;
  return true;
}

function isCollection(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  return Array.isArray(value) ? value.length > 0 : !isEmptyObject(value);
}

function writeScalar(value: unknown): string {
  switch (typeof value) {
    case "string":
      return writeString(value);
    case "number":
    case "boolean":
      return JSON.stringify(value);
    case "object":
      if (value === null) return "null";
      return Array.isArray(value) ? "[]" : "{}";
  }
  throw new TypeError(
    `a run record holds only JSON values, not ${typeof value}`,
  );
}

// `lead` replaces `indent` on the first line, so a collection can open on its
// parent's "- " line.
function writeCollection(value: object, indent: string, lead: string): string {
  return Array.isArray(value)
    ? writeSequence(value, indent, lead)
    : writeMapping(value as Record<string, unknown>, indent, lead);
}

function writeMapping(
  map: Record<string, unknown>,
  indent: string,
  lead: string,
): string {
  let out = "";
  let prefix = lead;
  for (const key of Object.keys(map)) {
    const value = map[key];
    const written = writeString(key);
    const explicit = written.length > MAX_IMPLICIT_KEY;
    out += explicit
      ? prefix + "? " + written + "\n" + indent + ":"
      : prefix + written + ":";
    if (!isCollection(value)) {
      out += " " + writeScalar(value) + "\n";
    } else {
      // a sequence under an implicit key sits at the key's own indent
      const inner = Array.isArray(value) && !explicit ? indent : indent + "  ";
      out += "\n" + writeCollection(value, inner, inner);
    }
    prefix = indent;
  }
  return out;
}

function writeSequence(items: unknown[], indent: string, lead: string): string {
  let out = "";
  let prefix = lead;
  for (const item of items) {
    out += isCollection(item)
      ? writeCollection(item, indent + "  ", prefix + "- ")
      : prefix + "- " + writeScalar(item) + "\n";
    prefix = indent;
  }
  return out;
}

/**
 * Block-style YAML 1.2 for a JSON-clean run record, which `@std/yaml` reads back
 * as the same data; it skips the general dumper's style search, folding and
 * anchors.
 */
export function writeRunRecordYaml(record: Record<string, unknown>): string {
  return isCollection(record) ? writeMapping(record, "", "") : "{}\n";
}
