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
 * Flags that never take a value. Code that reads raw CLI arguments before
 * Cliffy parses them (telemetry extraction, unknown-command hints) uses this
 * set to know that the token after one of these flags is a command word or a
 * positional, not the flag's value. Without it, `swamp --log model get x`
 * would read `model` as the value of `--log`, and `--skip-checks create
 * my-def` would shift a definition name into the method slot
 * (swamp-club#3265).
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
  // Boolean flags of a method run.
  "--skip-checks",
  "--skip-reports",
  "--stdin",
  "--literal-inputs",
]);

/** Whether `option` is a flag that never takes a value. */
export function isBooleanFlag(option: string): boolean {
  return BOOLEAN_FLAGS.has(option);
}
