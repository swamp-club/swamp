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

import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ensureDir, exists, walk } from "@std/fs";
import { configure, type LogRecord } from "@logtape/logtape";
import { join, resolve } from "@std/path";
import { hostname } from "node:os";
import { createRecordingSyncService } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { HydrateContractViolationError } from "../domain/datastore/datastore_sync_service.ts";
import {
  acquireModelLocks,
  assertManagedConfigWritable,
  attachSignalWaits,
  buildMarkDirtyHook,
  createLockProgressWriter,
  createModelLock,
  createWorkflowRunClaims,
  createWorkflowRunLock,
  datastoreGlobalLockOptions,
  type DrainWaits,
  ensureManagedConfigBase,
  flushSinglePhasePush,
  flushTwoPhasePush,
  type LockProgressWriter,
  ManagedConfigUnresolvedError,
  MODEL_LOCK_MAX_BACKOFF_MS,
  MODEL_LOCK_RETRY_INTERVAL_MS,
  type PerModelLockScan,
  reclaimModelLocks,
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveContinuationClaims,
  resolveDatastoreForRepo,
  resolveManagedConfigPaths,
  resolveManagedLockfileForWrite,
  resolveSignalWaitSupport,
  runRecordCurrencyOver,
  runsLiveInDatastore,
  runUnderModelLocks,
  signalWaitsOf,
  waitForPerModelLocks,
} from "./repo_context.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { InMemorySignalWaitStore } from "../domain/workflows/signal_wait_store_test_helpers.ts";
import { YamlWorkflowRunRepository } from "../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import { SignalWait } from "../domain/workflows/signal_wait.ts";
import {
  registrationOf,
  type WaitRegistration,
} from "../domain/workflows/signal_wait_records.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import {
  DRAIN_WAIT_TTL_MS,
  type DrainWait,
} from "../domain/datastore/drain_wait.ts";
import {
  DRAIN_WAITS_DIR,
  DrainWaitStore,
} from "../infrastructure/persistence/drain_wait_store.ts";
import {
  processLockHolderMarker,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_PID,
  SWAMP_LOCK_HOLDER_TOKENS,
} from "../domain/datastore/lock_holder_marker.ts";
import {
  flushDatastoreSync,
  getRegisteredLockKeys,
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { FileLock } from "../infrastructure/persistence/file_lock.ts";
import {
  assertPathEquals,
  withMockedEnv,
} from "../infrastructure/persistence/path_test_helpers.ts";
import {
  isManagedConfigBaseResolved,
  resolvePulledExtensionsRoot,
} from "../infrastructure/persistence/paths.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import {
  getAutoResolver,
  setAutoResolver,
} from "../domain/extensions/auto_resolver_context.ts";
import {
  type AutoResolveOutputPort,
  ExtensionAutoResolver,
} from "../domain/extensions/extension_auto_resolver.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import type {
  DatastoreSyncService,
  PushManifest,
} from "../domain/datastore/datastore_sync_service.ts";
import { CatalogStore } from "../infrastructure/persistence/catalog_store.ts";
import {
  type LockInfo,
  LockTimeoutError,
  LockWaitCycleError,
} from "../domain/datastore/distributed_lock.ts";
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
  // Keep the global skill install inside `dir` — the ambient HOME is shared
  // with every other test file in the process.
  const homeDir = join(dir, "test-home");
  const service = new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  });
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
// requireInitializedRepoReadOnly pull Tests (swamp-club#2151)
// ============================================================================

async function configureManagedConfigDatastore(
  dir: string,
  type: string,
): Promise<void> {
  const markerPath = join(dir, ".swamp.yaml");
  const existing = await Deno.readTextFile(markerPath);
  const datastoreYaml = [
    "datastore:",
    `  type: '${type}'`,
    "  config:",
    "    bucket: test-bucket",
    "  managedConfig: true",
  ].join("\n");
  await Deno.writeTextFile(
    markerPath,
    existing.trimEnd() + "\n" + datastoreYaml + "\n",
  );
}

Deno.test("requireInitializedRepoReadOnly - pull calls pullChanged when managedConfig is active", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  let pullCount = 0;
  let pullSubdirs: readonly string[] | undefined;
  const typeName = "test-readonly-pull";

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test readonly pull",
    description: "Test extension for readonly pull wiring",
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
        pullChanged: (opts?: { subdirs?: readonly string[] }) => {
          pullCount++;
          pullSubdirs = opts?.subdirs;
          return Promise.resolve(0);
        },
        pushChanged: () => Promise.resolve(0),
        markDirty: () => Promise.resolve(),
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      await configureManagedConfigDatastore(dir, typeName);

      pullCount = 0;
      pullSubdirs = undefined;

      await requireInitializedRepoReadOnly({
        repoDir: dir,
        outputMode: "json",
        pull: true,
      });

      assertEquals(pullCount, 1, "pull: true must call pullChanged once");
      assertEquals(
        pullSubdirs,
        ["config"],
        "pull must restrict to config subdirectory",
      );
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

Deno.test("requireInitializedRepoReadOnly - pull is no-op without managedConfig", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const result = await requireInitializedRepoReadOnly({
      repoDir: dir,
      outputMode: "json",
      pull: true,
    });

    assertEquals(result.repoDir, dir);
    assertEquals(result.managedConfig, false);
  });
});

Deno.test("requireInitializedRepoReadOnly - pullChanged failure throws UserError", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = "test-readonly-pull-fail";

  if (!datastoreTypeRegistry.has(typeName)) {
    datastoreTypeRegistry.register({
      type: typeName,
      name: "Test readonly pull fail",
      description: "Test extension for readonly pull failure",
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
            throw new Error("network unreachable");
          },
          pushChanged: () => Promise.resolve(0),
          markDirty: () => Promise.resolve(),
        }),
      }),
    });
  }

  await withTempDir(async (dir) => {
    await initializeRepo(dir);
    await configureManagedConfigDatastore(dir, typeName);

    const error = await assertRejects(
      () =>
        requireInitializedRepoReadOnly({
          repoDir: dir,
          outputMode: "json",
          pull: true,
        }),
      UserError,
    );

    assertStringIncludes(error.message, "Failed to pull config");
    assertStringIncludes(error.message, "network unreachable");
  });
});

Deno.test("requireInitializedRepoReadOnly - returns managedConfig state", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const result = await requireInitializedRepoReadOnly({
      repoDir: dir,
      outputMode: "json",
    });

    assertEquals(result.managedConfig, false);
  });
});

// ============================================================================
// Marker File Edge Cases
// ============================================================================

Deno.test("requireInitializedRepo - orphaned .swamp/ without marker reports distinct error", async () => {
  await withTempDir(async (dir) => {
    await ensureDir(join(dir, ".swamp"));

    const error = await assertRejects(
      () =>
        requireInitializedRepo({
          repoDir: dir,
          outputMode: "json",
        }),
      UserError,
    );

    assertStringIncludes(error.message, "Found a .swamp/ directory");
    assertStringIncludes(error.message, "no .swamp.yaml marker");
    assertStringIncludes(error.message, "remote datastore");
  });
});

Deno.test("resolveDatastoreForRepo - orphaned .swamp/ without marker reports distinct error", async () => {
  await withTempDir(async (dir) => {
    await ensureDir(join(dir, ".swamp"));

    const error = await assertRejects(
      () => resolveDatastoreForRepo(dir),
      UserError,
    );

    assertStringIncludes(error.message, "Found a .swamp/ directory");
    assertStringIncludes(error.message, "no .swamp.yaml marker");
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

Deno.test("createWorkflowRunLock - uses the per-model lock's short retry settings", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);
    const lock = await createWorkflowRunLock(
      datastoreConfig,
      crypto.randomUUID(),
    );

    assertEquals(await lock.inspect(), null);
    assertEquals(
      (lock as FileLock).retryIntervalMs,
      MODEL_LOCK_RETRY_INTERVAL_MS,
    );
    assertEquals((lock as FileLock).maxBackoffMs, MODEL_LOCK_MAX_BACKOFF_MS);
  });
});

Deno.test("createWorkflowRunLock - refuses an id that is not a run id", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);
    // The id is part of the lock file's path.
    await assertRejects(
      () => createWorkflowRunLock(datastoreConfig, "../../outside"),
      UserError,
      "Not a workflow run id",
    );
  });
});

Deno.test("createWorkflowRunClaims - holds the run's lock for the callback and releases it after", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);
    const runId = crypto.randomUUID();
    const otherRunId = crypto.randomUUID();
    const claims = createWorkflowRunClaims(datastoreConfig);
    const observer = await createWorkflowRunLock(datastoreConfig, runId);
    const otherObserver = await createWorkflowRunLock(
      datastoreConfig,
      otherRunId,
    );

    const result = await claims.withClaim(runId, async () => {
      assertEquals((await observer.inspect())?.pid, Deno.pid);
      // Another run's claim is free.
      assertEquals(await otherObserver.inspect(), null);
      return "done";
    });

    assertEquals(result, "done");
    assertEquals(await observer.inspect(), null);
  });
});

Deno.test("createWorkflowRunClaims - releases the lock when the callback throws", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);
    const runId = crypto.randomUUID();
    const claims = createWorkflowRunClaims(datastoreConfig);

    await assertRejects(
      () => claims.withClaim(runId, () => Promise.reject(new Error("boom"))),
      Error,
      "boom",
    );

    const observer = await createWorkflowRunLock(datastoreConfig, runId);
    assertEquals(await observer.inspect(), null);
  });
});

Deno.test("createModelLock - retries promptly on brief contention", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);
    const lock = await createModelLock(datastoreConfig, "aws-ec2", "my-server");

    // Per-model locks are brief, so the first retry must not sleep through
    // a release. Asserted on configuration, not elapsed time — wall-clock
    // assertions are banned by the repo's flakiness rules.
    assertEquals(
      (lock as FileLock).retryIntervalMs,
      MODEL_LOCK_RETRY_INTERVAL_MS,
    );
  });
});

Deno.test("createModelLock - caps backoff so queued waiters stay near the release", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);

    const { datastoreConfig } = await resolveDatastoreForRepo(dir);
    const lock = await createModelLock(datastoreConfig, "aws-ec2", "my-server");

    // A workflow step holds the per-model lock for its whole method run, so
    // forEach iterations on one instance queue behind it. Without a small cap
    // the tail waiter sleeps up to 8s after each release (swamp-club#2870).
    assertEquals(
      (lock as FileLock).maxBackoffMs,
      MODEL_LOCK_MAX_BACKOFF_MS,
    );
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
      const timeoutHandle: { id: ReturnType<typeof setTimeout> | undefined } = {
        id: undefined,
      };
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

  try {
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
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

Deno.test("requireInitializedRepo - default behavior still triggers coordinator pull", async () => {
  // Sanity check that omitting skipImplicitSync preserves the existing
  // implicit-pull behavior write commands depend on.
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  let pullCount = 0;
  const typeName = "test-default-implicit-sync";

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

  try {
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
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
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

    try {
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
    } finally {
      datastoreTypeRegistry.invalidateType(typeName);
    }
  },
);

Deno.test(
  "requireInitializedRepo - hydrateFile hook converts absolute path to cache-relative",
  async () => {
    const { datastoreTypeRegistry } = await import(
      "../domain/datastore/datastore_type_registry.ts"
    );
    const { Data } = await import("../domain/data/data.ts");
    const { ModelType } = await import("../domain/models/model_type.ts");

    const typeName = "test-hydratefile-relpath";
    const hydrateFileCalls: string[] = [];

    datastoreTypeRegistry.register({
      type: typeName,
      name: "Test hydrateFile relPath wiring",
      description:
        "Captures hydrateFile relPath to assert absolute→cache-relative conversion",
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
        createSyncService: (_repoDir: string, cachePath: string) => ({
          pullChanged: () => Promise.resolve(0),
          pushChanged: () => Promise.resolve(0),
          markDirty: () => Promise.resolve(),
          hydrateFile: (relPath: string) => {
            hydrateFileCalls.push(relPath);
            // Write the file so getContent retries successfully
            const absPath = join(cachePath, ...relPath.split("/"));
            Deno.mkdirSync(join(absPath, ".."), { recursive: true });
            Deno.writeFileSync(
              absPath,
              new TextEncoder().encode("hydrated"),
            );
            return Promise.resolve(true);
          },
          capabilities: () => ({ scopedSync: true, lazyHydration: true }),
        }),
      }),
    });

    try {
      await withTempDir(async (dir) => {
        await initializeRepo(dir);
        await configureExtensionDatastore(dir, typeName);

        hydrateFileCalls.length = 0;

        const repo = await requireInitializedRepo({
          repoDir: dir,
          outputMode: "json",
          skipImplicitSync: true,
        });

        const testType = ModelType.create("test/hydrate");
        const data = Data.create({
          name: "hydrate-probe",
          contentType: "text/plain",
          lifetime: "infinite",
          garbageCollection: 100,
          tags: { type: "test" },
          ownerDefinition: {
            ownerType: "manual",
            ownerRef: "test-user",
          },
        });

        // Save data then delete the raw file to simulate lazy hydration state
        await repo.repoContext.unifiedDataRepo.save(
          testType,
          "model-h",
          data,
          new TextEncoder().encode("original"),
        );
        const contentPath = repo.repoContext.unifiedDataRepo.getContentPath(
          testType,
          "model-h",
          "hydrate-probe",
          1,
        );
        await Deno.remove(contentPath);

        // getContent should trigger hydrateFile through the wired hook
        const result = await repo.repoContext.unifiedDataRepo.getContent(
          testType,
          "model-h",
          "hydrate-probe",
          1,
        );

        assertExists(result);
        assertEquals(new TextDecoder().decode(result), "hydrated");

        // The hydrateFile call must receive a cache-relative, forward-slash path
        assertEquals(hydrateFileCalls.length, 1);
        const relPath = hydrateFileCalls[0];

        // Must be cache-relative (not absolute)
        if (relPath.startsWith("/") || relPath.includes(":")) {
          throw new Error(
            `hydrateFile relPath must be cache-relative, got: ${relPath}`,
          );
        }
        // Must be forward-slash normalized
        if (relPath.includes("\\")) {
          throw new Error(
            `hydrateFile relPath must be forward-slash normalized, got: ${relPath}`,
          );
        }
        // Must include the data/ prefix so extensions can map to S3 keys
        assertStringIncludes(relPath, "data/");
        // Must end with /raw (the content file)
        assertStringIncludes(relPath, "/raw");

        await flushDatastoreSync();
      });
    } finally {
      datastoreTypeRegistry.invalidateType(typeName);
    }
  },
);

/**
 * Runs `fn` against a repo on a lazy-capable extension datastore whose
 * `hydrateFile` is `hydrate`, with one data item saved and its `raw` file
 * removed, as lazy hydration leaves it.
 */
