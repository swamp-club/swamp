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

/** Non-`text/*` media types whose content is human-readable text. */
const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
  "application/xml",
  "application/toml",
  "application/javascript",
  "application/ecmascript",
  "application/x-sh",
  "application/sql",
  "application/graphql",
]);

/** Structured-syntax suffixes (RFC 6839) of text-based formats. */
const TEXT_SUFFIXES = ["+json", "+xml", "+yaml"];

/**
 * Returns true if the content type represents human-readable text: any
 * `text/*` type, a text-based `application/*` type such as JSON, YAML, XML
 * or TOML, or a type with a text-based structured-syntax suffix such as
 * `application/vnd.api+json`. Parameters (`; charset=utf-8`) and case are
 * ignored.
 */
export function isTextContentType(contentType: string): boolean {
  const essence = contentType.split(";", 1)[0].trim().toLowerCase();
  return essence.startsWith("text/") ||
    TEXT_APPLICATION_TYPES.has(essence) ||
    TEXT_SUFFIXES.some((suffix) => essence.endsWith(suffix));
}
