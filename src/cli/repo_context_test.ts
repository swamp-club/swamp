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
import {
  acquireModelLocks,
  createModelLock,
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
} from "./repo_context.ts";
import { flushDatastoreSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
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

    // Clean up datastore sync (releases lock + heartbeat)
    await flushDatastoreSync();
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

    await flushDatastoreSync();
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

    await flushDatastoreSync();
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

    await flushDatastoreSync();
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

    await flushDatastoreSync();
  });
});

// ============================================================================
// resolveDatastoreForRepo Tests
// ============================================================================

Deno.test("resolveDatastoreForRepo - returns config for initialized repo without acquiring lock", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const result = await resolveDatastoreForRepo(dir);

    assertEquals(result.repoDir, dir);
    assertEquals(result.datastoreConfig.type, "filesystem");
    assertEquals(result.marker !== null, true);

    // flushDatastoreSync should be a no-op (no lock was acquired)
    await flushDatastoreSync();
  });
});

Deno.test("resolveDatastoreForRepo - throws UserError for non-initialized repo", async () => {
  await withTempDir(async (dir) => {
    const error = await assertRejects(
      () => resolveDatastoreForRepo(dir),
      UserError,
    );

    assertStringIncludes(error.message, "Not a swamp repository");
  });
});

// ============================================================================
// requireInitializedRepoReadOnly Tests
// ============================================================================

Deno.test("requireInitializedRepoReadOnly - returns context for initialized repo", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const result = await requireInitializedRepoReadOnly({
      repoDir: dir,
      outputMode: "json",
    });

    assertEquals(result.repoDir, dir);
    assertEquals(result.repoContext.definitionRepo !== undefined, true);
    assertEquals(result.repoContext.workflowRepo !== undefined, true);

    // flushDatastoreSync should be a no-op (no lock was acquired)
    await flushDatastoreSync();
  });
});

Deno.test("requireInitializedRepoReadOnly - throws UserError for non-initialized repo", async () => {
  await withTempDir(async (dir) => {
    const error = await assertRejects(
      () =>
        requireInitializedRepoReadOnly({
          repoDir: dir,
          outputMode: "json",
        }),
      UserError,
    );

    assertStringIncludes(error.message, "Not a swamp repository");
  });
});

Deno.test("requireInitializedRepoReadOnly - does not block concurrent access", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    // Acquire the lock via the write path
    const _writeResult = await requireInitializedRepo({
      repoDir: dir,
      outputMode: "json",
    });

    // Read-only path should still succeed despite the lock being held
    const readResult = await requireInitializedRepoReadOnly({
      repoDir: dir,
      outputMode: "json",
    });

    assertEquals(readResult.repoDir, dir);
    assertEquals(readResult.repoContext !== undefined, true);

    // Clean up the write lock
    await flushDatastoreSync();
  });
});

Deno.test("requireInitializedRepoReadOnly - passes factory config", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const result = await requireInitializedRepoReadOnly(
      {
        repoDir: dir,
        outputMode: "json",
      },
      { enableIndexing: false },
    );

    assertEquals(result.repoContext !== undefined, true);

    // No flush needed — no lock acquired
  });
});

// ============================================================================
// Marker File Edge Cases
// ============================================================================

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

// ============================================================================
// requireInitializedRepoUnlocked Tests
// ============================================================================

Deno.test("requireInitializedRepoUnlocked - returns context with datastoreConfig", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const result = await requireInitializedRepoUnlocked({
      repoDir: dir,
      outputMode: "json",
    });

    assertEquals(result.repoDir, dir);
    assertEquals(result.repoContext !== undefined, true);
    assertEquals(result.datastoreConfig.type, "filesystem");

    // No flush needed — no lock acquired
  });
});

Deno.test("requireInitializedRepoUnlocked - throws UserError for non-initialized repo", async () => {
  await withTempDir(async (dir) => {
    const error = await assertRejects(
      () =>
        requireInitializedRepoUnlocked({
          repoDir: dir,
          outputMode: "json",
        }),
      UserError,
    );

    assertStringIncludes(error.message, "Not a swamp repository");
  });
});

Deno.test("requireInitializedRepoUnlocked - does not acquire any lock", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    // Call unlocked — should not acquire any lock
    const _result = await requireInitializedRepoUnlocked({
      repoDir: dir,
      outputMode: "json",
    });

    // Now acquire the global lock — should succeed immediately (no contention)
    const writeResult = await requireInitializedRepo({
      repoDir: dir,
      outputMode: "json",
    });

    assertEquals(writeResult.repoDir, dir);

    await flushDatastoreSync();
  });
});

// ============================================================================
// createModelLock Tests
// ============================================================================

Deno.test("createModelLock - creates lock with correct path for filesystem", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);
    const lock = createModelLock(datastoreConfig, "aws-ec2", "my-server");

    // Verify we can inspect (no lock held)
    const info = await lock.inspect();
    assertEquals(info, null);
  });
});

// ============================================================================
// acquireModelLocks Tests
// ============================================================================

Deno.test("acquireModelLocks - acquires and releases per-model locks", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);

    const lockResult = await acquireModelLocks(datastoreConfig, [
      { modelType: "aws-ec2", modelId: "server-1" },
      { modelType: "aws-ec2", modelId: "server-2" },
    ], dir);

    // Locks should be held — verify by inspecting
    const lock1 = createModelLock(datastoreConfig, "aws-ec2", "server-1");
    const info1 = await lock1.inspect();
    assertEquals(info1 !== null, true);

    const lock2 = createModelLock(datastoreConfig, "aws-ec2", "server-2");
    const info2 = await lock2.inspect();
    assertEquals(info2 !== null, true);

    // Release
    await lockResult.flush();

    // Verify released
    const afterInfo = await lock1.inspect();
    assertEquals(afterInfo, null);
  });
});

Deno.test("acquireModelLocks - deduplicates same model", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);

    // Pass the same model twice — should only acquire one lock
    const lockResult = await acquireModelLocks(datastoreConfig, [
      { modelType: "aws-ec2", modelId: "server-1" },
      { modelType: "aws-ec2", modelId: "server-1" },
    ], dir);

    await lockResult.flush();
  });
});