async function withUnhydratedContent(
  hydrate: (cachePath: string, relPath: string) => boolean,
  fn: (
    repo: Awaited<ReturnType<typeof requireInitializedRepo>>,
    typeName: string,
    read: () => Promise<Uint8Array | null>,
    contentPath: string,
    repoDir: string,
  ) => Promise<void>,
): Promise<void> {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );
  const { Data } = await import("../domain/data/data.ts");
  const { ModelType } = await import("../domain/models/model_type.ts");

  const typeName = `test-hydrate-contract-${crypto.randomUUID()}`;
  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test hydrateFile contract",
    description: "hydrateFile with a configurable outcome",
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
      createSyncService: (_repoDir: string, cachePath: string) => ({
        pullChanged: () => Promise.resolve(0),
        pushChanged: () => Promise.resolve(0),
        markDirty: () => Promise.resolve(),
        hydrateFile: (relPath: string) =>
          Promise.resolve(hydrate(cachePath, relPath)),
        capabilities: () => ({ scopedSync: true, lazyHydration: true }),
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      await configureExtensionDatastore(dir, typeName);
      const repo = await requireInitializedRepo({
        repoDir: dir,
        outputMode: "json",
        skipImplicitSync: true,
      });
      const dataRepo = repo.repoContext.unifiedDataRepo;
      const testType = ModelType.create("test/hydrate");
      await dataRepo.save(
        testType,
        "model-h",
        Data.create({
          name: "hydrate-probe",
          contentType: "text/plain",
          lifetime: "infinite",
          garbageCollection: 100,
          tags: { type: "test" },
          ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
        }),
        new TextEncoder().encode("original"),
      );
      const contentPath = dataRepo.getContentPath(
        testType,
        "model-h",
        "hydrate-probe",
        1,
      );
      await Deno.remove(contentPath);
      try {
        await fn(
          repo,
          typeName,
          () => dataRepo.getContent(testType, "model-h", "hydrate-probe", 1),
          contentPath,
          dir,
        );
      } finally {
        await flushDatastoreSync();
      }
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
}

function writeHydrated(path: string): void {
  Deno.mkdirSync(join(path, ".."), { recursive: true });
  Deno.writeFileSync(path, new TextEncoder().encode("hydrated"));
}

Deno.test(
  "requireInitializedRepo - hydrateFile hook rejects a success that wrote no file",
  async () => {
    const relPaths: string[] = [];
    await withUnhydratedContent(
      (_cachePath, relPath) => {
        relPaths.push(relPath);
        return true;
      },
      async (_repo, typeName, read, contentPath) => {
        const captured: LogRecord[] = [];
        await configure({
          sinks: { capture: (record: LogRecord) => captured.push(record) },
          loggers: [
            {
              category: ["cli", "datastore"],
              lowestLevel: "warning",
              sinks: ["capture"],
            },
          ],
          reset: true,
        });
        let error: HydrateContractViolationError;
        try {
          error = await assertRejects(read, HydrateContractViolationError);
        } finally {
          await initializeLogging({ _reset: true });
        }
        // Callers that swallow getContent errors leave this warning as the
        // only trace of the violation.
        const warnings = captured
          .filter((r) => r.level === "warning")
          .map((r) => r.message.map((p) => String(p)).join(""));
        assertEquals(warnings.length, 1);
        assertStringIncludes(warnings[0], "reported hydrateFile success");
        assertStringIncludes(warnings[0], contentPath);
        assertEquals(error.datastoreType, typeName);
        assertEquals(error.relPath, relPaths[0]);
        assertPathEquals(error.absPath, contentPath);
        assertStringIncludes(error.message, typeName);
        assertStringIncludes(error.message, relPaths[0]);
        assertStringIncludes(error.message, contentPath);
      },
    );
  },
);

Deno.test(
  "requireInitializedRepo - hydrateFile hook rejects a success that wrote to the wrong place",
  async () => {
    await withUnhydratedContent(
      (cachePath, relPath) => {
        // The swamp-club#2404 shape: the first segment is doubled.
        const segments = relPath.split("/");
        writeHydrated(join(cachePath, segments[0], ...segments));
        return true;
      },
      async (_repo, _typeName, read) => {
        await assertRejects(read, HydrateContractViolationError);
      },
    );
  },
);

Deno.test(
  "requireInitializedRepo - hydrateFile hook returns the content a datastore wrote",
  async () => {
    await withUnhydratedContent(
      (cachePath, relPath) => {
        writeHydrated(join(cachePath, ...relPath.split("/")));
        return true;
      },
      async (_repo, _typeName, read) => {
        const content = await read();
        assertExists(content);
        assertEquals(new TextDecoder().decode(content), "hydrated");
      },
    );
  },
);

Deno.test(
  "requireInitializedRepo - hydrateFile hook passes a datastore's false through",
  async () => {
    await withUnhydratedContent(
      () => false,
      async (_repo, _typeName, read) => {
        assertEquals(await read(), null);
      },
    );
  },
);

Deno.test(
  "requireInitializedRepo - hydrateFile hook does not verify a path outside the cache",
  async () => {
    await withUnhydratedContent(
      () => true,
      async (repo, _typeName, _read, _contentPath, repoDir) => {
        const hook = repo.repoContext.hydrateFile;
        assertExists(hook);
        const outside = join(repoDir, ".swamp", "data", "absent", "raw");
        assertEquals(await hook(outside), true);
      },
    );
  },
);

// ============================================================================
// waitForPerModelLocks Tests
// ============================================================================
//
// `waitForPerModelLocks` is called twice by `requireInitializedRepo` —
// once before acquiring the global lock, and once after — to close the
// symmetric TOCTOU window between drain and global-lock acquisition that
// caused issue #234 (data delete failing with ENOTEMPTY against a
// concurrent writer). These tests exercise the polling primitive with an
// injected scanner so the regression coverage is deterministic.

/** A scan that counts `held` locks, none held for an ancestor's other run. */
const heldCount = (held: number): PerModelLockScan => ({
  held,
  heldForOtherRuns: [],
  skippedLockIds: [],
  waitedLocks: [],
});

Deno.test(
  "waitForPerModelLocks - returns immediately when no locks are held",
  async () => {
    let calls = 0;
    const scanner = (): Promise<PerModelLockScan> => {
      calls++;
      return Promise.resolve(heldCount(0));
    };

    const start = Date.now();
    await waitForPerModelLocks("/unused/datastore/path", undefined, {
      findModelLocks: scanner,
    });
    const elapsed = Date.now() - start;

    // No polling loop entered — single scan call, no setTimeout delay.
    assertEquals(calls, 1);
    assertEquals(
      elapsed < 500,
      true,
      `expected immediate return, elapsed=${elapsed}ms`,
    );
  },
);

Deno.test(
  "waitForPerModelLocks - polls until scanner reports no held locks",
  async () => {
    // Sequence simulates a per-model lock that releases after the second
    // poll: initial scan sees 1 (enter wait loop), first poll sees 1
    // (keep polling), second poll sees 0 (exit). The drain must not
    // return until the scanner reports 0.
    const sequence = [1, 1, 0];
    let i = 0;
    const scanner = (): Promise<PerModelLockScan> => {
      const next = sequence[Math.min(i, sequence.length - 1)];
      i++;
      return Promise.resolve(heldCount(next));
    };

    const start = Date.now();
    await waitForPerModelLocks("/unused/datastore/path", undefined, {
      findModelLocks: scanner,
    });
    const elapsed = Date.now() - start;

    // 3 calls: initial check + 2 polls (the second poll observes 0 and
    // breaks). Polling cadence is 1s; allow some slack for scheduler
    // overhead but require at least one poll interval.
    assertEquals(i, 3);
    assertEquals(
      elapsed >= 1_000,
      true,
      `expected to wait at least one poll interval, elapsed=${elapsed}ms`,
    );
  },
);

Deno.test(
  "waitForPerModelLocks - throws LockTimeoutError when locks are not released within timeout",
  async () => {
    const scanner = (): Promise<PerModelLockScan> =>
      Promise.resolve(heldCount(1));

    await assertRejects(
      async () => {
        // Force a short timeout via env var to keep the test fast
        await withMockedEnv(
          { SWAMP_LOCK_TIMEOUT_MS: "2000" },
          () =>
            waitForPerModelLocks(
              "/unused/datastore/path",
              undefined,
              { findModelLocks: scanner },
            ),
        );
      },
      LockTimeoutError,
    );
  },
);

Deno.test(
  "waitForPerModelLocks - uses custom progressWriter when provided",
  async () => {
    const sequence = [1, 0];
    let i = 0;
    const scanner = (): Promise<PerModelLockScan> => {
      const next = sequence[Math.min(i, sequence.length - 1)];
      i++;
      return Promise.resolve(heldCount(next));
    };

    const messages: string[] = [];
    const writer: LockProgressWriter = (msg) => {
      messages.push(msg);
    };

    await waitForPerModelLocks(
      "/unused/datastore/path",
      undefined,
      { findModelLocks: scanner, progressWriter: writer },
    );

    assertEquals(messages.length, 2);
    assertStringIncludes(messages[0], "Waiting for 1 per-model lock");
    assertStringIncludes(messages[1], "Per-model locks released");
  },
);

Deno.test(
  "createLockProgressWriter - formats with custom label",
  () => {
    const captured: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(String(args[0]));
    };
    try {
      const writer = createLockProgressWriter("my-model");
      writer("test message");
      assertEquals(captured.length, 1);
      assertStringIncludes(captured[0], "my-model");
      assertStringIncludes(captured[0], "│");
      assertStringIncludes(captured[0], "test message");
    } finally {
      console.error = originalError;
    }
  },
);

Deno.test(
  "requireInitializedRepo - second drain catches a per-model lock that " +
    "appears between the first drain and the global lock acquisition " +
    "(regression for issue #234)",
  async () => {
    // End-to-end coverage that the symmetric drain is wired through
    // `requireInitializedRepo`. Higher-fidelity timing-driven coverage
    // (a real concurrent writer racing a real delete) lives in
    // integration/data_delete_test.ts; this test only verifies the
    // wiring exists by writing a lock file and confirming
    // `requireInitializedRepo` succeeds without skipping it.
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      if (isCustomDatastoreConfig(datastoreConfig)) {
        throw new Error("expected filesystem datastore for this test");
      }

      // Pre-write a stale per-model lock file. Stale locks are ignored
      // by the scanner (the bug is about *live* writers); this test
      // confirms `requireInitializedRepo` traverses the symmetric drain
      // code path twice without the stale lock blocking it.
      const lockDir = join(
        datastoreConfig.path,
        "data",
        "aws-ec2",
        "test-server",
      );
      await ensureDir(lockDir);
      const lockFile = join(lockDir, ".lock");
      await Deno.writeTextFile(
        lockFile,
        JSON.stringify({
          holder: "stale@host",
          hostname: "host",
          pid: 1,
          // 10 minutes old + 30s TTL = stale
          acquiredAt: new Date(Date.now() - 600_000).toISOString(),
          ttlMs: 30_000,
        }),
      );

      const ctx = await requireInitializedRepo({
        repoDir: dir,
        outputMode: "json",
      });
      assertEquals(typeof ctx.repoDir, "string");
      await flushDatastoreSync();
    });
  },
);

// ============================================================================
// waitForPerModelLocks — Parent-Process Lock Awareness Tests
// ============================================================================
//
// These tests use real lock files in a temp directory so the default scanner
// exercises the PID-matching code path (the findModelLocksOverride seam
// bypasses it).

Deno.test(
  "waitForPerModelLocks - skips locks held by parent process (SWAMP_LOCK_HOLDER_PID)",
  async () => {
    await withTempDir(async (dir) => {
      const lockDir = join(dir, "data", "command-shell", "test-model");
      await ensureDir(lockDir);
      const lockFile = join(lockDir, ".lock");
      const parentPid = 99999;
      await Deno.writeTextFile(
        lockFile,
        JSON.stringify({
          holder: "parent@host",
          hostname: hostname(),
          pid: parentPid,
          acquiredAt: new Date().toISOString(),
          ttlMs: 30_000,
        }),
      );

      await withMockedEnv(
        {
          [SWAMP_LOCK_HOLDER_PID]: String(parentPid),
          [SWAMP_LOCK_ANCESTOR_PIDS]: undefined,
        },
        async () => {
          const start = Date.now();
          await waitForPerModelLocks(dir);
          const elapsed = Date.now() - start;

          assertEquals(
            elapsed < 500,
            true,
            `expected immediate return when parent lock is skipped, elapsed=${elapsed}ms`,
          );
        },
      );
    });
  },
);

Deno.test(
  "waitForPerModelLocks - does not skip locks from a different PID",
  async () => {
    await withTempDir(async (dir) => {
      const lockDir = join(dir, "data", "command-shell", "test-model");
      await ensureDir(lockDir);
      const lockFile = join(lockDir, ".lock");
      // Write a fresh lock with a different PID
      const otherPid = 88888;
      await Deno.writeTextFile(
        lockFile,
        JSON.stringify({
          holder: "other@host",
          hostname: "host",
          pid: otherPid,
          acquiredAt: new Date().toISOString(),
          ttlMs: 2_000,
        }),
      );

      await withMockedEnv({
        [SWAMP_LOCK_HOLDER_PID]: "77777",
        [SWAMP_LOCK_ANCESTOR_PIDS]: undefined,
      }, async () => {
        const start = Date.now();
        // The lock has a 2s TTL; the scanner will count it on the first
        // pass, enter the wait loop, and eventually see it as stale.
        await waitForPerModelLocks(dir);
        const elapsed = Date.now() - start;

        assertEquals(
          elapsed >= 1_000,
          true,
          `expected to wait for non-parent lock to go stale, elapsed=${elapsed}ms`,
        );
      });
    });
  },
);

Deno.test(
  "waitForPerModelLocks - no env var preserves existing wait behavior",
  async () => {
    await withTempDir(async (dir) => {
      const lockDir = join(dir, "data", "command-shell", "test-model");
      await ensureDir(lockDir);
      const lockFile = join(lockDir, ".lock");
      await Deno.writeTextFile(
        lockFile,
        JSON.stringify({
          holder: "writer@host",
          hostname: "host",
          pid: 66666,
          acquiredAt: new Date().toISOString(),
          ttlMs: 2_000,
        }),
      );

      await withMockedEnv({
        [SWAMP_LOCK_HOLDER_PID]: undefined,
        [SWAMP_LOCK_ANCESTOR_PIDS]: undefined,
      }, async () => {
        const start = Date.now();
        await waitForPerModelLocks(dir);
        const elapsed = Date.now() - start;

        assertEquals(
          elapsed >= 1_000,
          true,
          `expected to wait for lock to go stale without env var, elapsed=${elapsed}ms`,
        );
      });
    });
  },
);

Deno.test(
  "waitForPerModelLocks - skips locks held by every ancestor on this host",
  async () => {
    await withTempDir(async (dir) => {
      const writeLock = async (
        model: string,
        pid: number,
        host: string,
        ttlMs: number,
      ) => {
        const lockDir = join(dir, "data", "command-shell", model);
        await ensureDir(lockDir);
        await Deno.writeTextFile(
          join(lockDir, ".lock"),
          JSON.stringify({
            holder: `swamp@${host}`,
            hostname: host,
            pid,
            acquiredAt: new Date().toISOString(),
            ttlMs,
          }),
        );
      };
      // Two ancestors hold long-lived locks on this host. An unrelated
      // writer, and a process on another host sharing the datastore with
      // an ancestor's pid, hold locks that go stale shortly, ending the
      // wait.
      await writeLock("grandparent-model", 11111, hostname(), 30_000);
      await writeLock("parent-model", 22222, hostname(), 30_000);
      await writeLock("other-model", 33333, hostname(), 1_500);
      await writeLock("remote-model", 11111, "another-machine", 1_500);

      const messages: string[] = [];
      await withMockedEnv(
        {
          [SWAMP_LOCK_HOLDER_PID]: "22222",
          [SWAMP_LOCK_ANCESTOR_PIDS]: "11111,22222",
        },
        async () => {
          await waitForPerModelLocks(
            dir,
            undefined,
            { progressWriter: (msg) => messages.push(msg) },
          );
        },
      );

      assertEquals(
        messages.some((m) => m.includes("Waiting for 2 per-model lock(s)")),
        true,
        `expected only the non-ancestor and other-host locks to be counted, got ${
          JSON.stringify(messages)
        }`,
      );
    });
  },
);

/** Writes a per-model lock file for `model` under `dir`. */
async function writeModelLock(
  dir: string,
  model: string,
  lock: { pid: number; ttlMs: number; nonce?: string; host?: string },
): Promise<void> {
  const lockDir = join(dir, "data", "command-shell", model);
  await ensureDir(lockDir);
  const host = lock.host ?? hostname();
  await Deno.writeTextFile(
    join(lockDir, ".lock"),
    JSON.stringify({
      holder: `swamp@${host}`,
      hostname: host,
      pid: lock.pid,
      acquiredAt: new Date().toISOString(),
      ttlMs: lock.ttlMs,
      ...(lock.nonce ? { nonce: lock.nonce } : {}),
    }),
  );
}

/** Writes an empty per-model lock file for `model`, as a holder mid-write leaves it. */
async function writeEmptyModelLock(
  dir: string,
  model: string,
): Promise<string> {
  const lockDir = join(dir, "data", "command-shell", model);
  await ensureDir(lockDir);
  const lockPath = join(lockDir, ".lock");
  await Deno.writeTextFile(lockPath, "");
  return lockPath;
}

Deno.test(
  "waitForPerModelLocks - waits on a fresh unreadable lock file until it is gone",
  async () => {
    await withTempDir(async (dir) => {
      // A holder caught mid-write: the file exists but is empty
      // (swamp-club#3148). The holder releases once the drain is waiting.
      const lockPath = await writeEmptyModelLock(dir, "writer-model");

      const messages: string[] = [];
      await waitForPerModelLocks(dir, undefined, {
        pollIntervalMs: 10,
        progressWriter: (msg) => {
          messages.push(msg);
          if (msg.includes("Waiting for")) Deno.removeSync(lockPath);
        },
      });

      assertEquals(
        messages.some((m) => m.includes("Waiting for 1 per-model lock(s)")),
        true,
        `expected the unreadable lock to be counted, got ${
          JSON.stringify(messages)
        }`,
      );
    });
  },
);

Deno.test(
  "waitForPerModelLocks - ignores an unreadable lock file untouched for a full TTL",
  async () => {
    await withTempDir(async (dir) => {
      const lockPath = await writeEmptyModelLock(dir, "crashed-model");
      const past = new Date(Date.now() - 120_000);
      await Deno.utime(lockPath, past, past);

      const messages: string[] = [];
      await waitForPerModelLocks(dir, undefined, {
        progressWriter: (msg) => messages.push(msg),
      });

      assertEquals(messages, []);
    });
  },
);

Deno.test(
  "waitForPerModelLocks - skips the lock a parent holds for this run and waits on its other runs' locks",
  async () => {
    await withTempDir(async (dir) => {
      // The parent (22222) runs two steps in parallel. This command was
      // started by the step holding "run-a"; "run-b" is the sibling step's
      // lock, which goes stale shortly and ends the wait.
      await writeModelLock(dir, "step-a-model", {
        pid: 22222,
        ttlMs: 30_000,
        nonce: "run-a",
      });
      await writeModelLock(dir, "step-b-model", {
        pid: 22222,
        ttlMs: 1_500,
        nonce: "run-b",
      });

      const messages: string[] = [];
      await withMockedEnv(
        {
          [SWAMP_LOCK_HOLDER_PID]: "22222",
          [SWAMP_LOCK_ANCESTOR_PIDS]: "22222",
          [SWAMP_LOCK_HOLDER_TOKENS]: "22222:run-a",
        },
        async () => {
          await waitForPerModelLocks(
            dir,
            undefined,
            { progressWriter: (msg) => messages.push(msg) },
          );
        },
      );

      assertEquals(
        messages.some((m) => m.includes("Waiting for 1 per-model lock(s)")),
        true,
        `expected only the sibling step's lock to be counted, got ${
          JSON.stringify(messages)
        }`,
      );
    });
  },
);

Deno.test(
  "waitForPerModelLocks - matches on the pid when the parent handed down no held locks",
  async () => {
    await withTempDir(async (dir) => {
      // An older parent, or a spawn outside any held-lock scope: no list
      // for 22222, so both of its locks are skipped, as before.
      await writeModelLock(dir, "step-a-model", {
        pid: 22222,
        ttlMs: 30_000,
        nonce: "run-a",
      });
      await writeModelLock(dir, "step-b-model", {
        pid: 22222,
        ttlMs: 30_000,
        nonce: "run-b",
      });

      const messages: string[] = [];
      await withMockedEnv(
        {
          [SWAMP_LOCK_HOLDER_PID]: "22222",
          [SWAMP_LOCK_ANCESTOR_PIDS]: "22222",
          [SWAMP_LOCK_HOLDER_TOKENS]: undefined,
        },
        async () => {
          await waitForPerModelLocks(
            dir,
            undefined,
            { progressWriter: (msg) => messages.push(msg) },
          );
        },
      );

      assertEquals(messages, []);
    });
  },
);

Deno.test(
  "waitForPerModelLocks - a timeout on a parent's other-run lock explains the wait",
  async () => {
    await withTempDir(async (dir) => {
      await writeModelLock(dir, "step-b-model", {
        pid: 22222,
        ttlMs: 30_000,
        nonce: "run-b",
      });
      await writeModelLock(dir, "unrelated-model", {
        pid: 33333,
        ttlMs: 30_000,
        nonce: "other",
      });

      const error = await withMockedEnv(
        {
          [SWAMP_LOCK_HOLDER_PID]: "22222",
          [SWAMP_LOCK_ANCESTOR_PIDS]: "22222",
          [SWAMP_LOCK_HOLDER_TOKENS]: "22222:run-a",
          SWAMP_LOCK_TIMEOUT_MS: "1000",
        },
        () =>
          assertRejects(
            () =>
              waitForPerModelLocks(dir, undefined, {
                progressWriter: () => {},
              }),
            LockTimeoutError,
          ),
      );

      assertStringIncludes(error.message, "waiting on 2 per-model lock(s)");
      assertStringIncludes(error.message, "1 of them");
      assertStringIncludes(
        error.message,
        join("data", "command-shell", "step-b-model", ".lock"),
      );
      assertStringIncludes(error.message, "held by swamp pid 22222");
      assertStringIncludes(error.message, "one at a time");
    });
  },
);

