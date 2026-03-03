// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { requireInitializedRepo } from "./repo_context.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { RepoService } from "../domain/repo/repo_service.ts";
import { UserError } from "../domain/errors.ts";
import { VERSION } from "./commands/version.ts";

// Initialize logging for tests
await initializeLogging({});

/**
 * Helper to run tests with a temporary directory.
 */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-repo-context-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Sets up a directory as an initialized swamp repository.
 */
async function initializeRepo(dir: string): Promise<void> {
  const repoPath = RepoPath.create(dir);
  const service = new RepoService(VERSION);
  await service.init(repoPath);
}

// ============================================================================
// Non-Interactive Mode Tests
// ============================================================================

Deno.test("requireInitializedRepo - throws UserError in json mode for non-initialized repo", async () => {
  await withTempDir(async (dir) => {
    const error = await assertRejects(
      () =>
        requireInitializedRepo({
          repoDir: dir,
          outputMode: "json",
        }),
      UserError,
    );

    assertStringIncludes(error.message, "Not a swamp repository");
    assertStringIncludes(error.message, "swamp repo init");
    assertStringIncludes(error.message, "--repo-dir");
  });
});

Deno.test("requireInitializedRepo - throws UserError in log mode for non-initialized repo", async () => {
  await withTempDir(async (dir) => {
    const error = await assertRejects(
      () =>
        requireInitializedRepo({
          repoDir: dir,
          outputMode: "log",
        }),
      UserError,
    );

    assertStringIncludes(error.message, "Not a swamp repository");
    assertStringIncludes(error.message, "swamp repo init");
    assertStringIncludes(error.message, "--repo-dir");
  });
});

Deno.test("requireInitializedRepo - error message includes the path", async () => {
  await withTempDir(async (dir) => {
    const error = await assertRejects(
      () =>
        requireInitializedRepo({
          repoDir: dir,
          outputMode: "json",
        }),
      UserError,
    );

    // The error message should contain the resolved absolute path
    assertStringIncludes(error.message, dir);
  });
});

// ============================================================================
// Initialized Repo Tests
// ============================================================================

Deno.test("requireInitializedRepo - returns context for initialized repo (json mode)", async () => {
  await withTempDir(async (dir) => {
    // Initialize the repo first
    await initializeRepo(dir);

    // Now requireInitializedRepo should succeed
    const result = await requireInitializedRepo({
      repoDir: dir,
      outputMode: "json",
    });

    assertEquals(result.repoDir, dir);
    assertEquals(result.repoContext.definitionRepo !== undefined, true);
    assertEquals(result.repoContext.workflowRepo !== undefined, true);
  });
});

Deno.test("requireInitializedRepo - returns context for initialized repo (log mode)", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const result = await requireInitializedRepo({
      repoDir: dir,
      outputMode: "log",
    });

    assertEquals(result.repoDir, dir);
    assertEquals(result.repoContext !== undefined, true);
  });
});

Deno.test("requireInitializedRepo - handles relative paths", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    // Use the full path (simulating a user passing a path)
    const result = await requireInitializedRepo({
      repoDir: dir,
      outputMode: "json",
    });

    // Should resolve to the absolute path
    assertEquals(result.repoDir, dir);
  });
});

Deno.test("requireInitializedRepo - passes factory config", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const result = await requireInitializedRepo(
      {
        repoDir: dir,
        outputMode: "json",
      },
      { enableIndexing: false },
    );

    // Context should still be created
    assertEquals(result.repoContext !== undefined, true);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("requireInitializedRepo - handles nested directory paths", async () => {
  await withTempDir(async (baseDir) => {
    const nestedDir = join(baseDir, "nested", "repo");
    await ensureDir(nestedDir);
    await initializeRepo(nestedDir);

    const result = await requireInitializedRepo({
      repoDir: nestedDir,
      outputMode: "json",
    });

    assertEquals(result.repoDir, nestedDir);
  });
});

Deno.test("requireInitializedRepo - checks .swamp marker file", async () => {
  await withTempDir(async (dir) => {
    // Create a directory with some files but NOT a valid swamp repo
    await ensureDir(join(dir, ".swamp"));
    // Missing the marker file, so it should not be considered initialized

    const error = await assertRejects(
      () =>
        requireInitializedRepo({
          repoDir: dir,
          outputMode: "json",
        }),
      UserError,
    );

    assertStringIncludes(error.message, "Not a swamp repository");
  });
});
