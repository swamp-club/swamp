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

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { findRepoRoot } from "./find_repo_root.ts";
import { RepoRootNotFoundError } from "./repo_root_not_found_error.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-find-repo-root-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("findRepoRoot: returns directory containing .swamp/", async () => {
  await withTempDir(async (root) => {
    await Deno.mkdir(join(root, ".swamp"));
    await Deno.mkdir(join(root, "src", "deep", "nested"), { recursive: true });

    const start = join(root, "src", "deep", "nested");
    assertPathEquals(findRepoRoot(start), root);
  });
});

Deno.test("findRepoRoot: starting in the repo root itself returns root", async () => {
  await withTempDir(async (root) => {
    await Deno.mkdir(join(root, ".swamp"));
    assertPathEquals(findRepoRoot(root), root);
  });
});

Deno.test("findRepoRoot: throws when no ancestor has .swamp/", async () => {
  await withTempDir(async (root) => {
    await Deno.mkdir(join(root, "child"));
    // Walk terminates at the FS root with no match.
    assertThrows(
      () => findRepoRoot(join(root, "child")),
      RepoRootNotFoundError,
    );
  });
});

Deno.test("findRepoRoot: nested .swamp/ — innermost wins (worktree-in-repo)", async () => {
  await withTempDir(async (outer) => {
    // Outer is a swamp repo.
    await Deno.mkdir(join(outer, ".swamp"));
    // Inner is ALSO a swamp repo, nested under outer (e.g. a worktree
    // checked out inside the parent repo's working tree).
    const inner = join(outer, "worktree");
    await Deno.mkdir(join(inner, ".swamp"), { recursive: true });
    // Start path is deep inside the inner worktree.
    const start = join(inner, "src", "deep");
    await Deno.mkdir(start, { recursive: true });

    // Innermost wins — the inner .swamp/ is found before the walk
    // reaches the outer one.
    assertPathEquals(findRepoRoot(start), inner);
  });
});

Deno.test("findRepoRoot: lexical only — does NOT realpath through symlinks", async () => {
  // Symlink semantics: if `start` is reached via a symlinked ancestor,
  // the walk must follow lexical ancestors (the symlinked path),
  // not the realpath target. This keeps catalog identity stable even
  // when the user has set up a symlinked working tree.
  if (Deno.build.os === "windows") {
    // Windows symlink creation requires admin / dev mode + an explicit
    // target type. The lexical-only contract is the same on all
    // platforms; POSIX coverage is sufficient for this fixture.
    return;
  }
  await withTempDir(async (root) => {
    // Real layout:
    //   <root>/real/.swamp/
    //   <root>/real/sub/leaf
    //   <root>/link  → symlink to <root>/real
    // We start at <root>/link/sub/leaf — a path that resolves through
    // the symlink. findRepoRoot must return <root>/link (lexical) NOT
    // <root>/real (realpath).
    const real = join(root, "real");
    await Deno.mkdir(join(real, ".swamp"), { recursive: true });
    await Deno.mkdir(join(real, "sub", "leaf"), { recursive: true });
    const link = join(root, "link");
    await Deno.symlink(real, link, { type: "dir" });

    const start = join(link, "sub", "leaf");
    // The walk goes: link/sub/leaf → link/sub → link, where link/.swamp
    // is statable (because link points at real). The returned path is
    // the lexical "link", not the realpath "real".
    assertEquals(findRepoRoot(start), link);
  });
});
