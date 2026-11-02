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
import { dirname, join } from "@std/path";
import { findRepoRoot } from "./find_repo_root.ts";
import { RepoRootNotFoundError } from "./repo_root_not_found_error.ts";
import { errorPaths } from "../errors.ts";
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
    // an ancestor of the temp dir holding .swamp/ would be found instead of
    // throwing, so the no-match path is only testable when the ancestors are
    // clean
    let ancestorHasSwamp = false;
    let probe = root;
    while (true) {
      const parent = dirname(probe);
      if (parent === probe) break;
      try {
        const info = Deno.statSync(join(parent, ".swamp"));
        if (info.isDirectory) {
          ancestorHasSwamp = true;
          break;
        }
      } catch { /* not found */ }
      probe = parent;
    }
    if (ancestorHasSwamp) return;

    await Deno.mkdir(join(root, "child"));
    assertThrows(
      () => findRepoRoot(join(root, "child")),
      RepoRootNotFoundError,
    );
  });
});

Deno.test("findRepoRoot: nested .swamp/ — innermost wins (worktree-in-repo)", async () => {
  await withTempDir(async (outer) => {
    await Deno.mkdir(join(outer, ".swamp"));
    const inner = join(outer, "worktree");
    await Deno.mkdir(join(inner, ".swamp"), { recursive: true });
    const start = join(inner, "src", "deep");
    await Deno.mkdir(start, { recursive: true });

    assertPathEquals(findRepoRoot(start), inner);
  });
});

Deno.test("findRepoRoot: lexical only — does NOT realpath through symlinks", async () => {
  // the walk follows lexical ancestors, not the realpath target, so catalog
  // identity stays stable under a symlinked working tree
  if (Deno.build.os === "windows") {
    // windows symlink creation needs elevated rights and a target type; the
    // lexical contract is the same on every platform
    return;
  }
  await withTempDir(async (root) => {
    const real = join(root, "real");
    await Deno.mkdir(join(real, ".swamp"), { recursive: true });
    await Deno.mkdir(join(real, "sub", "leaf"), { recursive: true });
    const link = join(root, "link");
    await Deno.symlink(real, link, { type: "dir" });

    const start = join(link, "sub", "leaf");
    assertEquals(findRepoRoot(start), link);
  });
});

Deno.test("RepoRootNotFoundError: marks the start path (swamp-club#2830)", () => {
  const start = "/srv/acme/final report";
  assertEquals(errorPaths(new RepoRootNotFoundError(start)), [start]);
});