Deno.test(
  "waitForPerModelLocks - a timeout on unrelated locks keeps the plain message",
  async () => {
    const error = await withMockedEnv(
      { SWAMP_LOCK_TIMEOUT_MS: "1000" },
      () =>
        assertRejects(
          () =>
            waitForPerModelLocks(
              "/unused/datastore/path",
              undefined,
              {
                findModelLocks: () => Promise.resolve(heldCount(1)),
                progressWriter: () => {},
              },
            ),
          LockTimeoutError,
        ),
    );

    assertStringIncludes(error.message, `Lock "per-model locks"`);
    assertEquals(error.message.includes("one at a time"), false);
  },
);

// ============================================================================
// waitForPerModelLocks — drain-wait cycle detection (swamp-club#2981)
// ============================================================================

/** A scan of a drain that skips "mine" and waits on "theirs". */
const nestedScan = (): PerModelLockScan => ({
  held: 1,
  heldForOtherRuns: [],
  skippedLockIds: ["mine"],
  waitedLocks: [{
    lockId: "theirs",
    lockPath: join("data", "command-shell", "their-model", ".lock"),
  }],
});

/** The other side of {@link nestedScan}: skips "theirs", waits on "mine". */
function opponentWait(overrides: Partial<DrainWait> = {}): DrainWait {
  return {
    id: "opponent",
    pid: 4242,
    hostname: "host",
    startedAtMs: 0,
    updatedAtMs: Date.now(),
    ttlMs: DRAIN_WAIT_TTL_MS,
    skipping: ["theirs"],
    waitingOn: ["mine"],
    ...overrides,
  };
}

/** In-memory drain-wait markers: this drain's own, plus `others()`. */
function fakeDrainWaits(others: () => DrainWait[]): {
  waits: DrainWaits;
  published: DrainWait[];
  own: () => string[];
} {
  const own = new Map<string, DrainWait>();
  const published: DrainWait[] = [];
  return {
    waits: {
      publish: (wait) => {
        published.push(wait);
        own.set(wait.id, wait);
        return Promise.resolve();
      },
      list: () => Promise.resolve([...own.values(), ...others()]),
      remove: (id) => {
        own.delete(id);
        return Promise.resolve();
      },
    },
    published,
    own: () => [...own.keys()],
  };
}

/** A scanner that reports `scan` `times` times, then no held locks. */
function scanTimes(
  scan: PerModelLockScan,
  times: number,
): () => Promise<PerModelLockScan> {
  let calls = 0;
  return () => Promise.resolve(calls++ < times ? scan : heldCount(0));
}

Deno.test(
  "waitForPerModelLocks - gives way to an earlier drain it waits on and that waits on it",
  async () => {
    // The opponent refreshes its marker between this drain's polls.
    let refreshes = 0;
    const base = Date.now() - 1_000;
    const markers = fakeDrainWaits(
      () => [opponentWait({ updatedAtMs: base + refreshes++ })],
    );

    const error = await assertRejects(
      () =>
        waitForPerModelLocks("/unused/datastore/path", undefined, {
          findModelLocks: () => Promise.resolve(nestedScan()),
          progressWriter: () => {},
          drainWaits: markers.waits,
          pollIntervalMs: 0,
        }),
      LockWaitCycleError,
    );

    assertEquals(error.code, "lock_wait_cycle");
    assertEquals(error.opponentPid, 4242);
    assertStringIncludes(error.message, "swamp pid 4242");
    assertStringIncludes(
      error.message,
      join("data", "command-shell", "their-model", ".lock"),
    );
    assertStringIncludes(error.message, "one at a time");
    // One sighting is not enough: it published once, saw the opponent,
    // and gave way only after seeing it again with a newer marker.
    assertEquals(markers.published.length, 2);
    assertEquals(markers.published[0].skipping, ["mine"]);
    assertEquals(markers.published[0].waitingOn, ["theirs"]);
    assertEquals(markers.own(), []);
  },
);

Deno.test(
  "waitForPerModelLocks - does not give way to a marker that is never refreshed",
  async () => {
    // A drain that was killed, or has moved on, stops refreshing.
    const stale = opponentWait();
    const markers = fakeDrainWaits(() => [stale]);

    await waitForPerModelLocks("/unused/datastore/path", undefined, {
      findModelLocks: scanTimes(nestedScan(), 5),
      progressWriter: () => {},
      drainWaits: markers.waits,
      pollIntervalMs: 0,
    });

    assertEquals(markers.published.length, 5);
    assertEquals(markers.own(), []);
  },
);

Deno.test(
  "waitForPerModelLocks - keeps waiting when it started before the drain it waits on",
  async () => {
    let refreshes = 0;
    const later = Date.now() + 60_000;
    const markers = fakeDrainWaits(
      () => [
        opponentWait({ startedAtMs: later, updatedAtMs: refreshes++ + later }),
      ],
    );

    await waitForPerModelLocks("/unused/datastore/path", undefined, {
      findModelLocks: scanTimes(nestedScan(), 5),
      progressWriter: () => {},
      drainWaits: markers.waits,
      pollIntervalMs: 0,
    });

    assertEquals(markers.own(), []);
  },
);

Deno.test(
  "waitForPerModelLocks - does not give way to a drain that waits on none of its locks",
  async () => {
    let refreshes = 0;
    const base = Date.now() - 1_000;
    const markers = fakeDrainWaits(
      () => [
        opponentWait({ waitingOn: ["other"], updatedAtMs: base + refreshes++ }),
      ],
    );

    await waitForPerModelLocks("/unused/datastore/path", undefined, {
      findModelLocks: scanTimes(nestedScan(), 5),
      progressWriter: () => {},
      drainWaits: markers.waits,
      pollIntervalMs: 0,
    });

    assertEquals(markers.published.length, 5);
    assertEquals(markers.own(), []);
  },
);

Deno.test(
  "waitForPerModelLocks - publishes no marker when it skips no lock",
  async () => {
    const markers = fakeDrainWaits(() => [opponentWait()]);

    await waitForPerModelLocks("/unused/datastore/path", undefined, {
      findModelLocks: scanTimes({ ...nestedScan(), skippedLockIds: [] }, 3),
      progressWriter: () => {},
      drainWaits: markers.waits,
      pollIntervalMs: 0,
    });

    assertEquals(markers.published, []);
  },
);

Deno.test(
  "waitForPerModelLocks - withdraws its marker once it no longer skips a lock",
  async () => {
    const markers = fakeDrainWaits(() => []);
    const scans = [
      nestedScan(),
      { ...nestedScan(), skippedLockIds: [] },
      { ...nestedScan(), skippedLockIds: [] },
    ];
    let calls = 0;
    const ownAfterEachScan: number[] = [];

    await waitForPerModelLocks("/unused/datastore/path", undefined, {
      findModelLocks: () => {
        ownAfterEachScan.push(markers.own().length);
        return Promise.resolve(scans[calls++] ?? heldCount(0));
      },
      progressWriter: () => {},
      drainWaits: markers.waits,
      pollIntervalMs: 0,
    });

    // Published after the first scan, withdrawn after the second.
    assertEquals(ownAfterEachScan, [0, 1, 0, 0]);
  },
);

Deno.test(
  "waitForPerModelLocks - removes its marker when the wait times out",
  async () => {
    const markers = fakeDrainWaits(() => []);

    await withMockedEnv(
      { SWAMP_LOCK_TIMEOUT_MS: "20" },
      () =>
        assertRejects(
          () =>
            waitForPerModelLocks("/unused/datastore/path", undefined, {
              findModelLocks: () => Promise.resolve(nestedScan()),
              progressWriter: () => {},
              drainWaits: markers.waits,
              pollIntervalMs: 1,
            }),
          LockTimeoutError,
        ),
    );

    assertEquals(markers.published.length > 0, true);
    assertEquals(markers.own(), []);
  },
);

Deno.test(
  "waitForPerModelLocks - keeps waiting when the markers cannot be written or read",
  async () => {
    // An opponent this drain would give way to, if it could use markers.
    let refreshes = 0;
    const base = Date.now() - 1_000;
    const opponent = () => [opponentWait({ updatedAtMs: base + refreshes++ })];
    const cases: Array<
      { broken: Partial<DrainWaits>; others: () => DrainWait[] }
    > = [
      {
        broken: { publish: () => Promise.reject(new Error("read-only")) },
        others: opponent,
      },
      {
        broken: { list: () => Promise.reject(new Error("unreadable")) },
        others: opponent,
      },
      {
        broken: { remove: () => Promise.reject(new Error("busy")) },
        others: () => [],
      },
    ];
    for (const { broken, others } of cases) {
      const markers = fakeDrainWaits(others);

      await waitForPerModelLocks("/unused/datastore/path", undefined, {
        findModelLocks: scanTimes(nestedScan(), 3),
        progressWriter: () => {},
        drainWaits: { ...markers.waits, ...broken },
        pollIntervalMs: 0,
      });
    }
  },
);

Deno.test(
  "waitForPerModelLocks - a nested drain publishes the locks it skips and waits on, and removes the marker",
  async () => {
    await withTempDir(async (dir) => {
      await writeModelLock(dir, "step-a-model", {
        pid: 22222,
        ttlMs: 30_000,
        nonce: "run-a",
      });
      await writeModelLock(dir, "step-b-model", {
        pid: 22222,
        ttlMs: 30_000,
        nonce: "run-b",
      });
      const siblingLock = join(
        dir,
        "data",
        "command-shell",
        "step-b-model",
        ".lock",
      );
      const store = new DrainWaitStore(dir);
      const onDisk: DrainWait[] = [];

      await withMockedEnv(
        {
          [SWAMP_LOCK_HOLDER_PID]: "22222",
          [SWAMP_LOCK_ANCESTOR_PIDS]: "22222",
          [SWAMP_LOCK_HOLDER_TOKENS]: "22222:run-a",
        },
        () =>
          waitForPerModelLocks(dir, undefined, {
            pollIntervalMs: 0,
            progressWriter: () => {},
            drainWaits: {
              publish: (wait) => store.publish(wait),
              // The sibling step ends once the marker has been read back.
              list: async (nowMs) => {
                const waits = await store.list(nowMs);
                onDisk.push(...waits);
                await Deno.remove(siblingLock);
                return waits;
              },
              remove: (id) => store.remove(id),
            },
          }),
      );

      assertEquals(onDisk.length, 1);
      assertEquals(onDisk[0].skipping, ["run-a"]);
      assertEquals(onDisk[0].waitingOn, ["run-b"]);
      assertEquals(onDisk[0].pid, Deno.pid);
      const left: string[] = [];
      for await (const entry of Deno.readDir(join(dir, DRAIN_WAITS_DIR))) {
        left.push(entry.name);
      }
      assertEquals(left, []);
    });
  },
);

Deno.test(
  "waitForPerModelLocks - a lock skipped on the pid alone is not published as held for this drain",
  async () => {
    await withTempDir(async (dir) => {
      // The parent handed down no lock list, so its lock is skipped on the
      // pid. It may be held for another run and released first, so it must
      // not let another drain conclude the two wait on each other.
      await writeModelLock(dir, "parent-model", {
        pid: 22222,
        ttlMs: 30_000,
        nonce: "run-a",
      });
      await writeModelLock(dir, "unrelated-model", {
        pid: 33333,
        ttlMs: 30_000,
        nonce: "other",
      });
      const markers = fakeDrainWaits(() => [
        opponentWait({ skipping: ["other"], waitingOn: ["run-a"] }),
      ]);
      const messages: string[] = [];

      await withMockedEnv(
        {
          [SWAMP_LOCK_HOLDER_PID]: "22222",
          [SWAMP_LOCK_ANCESTOR_PIDS]: "22222",
          [SWAMP_LOCK_HOLDER_TOKENS]: undefined,
        },
        () =>
          waitForPerModelLocks(dir, undefined, {
            pollIntervalMs: 0,
            drainWaits: markers.waits,
            // The unrelated run ends once this drain has begun to wait.
            progressWriter: (message) => {
              if (messages.push(message) === 1) {
                Deno.removeSync(
                  join(
                    dir,
                    "data",
                    "command-shell",
                    "unrelated-model",
                    ".lock",
                  ),
                );
              }
            },
          }),
      );

      assertEquals(messages.length, 2);
      assertEquals(markers.published, []);
    });
  },
);

Deno.test(
  "acquireModelLocks - returns the nonces of the lock files it wrote",
  async () => {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      if (isCustomDatastoreConfig(datastoreConfig)) {
        throw new Error("expected filesystem datastore for this test");
      }

      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: "aws-ec2", modelId: "server-1" },
        { modelType: "aws-ec2", modelId: "server-2" },
      ], dir);
      try {
        const written: string[] = [];
        for await (
          const entry of walk(datastoreConfig.path, { match: [/\.lock$/] })
        ) {
          const info = JSON.parse(await Deno.readTextFile(entry.path));
          if (info.nonce) written.push(info.nonce);
        }
        assertEquals(lockResult.heldLockIds.length, 2);
        assertEquals([...lockResult.heldLockIds].sort(), written.sort());
      } finally {
        await lockResult.flush();
      }
    });
  },
);

Deno.test(
  "runUnderModelLocks - a method run's event stream sees the locks it took",
  async () => {
    // The method body runs inside an async generator, as libswamp's
    // modelMethodRun does; its spawns read the scope of whoever iterates.
    async function* methodRun(): AsyncGenerator<Record<string, string>> {
      await Promise.resolve();
      yield processLockHolderMarker.childLockEnv();
    }
    const consume = async () => {
      const seen: Record<string, string>[] = [];
      for await (const env of methodRun()) seen.push(env);
      return seen;
    };

    await withMockedEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: undefined }, async () => {
      assertEquals(
        await runUnderModelLocks({
          lentLocks: {
            lockIds: () => ["n1", "n2"],
            reclaim: () => Promise.resolve(),
          },
        }, consume),
        [{ [SWAMP_LOCK_HOLDER_TOKENS]: `${Deno.pid}:n1+n2` }],
      );
      // A non-mutating run takes no lock and still gets a scope.
      assertEquals(await runUnderModelLocks(undefined, consume), [
        { [SWAMP_LOCK_HOLDER_TOKENS]: `${Deno.pid}:` },
      ]);
      // Outside the helper nothing is handed down for this process.
      assertEquals(await consume(), [{}]);
    });
  },
);

// ============================================================================
// acquireModelLocks — lock holder marker (swamp-club#2659)
// ============================================================================

Deno.test(
  "acquireModelLocks - keeps this process as the lock holder across overlapping holders' flushes",
  async () => {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      // The chain is compared with the value read before acquiring: under a
      // swamp shell step (verify-build) the test process inherits one.
      const chainBefore = Deno.env.get(SWAMP_LOCK_ANCESTOR_PIDS);
      const readMarker = () => [
        Deno.env.get(SWAMP_LOCK_HOLDER_PID),
        Deno.env.get(SWAMP_LOCK_ANCESTOR_PIDS),
      ];
      const holding = [String(Deno.pid), chainBefore];

      const first = await acquireModelLocks(
        datastoreConfig,
        [{ modelType: "test-type", modelId: "first-model" }],
        dir,
      );
      const second = await acquireModelLocks(
        datastoreConfig,
        [{ modelType: "test-type", modelId: "second-model" }],
        dir,
      );
      assertEquals(readMarker(), holding, "set while both hold locks");

      // Flushing one holder used to delete the marker while the other
      // still held its lock.
      await first.flush();
      assertEquals(readMarker(), holding, "kept after the first flush");

      await second.flush();
      assertEquals(readMarker(), holding, "kept after the last flush");
    });
  },
);

// ============================================================================
// acquireModelLocks SyncCapabilities Tests
// ============================================================================

Deno.test("acquireModelLocks - scopedSync passes SyncContext to pull and push", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = "test-scoped-sync";
  const pullArgs: unknown[] = [];
  const pushArgs: unknown[] = [];

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test scoped sync",
    description: "Test extension for scoped sync capability",
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
        pullChanged: (options?: unknown) => {
          pullArgs.push(options);
          return Promise.resolve(1);
        },
        pushChanged: (options?: unknown) => {
          pushArgs.push(options);
          return Promise.resolve(0);
        },
        markDirty: () => Promise.resolve(),
        capabilities: () => ({ scopedSync: true }),
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      await configureExtensionDatastore(dir, typeName);

      pullArgs.length = 0;
      pushArgs.length = 0;

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: "aws-ec2", modelId: "server-1" },
      ], dir);

      assertEquals(lockResult.synced, true);
      // Custom datastore locks are never scanned by the drain.
      assertEquals(lockResult.heldLockIds, []);
      assertEquals(pullArgs.length, 1);

      const pullOpts = pullArgs[0] as {
        context?: { models: Array<{ modelType: string; modelId: string }> };
      };
      assertExists(pullOpts?.context, "pullChanged must receive context");
      assertEquals(pullOpts.context.models.length, 1);
      assertEquals(pullOpts.context.models[0].modelType, "aws-ec2");
      assertEquals(pullOpts.context.models[0].modelId, "server-1");

      await lockResult.flush();

      assertEquals(pushArgs.length, 1);
      const pushOpts = pushArgs[0] as {
        context?: { models: Array<{ modelType: string; modelId: string }> };
      };
      assertExists(pushOpts?.context, "pushChanged must receive context");
      assertEquals(pushOpts.context.models.length, 1);
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

/**
 * Registers a sync-capable test datastore whose locks and sync calls append
 * to `events`, so a test can check what ran inside a `wrapSync` wrapper.
 */
