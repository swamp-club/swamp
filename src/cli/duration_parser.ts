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
 * Parses a CLI timeout value like `30s`, `5m`, `1h`. Extends libswamp's
 * `parseDuration` (which is data-retention oriented and starts at
 * minutes) with second-level granularity needed for short-lived
 * cancellations. Returns milliseconds, always > 0.
 */
export function parseTimeout(value: string): number {
  const trimmed = value.trim();
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
