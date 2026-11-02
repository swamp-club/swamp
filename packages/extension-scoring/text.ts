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

/** Text helpers the scorer applies to subprocess output it reports. */

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Removes ANSI colour codes. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

/**
 * Replaces every absolute path in a message with `<redacted>`, keeping a
 * path that starts with `safePrefix` when one is given.
 */
export function redactPaths(message: string, safePrefix = ""): string {
  return message.replace(/\/[^\s:]*/g, (match) => {
    if (safePrefix.length > 0 && match.startsWith(safePrefix)) return match;
    return "<redacted>";
  });
}
