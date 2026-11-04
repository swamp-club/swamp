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

import { createHash } from "node:crypto";
import { canonicalJson } from "../expressions/expression_references.ts";

const HASH_SUFFIX_LENGTH = 16;

function sanitizeSuffix(raw: string): string {
  return raw
    .replace(/\0/g, "")
    .replace(/\.\./g, "--")
    .replace(/[/\\]/g, "--");
}

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
  // A hash, not the JSON: item content stays out of names and paths.
  return createHash("sha256").update(canonicalJson(val)).digest("hex").slice(
    0,
    HASH_SUFFIX_LENGTH,
  );
}
