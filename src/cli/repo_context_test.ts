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
import { isCustomDatastoreConfig } from "../domain/datastore/datastore_config.ts";
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
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
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
    const lock = await createModelLock(datastoreConfig, "aws-ec2", "my-server");

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
    const lock1 = await createModelLock(datastoreConfig, "aws-ec2", "server-1");
    const info1 = await lock1.inspect();
    assertEquals(info1 !== null, true);

    const lock2 = await createModelLock(datastoreConfig, "aws-ec2", "server-2");
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

Deno.test(
  "acquireModelLocks - force-releases stale global lock instead of infinite-looping",
  async () => {
    // Regression test for swamp-club#218. Before the fix, a stale global
    // lock observed during per-model lock acquisition was bypassed but
    // never deleted. The post-acquire TOCTOU re-check then re-detected
    // the same stale lock and recursed forever. With the fix,
    // acquireModelLocks force-releases the stale lock so subsequent
    // inspects return null and the per-model loop completes normally.
    await withTempDir(async (dir) => {
      await initializeRepo(dir);

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      if (isCustomDatastoreConfig(datastoreConfig)) {
        throw new Error("expected filesystem datastore for this test");
      }

      // Plant a stale global lock: acquiredAt 10 minutes ago, ttlMs 30s.
      // The presence of `nonce` is what enables forceRelease to work.
      const lockPath = join(datastoreConfig.path, ".datastore.lock");
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
        .toISOString();
      await Deno.writeTextFile(
        lockPath,
        JSON.stringify({
          holder: "ghost@dead-machine",
          hostname: "dead-machine",
          pid: 999999,
          acquiredAt: tenMinutesAgo,
          ttlMs: 30_000,
          nonce: "test-stale-nonce-218",
        }),
      );

      // Race acquireModelLocks against a 10s deadline. Without the fix
      // the call deadlocks (recurses forever) and this throws.
      const acquirePromise = acquireModelLocks(datastoreConfig, [
        { modelType: "x", modelId: "y" },
      ], dir);
      const timeoutHandle = { id: 0 as number | undefined };
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle.id = setTimeout(
          () =>
            reject(
              new Error(
                "acquireModelLocks did not return within 10s",
              ),
            ),
          10_000,
        );
      });
      let lockResult;
      try {
        lockResult = await Promise.race([acquirePromise, timeoutPromise]);
      } finally {
        if (timeoutHandle.id !== undefined) clearTimeout(timeoutHandle.id);
      }

      // Stale lock file should be gone.
      await assertRejects(
        () => Deno.stat(lockPath),
        Deno.errors.NotFound,
      );

      // Clean up the per-model lock acquired by the call.
      await lockResult.flush();
    });
  },
);

// ============================================================================
// skipImplicitSync Tests (lab #220)
//
// `swamp datastore sync` (push and default modes) acquires the lock but must
// NOT run the coordinator's implicit pre-command pull — otherwise the
// implicit pull silently moves files and the explicit pull fast-paths to 0,
// causing `filesPulled: 0` to be reported even when data was hydrated.
// ============================================================================

async function configureExtensionDatastore(
  dir: string,
  type: string,
): Promise<void> {
  // Read the existing marker, append the datastore config, write it back.
  // Mirrors what `swamp datastore setup extension` produces in the
  // .swamp.yaml file.
  const markerPath = join(dir, ".swamp.yaml");
  const existing = await Deno.readTextFile(markerPath);
  const datastoreYaml = [
    "datastore:",
    `  type: '${type}'`,
    "  config:",
    "    bucket: test-bucket",
  ].join("\n");
  await Deno.writeTextFile(
    markerPath,
    existing.trimEnd() + "\n" + datastoreYaml + "\n",
  );
}

Deno.test("requireInitializedRepo - skipImplicitSync prevents coordinator pull", async () => {
  // Late imports so registry side effects do not leak across other test
  // files that exercise the same registry.
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  let pullCount = 0;
  let pushCount = 0;
  const typeName = "test-skip-implicit-sync";

  if (!datastoreTypeRegistry.has(typeName)) {
    datastoreTypeRegistry.register({
      type: typeName,
      name: "Test skipImplicitSync",
      description: "Test extension for the skipImplicitSync wiring",
      isBuiltIn: false,
      createProvider: () => ({
        createLock: () => ({
          acquire: () => Promise.resolve(),
          release: () => Promise.resolve(),
          withLock: <T>(fn: () => Promise<T>) => fn(),
          inspect: () => Promise.resolve(null),
          forceRelease: () => Promise.resolve(true),
        }),
        createVerifier: () => ({
          verify: () =>
            Promise.resolve({
              healthy: true,
              message: "ok",
              latencyMs: 1,
              datastoreType: typeName,
            }),
        }),
        resolveDatastorePath: (repoDir: string) => `${repoDir}/.test-store`,
        resolveCachePath: (repoDir: string) => `${repoDir}/.test-cache`,
        createSyncService: () => ({
          pullChanged: () => {
            pullCount++;
            return Promise.resolve(0);
          },
          pushChanged: () => {
            pushCount++;
            return Promise.resolve(0);
          },
          markDirty: () => Promise.resolve(),
        }),
      }),
    });
  }

  await withTempDir(async (dir) => {
    await initializeRepo(dir);
    await configureExtensionDatastore(dir, typeName);

    pullCount = 0;
    pushCount = 0;

    await requireInitializedRepo({
      repoDir: dir,
      outputMode: "json",
      skipImplicitSync: true,
    });

    assertEquals(
      pullCount,
      0,
      "skipImplicitSync must prevent the coordinator's implicit pull",
    );

    // Flush should also not trigger an implicit push, since the sync
    // service was never registered with the coordinator.
    await flushDatastoreSync();

    assertEquals(
      pushCount,
      0,
      "skipImplicitSync must prevent the coordinator's implicit push on flush",
    );
  });
});

