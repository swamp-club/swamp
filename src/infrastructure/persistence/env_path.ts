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

import { markErrorPaths, UserError } from "../../domain/errors.ts";

const ENV_VAR_PATTERN =
  /^~(?=\/|$)|\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function expandEnvVars(path: string): string {
  return path.replace(ENV_VAR_PATTERN, (match, bracedVar, unbracedVar) => {
    if (match === "~") {
      const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
      if (!home) {
        throw markErrorPaths(
          new UserError(
            `Cannot expand "~" in path "${path}": neither HOME nor USERPROFILE is set`,
          ),
          [path],
        );
      }
      return home;
    }

    const varName = bracedVar ?? unbracedVar;
    const value = Deno.env.get(varName);
    if (value === undefined || value === "") {
      throw markErrorPaths(
        new UserError(
          `Environment variable "${varName}" is not set or empty (referenced in path "${path}")`,
        ),
        [path],
      );
    }
    return value;
  });
}

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
