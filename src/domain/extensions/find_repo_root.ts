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
 * Walks the lexical ancestors of `start` looking for a directory that
 * contains a `.swamp/` subdirectory. Returns the first ancestor that does
 * — i.e. the **innermost** match — so a worktree nested inside a parent
 * swamp repo resolves to its own root, not the parent's.
 *
 * **Lexical only.** This function never calls realpath / lstat. It walks
 * `start → dirname(start) → dirname(dirname(start)) → …` until either:
 *   1. A directory containing `.swamp/` is found — return that directory.
 *   2. `dirname(p)` returns `p` (filesystem root reached) — throw
 *      {@link RepoRootNotFoundError}.
 *
 * The lexical-only contract matters for symlinked layouts: if `start` is
 * inside a symlinked directory tree, the walk stays within the symlinked
 * branch and never crosses into the symlink target's true ancestors. This
 * is intentional — the catalog and the lockfile both use the lexical path
 * as identity, so a realpath here would split those identities.
 *
 * The check itself uses {@link Deno.statSync} on the candidate
 * `<ancestor>/.swamp` path. Stat is required (we can't check existence
 * without it) but is not "realpath" — it does not resolve the ancestor
 * itself, only probes for the marker.
 */
export function findRepoRoot(start: string): string {
  let current = start;
  // Loop terminates: dirname is monotonic and idempotent at the FS root.
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
