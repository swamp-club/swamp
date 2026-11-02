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

import { dirname, join } from "@std/path";
import { RepoRootNotFoundError } from "./repo_root_not_found_error.ts";

/**
 * lexical only, never realpath, since the catalog and lockfile use the lexical
 * path as identity; innermost match wins so a nested worktree resolves to its
 * own root
 */
export function findRepoRoot(start: string): string {
  let current = start;
  while (true) {
    if (hasMarkerDir(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new RepoRootNotFoundError(start);
    }
    current = parent;
  }
}

function hasMarkerDir(candidate: string): boolean {
  try {
    const info = Deno.statSync(join(candidate, ".swamp"));
    return info.isDirectory;
  } catch {
    return false;
  }
}
