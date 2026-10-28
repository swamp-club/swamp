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

import { dirname, isAbsolute, join, relative, resolve } from "@std/path";

/** Where relative `.swamp-sources.yaml` paths resolve. */
export interface SourceBaseDirs {
  /** The swamp repository directory as it sits in the git main working
   * tree, so a linked worktree resolves the same sources as the main
   * checkout. */
  baseDir: string;
  /** The git main working tree root, which every release from
   * swamp-club#1174 until swamp-club#4027 used as the base. Set only when
   * it differs from `baseDir` (a repository nested below the git root), so
   * sources recorded relative to the git root in that window still
   * resolve. */
  legacyBaseDir?: string;
}

const cache = new Map<string, SourceBaseDirs>();

/**
 * Resolves the base directories for relative extension source paths.
 *
 * Relative source paths are relative to the swamp repository. In a linked
 * worktree, `baseDir` is the repository's counterpart in the main checkout.
 * When the repository is the git root, `baseDir` is the main working tree
 * root exactly as git spells it, and there is no `legacyBaseDir`. Falls
 * back to `dir` when git is unavailable or `dir` is not inside a git
 * working tree.
 */
export async function resolveSourceBaseDirs(
  dir: string,
): Promise<SourceBaseDirs> {
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;

  const result = await probeSourceBaseDirs(dir);
  cache.set(dir, result);
  return result;
}

async function probeSourceBaseDirs(dir: string): Promise<SourceBaseDirs> {
  try {
    const command = new Deno.Command("git", {
      args: [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await command.output();
    if (code !== 0) return { baseDir: dir };
    const [gitCommonDir, topLevel] = new TextDecoder().decode(stdout)
      .split("\n").map((line) => line.trim());
    if (!gitCommonDir || !topLevel) return { baseDir: dir };
    const mainRoot = dirname(gitCommonDir);
    // git prints real paths, so compare against the real path of dir.
    const below = relative(resolve(topLevel), await Deno.realPath(dir));
    if (
      below === "" || below.split(/[\\/]/)[0] === ".." ||
      isAbsolute(below)
    ) {
      return { baseDir: mainRoot };
    }
    return { baseDir: join(mainRoot, below), legacyBaseDir: mainRoot };
  } catch {
    return { baseDir: dir };
  }
}

/** Clears the internal cache. Exposed for tests only. */
export function clearGitWorktreeCache(): void {
  cache.clear();
}