async function registerRecordingDatastore(
  events: string[],
  capabilities: { twoPhaseSync: boolean },
): Promise<{ typeName: string; invalidate: () => void }> {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );
  const typeName = `test-wrap-sync-${crypto.randomUUID()}`;
  const manifest = {} as unknown as PushManifest;
  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test wrapSync",
    description: "Records sync calls relative to the wrapSync wrapper",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: (_path: string, opts?: { lockKey?: string }) => {
        const kind = opts?.lockKey ? "model" : "global";
        return {
          acquire: () => {
            events.push(`${kind}-lock:acquire`);
            return Promise.resolve();
          },
          release: () => {
            events.push(`${kind}-lock:release`);
            return Promise.resolve();
          },
          withLock: <T>(fn: () => Promise<T>) => fn(),
          inspect: () => Promise.resolve(null),
          forceRelease: () => Promise.resolve(true),
        };
      },
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
          events.push("pullChanged");
          return Promise.resolve(0);
        },
        pushChanged: () => {
          events.push("pushChanged");
          return Promise.resolve(0);
        },
        markDirty: () => Promise.resolve(),
        capabilities: () => ({ scopedSync: true, ...capabilities }),
        preparePush: () => {
          events.push("preparePush");
          return Promise.resolve(manifest);
        },
        commitPush: () => {
          events.push("commitPush");
          return Promise.resolve(1);
        },
      }),
    }),
  });
  return {
    typeName,
    invalidate: () => datastoreTypeRegistry.invalidateType(typeName),
  };
}

for (const twoPhaseSync of [false, true]) {
  const pushCalls = twoPhaseSync ? ["preparePush", "commitPush"] : [
    "pushChanged",
  ];
  Deno.test(
    `acquireModelLocks - wrapSync wraps the pull and the ${
      twoPhaseSync ? "two-phase" : "single-phase"
    } push, never the model lock`,
    async () => {
      const events: string[] = [];
      const { typeName, invalidate } = await registerRecordingDatastore(
        events,
        { twoPhaseSync },
      );
      const wrapSync = async <T>(fn: () => Promise<T>): Promise<T> => {
        events.push("wrap:enter");
        try {
          return await fn();
        } finally {
          events.push("wrap:exit");
        }
      };

      try {
        await withTempDir(async (dir) => {
          await initializeRepo(dir);
          await configureExtensionDatastore(dir, typeName);
          const { datastoreConfig } = await resolveDatastoreForRepo(dir);
          events.length = 0;

          const lockResult = await acquireModelLocks(
            datastoreConfig,
            [{ modelType: "aws-ec2", modelId: "server-1" }],
            dir,
            undefined,
            undefined,
            undefined,
            { wrapSync },
          );

          // The model lock is held before the wrapper is entered, and the
          // pull runs inside it.
          assertEquals(events, [
            "model-lock:acquire",
            "wrap:enter",
            "pullChanged",
            "wrap:exit",
          ]);

          events.length = 0;
          await lockResult.flush();

          // Every push call runs inside the wrapper; the model lock is
          // released only after the wrapper has exited.
          const enter = events.indexOf("wrap:enter");
          const exit = events.indexOf("wrap:exit");
          for (const call of pushCalls) {
            const at = events.indexOf(call);
            assertEquals(
              at > enter && at < exit,
              true,
              `${call} inside wrapSync`,
            );
          }
          assertEquals(events.at(-1), "model-lock:release");
          assertEquals(
            events.lastIndexOf("wrap:exit") < events.length - 1,
            true,
          );
        });
      } finally {
        invalidate();
      }
    },
  );
}

Deno.test("acquireModelLocks - no capabilities calls pull/push with no args", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = "test-no-caps";
  const pullArgs: unknown[] = [];
  const pushArgs: unknown[] = [];

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test no capabilities",
    description: "Test extension without capabilities method",
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
        pullChanged: (...args: unknown[]) => {
          pullArgs.push(args);
          return Promise.resolve(1);
        },
        pushChanged: (...args: unknown[]) => {
          pushArgs.push(args);
          return Promise.resolve(0);
        },
        markDirty: () => Promise.resolve(),
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      await configureExtensionDatastore(dir, typeName);

      pullArgs.length = 0;
      pushArgs.length = 0;

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: "aws-ec2", modelId: "server-1" },
      ], dir);

      assertEquals(lockResult.synced, true);
      assertEquals(pullArgs.length, 1);
      assertEquals(
        (pullArgs[0] as unknown[]).length,
        0,
        "pullChanged must be called with no arguments when capabilities absent",
      );

      await lockResult.flush();

      assertEquals(pushArgs.length, 1);
      assertEquals(
        (pushArgs[0] as unknown[]).length,
        0,
        "pushChanged must be called with no arguments when capabilities absent",
      );
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

Deno.test("acquireModelLocks - buggy capabilities degrades to full sync", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = "test-buggy-caps";
  const pullArgs: unknown[] = [];

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test buggy capabilities",
    description: "Test extension whose capabilities() throws",
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
        pullChanged: (...args: unknown[]) => {
          pullArgs.push(args);
          return Promise.resolve(1);
        },
        pushChanged: () => Promise.resolve(0),
        markDirty: () => Promise.resolve(),
        capabilities: () => {
          throw new Error("buggy extension");
        },
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      await configureExtensionDatastore(dir, typeName);

      pullArgs.length = 0;

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: "aws-ec2", modelId: "server-1" },
      ], dir);

      assertEquals(lockResult.synced, true);
      assertEquals(pullArgs.length, 1);
      assertEquals(
        (pullArgs[0] as unknown[]).length,
        0,
        "pullChanged must be called with no arguments when capabilities throws",
      );

      await lockResult.flush();
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

Deno.test("acquireModelLocks - scopedSync deduplicates models in context", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = "test-scoped-dedup";
  const pullArgs: unknown[] = [];

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test scoped dedup",
    description: "Test extension for scoped sync deduplication",
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
        pullChanged: (options?: unknown) => {
          pullArgs.push(options);
          return Promise.resolve(1);
        },
        pushChanged: () => Promise.resolve(0),
        markDirty: () => Promise.resolve(),
        capabilities: () => ({ scopedSync: true }),
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      await configureExtensionDatastore(dir, typeName);

      pullArgs.length = 0;

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: "aws-ec2", modelId: "server-1" },
        { modelType: "aws-ec2", modelId: "server-1" },
        { modelType: "aws-ec2", modelId: "server-2" },
      ], dir);

      assertEquals(lockResult.synced, true);
      // unique deduplicates to 2 models, so 2 pull calls
      assertEquals(pullArgs.length, 2);

      const firstPull = pullArgs[0] as { context?: { models: unknown[] } };
      assertExists(firstPull?.context, "pullChanged must receive context");
      assertEquals(
        firstPull.context.models.length,
        1,
        "each pull call must receive only the current model",
      );

      const secondPull = pullArgs[1] as { context?: { models: unknown[] } };
      assertExists(secondPull?.context, "pullChanged must receive context");
      assertEquals(
        secondPull.context.models.length,
        1,
        "each pull call must receive only the current model",
      );

      await lockResult.flush();
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

// ── Giga-swamp per-namespace global lock (Phase 3) ──────────────────────────

Deno.test("datastoreGlobalLockOptions: solo mode falls back to the single .datastore.lock", () => {
  const solo: DatastoreConfig = { type: "filesystem", path: "/ds" };
  const explicitEmpty: DatastoreConfig = {
    type: "filesystem",
    path: "/ds",
    namespace: "",
  };
  // undefined → FileLock uses the default `.datastore.lock` key.
  assertEquals(datastoreGlobalLockOptions(solo), undefined);
  assertEquals(datastoreGlobalLockOptions(explicitEmpty), undefined);
});

Deno.test("datastoreGlobalLockOptions: namespaced repo passes namespace in LockOptions", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/ds",
    namespace: "infra",
  };
  assertEquals(datastoreGlobalLockOptions(config), {
    lockKey: ".datastore.lock",
    namespace: "infra",
  });
});

Deno.test("datastoreGlobalLockOptions: applies to custom datastores too", () => {
  const config: DatastoreConfig = {
    type: "s3",
    config: { bucket: "b" },
    datastorePath: "/cache",
    namespace: "security",
  };
  assertEquals(datastoreGlobalLockOptions(config), {
    lockKey: ".datastore.lock",
    namespace: "security",
  });
});

// ── Phase 6b: namespace-scoped sync regression gates ────────────────────────

Deno.test("acquireModelLocks - namespace is threaded to pull and push", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = "test-ns-sync";
  const pullArgs: unknown[] = [];
  const pushArgs: unknown[] = [];

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test namespace sync",
    description: "Test extension for namespace threading",
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
        pullChanged: (options?: unknown) => {
          pullArgs.push(options);
          return Promise.resolve(1);
        },
        pushChanged: (options?: unknown) => {
          pushArgs.push(options);
          return Promise.resolve(0);
        },
        markDirty: () => Promise.resolve(),
        capabilities: () => ({ scopedSync: true, namespacedSync: true }),
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);

      const markerPath = join(dir, ".swamp.yaml");
      const existing = await Deno.readTextFile(markerPath);
      const datastoreYaml = [
        "datastore:",
        `  type: '${typeName}'`,
        "  config:",
        "    bucket: test-bucket",
        "  namespace: infra",
      ].join("\n");
      await Deno.writeTextFile(
        markerPath,
        existing.trimEnd() + "\n" + datastoreYaml + "\n",
      );

      pullArgs.length = 0;
      pushArgs.length = 0;

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: "aws-ec2", modelId: "server-1" },
      ], dir);

      // PR #1386 regression gate: synced must be true after namespace-scoped
      // pull so callers fire catalogStore.invalidate(). A false here means
      // pulled files land in cache but the catalog is never re-indexed.
      assertEquals(lockResult.synced, true);

      assertEquals(pullArgs.length, 1);
      const pullOpts = pullArgs[0] as {
        context?: { models: unknown[] };
        namespace?: string;
      };
      assertEquals(
        pullOpts?.namespace,
        "infra",
        "pullChanged must receive namespace from config",
      );
      assertExists(pullOpts?.context, "pullChanged must still receive context");

      await lockResult.flush();

      assertEquals(pushArgs.length, 1);
      const pushOpts = pushArgs[0] as {
        context?: { models: unknown[] };
        namespace?: string;
      };
      assertEquals(
        pushOpts?.namespace,
        "infra",
        "pushChanged must receive namespace from config",
      );
      assertExists(pushOpts?.context, "pushChanged must still receive context");
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

// ── swamp-club#2553: synced reflects whether the pull changed the cache ─────

for (
  const [label, pullResult, expectedSynced] of [
    ["0 files pulled leaves synced false", 0, false],
    ["a positive count sets synced", 3, true],
    ["an unknown (void) count sets synced", undefined, true],
  ] as const
) {
  Deno.test(`acquireModelLocks - ${label}`, async () => {
    const { datastoreTypeRegistry } = await import(
      "../domain/datastore/datastore_type_registry.ts"
    );

    const typeName = `test-synced-${crypto.randomUUID().slice(0, 8)}`;

    datastoreTypeRegistry.register({
      type: typeName,
      name: "Test synced flag",
      description: "Test extension for the synced flag",
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
          pullChanged: () => Promise.resolve(pullResult),
          pushChanged: () => Promise.resolve(0),
          markDirty: () => Promise.resolve(),
          capabilities: () => ({ scopedSync: true }),
        }),
      }),
    });

    try {
      await withTempDir(async (dir) => {
        await initializeRepo(dir);

        const markerPath = join(dir, ".swamp.yaml");
        const existing = await Deno.readTextFile(markerPath);
        await Deno.writeTextFile(
          markerPath,
          existing.trimEnd() + "\n" + [
            "datastore:",
            `  type: '${typeName}'`,
            "  config:",
            "    bucket: test-bucket",
          ].join("\n") + "\n",
        );

        const { datastoreConfig } = await resolveDatastoreForRepo(dir);
        const lockResult = await acquireModelLocks(datastoreConfig, [
          { modelType: "aws-ec2", modelId: "server-1" },
        ], dir);
        try {
          assertEquals(lockResult.synced, expectedSynced);
        } finally {
          await lockResult.flush();
        }
      });
    } finally {
      datastoreTypeRegistry.invalidateType(typeName);
    }
  });
}

Deno.test("acquireModelLocks - synced survives the global-lock retry after an earlier pull changed the cache", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = `test-synced-retry-${crypto.randomUUID().slice(0, 8)}`;
  // A structural command takes the global lock right after model A's pull,
  // so the re-check after model B's lock sees it and the whole acquisition
  // restarts. It is reported once; the wait loop and the retry see it gone.
  const structuralHolder: LockInfo = {
    holder: "structural@host",
    hostname: "host",
    pid: 1,
    acquiredAt: new Date().toISOString(),
    ttlMs: 30_000,
  };
  let structuralReported = false;
  // Model A's first pull writes files; every pull in the retry finds none.
  const pullResults = [5];
  let pullCount = 0;

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test synced retry",
    description: "Test extension for the synced flag across the retry",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: (_path: string, options?: { lockKey?: string }) => ({
        acquire: () => Promise.resolve(),
        release: () => Promise.resolve(),
        withLock: <T>(fn: () => Promise<T>) => fn(),
        inspect: () => {
          if (
            // Without a namespace the global lock carries no lockKey;
            // per-model locks always do.
            options?.lockKey === undefined && pullCount === 1 &&
            !structuralReported
          ) {
            structuralReported = true;
            return Promise.resolve(structuralHolder);
          }
          return Promise.resolve(null);
        },
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
          return Promise.resolve(pullResults.shift() ?? 0);
        },
        pushChanged: () => Promise.resolve(0),
        markDirty: () => Promise.resolve(),
        capabilities: () => ({ scopedSync: true }),
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);

      const markerPath = join(dir, ".swamp.yaml");
      const existing = await Deno.readTextFile(markerPath);
      await Deno.writeTextFile(
        markerPath,
        existing.trimEnd() + "\n" + [
          "datastore:",
          `  type: '${typeName}'`,
          "  config:",
          "    bucket: test-bucket",
        ].join("\n") + "\n",
      );

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: "aws-ec2", modelId: "a" },
        { modelType: "aws-ec2", modelId: "b" },
      ], dir);
      try {
        // A, then the retry's A and B: the retry really ran.
        assertEquals(structuralReported, true);
        assertEquals(pullCount, 3);
        assertEquals(lockResult.synced, true);
      } finally {
        await lockResult.flush();
      }
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

// ── Unwind on a failed acquisition (swamp-club#2901) ─────────────────────────

/** Where the fake datastore of {@link withFailingAcquisition} fails. */
interface AcquisitionFailure {
  /** Rejects this pull (1-based). */
  pullAt?: number;
  /** Rejects this per-model lock acquire (1-based). */
  acquireAt?: number;
  /** Rejects the global lock inspect made after the first model lock. */
  postAcquireInspect?: boolean;
  /** Rejects every per-model lock release. */
  release?: boolean;
}

/**
 * Locks models `a` and `b` on a fake sync-capable datastore that fails as
 * `failure` says, and returns the error with the per-model lock keys
 * acquired and the keys whose release was attempted, in order.
 */
async function withFailingAcquisition(
  failure: AcquisitionFailure,
): Promise<{ error: Error; acquired: string[]; released: string[] }> {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = `test-unwind-${crypto.randomUUID().slice(0, 8)}`;
  const acquired: string[] = [];
  const released: string[] = [];
  let acquireCount = 0;
  let pullCount = 0;
  let globalInspectCount = 0;

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test unwind",
    description: "Test extension for unwinding a failed lock acquisition",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: (_path: string, options?: { lockKey?: string }) => {
        // Without a namespace the global lock carries no lockKey;
        // per-model locks always do.
        const lockKey = options?.lockKey;
        return {
          acquire: () => {
            if (lockKey === undefined) return Promise.resolve();
            acquireCount++;
            if (acquireCount === failure.acquireAt) {
              return Promise.reject(new Error("injected acquire failure"));
            }
            acquired.push(lockKey);
            return Promise.resolve();
          },
          release: () => {
            if (lockKey === undefined) return Promise.resolve();
            released.push(lockKey);
            return failure.release
              ? Promise.reject(new Error("injected release failure"))
              : Promise.resolve();
          },
          withLock: <T>(fn: () => Promise<T>) => fn(),
          inspect: () => {
            if (lockKey !== undefined) return Promise.resolve(null);
            globalInspectCount++;
            // The first inspect is the wait before any model lock.
            return failure.postAcquireInspect && globalInspectCount === 2
              ? Promise.reject(new Error("injected inspect failure"))
              : Promise.resolve(null);
          },
          forceRelease: () => Promise.resolve(true),
        };
      },
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
          return pullCount === failure.pullAt
            ? Promise.reject(new Error("injected pull failure"))
            : Promise.resolve(0);
        },
        pushChanged: () => Promise.resolve(0),
        markDirty: () => Promise.resolve(),
        capabilities: () => ({ scopedSync: true }),
      }),
    }),
  });

  try {
    let error: Error | undefined;
    await withTempDir(async (dir) => {
      await initializeRepo(dir);

      const markerPath = join(dir, ".swamp.yaml");
      const existing = await Deno.readTextFile(markerPath);
      await Deno.writeTextFile(
        markerPath,
        existing.trimEnd() + "\n" + [
          "datastore:",
          `  type: '${typeName}'`,
          "  config:",
          "    bucket: test-bucket",
        ].join("\n") + "\n",
      );

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      error = await assertRejects(
        () =>
          acquireModelLocks(
            datastoreConfig,
            [
              { modelType: "aws-ec2", modelId: "a" },
              { modelType: "aws-ec2", modelId: "b" },
            ],
            dir,
            undefined,
            undefined,
            () => {},
          ),
        Error,
      );
      assertEquals(getRegisteredLockKeys(), []);
    });
    return { error: error!, acquired, released };
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
}

Deno.test("acquireModelLocks: a failed pull on a later model releases every lock taken so far", async () => {
  const { error, acquired, released } = await withFailingAcquisition({
    pullAt: 2,
  });
  assertEquals(
    error.message,
    "Datastore sync failed: could not pull data for aws-ec2/b: injected pull failure",
  );
  assertEquals(acquired.length, 2);
  assertEquals(released, acquired);
});

Deno.test("acquireModelLocks: a failed lock acquire on a later model releases the locks taken before it", async () => {
  const { error, acquired, released } = await withFailingAcquisition({
    acquireAt: 2,
  });
  assertEquals(error.message, "injected acquire failure");
  assertEquals(acquired.length, 1);
  assertEquals(released, acquired);
});

Deno.test("acquireModelLocks: a failed global lock re-check releases the lock just taken", async () => {
  const { error, acquired, released } = await withFailingAcquisition({
    postAcquireInspect: true,
  });
  assertEquals(error.message, "injected inspect failure");
  assertEquals(acquired.length, 1);
  assertEquals(released, acquired);
});

