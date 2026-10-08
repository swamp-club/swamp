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
 * Builds the environment for a deno subprocess whose output swamp captures
 * as text, so that output carries no ANSI escape codes whatever the calling
 * shell sets.
 *
 * `NO_COLOR` alone is not enough: deno lets `FORCE_COLOR` win at any
 * non-empty value, `0` included. Leaving `FORCE_COLOR` out of the record does
 * not help either — `Deno.Command` merges `env` over the parent environment,
 * so an absent key is still inherited. An explicit empty value replaces the
 * inherited one, and deno reads it as unset.
 *
 * Other casings of the key are dropped so the record never carries two
 * spellings of one variable on Windows, where names are case-insensitive.
 */
export function plainDenoEnv(
  baseEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.toUpperCase() !== "FORCE_COLOR") {
      env[key] = value;
    }
  }
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "";
  return env;
}
