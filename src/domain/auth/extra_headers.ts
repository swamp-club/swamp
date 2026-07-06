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

import { UserError } from "../errors.ts";

const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "host",
  "upgrade",
  "connection",
]);

// deno-lint-ignore no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export function parseExtraHeaders(
  raw: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex < 1) {
      throw new UserError(
        `Invalid header format: expected "Name: value", got ${
          JSON.stringify(trimmed)
        }`,
      );
    }

    const name = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    validateHeaderName(name);
    validateHeaderValue(name, value);

    headers[name] = value;
  }
  return headers;
}

function validateHeaderName(name: string): void {
  if (name === "") {
    throw new UserError("Header name must not be empty");
  }
  if (CONTROL_CHAR_RE.test(name)) {
    throw new UserError(
      `Header name ${JSON.stringify(name)} contains control characters`,
    );
  }
  if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
    throw new UserError(
      `Header name ${
        JSON.stringify(name)
      } is reserved and cannot be overridden`,
    );
  }
}

function validateHeaderValue(name: string, value: string): void {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new UserError(
      `Value for header ${JSON.stringify(name)} contains control characters`,
    );
  }
}

export function resolveExtraHeaders(
  getEnv: () => string | undefined = () =>
    Deno.env.get("SWAMP_SERVE_EXTRA_HEADERS"),
): Record<string, string> {
  const raw = getEnv();
  if (!raw) return {};
  return parseExtraHeaders(raw);
}