Deno.test("acquireModelLocks: waits on a fresh unreadable global lock file until it is gone", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);
    const { datastoreConfig } = await resolveDatastoreForRepo(dir);
    assert(!isCustomDatastoreConfig(datastoreConfig));

    // A structural command caught mid-write: its global lock file exists
    // but is empty (swamp-club#3148). It releases once the writer waits.
    const globalLockPath = join(datastoreConfig.path, ".datastore.lock");
    await ensureDir(datastoreConfig.path);
    await Deno.writeTextFile(globalLockPath, "");

    const messages: string[] = [];
    const lockResult = await acquireModelLocks(
      datastoreConfig,
      [{ modelType: "aws-ec2", modelId: "server-1" }],
      dir,
      undefined,
      undefined,
      (msg) => {
        messages.push(msg);
        if (msg.includes("Global lock held by")) {
          Deno.removeSync(globalLockPath);
        }
      },
    );
    await lockResult.flush();

    assertEquals(
      messages.some((m) => m.includes("Global lock held by unknown")),
      true,
      `expected a wait on the unreadable global lock, got ${
        JSON.stringify(messages)
      }`,
    );
  });
});

Deno.test("acquireModelLocks: the re-check after a per-model lock sees a fresh unreadable global lock file as held", async () => {
  const typeName = `test-recheck-${crypto.randomUUID().slice(0, 8)}`;
  const acquired: string[] = [];
  const released: string[] = [];
  let globalLockDir = "";

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test global lock re-check",
    description: "A real FileLock global lock behind recording model locks",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: (_path: string, options?: { lockKey?: string }) => {
        // Without a namespace the global lock carries no lockKey;
        // per-model locks always do.
        const lockKey = options?.lockKey;
        if (lockKey === undefined) return new FileLock(globalLockDir);
        return {
          acquire: async () => {
            // A structural command starts creating the global lock just
            // after this writer's first inspect, the first time only.
            if (acquired.length === 0) {
              await Deno.writeTextFile(
                join(globalLockDir, ".datastore.lock"),
                "",
              );
            }
            acquired.push(lockKey);
          },
          release: () => {
            released.push(lockKey);
            return Promise.resolve();
          },
          withLock: <T>(fn: () => Promise<T>) => fn(),
          inspect: () => Promise.resolve(null),
          forceRelease: () => Promise.resolve(true),
        };
      },
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
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      globalLockDir = join(dir, "global-lock");
      await ensureDir(globalLockDir);

      const markerPath = join(dir, ".swamp.yaml");
      const existing = await Deno.readTextFile(markerPath);
      await Deno.writeTextFile(
        markerPath,
        existing.trimEnd() + "\n" + [
          "datastore:",
          `  type: '${typeName}'`,
          "  config:",
          "    bucket: test-bucket",
        ].join("\n") + "\n",
      );

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const messages: string[] = [];
      const lockResult = await acquireModelLocks(
        datastoreConfig,
        [{ modelType: "aws-ec2", modelId: "a" }],
        dir,
        undefined,
        undefined,
        (msg) => {
          messages.push(msg);
          if (msg.includes("during per-model lock acquisition")) {
            Deno.removeSync(join(globalLockDir, ".datastore.lock"));
          }
        },
      );
      await lockResult.flush();

      assertEquals(
        messages.some((m) => m.includes("Global lock acquired by unknown")),
        true,
        `expected the re-check to see the global lock, got ${
          JSON.stringify(messages)
        }`,
      );
      // Taken, given up for the structural command, then taken again.
      assertEquals(acquired.length, 2);
      assertEquals(released.length, 2);
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

Deno.test("acquireModelLocks: a lock release failing during the unwind does not replace the pull error", async () => {
  const { error, acquired, released } = await withFailingAcquisition({
    pullAt: 2,
    release: true,
  });
  assertEquals(
    error.message,
    "Datastore sync failed: could not pull data for aws-ec2/b: injected pull failure",
  );
  assertEquals(acquired.length, 2);
  assertEquals(released, acquired);
});

// ── Two-Phase Sync Tests ─────────────────────────────────────────────────────

function createMockConfig(namespace?: string): CustomDatastoreConfig {
  return {
    type: "test-two-phase",
    config: { bucket: "test" },
    datastorePath: "/tmp/test-datastore",
    cachePath: "/tmp/test-cache",
    namespace,
  };
}

function createMockProvider(events: string[]) {
  return {
    createLock: () => ({
      acquire: () => {
        events.push("global-lock-acquire");
        return Promise.resolve();
      },
      release: () => {
        events.push("global-lock-release");
        return Promise.resolve();
      },
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
          datastoreType: "test",
        }),
    }),
    resolveDatastorePath: () => "/tmp/test-datastore",
    resolveCachePath: () => "/tmp/test-cache",
  };
}

function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as ReturnType<
    typeof import("../infrastructure/logging/logger.ts").getSwampLogger
  >;
}

Deno.test("flushTwoPhasePush: calls preparePush outside lock, commitPush inside lock", async () => {
  const events: string[] = [];
  const provider = createMockProvider(events);
  const mockManifest = { uploaded: ["a.json"] } as unknown as PushManifest;

  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => {
      events.push("pushChanged");
      return Promise.resolve(0);
    },
    markDirty: () => Promise.resolve(),
    capabilities: () => ({ twoPhaseSync: true, scopedSync: true }),
    preparePush: () => {
      events.push("preparePush");
      return Promise.resolve(mockManifest);
    },
    commitPush: () => {
      events.push("commitPush");
      return Promise.resolve(1);
    },
  };

  await flushTwoPhasePush(
    provider,
    syncService,
    createMockConfig(),
    { twoPhaseSync: true, scopedSync: true },
    [{ modelType: "test", modelId: "m1" }],
    undefined,
    undefined,
    createMockLogger(),
  );

  assertEquals(events, [
    "preparePush",
    "global-lock-acquire",
    "commitPush",
    "global-lock-release",
  ]);
});

Deno.test("flushSinglePhasePush: calls pushChanged under global lock", async () => {
  const events: string[] = [];
  const provider = createMockProvider(events);

  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => {
      events.push("pushChanged");
      return Promise.resolve(0);
    },
    markDirty: () => Promise.resolve(),
    capabilities: () => ({ scopedSync: true }),
  };

  await flushSinglePhasePush(
    provider,
    syncService,
    createMockConfig(),
    { scopedSync: true },
    [{ modelType: "test", modelId: "m1" }],
    undefined,
    undefined,
    createMockLogger(),
  );

  assertEquals(events, [
    "global-lock-acquire",
    "pushChanged",
    "global-lock-release",
  ]);
});

Deno.test("flushTwoPhasePush: preparePush failure skips global lock", async () => {
  const events: string[] = [];
  const provider = createMockProvider(events);

  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
    capabilities: () => ({ twoPhaseSync: true }),
    preparePush: () => {
      events.push("preparePush");
      return Promise.reject(new Error("upload failed"));
    },
    commitPush: () => {
      events.push("commitPush");
      return Promise.resolve(0);
    },
  };

  await assertRejects(
    () =>
      flushTwoPhasePush(
        provider,
        syncService,
        createMockConfig(),
        { twoPhaseSync: true },
        [{ modelType: "test", modelId: "m1" }],
        undefined,
        undefined,
        createMockLogger(),
      ),
    Error,
  );

  assertEquals(events, ["preparePush"]);
  assertEquals(events.includes("global-lock-acquire"), false);
});

Deno.test("flushTwoPhasePush: commitPush failure still releases global lock", async () => {
  const events: string[] = [];
  const provider = createMockProvider(events);
  const mockManifest = {} as unknown as PushManifest;

  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
    capabilities: () => ({ twoPhaseSync: true }),
    preparePush: () => {
      events.push("preparePush");
      return Promise.resolve(mockManifest);
    },
    commitPush: () => {
      events.push("commitPush");
      return Promise.reject(new Error("index update failed"));
    },
  };

  await assertRejects(
    () =>
      flushTwoPhasePush(
        provider,
        syncService,
        createMockConfig(),
        { twoPhaseSync: true },
        [{ modelType: "test", modelId: "m1" }],
        undefined,
        undefined,
        createMockLogger(),
      ),
    Error,
  );

  assertEquals(events.includes("global-lock-acquire"), true);
  assertEquals(events.includes("global-lock-release"), true);
  assertEquals(
    events.indexOf("global-lock-release") > events.indexOf("commitPush"),
    true,
    "global lock must be released after commitPush failure",
  );
});

Deno.test("flushTwoPhasePush: passes namespace to both phases", async () => {
  const prepareOpts: unknown[] = [];
  const commitOpts: unknown[] = [];
  const events: string[] = [];
  const provider = createMockProvider(events);
  const mockManifest = {} as unknown as PushManifest;

  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
    capabilities: () => ({ twoPhaseSync: true, scopedSync: true }),
    preparePush: (opts?: unknown) => {
      prepareOpts.push(opts);
      return Promise.resolve(mockManifest);
    },
    commitPush: (_manifest: unknown, opts?: unknown) => {
      commitOpts.push(opts);
      return Promise.resolve(1);
    },
  };

  await flushTwoPhasePush(
    provider,
    syncService,
    createMockConfig("infra"),
    { twoPhaseSync: true, scopedSync: true },
    [{ modelType: "test", modelId: "m1" }],
    "infra",
    undefined,
    createMockLogger(),
  );

  const prepOpts = prepareOpts[0] as { namespace?: string; context?: unknown };
  assertEquals(prepOpts?.namespace, "infra");
  assertExists(prepOpts?.context);

  const cmtOpts = commitOpts[0] as { namespace?: string };
  assertEquals(cmtOpts?.namespace, "infra");
});

Deno.test("acquireModelLocks: uses two-phase push when twoPhaseSync is advertised", async () => {
  const { datastoreTypeRegistry } = await import(
    "../domain/datastore/datastore_type_registry.ts"
  );

  const typeName = "test-two-phase-sync";
  const events: string[] = [];
  const mockManifest = {} as unknown as PushManifest;

  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test two-phase sync",
    description: "Test extension for two-phase sync",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: () => ({
        acquire: () => {
          events.push("lock-acquire");
          return Promise.resolve();
        },
        release: () => {
          events.push("lock-release");
          return Promise.resolve();
        },
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
        pushChanged: () => {
          events.push("pushChanged");
          return Promise.resolve(0);
        },
        markDirty: () => Promise.resolve(),
        capabilities: () => ({
          scopedSync: true,
          twoPhaseSync: true,
        }),
        preparePush: () => {
          events.push("preparePush");
          return Promise.resolve(mockManifest);
        },
        commitPush: () => {
          events.push("commitPush");
          return Promise.resolve(1);
        },
      }),
    }),
  });

  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);

      const markerPath = join(dir, ".swamp.yaml");
      const existing = await Deno.readTextFile(markerPath);
      const datastoreYaml = [
        "datastore:",
        `  type: '${typeName}'`,
        "  config:",
        "    bucket: test-bucket",
      ].join("\n");
      await Deno.writeTextFile(
        markerPath,
        existing.trimEnd() + "\n" + datastoreYaml + "\n",
      );

      events.length = 0;

      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: "test-type", modelId: "m1" },
      ], dir);

      await lockResult.flush();

      assertEquals(
        events.includes("preparePush"),
        true,
        "two-phase path must call preparePush",
      );
      assertEquals(
        events.includes("commitPush"),
        true,
        "two-phase path must call commitPush",
      );
      assertEquals(
        events.includes("pushChanged"),
        false,
        "two-phase path must NOT call pushChanged",
      );
      assertEquals(
        events.indexOf("preparePush") < events.indexOf("commitPush"),
        true,
        "preparePush must run before commitPush",
      );
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

// ============================================================================
// resolveManagedConfigPaths Tests
// ============================================================================

Deno.test("resolveManagedConfigPaths: null marker returns default lockfile path", () => {
  const repo = resolve("/repo");
  const { lockfilePath } = resolveManagedConfigPaths(repo, null);
  assertPathEquals(
    lockfilePath,
    join(repo, "extensions", "models", "upstream_extensions.json"),
  );
});

Deno.test("resolveManagedConfigPaths: marker without datastore returns default paths", () => {
  const repo = resolve("/repo");
  const marker: RepoMarkerData = {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
  };
  const { lockfilePath } = resolveManagedConfigPaths(repo, marker);
  assertPathEquals(
    lockfilePath,
    join(repo, "extensions", "models", "upstream_extensions.json"),
  );
});

Deno.test("resolveManagedConfigPaths: managedConfig=false returns default paths", () => {
  const repo = resolve("/repo");
  const marker: RepoMarkerData = {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    datastore: { type: "filesystem", managedConfig: false },
  };
  const { lockfilePath } = resolveManagedConfigPaths(repo, marker);
  assertPathEquals(
    lockfilePath,
    join(repo, "extensions", "models", "upstream_extensions.json"),
  );
});

Deno.test("resolveManagedConfigPaths: managedConfig=true returns managed lockfile path", () => {
  const repo = resolve("/repo");
  const marker: RepoMarkerData = {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    datastore: { type: "@swamp/s3-datastore", managedConfig: true },
  };
  const { lockfilePath } = resolveManagedConfigPaths(repo, marker);
  assertPathEquals(
    lockfilePath,
    join(repo, ".swamp", "config", "upstream_extensions.json"),
  );
});

Deno.test("resolveManagedConfigPaths: managedConfig=true with custom modelsDir still uses managed path", () => {
  const repo = resolve("/repo");
  const marker: RepoMarkerData = {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    modelsDir: "custom/models",
    datastore: { type: "@swamp/s3-datastore", managedConfig: true },
  };
  const { lockfilePath } = resolveManagedConfigPaths(repo, marker);
  assertPathEquals(
    lockfilePath,
    join(repo, ".swamp", "config", "upstream_extensions.json"),
  );
});

Deno.test("resolveManagedConfigPaths: managedConfig=true uses managed paths regardless of sentinel file", () => {
  const repo = resolve("/nonexistent-repo");
  const marker: RepoMarkerData = {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    datastore: { type: "@swamp/s3-datastore", managedConfig: true },
  };
  const { lockfilePath } = resolveManagedConfigPaths(repo, marker);
  assertPathEquals(
    lockfilePath,
    join(repo, ".swamp", "config", "upstream_extensions.json"),
  );
});

Deno.test("resolveManagedConfigPaths: custom modelsDir is used when managedConfig=false", () => {
  const repo = resolve("/repo");
  const marker: RepoMarkerData = {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    modelsDir: "custom/models",
  };
  const { lockfilePath } = resolveManagedConfigPaths(repo, marker);
  assertPathEquals(
    lockfilePath,
    join(repo, "custom", "models", "upstream_extensions.json"),
  );
});

// ── ensureManagedConfigBase Tests ────────────────────────────────────────────

Deno.test("ensureManagedConfigBase: no-ops when managedConfig is false", async () => {
  const repo = resolve("/repo-no-managed");
  const marker: RepoMarkerData = {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
  };
  assertEquals(await ensureManagedConfigBase(repo, marker), false);
  const { lockfilePath, active } = resolveManagedConfigPaths(repo, marker);
  assertEquals(active, false);
  assertPathEquals(
    lockfilePath,
    join(repo, "extensions", "models", "upstream_extensions.json"),
  );
});

