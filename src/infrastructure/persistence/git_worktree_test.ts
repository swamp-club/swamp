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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  clearGitWorktreeCache,
  resolveSourceBaseDirs,
} from "./git_worktree.ts";
import { assertPathEquals } from "./path_test_helpers.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const { code } = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@test.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(code, 0, `git ${args.join(" ")} failed`);
}

/** A git repo at `root` with one commit (worktree add requires one) and a
 * `example/` directory inside it. */
async function initRepo(root: string): Promise<void> {
  await git(root, "init");
  await Deno.mkdir(join(root, "example"));
  await Deno.writeTextFile(join(root, "example", "f.txt"), "x");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "init");
}

async function withRepo(
  fn: (root: string, worktree: string) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_git_wt_" });
  const worktree = join(tmp, ".claude", "worktrees", "test-wt");
  clearGitWorktreeCache();
  try {
    await initRepo(tmp);
    await git(tmp, "worktree", "add", "--detach", worktree, "HEAD");
    await fn(tmp, worktree);
  } finally {
    clearGitWorktreeCache();
    // Remove worktree first to avoid git lock issues
    await new Deno.Command("git", {
      args: ["worktree", "remove", "--force", worktree],
      cwd: tmp,
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {});
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test("resolveSourceBaseDirs: returns main checkout from main checkout", async () => {
  await withRepo(async (root) => {
    const dirs = await resolveSourceBaseDirs(root);
    assertPathEquals(dirs.baseDir, await Deno.realPath(root));
    assertEquals(dirs.legacyBaseDir, undefined);
  });
});

Deno.test("resolveSourceBaseDirs: returns main checkout from worktree", async () => {
  await withRepo(async (root, worktree) => {
    const dirs = await resolveSourceBaseDirs(worktree);
    assertPathEquals(dirs.baseDir, await Deno.realPath(root));
    assertEquals(dirs.legacyBaseDir, undefined);
  });
});

Deno.test("resolveSourceBaseDirs: a repo below the git root resolves from its own directory", async () => {
  await withRepo(async (root) => {
    // root is not a real path on macOS (/var -> /private/var), which the
    // relative-path computation must not trip over.
    const dirs = await resolveSourceBaseDirs(join(root, "example"));
    const realRoot = await Deno.realPath(root);
    assertPathEquals(dirs.baseDir, join(realRoot, "example"));
    assertPathEquals(dirs.legacyBaseDir!, realRoot);
  });
});

Deno.test("resolveSourceBaseDirs: a repo below a worktree root maps into the main checkout", async () => {
  await withRepo(async (root, worktree) => {
    const dirs = await resolveSourceBaseDirs(join(worktree, "example"));
    const realRoot = await Deno.realPath(root);
    assertPathEquals(dirs.baseDir, join(realRoot, "example"));
    assertPathEquals(dirs.legacyBaseDir!, realRoot);
  });
});

Deno.test("resolveSourceBaseDirs: falls back to dir for non-git directory", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_git_wt_" });
  clearGitWorktreeCache();
  try {
    const dirs = await resolveSourceBaseDirs(tmp);
    assertEquals(dirs, { baseDir: tmp });
  } finally {
    clearGitWorktreeCache();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveSourceBaseDirs: caches result per directory", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_git_wt_" });
  clearGitWorktreeCache();
  try {
    const r1 = await resolveSourceBaseDirs(tmp);
    const r2 = await resolveSourceBaseDirs(tmp);
    assertEquals(r1, r2);
    assertEquals(r1.baseDir, tmp);
  } finally {
    clearGitWorktreeCache();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});
