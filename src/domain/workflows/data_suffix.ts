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

/** Maximum length for a coerced suffix before truncation. */
const MAX_SUFFIX_LENGTH = 64;

function sanitizeSuffix(raw: string): string {
  return raw
    .replace(/\.\./g, "--")
    .replace(/[/\\]/g, "--")
    .replace(/\0/g, "");
}

/**
 * Safely converts an unknown value to a string suitable for use as a
 * data artifact name suffix. For objects, tries common identifier
 * properties (`key`, `name`, `id`) before falling back to a truncated
 * JSON representation.
 *
 * Used by both forEach iteration (to derive per-iteration suffixes)
 * and the vary mechanism (to derive per-vary-dimension suffixes).
 */
export function coerceToSuffix(val: unknown): string {
  if (val === undefined || val === null) {
    return "";
  }
  if (typeof val !== "object") {
    return sanitizeSuffix(String(val));
  }
  const obj = val as Record<string, unknown>;
  for (const prop of ["key", "name", "id"]) {
    if (prop in obj && obj[prop] !== undefined && obj[prop] !== null) {
      return sanitizeSuffix(String(obj[prop]));
    }
  }
  const json = sanitizeSuffix(JSON.stringify(val));
  if (json.length <= MAX_SUFFIX_LENGTH) {
    return json;
  }
  return json.slice(0, MAX_SUFFIX_LENGTH);
}