Deno.test("ensureManagedConfigBase: registers cache-based config path via resolver override", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const cachePath = join(tmpDir, "cache");
    await Deno.mkdir(cachePath, { recursive: true });
    const marker: RepoMarkerData = {
      swampVersion: "1.0.0",
      initializedAt: "2026-01-01T00:00:00.000Z",
      datastore: { type: "@swamp/s3-datastore", managedConfig: true },
    };
    const mockResolver = {
      resolvePath: (subdir: string) => join(cachePath, subdir),
      localPath: () => "",
      datastorePath: () => "",
      isDatastoreSubdir: () => false,
      isExcluded: () => false,
      config: () => ({ type: "filesystem", path: tmpDir }) as DatastoreConfig,
    };
    await ensureManagedConfigBase(tmpDir, marker, mockResolver);
    const { lockfilePath, active } = resolveManagedConfigPaths(
      tmpDir,
      marker,
    );
    assertEquals(active, true);
    assertPathEquals(
      lockfilePath,
      join(cachePath, "config", "upstream_extensions.json"),
    );
    // Sources stay in the repo while the lockfile follows the cache base.
    assertPathEquals(
      resolvePulledExtensionsRoot(tmpDir),
      join(tmpDir, ".swamp", "config", "pulled-extensions"),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveManagedConfigPaths: picks up registry-populated base when sentinel missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const cachePath = join(tmpDir, "remote-cache");
    await Deno.mkdir(cachePath, { recursive: true });
    const marker: RepoMarkerData = {
      swampVersion: "1.0.0",
      initializedAt: "2026-01-01T00:00:00.000Z",
      datastore: { type: "@swamp/s3-datastore", managedConfig: true },
    };
    const mockResolver = {
      resolvePath: (subdir: string) => join(cachePath, subdir),
      localPath: () => "",
      datastorePath: () => "",
      isDatastoreSubdir: () => false,
      isExcluded: () => false,
      config: () => ({ type: "filesystem", path: tmpDir }) as DatastoreConfig,
    };
    await ensureManagedConfigBase(tmpDir, marker, mockResolver);
    const { lockfilePath, active } = resolveManagedConfigPaths(
      tmpDir,
      marker,
    );
    assertEquals(active, true);
    assertPathEquals(
      lockfilePath,
      join(cachePath, "config", "upstream_extensions.json"),
    );
    assertPathEquals(
      resolvePulledExtensionsRoot(tmpDir),
      join(tmpDir, ".swamp", "config", "pulled-extensions"),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ensureManagedConfigBase: explicit configBasePath still takes precedence", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const explicitBase = join(tmpDir, "explicit-config");
    await Deno.mkdir(explicitBase, { recursive: true });
    const cachePath = join(tmpDir, "cache");
    await Deno.mkdir(cachePath, { recursive: true });
    const marker: RepoMarkerData = {
      swampVersion: "1.0.0",
      initializedAt: "2026-01-01T00:00:00.000Z",
      datastore: { type: "@swamp/s3-datastore", managedConfig: true },
    };
    const mockResolver = {
      resolvePath: (subdir: string) => join(cachePath, subdir),
      localPath: () => "",
      datastorePath: () => "",
      isDatastoreSubdir: () => false,
      isExcluded: () => false,
      config: () => ({ type: "filesystem", path: tmpDir }) as DatastoreConfig,
    };
    await ensureManagedConfigBase(tmpDir, marker, mockResolver);
    const { lockfilePath } = resolveManagedConfigPaths(
      tmpDir,
      marker,
      explicitBase,
    );
    assertPathEquals(
      lockfilePath,
      join(explicitBase, "upstream_extensions.json"),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ── assertManagedConfigWritable (swamp-club#2483) ───────────────────────────

const unsetDatastoreEnv = () => undefined;

function managedMarker(type: string): RepoMarkerData {
  return {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    datastore: { type, managedConfig: true },
  };
}

Deno.test("ensureManagedConfigBase: an unloadable datastore leaves the fallback unresolved", async () => {
  const repo = resolve(`/repo-unresolved-${crypto.randomUUID()}`);
  const marker = managedMarker(`@t${crypto.randomUUID().slice(0, 8)}/ds`);
  assertEquals(
    await ensureManagedConfigBase(repo, marker, undefined, {
      autoResolve: false,
    }),
    false,
  );
  const { lockfilePath, active } = resolveManagedConfigPaths(repo, marker);
  assertEquals(active, true);
  assertEquals(isManagedConfigBaseResolved(repo), false);
  assertPathEquals(
    lockfilePath,
    join(repo, ".swamp", "config", "upstream_extensions.json"),
  );
});

Deno.test("assertManagedConfigWritable: throws a typed error for an unresolved extension datastore", async () => {
  const repo = resolve(`/repo-guard-${crypto.randomUUID()}`);
  const type = `@t${crypto.randomUUID().slice(0, 8)}/ds`;
  const marker = managedMarker(type);
  await ensureManagedConfigBase(repo, marker, undefined, {
    autoResolve: false,
  });
  resolveManagedConfigPaths(repo, marker);
  let caught: unknown;
  try {
    assertManagedConfigWritable(repo, marker, unsetDatastoreEnv);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof ManagedConfigUnresolvedError)) {
    throw new Error(`expected ManagedConfigUnresolvedError, got ${caught}`);
  }
  assertEquals(caught.code, "managed_config_unresolved");
  assertStringIncludes(caught.message, `\`swamp extension pull ${type}\``);
  assertStringIncludes(caught.message, "--force");
  assertStringIncludes(caught.message, "swamp datastore sync --pull");
  assertStringIncludes(
    caught.message,
    "its datastore extension is not installed and could not be installed " +
      "automatically",
  );
  assertEquals(caught.message.includes("Available types"), false);
});

Deno.test("assertManagedConfigWritable: drops the legacy s3 pull hint from the reason", async () => {
  const repo = resolve(`/repo-guard-s3-${crypto.randomUUID()}`);
  const marker = managedMarker("s3");
  await ensureManagedConfigBase(repo, marker, undefined, {
    autoResolve: false,
  });
  let message = "";
  try {
    assertManagedConfigWritable(repo, marker, unsetDatastoreEnv);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "`swamp extension pull @swamp/s3-datastore`");
  assertEquals(message.includes("Install it with"), false);
});

Deno.test("assertManagedConfigWritable: passes once the base is resolved", async () => {
  const repo = resolve(`/repo-guard-ok-${crypto.randomUUID()}`);
  const marker = managedMarker("@swamp/s3-datastore");
  const resolver = {
    resolvePath: (subdir: string) => join("/cache/ns", subdir),
    localPath: () => "",
    datastorePath: () => "",
    isDatastoreSubdir: () => false,
    isExcluded: () => false,
    config: () => ({ type: "filesystem", path: "/cache" }) as DatastoreConfig,
  };
  assertEquals(await ensureManagedConfigBase(repo, marker, resolver), true);
  // A later lookup without a base must not downgrade the resolved base.
  resolveManagedConfigPaths(repo, marker);
  assertEquals(isManagedConfigBaseResolved(repo), true);
  assertManagedConfigWritable(repo, marker, unsetDatastoreEnv);
});

Deno.test("assertManagedConfigWritable: does not apply to filesystem or unmanaged repos", () => {
  const fsRepo = resolve(`/repo-guard-fs-${crypto.randomUUID()}`);
  assertManagedConfigWritable(
    fsRepo,
    managedMarker("filesystem"),
    unsetDatastoreEnv,
  );
  const plainRepo = resolve(`/repo-guard-plain-${crypto.randomUUID()}`);
  assertManagedConfigWritable(
    plainRepo,
    {
      swampVersion: "1.0.0",
      initializedAt: "2026-01-01T00:00:00.000Z",
      datastore: { type: "@swamp/s3-datastore" },
    },
    unsetDatastoreEnv,
  );
});

Deno.test("resolveManagedLockfileForWrite: exempts the datastore extension while unresolved", async () => {
  const repo = resolve(`/repo-exempt-${crypto.randomUUID()}`);
  const type = `@t${crypto.randomUUID().slice(0, 8)}/s3-datastore`;
  const marker = managedMarker(type);
  const target = await resolveManagedLockfileForWrite(repo, marker, {
    exemptTargets: [type],
    readDatastoreEnv: unsetDatastoreEnv,
  });
  assertEquals(target.publish, false);
  assertPathEquals(
    target.lockfilePath,
    join(repo, ".swamp", "config", "upstream_extensions.json"),
  );
});

Deno.test("resolveManagedLockfileForWrite: a static candidate match makes no registry calls", async () => {
  const repo = resolve(`/repo-exempt-static-${crypto.randomUUID()}`);
  const type = `@t${crypto.randomUUID().slice(0, 8)}/s3-datastore`;
  let lookups = 0;
  const target = await resolveManagedLockfileForWrite(
    repo,
    managedMarker(type),
    {
      exemptTargets: [type],
      extensionLookup: {
        getExtension: () => {
          lookups++;
          return Promise.resolve(null);
        },
        searchExtensions: () => {
          lookups++;
          return Promise.resolve({ extensions: [] });
        },
      },
      readDatastoreEnv: unsetDatastoreEnv,
    },
  );
  assertEquals(target.publish, false);
  assertEquals(lookups, 0);
});

Deno.test("resolveManagedLockfileForWrite: recognises a search-found datastore extension", async () => {
  const repo = resolve(`/repo-exempt-search-${crypto.randomUUID()}`);
  const collective = `t${crypto.randomUUID().slice(0, 8)}`;
  const marker = managedMarker(`@${collective}/pg`);
  const target = await resolveManagedLockfileForWrite(repo, marker, {
    exemptTargets: [`@${collective}/postgres-datastore`],
    extensionLookup: {
      getExtension: () => Promise.resolve(null),
      searchExtensions: () =>
        Promise.resolve({
          extensions: [{ name: `@${collective}/postgres-datastore` }],
        }),
    },
    readDatastoreEnv: unsetDatastoreEnv,
  });
  assertEquals(target.publish, false);
});

Deno.test("resolveManagedLockfileForWrite: refuses other targets while unresolved", async () => {
  const repo = resolve(`/repo-refuse-${crypto.randomUUID()}`);
  const marker = managedMarker(`@t${crypto.randomUUID().slice(0, 8)}/ds`);
  await assertRejects(
    () =>
      resolveManagedLockfileForWrite(repo, marker, {
        exemptTargets: ["@swamp/aws/cur"],
        readDatastoreEnv: unsetDatastoreEnv,
      }),
    ManagedConfigUnresolvedError,
    "swamp datastore sync --pull",
  );
  await assertRejects(
    () =>
      resolveManagedLockfileForWrite(repo, marker, {
        readDatastoreEnv: unsetDatastoreEnv,
      }),
    ManagedConfigUnresolvedError,
  );
});

/**
 * Installs an auto-resolver for `collective` that records every registry
 * lookup and finds nothing, runs `fn`, then restores the previous resolver.
 */
async function withRecordingAutoResolver(
  collective: string,
  fn: (lookups: string[]) => Promise<void>,
): Promise<void> {
  const lookups: string[] = [];
  const previous = getAutoResolver();
  setAutoResolver(
    new ExtensionAutoResolver({
      allowedCollectives: [collective],
      extensionLookup: {
        getExtension: (name) => {
          lookups.push(name);
          return Promise.resolve(null);
        },
        searchExtensions: () => Promise.resolve({ extensions: [] }),
      },
      extensionInstaller: {
        inspectInstallation: () => Promise.resolve({ state: "missing" }),
        install: () => Promise.resolve(null),
        hotLoadModels: () => Promise.resolve(0),
        hotLoadVaults: () => Promise.resolve(),
        hotLoadDatastores: () => Promise.resolve(),
        hotLoadWebhooks: () => Promise.resolve(),
        failedLocalSourceMatchesType: () => false,
        withInstallLock: (fn) => fn(),
        providesType: () => Promise.resolve(false),
      },
      // A no-op for every output event.
      output: new Proxy({}, { get: () => () => {} }) as AutoResolveOutputPort,
    }),
  );
  try {
    await fn(lookups);
  } finally {
    setAutoResolver(previous);
  }
}

Deno.test("resolveManagedLockfileForWrite: tries to auto-install a missing datastore extension before refusing", async () => {
  const repo = resolve(`/repo-autoresolve-${crypto.randomUUID()}`);
  const collective = `t${crypto.randomUUID().slice(0, 8)}`;
  const marker = managedMarker(`@${collective}/ds`);
  await withRecordingAutoResolver(collective, async (lookups) => {
    await assertRejects(
      () =>
        resolveManagedLockfileForWrite(repo, marker, {
          readDatastoreEnv: unsetDatastoreEnv,
        }),
      ManagedConfigUnresolvedError,
    );
    assertEquals(lookups.length > 0, true);
  });
});

Deno.test("resolveManagedLockfileForWrite: returns the models-dir lockfile for unmanaged repos", async () => {
  const repo = resolve(`/repo-plain-${crypto.randomUUID()}`);
  const target = await resolveManagedLockfileForWrite(repo, {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(target.publish, true);
  assertPathEquals(
    target.lockfilePath,
    join(repo, "extensions", "models", "upstream_extensions.json"),
  );
});

Deno.test("ensureManagedConfigBase: rethrows a transient lock_timeout", async () => {
  const repo = resolve(`/repo-lock-${crypto.randomUUID()}`);
  const marker = managedMarker(`@t${crypto.randomUUID().slice(0, 8)}/ds`);
  datastoreTypeRegistry.setLoader(() =>
    Promise.reject(new UserError("index busy", "lock_timeout"))
  );
  try {
    await assertRejects(
      () =>
        ensureManagedConfigBase(repo, marker, undefined, {
          autoResolve: false,
        }),
      UserError,
      "index busy",
    );
  } finally {
    datastoreTypeRegistry.clearLoadersForTesting();
  }
});

Deno.test("ensureManagedConfigBase: a failed attempt resets the datastore loader so a retry rescans", async () => {
  const repo = resolve(`/repo-retry-${crypto.randomUUID()}`);
  const marker = managedMarker(`@t${crypto.randomUUID().slice(0, 8)}/ds`);
  let loads = 0;
  datastoreTypeRegistry.setLoader(() => {
    loads++;
    return Promise.resolve();
  });
  try {
    assertEquals(
      await ensureManagedConfigBase(repo, marker, undefined, {
        autoResolve: false,
      }),
      false,
    );
    assertEquals(
      await ensureManagedConfigBase(repo, marker, undefined, {
        autoResolve: false,
      }),
      false,
    );
    assertEquals(loads, 2);
  } finally {
    datastoreTypeRegistry.clearLoadersForTesting();
  }
});

// ── flushSinglePhasePush: catalog export ordering ──────────────────────────

Deno.test("flushSinglePhasePush: writes catalog export before acquiring global lock", async () => {
  const events: string[] = [];
  const provider = createMockProvider(events);

  const dir = await Deno.makeTempDir({ prefix: "swamp-export-order-test-" });
  try {
    const dbPath = join(dir, "_catalog.db");
    const cachePath = join(dir, "cache");
    await ensureDir(join(cachePath, "test-ns"));
    const catalogStore = new CatalogStore(dbPath);
    try {
      catalogStore.upsert({
        namespace: "test-ns",
        type_normalized: "test-model",
        model_id: "model-001",
        data_name: "my-data",
        id: "data-uuid-001",
        version: 1,
        is_latest: 1,
        is_step_latest: 1,
        model_name: "test-model-name",
        spec_name: "result",
        data_type: "resource",
        content_type: "application/json",
        lifetime: "infinite",
        garbage_collection: "10",
        owner_type: "model-method",
        owner_ref: "",
        workflow_run_id: "",
        workflow_name: "",
        job_name: "",
        step_name: "",
        source: "",
        streaming: 0,
        size: 256,
        created_at: "2026-01-01T00:00:00.000Z",
        tags: "{}",
      });

      const syncService: DatastoreSyncService = {
        pullChanged: () => Promise.resolve(0),
        pushChanged: () => {
          events.push("pushChanged");
          return Promise.resolve(0);
        },
        markDirty: () => {
          events.push("markDirty");
          return Promise.resolve();
        },
        capabilities: () => ({ scopedSync: true }),
      };

      await flushSinglePhasePush(
        provider,
        syncService,
        { ...createMockConfig("test-ns"), cachePath },
        { scopedSync: true },
        [{ modelType: "test", modelId: "m1" }],
        "test-ns",
        catalogStore,
        createMockLogger(),
      );

      const markDirtyIdx = events.indexOf("markDirty");
      const lockAcquireIdx = events.indexOf("global-lock-acquire");
      assertEquals(
        markDirtyIdx < lockAcquireIdx,
        true,
        `catalog export (markDirty at ${markDirtyIdx}) should run before lock acquire (at ${lockAcquireIdx}): ${
          JSON.stringify(events)
        }`,
      );

      const exportPath = join(cachePath, "test-ns", ".catalog-export.json");
      const content = await Deno.readTextFile(exportPath);
      const parsed = JSON.parse(content);
      assertEquals(parsed.length, 1);
    } finally {
      catalogStore.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("buildMarkDirtyHook: forwards a cache path as a forward-slash relPath", async () => {
  const base = resolve("mark-dirty-hook");
  const cacheRoot = join(base, "cache");
  const { service, marks } = createRecordingSyncService();
  const hook = buildMarkDirtyHook(service, cacheRoot, join(base, "repo"));

  await hook(join(cacheRoot, "data", "test", "model-1", "result"));

  assertEquals(marks, ["data/test/model-1/result"]);
});

Deno.test("buildMarkDirtyHook: maps a repo .swamp path onto the cache layout", async () => {
  const base = resolve("mark-dirty-hook");
  const repoDir = join(base, "repo");
  const { service, marks } = createRecordingSyncService();
  const hook = buildMarkDirtyHook(service, join(base, "cache"), repoDir);

  await hook(join(repoDir, ".swamp", "outputs", "test", "run-1.yaml"));

  assertEquals(marks, ["outputs/test/run-1.yaml"]);
});

Deno.test("buildMarkDirtyHook: sends nothing for a path outside the cache and .swamp", async () => {
  // Repo-local definitions without managedConfig are never synced. An
  // escaping relPath would make the S3/GCS extensions fall back to a bulk
  // push of the whole cache (swamp-club#2415).
  const base = resolve("mark-dirty-hook");
  const repoDir = join(base, "repo");
  const { service, marks } = createRecordingSyncService();
  const hook = buildMarkDirtyHook(service, join(base, "cache"), repoDir);

  await hook(join(repoDir, "models", "command", "shell", "probe.yaml"));
  await hook(join(repoDir, "vaults", "local_encryption", "v1.yaml"));

  assertEquals(marks, []);
});

Deno.test("buildMarkDirtyHook: forwards an absent path as a bare call", async () => {
  const base = resolve("mark-dirty-hook");
  const { service, marks } = createRecordingSyncService();
  const hook = buildMarkDirtyHook(
    service,
    join(base, "cache"),
    join(base, "repo"),
  );

  await hook(undefined);

  assertEquals(marks, [undefined]);
});

Deno.test("buildMarkDirtyHook: marks a first segment that only starts with two dots", async () => {
  // A name such as `..hidden` sits inside the root. Before the escape check
  // compared whole segments, the hook dropped these marks.
  const base = resolve("mark-dirty-hook");
  const cacheRoot = join(base, "cache");
  const repoDir = join(base, "repo");
  const { service, marks } = createRecordingSyncService();
  const hook = buildMarkDirtyHook(service, cacheRoot, repoDir);

  await hook(join(cacheRoot, "..hidden", "file"));
  await hook(join(cacheRoot, "...", "file"));
  await hook(join(repoDir, ".swamp", "..cache-like", "file"));

  assertEquals(marks, ["..hidden/file", ".../file", "..cache-like/file"]);
});

Deno.test("buildMarkDirtyHook: sends nothing for a sibling whose name extends the root's", async () => {
  const base = resolve("mark-dirty-hook");
  const { service, marks } = createRecordingSyncService();
  const hook = buildMarkDirtyHook(
    service,
    join(base, "cache"),
    join(base, "repo"),
  );

  await hook(join(base, "cache-other", "file"));
  await hook(join(base, "cache..x", "file"));
  await hook(join(base, "repo", ".swamp-other", "file"));

  assertEquals(marks, []);
});

/**
 * Registers a sync-capable datastore type that records lock and sync
 * events, optionally pushing two-phase and failing the push.
 */
function registerRecordingLockType(
  events: string[],
  options: { twoPhase: boolean; failPush: boolean },
): string {
  const typeName = `test-lock-split-${crypto.randomUUID().slice(0, 8)}`;
  const failPush = () => {
    events.push("push-failed");
    return Promise.reject(new Error("push failed"));
  };
  datastoreTypeRegistry.register({
    type: typeName,
    name: "Test lock push/release split",
    description: "Records lock and sync events",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: () => ({
        acquire: () => {
          events.push("lock-acquire");
          return Promise.resolve();
        },
        release: () => {
          events.push("lock-release");
          return Promise.resolve();
        },
        withLock: async <T>(fn: () => Promise<T>) => {
          events.push("lock-acquire");
          try {
            return await fn();
          } finally {
            events.push("lock-release");
          }
        },
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
        pushChanged: () => {
          if (options.failPush) return failPush();
          events.push("pushChanged");
          return Promise.resolve(1);
        },
        markDirty: () => Promise.resolve(),
        capabilities: () => ({ twoPhaseSync: options.twoPhase }),
        preparePush: () => {
          if (options.failPush) return failPush();
          events.push("preparePush");
          return Promise.resolve({} as unknown as PushManifest);
        },
        commitPush: () => {
          events.push("commitPush");
          return Promise.resolve(1);
        },
      }),
    }),
  });
  return typeName;
}

for (const twoPhase of [false, true]) {
  for (const failPush of [false, true]) {
    const label = `${twoPhase ? "two-phase" : "single-phase"}${
      failPush ? ", failing push" : ""
    }`;
    Deno.test(`acquireModelLocks: push then release matches flush (${label})`, async () => {
      const events: string[] = [];
      const typeName = registerRecordingLockType(events, {
        twoPhase,
        failPush,
      });
      try {
        await withTempDir(async (dir) => {
          await initializeRepo(dir);
          await configureExtensionDatastore(dir, typeName);
          const { datastoreConfig } = await resolveDatastoreForRepo(dir);
          const models = [{ modelType: "test-type", modelId: "m1" }];

          // Each run records only what happens after the locks are held.
          const run = async (
            end: (
              lock: Awaited<ReturnType<typeof acquireModelLocks>>,
            ) => Promise<void>,
          ) => {
            const lock = await acquireModelLocks(datastoreConfig, models, dir);
            events.length = 0;
            let error: string | undefined;
            try {
              await end(lock);
            } catch (caught) {
              error = caught instanceof Error ? caught.message : String(caught);
            }
            return { events: [...events], error };
          };

          const viaFlush = await run((lock) => lock.flush());
          const viaSplit = await run(async (lock) => {
            try {
              await lock.push();
            } finally {
              await lock.release();
            }
          });

          assertEquals(viaSplit, viaFlush);
          assertEquals(viaFlush.error !== undefined, failPush);
          if (failPush) assertStringIncludes(viaFlush.error!, "push failed");
          assertEquals(
            viaSplit.events.at(-1),
            "lock-release",
            "the per-model lock is released last, even when the push fails",
          );
          assertEquals(
            viaSplit.events.includes(twoPhase ? "preparePush" : "pushChanged"),
            !failPush,
          );
        });
      } finally {
        datastoreTypeRegistry.invalidateType(typeName);
      }
    });
  }
}

Deno.test("acquireModelLocks: push leaves the locks held until release", async () => {
  const events: string[] = [];
  const typeName = registerRecordingLockType(events, {
    twoPhase: false,
    failPush: false,
  });
  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      await configureExtensionDatastore(dir, typeName);
      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      const lock = await acquireModelLocks(datastoreConfig, [
        { modelType: "test-type", modelId: "m1" },
      ], dir);

      await lock.push();
      const releasesAfterPush = events.filter((e) => e === "lock-release")
        .length;
      await lock.release();
      const releasesAfterRelease = events.filter((e) => e === "lock-release")
        .length;

      assertEquals(
        releasesAfterRelease - releasesAfterPush,
        1,
        "release frees the one per-model lock push left held",
      );
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

// CLI commands stage their bare marks through a root unit over
// repoContext.markDirty and push with syncService (swamp-club#3033), so a
// sync service without a mark hook would push a change that was never marked.
Deno.test("requireInitializedRepoUnlocked: returns a mark hook exactly when it returns a sync service", async () => {
  const events: string[] = [];
  const typeName = registerRecordingLockType(events, {
    twoPhase: false,
    failPush: false,
  });
  try {
    await withTempDir(async (dir) => {
      await initializeRepo(dir);
      const filesystem = await requireInitializedRepoUnlocked({
        repoDir: dir,
        outputMode: "json",
      });
      assertEquals(filesystem.syncService, undefined);
      assertEquals(filesystem.repoContext.markDirty, undefined);

      await configureExtensionDatastore(dir, typeName);
      const custom = await requireInitializedRepoUnlocked({
        repoDir: dir,
        outputMode: "json",
      });
      assertExists(custom.syncService);
      assertExists(custom.repoContext.markDirty);
      await flushDatastoreSync();
    });
  } finally {
    datastoreTypeRegistry.invalidateType(typeName);
  }
});

function waitRegistrationFor(runId: string): WaitRegistration {
  return registrationOf(
    {
      workflowId: "wf-1",
      workflowName: "release",
      runId,
      jobName: "main",
      stepName: "review",
    },
    SignalWait.open({ type: "object" }, 60, new Date()),
    new Date(),
  );
}

/** A control-plane store in memory that records each call it receives. */
function recordingControlPlane(calls: string[]): ControlPlaneStore {
  const data = new Map<string, Uint8Array>();
  return {
    put: (key, bytes) => {
      calls.push(`put:${key}`);
      data.set(key, bytes);
      return Promise.resolve();
    },
    putIfAbsent: (key, bytes) => {
      calls.push(`putIfAbsent:${key}`);
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, bytes);
      return Promise.resolve(true);
    },
    get: (key) => {
      calls.push(`get:${key}`);
      return Promise.resolve(data.get(key) ?? null);
    },
    delete: (key) => {
      calls.push(`delete:${key}`);
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix) => {
      calls.push(`list:${prefix}`);
      return Promise.resolve(
        [...data.keys()].filter((key) => key.startsWith(prefix)),
      );
    },
  };
}

function customConfig(namespace?: string): DatastoreConfig {
  return {
    type: "@acme/bucket",
    config: {},
    datastorePath: "bucket://x",
    cachePath: "/nonexistent/cache",
    namespace,
  };
}

Deno.test("resolveSignalWaitSupport: a filesystem datastore keeps wait records under its own path, shared by every repository on it", async () => {
  await withTempDir(async (datastore) => {
    // Two repositories that share one datastore directory.
    const config: DatastoreConfig = { type: "filesystem", path: datastore };
    const one = resolveSignalWaitSupport(config, undefined, {
      runsInDatastore: true,
    });
    const two = resolveSignalWaitSupport(config);
    assert(one.supported && two.supported);
    // Run records are the datastore's own only where they are stored in
    // it; a repository that keeps its runs to itself is not told so.
    assertEquals(one.localRunAbsenceIsAuthoritative, true);
    assertEquals(two.localRunAbsenceIsAuthoritative, false);
    const registration = waitRegistrationFor(crypto.randomUUID());

    await one.store.register(registration);

    assertEquals(await two.store.listRegistrations(), [registration]);
    assertEquals(
      (await Deno.stat(
        join(datastore, "_control", "waits", registration.waitId),
      )).isFile,
      true,
    );
  });
});

Deno.test("resolveSignalWaitSupport: a namespaced filesystem datastore keeps each namespace's wait records apart", async () => {
  await withTempDir(async (datastore) => {
    const team = resolveSignalWaitSupport({
      type: "filesystem",
      path: datastore,
      namespace: "team-a",
    });
    const other = resolveSignalWaitSupport({
      type: "filesystem",
      path: datastore,
      namespace: "team-b",
    });
    assert(team.supported && other.supported);
    const registration = waitRegistrationFor(crypto.randomUUID());

    await team.store.register(registration);

    assertEquals(await other.store.listRegistrations(), []);
    assertEquals(
      (await Deno.stat(
        join(datastore, "team-a", "_control", "waits", registration.waitId),
      )).isFile,
      true,
    );
  });
});

Deno.test("resolveSignalWaitSupport: a custom datastore without a shared control-plane store does not support waits", () => {
  const { service: plain } = createRecordingSyncService();
  const noSync = resolveSignalWaitSupport(customConfig());
  const noCapability = resolveSignalWaitSupport(customConfig(), plain);
  // Advertised without a store to hand out.
  const noStore = resolveSignalWaitSupport(customConfig(), {
    ...plain,
    capabilities: () => ({ controlPlane: true }),
  });

  for (const support of [noSync, noCapability, noStore]) {
    assert(!support.supported);
    assertStringIncludes(support.reason, '"@acme/bucket"');
    assertStringIncludes(support.reason, "update the");
  }
});

Deno.test("resolveSignalWaitSupport: a store that cannot create a record atomically is found out when the store is opened, with the reason", async () => {
  const { service: plain } = createRecordingSyncService();
  const { putIfAbsent: _dropped, ...withoutCreate } = recordingControlPlane([]);
  const support = resolveSignalWaitSupport(customConfig(), {
    ...plain,
    capabilities: () => ({ controlPlane: true }),
    controlPlaneStore: () => withoutCreate,
  });
  assert(support.supported);

  // What a workflow with a wait asks before it starts.
  const refused = await assertRejects(() => support.ready!(), Error);
  assertStringIncludes(refused.message, "putIfAbsent");
  assertStringIncludes(refused.message, '"@acme/bucket"');
  // And no record is written through such a store.
  await assertRejects(
    () => support.store.register(waitRegistrationFor(crypto.randomUUID())),
    Error,
    "putIfAbsent",
  );
});

Deno.test("resolveSignalWaitSupport: the extension's store is not created until a wait is used, and then only after the namespace is bound", async () => {
  // As the S3 and GCS extensions behave: the store's list prefix is fixed
  // by the namespace bound when the store is created.
  const order: string[] = [];
  let bound: string | undefined;
  const records = new Map<string, Uint8Array>();
  const { service: plain } = createRecordingSyncService();
  const sync = {
    ...plain,
    capabilities: () => ({ controlPlane: true }),
    pullChanged: (options?: { namespace?: string }) => {
      order.push(`pull:${options?.namespace}`);
      bound = options?.namespace;
      return Promise.resolve(0);
    },
    controlPlaneStore: (): ControlPlaneStore => {
      order.push(`store:${bound}`);
      const prefix = bound ? `${bound}/_control/` : "_control/";
      return {
        put: (key, data) => {
          records.set(`${bound}/_control/${key}`, data);
          return Promise.resolve();
        },
        putIfAbsent: (key, data) => {
          const full = `${bound}/_control/${key}`;
          if (records.has(full)) return Promise.resolve(false);
          records.set(full, data);
          return Promise.resolve(true);
        },
        get: (key) =>
          Promise.resolve(records.get(`${bound}/_control/${key}`) ?? null),
        delete: (key) => {
          records.delete(`${bound}/_control/${key}`);
          return Promise.resolve();
        },
        // The prefix captured at creation, not the one bound now.
        list: (keyPrefix) =>
          Promise.resolve(
            [...records.keys()].filter((key) =>
              key.startsWith(prefix + keyPrefix)
            ).map((key) => key.slice(prefix.length)),
          ),
      };
    },
  };

  const support = resolveSignalWaitSupport(customConfig("team-a"), sync);
  assert(support.supported);
  // Building a repository context creates nothing and binds nothing.
  assertEquals(order, []);

  const registration = waitRegistrationFor(crypto.randomUUID());
  await support.store.register(registration);

  assertEquals(order, ["pull:team-a", "store:team-a"]);
  // Written and listed under the same, namespaced prefix.
  assertEquals(await support.store.listRegistrations(), [registration]);
  assertEquals(order, ["pull:team-a", "store:team-a"]);
});

Deno.test("resolveSignalWaitSupport: a failed open is tried again by the next call, not kept", async () => {
  const { service: plain } = createRecordingSyncService();
  let pulls = 0;
  const support = resolveSignalWaitSupport(customConfig("team-a"), {
    ...plain,
    capabilities: () => ({ controlPlane: true }),
    pullChanged: () => {
      pulls++;
      return pulls === 1
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(0);
    },
    controlPlaneStore: () => recordingControlPlane([]),
  });
  assert(support.supported);

  await assertRejects(() => support.ready!(), Error, "network down");
  await support.ready!();
  await support.store.listRegistrations();

  assertEquals(pulls, 2);
});

Deno.test("resolveSignalWaitSupport: a custom datastore's store is bound to the namespace by one pull before its first use", async () => {
  const { service, events } = createRecordingSyncService();
  const calls: string[] = [];
  const remote = recordingControlPlane(calls);
  const support = resolveSignalWaitSupport(customConfig("team-a"), {
    ...service,
    capabilities: () => ({ controlPlane: true }),
    controlPlaneStore: () => remote,
  });
  assert(support.supported);
  assertEquals(support.localRunAbsenceIsAuthoritative, undefined);
  // Resolving touches neither the store nor the remote.
  assertEquals(events, []);
  assertEquals(calls, []);
  const registration = waitRegistrationFor(crypto.randomUUID());

  await support.store.register(registration);
  await support.store.listRegistrations();
  await support.store.findOutcome(registration.waitId);

  assertEquals(events, [{ kind: "pull", options: { namespace: "team-a" } }]);
  assertEquals(calls[0], `putIfAbsent:waits/${registration.waitId}`);
});

Deno.test("resolveSignalWaitSupport: no pull is made without a namespace, or when the caller has bound it already", async () => {
  for (
    const [namespace, options] of [
      [undefined, undefined],
      ["team-a", { namespaceBound: true }],
    ] as const
  ) {
    const { service, events } = createRecordingSyncService();
    const support = resolveSignalWaitSupport(
      customConfig(namespace),
      {
        ...service,
        capabilities: () => ({ controlPlane: true }),
        controlPlaneStore: () => recordingControlPlane([]),
      },
      options,
    );
    assert(support.supported);

    assertEquals(support.localRunAbsenceIsAuthoritative, undefined);
    await support.store.register(waitRegistrationFor(crypto.randomUUID()));

    assertEquals(events, []);
  }
});

Deno.test("requireInitializedRepoUnlocked: gives the context wait support, and its run repository closes the waits of a run saved as ended", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: dir,
      outputMode: "json",
    });
    const support = signalWaitsOf(repoContext);
    assert(support.supported);

    const workflow = Workflow.create({
      name: "release",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "review",
              task: StepTask.waitForSignal(60, { type: "object" }),
            }),
          ],
        }),
      ],
    });
    const run = WorkflowRun.create(workflow);
    run.start();
    run.getJob("main")!.start();
    const step = run.getJob("main")!.getStep("review")!;
    step.start();
    const wait = SignalWait.open({ type: "object" }, 60, new Date());
    step.waitForSignal(wait);
    await support.store.register({
      ...waitRegistrationFor(run.id),
      waitId: wait.id,
    });
    run.suspend();

    // A suspended run keeps its wait open.
    await repoContext.workflowRunRepo.save(workflow.id, run);
    assertEquals((await support.store.findRegistration(wait.id)).kind, "found");
    assertEquals((await support.store.findOutcome(wait.id)).kind, "absent");

    // Any writer that ends the run closes it, with nothing to remember.
    run.endAsCancelled("operator");
    await repoContext.workflowRunRepo.save(workflow.id, run);
    assertEquals(
      (await support.store.findRegistration(wait.id)).kind,
      "absent",
    );
    const outcome = await support.store.findOutcome(wait.id);
    assert(outcome.kind === "found");
    assertEquals(outcome.record.kind, "cancelled");
    await flushDatastoreSync();
  });
});

