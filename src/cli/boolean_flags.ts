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

/**
 * flags that never take a value; code reading raw args before Cliffy parses them
 * uses this to know the next token is a command word or positional, not the
 * flag's value (else `swamp --log model get x` reads model as --log's value).
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--log",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--no-telemetry",
  "--no-color",
  "--show-properties",
  "--force",
  "-f",
  "--help",
  "-h",
  "--version",
  "-V",
  "--dry-run",
  "--all",
  "-a",
  "--yes",
  "-y",
  "--check",
  "--verify",
  "--prune",
  "--streaming",
  "--last-evaluated",
  "--skip-checks",
  "--skip-reports",
  "--stdin",
  "--literal-inputs",
]);

export function isBooleanFlag(option: string): boolean {
  return BOOLEAN_FLAGS.has(option);
}
