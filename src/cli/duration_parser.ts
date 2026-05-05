// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { parseDuration } from "../libswamp/mod.ts";
import { UserError } from "../domain/errors.ts";

/**
 * Parses a CLI timeout value into milliseconds. Accepts:
 *
 * - A bare integer interpreted as seconds: `1800` → 1,800,000ms. Matches
 *   the convention used by `swamp datastore sync --timeout` so knowledge
 *   transfers across commands.
 * - A `<n>s` suffix for explicit seconds: `30s` → 30,000ms.
 * - libswamp's `parseDuration` units (`m`, `h`, `d`, `w`, `mo`, `y`):
 *   `5m`, `1h`, `7d`, etc.
 *
 * Returns milliseconds, always > 0. Throws `UserError` on non-positive
 * values or unrecognized formats.
 */
export function parseTimeout(value: string): number {
  const trimmed = value.trim();

  // Bare integer → seconds (matches `swamp datastore sync --timeout`).
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (seconds <= 0) {
      throw new UserError(
        `Invalid --timeout value "${value}": must be positive`,
      );
    }
    return seconds * 1000;
  }

  // `<n>s` → seconds. parseDuration starts at minutes, so we handle this
  // case here before delegating.
  const secondsMatch = trimmed.match(/^(\d+)s$/);
  if (secondsMatch) {
    const seconds = parseInt(secondsMatch[1], 10);
    if (seconds <= 0) {
      throw new UserError(
        `Invalid --timeout value "${value}": must be positive`,
      );
    }
    return seconds * 1000;
  }

  const ms = parseDuration(trimmed);
  if (ms <= 0) {
    throw new UserError(
      `Invalid --timeout value "${value}": must be positive`,
    );
  }
  return ms;
}