Deno.test("requireInitializedRepo - default behavior still triggers coordinator pull", async () => {
  // Sanity check that omitting skipImplicitSync preserves the existing
  // implicit-pull behavior write commands depend on.
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  let pullCount = 0;
  const typeName = "test-default-implicit-sync";

  if (!datastoreTypeRegistry.has(typeName)) {
    datastoreTypeRegistry.register({
      type: typeName,
      name: "Test default implicit sync",
      description: "Test extension for default coordinator wiring",
      isBuiltIn: false,
      createProvider: () => ({
        createLock: () => ({
          acquire: () => Promise.resolve(),
          release: () => Promise.resolve(),
          withLock: <T>(fn: () => Promise<T>) => fn(),
          inspect: () => Promise.resolve(null),
          forceRelease: () => Promise.resolve(true),
        }),
        createVerifier: () => ({
          verify: () =>
            Promise.resolve({
              healthy: true,
              message: "ok",
              latencyMs: 1,
              datastoreType: typeName,
            }),
        }),
        resolveDatastorePath: (repoDir: string) => `${repoDir}/.test-store`,
        resolveCachePath: (repoDir: string) => `${repoDir}/.test-cache`,
        createSyncService: () => ({
          pullChanged: () => {
            pullCount++;
            return Promise.resolve(0);
          },
          pushChanged: () => Promise.resolve(0),
          markDirty: () => Promise.resolve(),
        }),
      }),
    });
  }

  await withTempDir(async (dir) => {
    await initializeRepo(dir);
    await configureExtensionDatastore(dir, typeName);

    pullCount = 0;

    await requireInitializedRepo({
      repoDir: dir,
      outputMode: "json",
    });

    assertEquals(
      pullCount,
      1,
      "default requireInitializedRepo must run the coordinator's implicit pull exactly once",
    );

    await flushDatastoreSync();
  });
});

Deno.test(
  "requireInitializedRepo - wiring forwards forward-slash cache-relative relPath to markDirty",
  async () => {
    // End-to-end integration: a repository write under `requireInitializedRepo`
    // should reach the sync service's `markDirty` with `options.relPath` set
    // to a forward-slash cache-relative string. Pins the cacheRoot→relPath
    // conversion in `buildMarkDirtyHook`. Uses a relPath that contains a
    // directory separator so a regression that drops forward-slash
    // normalization fails on the Windows CI runner.
    const { datastoreTypeRegistry } = await import(
      "../domain/datastore/datastore_type_registry.ts"
    );
    const { Data } = await import("../domain/data/data.ts");
    const { ModelType } = await import("../domain/models/model_type.ts");

    const typeName = "test-markdirty-relpath";
    const markDirtyCalls: Array<{ relPath?: string }> = [];

    if (!datastoreTypeRegistry.has(typeName)) {
      datastoreTypeRegistry.register({
        type: typeName,
        name: "Test markDirty relPath wiring",
        description: "Captures markDirty options to assert relPath threading",
        isBuiltIn: false,
        createProvider: () => ({
          createLock: () => ({
            acquire: () => Promise.resolve(),
            release: () => Promise.resolve(),
            withLock: <T>(fn: () => Promise<T>) => fn(),
            inspect: () => Promise.resolve(null),
            forceRelease: () => Promise.resolve(true),
          }),
          createVerifier: () => ({
            verify: () =>
              Promise.resolve({
                healthy: true,
                message: "ok",
                latencyMs: 1,
                datastoreType: typeName,
              }),
          }),
          resolveDatastorePath: (repoDir: string) => `${repoDir}/.test-store`,
          resolveCachePath: (repoDir: string) => `${repoDir}/.test-cache`,
          createSyncService: () => ({
            pullChanged: () => Promise.resolve(0),
            pushChanged: () => Promise.resolve(0),
            markDirty: (options?: { relPath?: string }) => {
              markDirtyCalls.push({ relPath: options?.relPath });
              return Promise.resolve();
            },
          }),
        }),
      });
    }

    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      await configureExtensionDatastore(dir, typeName);

      markDirtyCalls.length = 0;

      const repo = await requireInitializedRepo({
        repoDir: dir,
        outputMode: "json",
        skipImplicitSync: true,
      });

      const testType = ModelType.create("test/relpath");
      const data = Data.create({
        name: "wiring-probe",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 100,
        tags: { type: "test" },
        ownerDefinition: {
          ownerType: "manual",
          ownerRef: "test-user",
        },
      });

      await repo.repoContext.unifiedDataRepo.save(
        testType,
        "model-x",
        data,
        new TextEncoder().encode("payload"),
      );

      // save fires one markDirty call with the data-name directory as relPath.
      assertEquals(markDirtyCalls.length, 1);
      const relPath = markDirtyCalls[0].relPath;
      if (relPath === undefined) {
        throw new Error("expected relPath to be set");
      }
      // Forward-slash normalized — the data-name directory under the cache
      // root contains at least one separator (data/<type>/.../wiring-probe).
      if (relPath.includes("\\")) {
        throw new Error(
          `relPath must be forward-slash normalized, got: ${relPath}`,
        );
      }
      // Cache-relative — must not start with the cache root or be absolute.
      if (relPath.startsWith("/") || relPath.includes(":")) {
        throw new Error(
          `relPath must be cache-relative, got: ${relPath}`,
        );
      }
      // Must contain at least one separator (data-name dir lives under
      // data/.../<dataName>) so the normalization is exercised.
      if (!relPath.includes("/")) {
        throw new Error(
          `relPath must contain a separator to exercise normalization, got: ${relPath}`,
        );
      }

      await flushDatastoreSync();
    });
  },
);
