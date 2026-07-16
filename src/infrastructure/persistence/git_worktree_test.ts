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
  resolveGitMainWorktreeRoot,
} from "./git_worktree.ts";
import { assertPathEquals } from "./path_test_helpers.ts";

Deno.test("resolveGitMainWorktreeRoot: returns main checkout from main checkout", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_git_wt_" });
  clearGitWorktreeCache();
  try {
    const cmd = new Deno.Command("git", {
      args: ["init"],
      cwd: tmp,
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
    assertEquals(code, 0);

    const root = await resolveGitMainWorktreeRoot(tmp);
    assertPathEquals(root, await Deno.realPath(tmp));
  } finally {
    clearGitWorktreeCache();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveGitMainWorktreeRoot: returns main checkout from worktree", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_git_wt_" });
  clearGitWorktreeCache();
  try {
    // Init repo and create an initial commit (worktree add requires a commit)
    let cmd = new Deno.Command("git", {
      args: ["init"],
      cwd: tmp,
      stdout: "null",
      stderr: "null",
    });
    await cmd.output();
    await Deno.writeTextFile(join(tmp, "f.txt"), "x");
    cmd = new Deno.Command("git", {
      args: ["add", "."],
      cwd: tmp,
      stdout: "null",
      stderr: "null",
    });
    await cmd.output();
    cmd = new Deno.Command("git", {
      args: ["commit", "-m", "init"],
      cwd: tmp,
      stdout: "null",
      stderr: "null",
    });
    await cmd.output();

    // Create a nested worktree
    const wtDir = join(tmp, ".claude", "worktrees", "test-wt");
    cmd = new Deno.Command("git", {
      args: ["worktree", "add", "--detach", wtDir, "HEAD"],
      cwd: tmp,
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
    assertEquals(code, 0);

    const root = await resolveGitMainWorktreeRoot(wtDir);
    assertPathEquals(root, await Deno.realPath(tmp));
  } finally {
    clearGitWorktreeCache();
    // Remove worktree first to avoid git lock issues
    const cmd = new Deno.Command("git", {
      args: [
        "worktree",
        "remove",
        "--force",
        join(tmp, ".claude", "worktrees", "test-wt"),
      ],
      cwd: tmp,
      stdout: "null",
      stderr: "null",
    });
    await cmd.output().catch(() => {});
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveGitMainWorktreeRoot: falls back to dir for non-git directory", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_git_wt_" });
  clearGitWorktreeCache();
  try {
    const root = await resolveGitMainWorktreeRoot(tmp);
    assertEquals(root, tmp);
  } finally {
    clearGitWorktreeCache();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveGitMainWorktreeRoot: caches result per directory", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_git_wt_" });
  clearGitWorktreeCache();
  try {
    const r1 = await resolveGitMainWorktreeRoot(tmp);
    const r2 = await resolveGitMainWorktreeRoot(tmp);
    assertEquals(r1, r2);
    assertEquals(r1, tmp);
  } finally {
    clearGitWorktreeCache();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});
