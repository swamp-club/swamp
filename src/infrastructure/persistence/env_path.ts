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

import { UserError } from "../../domain/errors.ts";

/**
 * Pattern that matches environment variable references and tilde:
 * - `~` at start of path (before `/` or end of string)
 * - `${VAR_NAME}` — braced syntax
 * - `$VAR_NAME` — unbraced syntax
 */
const ENV_VAR_PATTERN =
  /^~(?=\/|$)|\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Expands environment variable references in a path string.
 *
 * Supports:
 * - `~` at the start of a path (expands to `$HOME` or `$USERPROFILE`)
 * - `$VAR` and `${VAR}` syntax (expands from the environment)
 *
 * Throws a `UserError` if a referenced variable is not set.
 *
 * @param path - The path string potentially containing env var references
 * @returns The path with all env var references expanded
 */
export function expandEnvVars(path: string): string {
  return path.replace(ENV_VAR_PATTERN, (match, bracedVar, unbracedVar) => {
    if (match === "~") {
      const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
      if (!home) {
        throw new UserError(
          `Cannot expand "~" in path "${path}": neither HOME nor USERPROFILE is set`,
        );
      }
      return home;
    }

    const varName = bracedVar ?? unbracedVar;
    const value = Deno.env.get(varName);
    if (value === undefined || value === "") {
      throw new UserError(
        `Environment variable "${varName}" is not set or empty (referenced in path "${path}")`,
      );
    }
    return value;
  });
}

/**
 * Collapses known environment variable values back into `$VAR` form
 * for portable storage.
 *
 * Currently collapses `$HOME` (or `$USERPROFILE` on Windows). If the path
 * starts with the value of `$HOME`, that prefix is replaced with `$HOME`.
 *
 * @param path - An absolute path to collapse
 * @returns The path with known prefixes replaced by env var references
 */
export function collapseEnvVars(path: string): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    return path;
  }

  if (path === home) {
    return "$HOME";
  }

  if (path.startsWith(home + "/")) {
    return "$HOME" + path.slice(home.length);
  }

  return path;
}
