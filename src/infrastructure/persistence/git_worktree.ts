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

import { dirname } from "@std/path";

const cache = new Map<string, string>();

/**
 * Resolves the git main working tree root for a directory.
 *
 * In a worktree, this returns the main checkout root (not the worktree
 * root). In the main checkout or a non-worktree repo, this returns the
 * repo root. Falls back to `dir` when git is unavailable or `dir` is
 * not inside a git repository.
 */
export async function resolveGitMainWorktreeRoot(
  dir: string,
): Promise<string> {
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;

  try {
    const command = new Deno.Command("git", {
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await command.output();
    if (code !== 0) {
      cache.set(dir, dir);
      return dir;
    }
    const gitCommonDir = new TextDecoder().decode(stdout).trim();
    const root = dirname(gitCommonDir);
    cache.set(dir, root);
    return root;
  } catch {
    cache.set(dir, dir);
    return dir;
  }
}

/** Clears the internal cache. Exposed for tests only. */
export function clearGitWorktreeCache(): void {
  cache.clear();
}
