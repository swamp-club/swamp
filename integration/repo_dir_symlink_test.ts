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

// A repo dir given by --repo-dir or SWAMP_REPO_DIR through a symlink must
// reach the .swamp SQLite stores as its symlink-resolved path: node:sqlite
// refuses to open a database whose path runs through a symlink
// (swamp-club#3552).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveRepoDir } from "../src/cli/context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";

async function withRepoBehindSymlink(
  fn: (linkedRepoDir: string) => void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-repo-dir-symlink-" });
  try {
    const real = join(dir, "real");
    await Deno.mkdir(real);
    const link = join(dir, "link");
    await Deno.symlink(real, link, { type: "dir" });
    const repoDir = join(link, "repo");
    const homeDir = join(dir, "home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });
    fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function openStores(repoDir: string): void {
  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
  );
  catalog.close();
  const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
  assertEquals(runTracker.findAll(), []);
  runTracker.close();
}

Deno.test({
  name:
    "resolveRepoDir: a --repo-dir through a symlink opens the .swamp stores",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withRepoBehindSymlink((linkedRepoDir) => {
      withMockedEnv({ SWAMP_REPO_DIR: undefined }, () => {
        openStores(resolveRepoDir(linkedRepoDir));
      });
    }),
});

Deno.test({
  name:
    "resolveRepoDir: a SWAMP_REPO_DIR through a symlink opens the .swamp stores",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withRepoBehindSymlink((linkedRepoDir) => {
      withMockedEnv({ SWAMP_REPO_DIR: linkedRepoDir }, () => {
        openStores(resolveRepoDir(undefined));
      });
    }),
});