Deno.test("signalWaitsOf: a context that was given no store does not support waits", () => {
  const support = signalWaitsOf({});
  assert(!support.supported);
});

Deno.test("attachSignalWaits: a wait store that cannot be reached does not stop a run from being saved as ended", async () => {
  await withTempDir(async (dir) => {
    class Unreachable extends InMemorySignalWaitStore {
      override removeRegistration(): Promise<void> {
        return Promise.reject(new Error("bucket unreachable"));
      }
    }
    const store = new Unreachable();
    const runRepo = new YamlWorkflowRunRepository(dir);
    attachSignalWaits({ workflowRunRepo: runRepo }, { supported: true, store });

    const workflow = Workflow.create({
      name: "release",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "review",
              task: StepTask.waitForSignal(60, { type: "object" }),
            }),
          ],
        }),
      ],
    });
    const run = WorkflowRun.create(workflow);
    run.start();
    run.getJob("main")!.start();
    const step = run.getJob("main")!.getStep("review")!;
    step.start();
    step.waitForSignal(SignalWait.open({ type: "object" }, 60, new Date()));
    run.endAsCancelled("operator");

    await runRepo.save(workflow.id, run);

    assertEquals(
      (await runRepo.findById(workflow.id, run.id))?.status,
      "cancelled",
    );

    // Without support the hook is cleared, not left from an earlier call.
    attachSignalWaits({ workflowRunRepo: runRepo }, {
      supported: false,
      reason: "none",
    });
    assertEquals(runRepo.beforeSave, undefined);
  });
});

Deno.test("runsLiveInDatastore: true only when run records are stored in the datastore, not kept in the repository", () => {
  const dir = join("some", "repo");
  const path = join("some", "shared");
  const resolverFor = (config: DatastoreConfig) =>
    new DefaultDatastorePathResolver(dir, config);

  // The default layout keeps runs in the datastore.
  assertEquals(
    runsLiveInDatastore(resolverFor({ type: "filesystem", path })),
    true,
  );
  // A datastore told to hold other directories only.
  assertEquals(
    runsLiveInDatastore(
      resolverFor({ type: "filesystem", path, directories: ["data"] }),
    ),
    false,
  );
  // Or told to leave the runs out.
  assertEquals(
    runsLiveInDatastore(
      resolverFor({ type: "filesystem", path, exclude: ["workflow-runs"] }),
    ),
    false,
  );
});

Deno.test("requireInitializedRepoUnlocked: the default datastore lets the sweep judge a wait by its run record", async () => {
  await withTempDir(async (dir) => {
    await initializeRepo(dir);
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: dir,
      outputMode: "json",
    });
    const support = signalWaitsOf(repoContext);
    assert(support.supported);
    assertEquals(support.localRunAbsenceIsAuthoritative, true);
    await flushDatastoreSync();
  });
});

// ============================================================================
// Hand-off reclaim (swamp-club#3111)
// ============================================================================

/** A scan that skips `skipped` and waits on `held` locks. */
const skippingScan = (
  skipped: readonly string[],
  held = 0,
): PerModelLockScan => ({
  held,
  heldForOtherRuns: [],
  skippedLockIds: skipped,
  waitedLocks: [],
});

/** Runs a drain over `scans`, recording scans and published lists in order. */
async function drainPublishing(scans: PerModelLockScan[]) {
  const log: string[] = [];
  let i = 0;
  const skipped = await waitForPerModelLocks("/unused", undefined, {
    progressWriter: () => {},
    pollIntervalMs: 1,
    drainWaits: {
      publish: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve(),
    },
    findModelLocks: () => {
      const scan = scans[Math.min(i++, scans.length - 1)];
      log.push(`scan held=${scan.held} skip=${scan.skippedLockIds.join("+")}`);
      return Promise.resolve(scan);
    },
    publishSkipping: (lockIds) => {
      log.push(`publish ${lockIds.join("+")}`);
      return Promise.resolve();
    },
  });
  return { skipped, log };
}

Deno.test("waitForPerModelLocks: a drain that skips nothing publishes nothing and scans once", async () => {
  const { skipped, log } = await drainPublishing([skippingScan([])]);
  assertEquals(skipped, []);
  assertEquals(log, ["scan held=0 skip="]);
});

Deno.test("waitForPerModelLocks: publishes the locks it skips, then confirms them with one more scan", async () => {
  const { skipped, log } = await drainPublishing([skippingScan(["a", "b"])]);
  assertEquals(skipped, ["a", "b"]);
  assertEquals(log, [
    "scan held=0 skip=a+b",
    "publish a+b",
    "scan held=0 skip=a+b",
  ]);
});

Deno.test("waitForPerModelLocks: withdraws a re-keyed lock from the list before waiting on it", async () => {
  const { skipped, log } = await drainPublishing([
    skippingScan(["a", "b"]),
    // The holder of b re-keyed it: no longer skipped, now waited on.
    skippingScan(["a"], 1),
    skippingScan(["a"], 1),
    skippingScan(["a"]),
  ]);
  assertEquals(skipped, ["a"]);
  assertEquals(log, [
    "scan held=0 skip=a+b",
    "publish a+b",
    "scan held=1 skip=a",
    "publish a",
    "scan held=1 skip=a",
    "scan held=0 skip=a",
  ]);
});

Deno.test("waitForPerModelLocks: without a publisher it returns the skipped locks of its only scan", async () => {
  let scans = 0;
  const skipped = await waitForPerModelLocks("/unused", undefined, {
    findModelLocks: () => {
      scans++;
      return Promise.resolve(skippingScan(["a"]));
    },
  });
  assertEquals(skipped, ["a"]);
  assertEquals(scans, 1);
});

/** A global lock as `reclaimModelLocks` reads it: one info per inspect. */
function globalLockReturning(infos: Array<LockInfo | null>) {
  let inspects = 0;
  return {
    inspect: () =>
      Promise.resolve(infos[Math.min(inspects++, infos.length - 1)]),
    inspects: () => inspects,
  };
}

const globalInfo = (skipping?: string[], ageMs = 0): LockInfo => ({
  holder: "gc@host",
  hostname: "host",
  pid: 4242,
  acquiredAt: new Date(Date.now() - ageMs).toISOString(),
  ttlMs: 30_000,
  nonce: "global-nonce",
  ...(skipping ? { skipping } : {}),
});

Deno.test("reclaimModelLocks: re-keys each held lock and proceeds when no structural command is working", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    const before = lock.heldNonce;
    const global = globalLockReturning([null]);

    await reclaimModelLocks([lock], global, { progressWriter: () => {} });

    assertNotEquals(lock.heldNonce, before);
    assertEquals(global.inspects(), 1);
    await lock.release();
  });
});

Deno.test("reclaimModelLocks: holds nothing to re-key, so it never reads the global lock", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    const global = globalLockReturning([globalInfo(["anything"])]);
    await reclaimModelLocks([lock], global, { progressWriter: () => {} });
    await reclaimModelLocks([], global, { progressWriter: () => {} });
    assertEquals(global.inspects(), 0);
  });
});

Deno.test("reclaimModelLocks: waits while a structural command lists the retired nonce, until it finishes or withdraws it", async () => {
  await withTempDir(async (dir) => {
    for (const ending of [null, globalInfo(["some-other-lock"])]) {
      const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
      await lock.acquire();
      const retired = lock.heldNonce!;
      const working = globalInfo([retired]);
      const global = globalLockReturning([working, working, ending]);
      const lines: string[] = [];

      await reclaimModelLocks([lock], global, {
        pollMs: 1,
        progressWriter: (line) => lines.push(line),
      });

      assertEquals(global.inspects(), 3);
      assertStringIncludes(lines[0], "pid 4242");
      assertEquals(lines.length, 2);
      await lock.release();
    }
  });
});

Deno.test("reclaimModelLocks: ignores a structural command that skipped other locks, a malformed list and a stale global lock", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    const cases = (retired: string): LockInfo[] => [
      globalInfo(["some-other-lock"]),
      globalInfo(),
      { ...globalInfo(), skipping: [retired, "not a nonce"] },
      globalInfo([retired], 60_000),
    ];
    for (let i = 0; i < 4; i++) {
      const global = globalLockReturning([cases(lock.heldNonce!)[i]]);
      await reclaimModelLocks([lock], global, {
        pollMs: 1,
        progressWriter: () => {},
      });
      assertEquals(global.inspects(), 1);
    }
    await lock.release();
  });
});

Deno.test("reclaimModelLocks: throws LockTimeoutError when the structural command outlasts the timeout", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    const retired = lock.heldNonce!;
    const global = globalLockReturning([globalInfo([retired])]);

    const error = await assertRejects(
      () =>
        reclaimModelLocks([lock], global, {
          pollMs: 1,
          timeoutMs: 1,
          progressWriter: () => {},
          displayKey: "ns/.datastore.lock",
        }),
      LockTimeoutError,
    );
    assertStringIncludes(error.message, "ns/.datastore.lock");
    // The lock is still re-keyed: nothing new can skip it.
    assertNotEquals(lock.heldNonce, retired);
    await lock.release();
  });
});

Deno.test("reclaimModelLocks: a cancelled run re-keys and does not wait on a structural command (swamp-club#3157)", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    const retired = lock.heldNonce!;
    const global = globalLockReturning([globalInfo([retired])]);
    const lines: string[] = [];

    const error = await assertRejects(
      () =>
        reclaimModelLocks([lock], global, {
          signal: AbortSignal.abort(),
          progressWriter: (line) => lines.push(line),
        }),
      DOMException,
    );
    assertEquals(error.name, "AbortError");
    // One read of the global lock, and no notice of a wait that never began.
    assertEquals(global.inspects(), 1);
    assertEquals(lines, []);
    // The lock is still re-keyed: nothing new can skip it.
    assertNotEquals(lock.heldNonce, retired);
    await lock.release();
  });
});

Deno.test("reclaimModelLocks: a cancel during the wait ends it", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    const controller = new AbortController();
    const working = globalInfo([lock.heldNonce!]);
    let inspects = 0;
    const global = {
      inspect: () => {
        // Cancelled while the second poll is being read.
        if (++inspects === 2) controller.abort();
        return Promise.resolve(working);
      },
    };

    const error = await assertRejects(
      () =>
        reclaimModelLocks([lock], global, {
          pollMs: 1,
          signal: controller.signal,
          progressWriter: () => {},
        }),
      DOMException,
    );
    assertEquals(error.name, "AbortError");
    assertEquals(inspects, 2);
    await lock.release();
  });
});

Deno.test("reclaimModelLocks: a cancelled run reads a global lock caught mid-write again instead of rejecting", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    // What FileLock.inspect reports for a fresh unreadable lock file.
    const midWrite: LockInfo = {
      holder: "unknown (lock file is being written)",
      hostname: "unknown",
      pid: 0,
      acquiredAt: new Date().toISOString(),
      ttlMs: 30_000,
    };
    // Once readable, it is a command that skipped none of these locks.
    const global = globalLockReturning([midWrite, globalInfo(["other"])]);

    await reclaimModelLocks([lock], global, {
      pollMs: 1,
      signal: AbortSignal.abort(),
      progressWriter: () => {},
    });
    assertEquals(global.inspects(), 2);
    await lock.release();
  });
});

Deno.test("reclaimModelLocks: a cancelled run with no structural command at work takes its locks back", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    const retired = lock.heldNonce!;

    await reclaimModelLocks([lock], globalLockReturning([null]), {
      signal: AbortSignal.abort(),
      progressWriter: () => {},
    });
    assertNotEquals(lock.heldNonce, retired);
    await lock.release();
  });
});

Deno.test("waitForPerModelLocks: a skipped set that never settles ends at the lock timeout, not in a spin", async () => {
  let scans = 0;
  await assertRejects(
    () =>
      withMockedEnv(
        { SWAMP_LOCK_TIMEOUT_MS: "30" },
        () =>
          waitForPerModelLocks("/unused", undefined, {
            progressWriter: () => {},
            pollIntervalMs: 5,
            // Nothing is ever held, but the skipped set flips on every scan.
            findModelLocks: () =>
              Promise.resolve(skippingScan(scans++ % 2 === 0 ? ["a"] : [])),
            publishSkipping: () => Promise.resolve(),
          }),
      ),
    LockTimeoutError,
  );
  // Paced by the poll interval after the first confirming scan.
  assert(scans < 30, `expected a paced drain, got ${scans} scans`);
});

Deno.test("reclaimModelLocks: does not wait on a structural command on this host that has died", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    const here = (retired: string): LockInfo => ({
      ...globalInfo([retired]),
      hostname: hostname(),
    });

    // Killed with its hop: its lock file outlives it until the ttl.
    const dead = globalLockReturning([here(lock.heldNonce!)]);
    await reclaimModelLocks([lock], dead, {
      pollMs: 1,
      progressWriter: () => {},
      isProcessDead: (pid) => pid === 4242,
    });
    assertEquals(dead.inspects(), 1);

    // The same pid on another host says nothing about that process.
    const elsewhere = globalLockReturning([
      globalInfo([lock.heldNonce!]),
      null,
    ]);
    await reclaimModelLocks([lock], elsewhere, {
      pollMs: 1,
      progressWriter: () => {},
      isProcessDead: () => true,
    });
    assertEquals(elsewhere.inspects(), 2);
    await lock.release();
  });
});

Deno.test("reclaimModelLocks: reads a global lock caught mid-write again instead of proceeding", async () => {
  await withTempDir(async (dir) => {
    const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
    await lock.acquire();
    // What FileLock.inspect reports for a fresh unreadable lock file.
    const midWrite: LockInfo = {
      holder: "unknown (lock file is being written)",
      hostname: "unknown",
      pid: 0,
      acquiredAt: new Date().toISOString(),
      ttlMs: 30_000,
    };
    const retired = lock.heldNonce!;
    const global = globalLockReturning([
      midWrite,
      globalInfo([retired]),
      null,
    ]);

    await reclaimModelLocks([lock], global, {
      pollMs: 1,
      progressWriter: () => {},
    });

    // Not taken for a command that skipped nothing: read again, found
    // working under the retired nonce, and waited out.
    assertEquals(global.inspects(), 3);
    await lock.release();
  });
});

const SUSPENSION = {
  runId: "0b8a6a52-3a51-4b53-9a4e-0d5a1c8a7f10",
  suspensionKey: "a".repeat(64),
};

Deno.test("resolveContinuationClaims: a filesystem datastore keeps claims in the repository's control-plane directory, one holder per process", async () => {
  await withTempDir(async (repoDir) => {
    const config: DatastoreConfig = { type: "filesystem", path: repoDir };
    const one = resolveContinuationClaims(config, repoDir)!;
    const two = resolveContinuationClaims(config, repoDir)!;
    assert(one.holder.startsWith("local:"));
    assert(one.holder !== two.holder);
    assertEquals(one.usable, undefined);

    const claim = {
      ...SUSPENSION,
      generation: 1,
      holder: one.holder,
      claimedAt: new Date().toISOString(),
    };
    assertEquals(await one.store.create(claim), true);

    // Another process on the repository reads the same record.
    assertEquals(
      await two.store.find(claim.runId, claim.suspensionKey),
      claim,
    );
    assertEquals(await two.store.create(claim), false);
    // A local command writes no heartbeat, so nothing is known of it.
    assertEquals(await two.liveness(one.holder), "unknown");
  });
});

Deno.test("resolveContinuationClaims: a custom datastore without a shared control-plane store has no claims", () => {
  const { service: plain } = createRecordingSyncService();
  assertEquals(resolveContinuationClaims(customConfig(), "/repo"), undefined);
  assertEquals(
    resolveContinuationClaims(customConfig(), "/repo", plain),
    undefined,
  );
  // Advertised without a store to hand out.
  assertEquals(
    resolveContinuationClaims(customConfig(), "/repo", {
      ...plain,
      capabilities: () => ({ controlPlane: true }),
    }),
    undefined,
  );
});

Deno.test("resolveContinuationClaims: a custom datastore's claims go to its control-plane store, opened on first use after the namespace is bound", async () => {
  const { service: plain } = createRecordingSyncService();
  const calls: string[] = [];
  const remote = recordingControlPlane(calls);
  const claims = resolveContinuationClaims(customConfig("team-a"), "/repo", {
    ...plain,
    capabilities: () => ({ controlPlane: true }),
    pullChanged: (options?: { namespace?: string }) => {
      calls.push(`pull:${options?.namespace}`);
      return Promise.resolve(0);
    },
    controlPlaneStore: () => remote,
  })!;
  assert(claims.holder.startsWith("local:"));
  // Building a repository context opens nothing.
  assertEquals(calls, []);

  assertEquals(await claims.usable!(), true);
  assertEquals(calls, ["pull:team-a"]);
  const claim = {
    ...SUSPENSION,
    generation: 1,
    holder: claims.holder,
    claimedAt: new Date().toISOString(),
  };
  assertEquals(await claims.store.create(claim), true);
  assertEquals(calls, [
    "pull:team-a",
    `putIfAbsent:continuations/${claim.runId}/${claim.suspensionKey}/1`,
  ]);
  // A serve instance with no heartbeat in that store is dead.
  assertEquals(await claims.liveness("serve:gone"), "dead");
});

Deno.test("resolveContinuationClaims: a store that cannot create a record atomically is not usable, and any other failure to open it is not hidden", async () => {
  const { service: plain } = createRecordingSyncService();
  const { putIfAbsent: _dropped, ...withoutCreate } = recordingControlPlane([]);
  const notAtomic = resolveContinuationClaims(customConfig(), "/repo", {
    ...plain,
    capabilities: () => ({ controlPlane: true }),
    controlPlaneStore: () => withoutCreate,
  })!;
  assertEquals(await notAtomic.usable!(), false);

  let pulls = 0;
  const flaky = resolveContinuationClaims(customConfig("team-a"), "/repo", {
    ...plain,
    capabilities: () => ({ controlPlane: true }),
    pullChanged: () => {
      pulls++;
      return pulls === 1
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(0);
    },
    controlPlaneStore: () => recordingControlPlane([]),
  })!;
  await assertRejects(() => flaky.usable!(), Error, "network down");
  // The failed open is not kept: the next call tries again.
  assertEquals(await flaky.usable!(), true);
  assertEquals(pulls, 2);
});

Deno.test("runRecordCurrencyOver: nothing to compare on a filesystem datastore or without fetchContent", () => {
  const { service: plain } = createRecordingSyncService();
  const pathOf = () => "/nonexistent/cache/run.yaml";
  const fetching = { ...plain, fetchContent: () => Promise.resolve(null) };
  assertEquals(
    runRecordCurrencyOver(
      { type: "filesystem", path: "/repo" },
      fetching,
      pathOf,
    ),
    undefined,
  );
  assertEquals(
    runRecordCurrencyOver(customConfig(), plain, pathOf),
    undefined,
  );
  assertEquals(
    runRecordCurrencyOver(customConfig(), undefined, pathOf),
    undefined,
  );
});

Deno.test("runRecordCurrencyOver: compares the cached run record with the remote one, read by its cache-relative path", async () => {
  await withTempDir(async (cachePath) => {
    const { service: plain } = createRecordingSyncService();
    const runPath = join(cachePath, "team-a", "workflow-runs", "w", "r.yaml");
    await Deno.mkdir(join(cachePath, "team-a", "workflow-runs", "w"), {
      recursive: true,
    });
    await Deno.writeTextFile(runPath, "status: suspended\n");
    const encoder = new TextEncoder();
    let remote: Uint8Array | null = encoder.encode("status: suspended\n");
    const fetched: { relPath: string; namespace?: string; bounded: boolean }[] =
      [];
    const current = runRecordCurrencyOver(
      { ...customConfig("team-a"), cachePath },
      {
        ...plain,
        fetchContent: (relPath, options) => {
          fetched.push({
            relPath,
            namespace: options?.namespace,
            bounded: options?.signal !== undefined,
          });
          return Promise.resolve(remote);
        },
      },
      () => runPath,
    )!;
    const run = { workflowId: "w", runId: "r" };

    assertEquals(await current(run), true);
    assertEquals(fetched, [{
      relPath: "team-a/workflow-runs/w/r.yaml",
      namespace: "team-a",
      bounded: true,
    }]);

    // A peer ended the run: same length, other bytes.
    remote = encoder.encode("status: cancelled\n");
    assertEquals(await current(run), false);
    // A longer record.
    remote = encoder.encode("status: suspended\nmore: 1\n");
    assertEquals(await current(run), false);
    // The remote has no such run.
    remote = null;
    assertEquals(await current(run), false);
    // This host has no record to resume from.
    remote = encoder.encode("status: suspended\n");
    await Deno.remove(runPath);
    assertEquals(await current(run), false);
    // Nothing was written back to the cache.
    assertEquals(await exists(runPath), false);
  });
});

Deno.test("runRecordCurrencyOver: a remote that cannot be read rejects", async () => {
  await withTempDir(async (cachePath) => {
    const { service: plain } = createRecordingSyncService();
    const runPath = join(cachePath, "r.yaml");
    await Deno.writeTextFile(runPath, "status: suspended\n");
    const current = runRecordCurrencyOver(
      { ...customConfig(), cachePath },
      { ...plain, fetchContent: () => Promise.reject(new Error("offline")) },
      () => runPath,
    )!;

    await assertRejects(
      () => current({ workflowId: "w", runId: "r" }),
      Error,
      "offline",
    );
  });
});

Deno.test("runRecordCurrencyOver: a run record outside the cache is never read from the remote", async () => {
  await withTempDir(async (dir) => {
    const { service: plain } = createRecordingSyncService();
    let fetched = 0;
    const current = runRecordCurrencyOver(
      { ...customConfig(), cachePath: join(dir, "cache") },
      {
        ...plain,
        fetchContent: () => {
          fetched++;
          return Promise.resolve(null);
        },
      },
      () => join(dir, "repo", ".swamp", "workflow-runs", "r.yaml"),
    )!;

    await assertRejects(
      () => current({ workflowId: "w", runId: "r" }),
      Error,
      "outside the datastore cache",
    );
    assertEquals(fetched, 0);
  });
});
