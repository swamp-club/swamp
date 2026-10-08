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
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { copy } from "@std/fs";
import { dirname, join } from "@std/path";
import { z } from "zod";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createDatastoreSetupDeps,
  type DatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupExtension,
  type DatastoreSetupExtensionInput,
  datastoreSetupFilesystem,
  type DatastoreSetupFilesystemInput,
} from "./setup.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import {
  type DatastoreSyncOptions,
  SyncTimeoutError,
} from "../../domain/datastore/datastore_sync_service.ts";
import { readNamespaceManifest } from "../../infrastructure/persistence/namespace_manifest.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import type {
  DatastoreConfig,
  DatastoreConfigData,
} from "../../domain/datastore/datastore_config.ts";
import {
  DATASTORE_FORMAT_MARKER_INVALID_CODE,
  DATASTORE_FORMAT_UNSUPPORTED_CODE,
  InvalidDatastoreFormatMarkerError,
  UnsupportedDatastoreFormatError,
} from "../../domain/datastore/datastore_format.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";

function makeDeps(
  overrides: Partial<DatastoreSetupDeps> = {},
): DatastoreSetupDeps {
  return {
    requireUpgradedRepo: () => Promise.resolve(),
    verifyPath: () => Promise.resolve({ healthy: true, message: "ok" }),
    ensureDir: () => Promise.resolve(),
    getDatastoreDirectories: () => ["data", "outputs"],
    migrateData: () =>
      Promise.resolve({
        filesCopied: 5,
        bytesCopied: 1024,
        directoriesMigrated: ["data", "outputs"],
        errors: [],
      }),
    verifyMigration: () =>
      Promise.resolve({ valid: true, sourceCount: 5, destCount: 5 }),
    cleanupSourceDirs: () => Promise.resolve(),
    updateRepoConfig: () => Promise.resolve(),
    resolveInRepoConfigRole: () => Promise.resolve("unmanaged"),
    listConfigTierConflicts: () => Promise.resolve([]),
    inspectManagedConfigTier: () => Promise.resolve({ managed: false }),
    collapseEnvVars: (path: string) => path,
    assertDatastoreFormat: () => Promise.resolve(),
    ...overrides,
  };
}

function makeFilesystemInput(
  overrides: Partial<DatastoreSetupFilesystemInput> = {},
): DatastoreSetupFilesystemInput {
  return {
    datastorePath: "/tmp/datastore",
    repoDir: "/tmp/repo",
    skipMigration: false,
    ...overrides,
  };
}

Deno.test("datastoreSetupFilesystem: completes with migration", async () => {
  const deps = makeDeps();
  const input = makeFilesystemInput();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 3);
  assertEquals(events[0].kind, "validating");
  assertEquals(events[1].kind, "migrating");
  const completed = events[2] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.type, "filesystem");
  assertEquals(completed.data.path, "/tmp/datastore");
  assertEquals(completed.data.filesCopied, 5);
  assertEquals(completed.data.bytesCopied, 1024);
  assertEquals(completed.data.directoriesMigrated, ["data", "outputs"]);
  assertEquals(completed.data.errors, []);
  assertEquals(completed.data.sourcePath, "/tmp/repo/.swamp");
  assertEquals(completed.data.destinationPath, "/tmp/datastore");
});

Deno.test("datastoreSetupFilesystem: completes with skip migration", async () => {
  const deps = makeDeps();
  const input = makeFilesystemInput({ skipMigration: true });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const completed = events[1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.filesCopied, 0);
  assertEquals(completed.data.directoriesMigrated, []);
  assertEquals(completed.data.sourcePath, undefined);
  assertEquals(completed.data.destinationPath, undefined);
});

Deno.test("datastoreSetupFilesystem: errors on unhealthy path", async () => {
  const deps = makeDeps({
    verifyPath: () =>
      Promise.resolve({ healthy: false, message: "permission denied" }),
  });
  const input = makeFilesystemInput();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
});

Deno.test("datastoreSetupFilesystem: errors on non-upgraded repo", async () => {
  const deps = makeDeps({
    requireUpgradedRepo: () => {
      throw new Error("Run 'swamp repo upgrade' first");
    },
  });
  const input = makeFilesystemInput();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
});

Deno.test("datastoreSetupFilesystem: migrates from outgoing cache path when provided and exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Create a fake cache directory with content
    await Deno.mkdir(join(tempDir, "data"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "data", "test.json"),
      '{"hello":"world"}',
    );

    let capturedSourceDir = "";
    const deps = makeDeps({
      migrateData: (sourceDir: string) => {
        capturedSourceDir = sourceDir;
        return Promise.resolve({
          filesCopied: 1,
          bytesCopied: 18,
          directoriesMigrated: ["data"],
          errors: [],
        });
      },
    });
    const input = makeFilesystemInput({ outgoingCachePath: tempDir });

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupFilesystem(createLibSwampContext(), deps, input),
    );

    assertEquals(
      capturedSourceDir,
      tempDir,
      "migrateData should use the outgoing cache path as source",
    );
    const completed = events[events.length - 1] as Extract<
      DatastoreSetupEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.kind, "completed");
    assertEquals(completed.data.filesCopied, 1);
    assertEquals(completed.data.errors, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("datastoreSetupFilesystem: falls back to .swamp/ when outgoing cache path does not exist", async () => {
  let capturedSourceDir = "";
  const deps = makeDeps({
    migrateData: (sourceDir: string) => {
      capturedSourceDir = sourceDir;
      return Promise.resolve({
        filesCopied: 5,
        bytesCopied: 1024,
        directoriesMigrated: ["data", "outputs"],
        errors: [],
      });
    },
  });
  const input = makeFilesystemInput({
    outgoingCachePath: "/nonexistent/cache/path",
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(
    capturedSourceDir,
    "/tmp/repo/.swamp",
    "migrateData should fall back to .swamp/ when cache path does not exist",
  );
  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.filesCopied, 5);
});

Deno.test("datastoreSetupFilesystem: uses .swamp/ when no outgoing cache path provided", async () => {
  let capturedSourceDir = "";
  const deps = makeDeps({
    migrateData: (sourceDir: string) => {
      capturedSourceDir = sourceDir;
      return Promise.resolve({
        filesCopied: 5,
        bytesCopied: 1024,
        directoriesMigrated: ["data", "outputs"],
        errors: [],
      });
    },
  });
  const input = makeFilesystemInput();

  await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(
    capturedSourceDir,
    "/tmp/repo/.swamp",
    "migrateData should use .swamp/ when no outgoing cache path is set",
  );
});

// ============================================================================
// Extension datastore setup tests
// ============================================================================

/** Creates a stub DatastoreProvider for testing. */
function createStubProvider(
  overrides?: {
    healthy?: boolean;
    message?: string;
    hasSyncService?: boolean;
    pullResult?: number | (() => Promise<number | void>);
    pushResult?: () => Promise<number | void>;
  },
): DatastoreProvider {
  const healthy = overrides?.healthy ?? true;
  const message = overrides?.message ?? "ok";
  return {
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
          healthy,
          message,
          latencyMs: 1,
          datastoreType: "test",
        }),
    }),
    resolveDatastorePath: (repoDir: string) => `${repoDir}/.custom-store`,
    resolveCachePath: (repoDir: string) => `${repoDir}/.custom-cache`,
    ...(overrides?.hasSyncService !== false
      ? {
        createSyncService: () => ({
          pullChanged: () => {
            if (typeof overrides?.pullResult === "function") {
              return overrides.pullResult();
            }
            if (typeof overrides?.pullResult === "number") {
              return Promise.resolve(overrides.pullResult);
            }
            return Promise.resolve();
          },
          pushChanged: () =>
            overrides?.pushResult ? overrides.pushResult() : Promise.resolve(),
          markDirty: () => Promise.resolve(),
        }),
      }
      : {}),
  };
}

/** Registers a test extension datastore type if not already registered. */
function ensureTestExtensionType(
  type: string,
  opts?: {
    configSchema?: z.ZodTypeAny;
    healthy?: boolean;
    message?: string;
    hasSyncService?: boolean;
    pullResult?: number | (() => Promise<number | void>);
    pushResult?: () => Promise<number | void>;
  },
): void {
  if (!datastoreTypeRegistry.has(type)) {
    datastoreTypeRegistry.register({
      type,
      name: `Test ${type}`,
      description: `Test extension datastore: ${type}`,
      isBuiltIn: false,
      configSchema: opts?.configSchema,
      createProvider: () =>
        createStubProvider({
          healthy: opts?.healthy,
          message: opts?.message,
          hasSyncService: opts?.hasSyncService,
          pullResult: opts?.pullResult,
          pushResult: opts?.pushResult,
        }),
    });
  }
}

function makeExtensionInput(
  overrides: Partial<DatastoreSetupExtensionInput> = {},
): DatastoreSetupExtensionInput {
  return {
    type: "test-ext-setup",
    config: { bucket: "my-bucket" },
    repoDir: "/tmp/repo",
    repoId: "test-repo",
    skipMigration: false,
    ...overrides,
  };
}

Deno.test("datastoreSetupExtension: completes with valid config", async () => {
  ensureTestExtensionType("test-ext-setup");
  const deps = makeDeps();
  const input = makeExtensionInput();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  // Event sequence with sync-service-equipped extension:
  // validating → migrating → hydrating → completed
  assertEquals(events.length, 4);
  assertEquals(events[0].kind, "validating");
  assertEquals(events[1].kind, "migrating");
  assertEquals(events[2].kind, "hydrating");
  const completed = events[3] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.type, "test-ext-setup");
  assertEquals(completed.data.directoriesMigrated, ["data", "outputs"]);
  assertEquals(completed.data.bytesCopied, 1024);
  assertEquals(completed.data.sourcePath, "/tmp/repo/.swamp");
  assertEquals(completed.data.destinationPath, "/tmp/repo/.custom-cache");
});

Deno.test("datastoreSetupExtension: completes with skip migration", async () => {
  ensureTestExtensionType("test-ext-skip-migrate");
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-skip-migrate",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  // Event sequence on skip-migration with sync service:
  // validating → hydrating → completed (migration legs skipped, but
  // hydration still runs because the extension exposes a sync service).
  assertEquals(events.length, 3);
  assertEquals(events[0].kind, "validating");
  assertEquals(events[1].kind, "hydrating");
  const completed = events[2] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.filesCopied, 0);
  assertEquals(completed.data.sourcePath, undefined);
  assertEquals(completed.data.destinationPath, undefined);
});

Deno.test("datastoreSetupExtension: errors on unregistered type", async () => {
  const deps = makeDeps();
  const input = makeExtensionInput({ type: "@unknown/nonexistent" });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
  assertStringIncludes(error.error.message, "not registered");
});

Deno.test("datastoreSetupExtension: errors on invalid config schema", async () => {
  const schema = z.object({ endpoint: z.string() });
  ensureTestExtensionType("test-ext-bad-config", { configSchema: schema });
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-bad-config",
    config: {},
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
  assertStringIncludes(error.error.message, "Invalid config");
});

Deno.test("datastoreSetupExtension: passes config with namespace to extension schema that requires it", async () => {
  const schema = z.object({
    uri: z.string(),
    namespace: z.string(),
  });
  ensureTestExtensionType("test-ext-ns-required", { configSchema: schema });
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-ns-required",
    config: { uri: "mongodb://localhost:27017", namespace: "my-ns" },
    namespace: "my-ns",
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const error = events.find((e) => e.kind === "error") as
    | Extract<DatastoreSetupEvent, { kind: "error" }>
    | undefined;
  assertEquals(error, undefined, "expected no validation error");
  const completed = events.find((e) => e.kind === "completed");
  assertNotEquals(completed, undefined, "expected setup to complete");
});

Deno.test("datastoreSetupExtension: errors on unhealthy backend", async () => {
  ensureTestExtensionType("test-ext-unhealthy", {
    healthy: false,
    message: "bucket not found",
  });
  const deps = makeDeps();
  const input = makeExtensionInput({ type: "test-ext-unhealthy" });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
  assertStringIncludes(error.error.message, "not accessible");
});

Deno.test("datastoreSetupExtension: errors on non-upgraded repo", async () => {
  ensureTestExtensionType("test-ext-upgrade");
  const deps = makeDeps({
    requireUpgradedRepo: () => {
      throw new Error("Run 'swamp repo upgrade' first");
    },
  });
  const input = makeExtensionInput({ type: "test-ext-upgrade" });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
});

// ============================================================================
// Cache hydration tests (issue #220)
//
// Setup must pull existing remote data into the local cache regardless of
// whether --skip-migration was used. Migration moves data UP (local →
// remote); hydration moves data DOWN (remote → local). A contributor
// joining a populated remote needs hydration even when there is nothing
// local to migrate.
// ============================================================================

Deno.test("datastoreSetupExtension: skip-migration pulls populated remote into cache", async () => {
  ensureTestExtensionType("test-ext-hydrate-skip", {
    pullResult: 17,
  });
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-hydrate-skip",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.filesCopied, 0);
  assertEquals(completed.data.filesPulled, 17);
  assertEquals(completed.data.errors, []);
});

Deno.test("datastoreSetupExtension: skip-migration with empty remote is a no-op pull", async () => {
  ensureTestExtensionType("test-ext-hydrate-empty", {
    pullResult: 0,
  });
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-hydrate-empty",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.filesPulled, 0);
  assertEquals(completed.data.errors, []);
});

Deno.test("datastoreSetupExtension: default path migrates and then hydrates", async () => {
  ensureTestExtensionType("test-ext-migrate-and-hydrate", {
    pullResult: 4,
  });
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-migrate-and-hydrate",
    skipMigration: false,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  // makeDeps default migrateData returns filesCopied: 5
  assertEquals(completed.data.filesCopied, 5);
  assertEquals(completed.data.filesPulled, 4);
  assertEquals(completed.data.errors, []);
});

Deno.test("datastoreSetupExtension: pull failure surfaces in errors and blocks .swamp.yaml writeback", async () => {
  ensureTestExtensionType("test-ext-pull-fail", {
    pullResult: () => Promise.reject(new Error("network unreachable")),
  });
  let configUpdated = false;
  let cleanupCalled = false;
  const deps = makeDeps({
    updateRepoConfig: () => {
      configUpdated = true;
      return Promise.resolve();
    },
    cleanupSourceDirs: () => {
      cleanupCalled = true;
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-pull-fail",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors.length, 1);
  assertStringIncludes(completed.data.errors[0], "network unreachable");
  assertEquals(
    configUpdated,
    false,
    "pull failure must prevent .swamp.yaml writeback",
  );
  assertEquals(
    cleanupCalled,
    false,
    "pull failure must keep migrated .swamp/ dirs intact for retry",
  );
});

Deno.test("datastoreSetupExtension: extension without sync service skips push and pull cleanly", async () => {
  ensureTestExtensionType("test-ext-no-sync", {
    hasSyncService: false,
  });
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-no-sync",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.filesPulled, 0);
  assertEquals(completed.data.errors, []);
});

// ============================================================================
// Retry and partial-failure tests (issue #248)
//
// Verify that failed migrations leave the repo in a resumable state:
// config not updated, .swamp/ preserved, retryHint populated.
// ============================================================================

Deno.test("datastoreSetupExtension: push failure blocks config update, preserves .swamp/, and surfaces retryHint", async () => {
  ensureTestExtensionType("test-ext-push-fail", {
    pushResult: () => Promise.reject(new Error("connection reset")),
  });
  let configUpdated = false;
  let cleanupCalled = false;
  const deps = makeDeps({
    updateRepoConfig: () => {
      configUpdated = true;
      return Promise.resolve();
    },
    cleanupSourceDirs: () => {
      cleanupCalled = true;
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-push-fail",
    skipMigration: false,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors.length, 1);
  assertStringIncludes(completed.data.errors[0], "connection reset");
  assertEquals(
    configUpdated,
    false,
    "push failure must prevent .swamp.yaml writeback",
  );
  assertEquals(
    cleanupCalled,
    false,
    "push failure must keep migrated .swamp/ dirs intact for retry",
  );
  assertEquals(
    typeof completed.data.retryHint,
    "string",
    "push failure must surface a retryHint",
  );
});

Deno.test("datastoreSetupExtension: pull failure after successful push surfaces retryHint", async () => {
  ensureTestExtensionType("test-ext-push-ok-pull-fail", {
    pullResult: () => Promise.reject(new Error("timeout")),
  });
  let configUpdated = false;
  const deps = makeDeps({
    updateRepoConfig: () => {
      configUpdated = true;
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-push-ok-pull-fail",
    skipMigration: false,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors.length, 1);
  assertStringIncludes(completed.data.errors[0], "timeout");
  assertEquals(
    configUpdated,
    false,
    "pull failure must prevent .swamp.yaml writeback even when push succeeded",
  );
  assertEquals(
    typeof completed.data.retryHint,
    "string",
    "pull failure must surface a retryHint",
  );
});

Deno.test("datastoreSetupFilesystem: migration errors block config update and surface retryHint", async () => {
  let configUpdated = false;
  const deps = makeDeps({
    migrateData: () =>
      Promise.resolve({
        filesCopied: 3,
        bytesCopied: 512,
        directoriesMigrated: ["data"],
        errors: ["Failed to migrate outputs: permission denied"],
      }),
    updateRepoConfig: () => {
      configUpdated = true;
      return Promise.resolve();
    },
  });
  const input = makeFilesystemInput();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors.length, 1);
  assertStringIncludes(completed.data.errors[0], "permission denied");
  assertEquals(
    configUpdated,
    false,
    "migration errors must prevent .swamp.yaml writeback",
  );
  assertEquals(
    typeof completed.data.retryHint,
    "string",
    "migration errors must surface a retryHint",
  );
});

Deno.test("datastoreSetupExtension: successful setup has no retryHint", async () => {
  ensureTestExtensionType("test-ext-no-hint");
  const deps = makeDeps();
  const input = makeExtensionInput({ type: "test-ext-no-hint" });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors, []);
  assertEquals(completed.data.retryHint, undefined);
});

Deno.test("datastoreSetupExtension: ensures cachePath exists before hydration pull", async () => {
  // Defensive guard: setup owns its preconditions rather than relying on
  // sync service internals. Some extension implementations may not call
  // ensureDir inside pullChanged; the skip-migration path must create
  // the cache directory itself before pulling.
  ensureTestExtensionType("test-ext-ensuredir", { pullResult: 5 });
  const ensureDirCalls: string[] = [];
  const deps = makeDeps({
    ensureDir: (path: string) => {
      ensureDirCalls.push(path);
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-ensuredir",
    skipMigration: true,
  });

  await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  // The stub provider's resolveCachePath returns `${repoDir}/.custom-cache`.
  assertEquals(
    ensureDirCalls.includes(`${input.repoDir}/.custom-cache`),
    true,
    `expected ensureDir to be called for the cache path before pull; got ${
      JSON.stringify(ensureDirCalls)
    }`,
  );
});

// ============================================================================
// Namespace threading tests (issue #536)
// ============================================================================

const setupSyncSpyCalls: {
  method: string;
  options: DatastoreSyncOptions | undefined;
}[] = [];

const SETUP_NS_TYPE = "test-ext-ns-threading";

if (!datastoreTypeRegistry.has(SETUP_NS_TYPE)) {
  datastoreTypeRegistry.register({
    type: SETUP_NS_TYPE,
    name: "Setup NS Test",
    description: "Test datastore for setup namespace threading",
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
            datastoreType: SETUP_NS_TYPE,
          }),
      }),
      resolveDatastorePath: (repoDir: string) => `${repoDir}/.store`,
      resolveCachePath: (repoDir: string) => `${repoDir}/.cache`,
      createSyncService: () => ({
        pullChanged: (opts?: DatastoreSyncOptions) => {
          setupSyncSpyCalls.push({ method: "pullChanged", options: opts });
          return Promise.resolve(1);
        },
        pushChanged: (opts?: DatastoreSyncOptions) => {
          setupSyncSpyCalls.push({ method: "pushChanged", options: opts });
          return Promise.resolve(2);
        },
        markDirty: () => Promise.resolve(),
      }),
    }),
  });
}

Deno.test("datastoreSetupExtension: threads namespace into push and pull", async () => {
  setupSyncSpyCalls.length = 0;
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: SETUP_NS_TYPE,
    namespace: "infra",
  });

  await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const push = setupSyncSpyCalls.find((c) => c.method === "pushChanged");
  const pull = setupSyncSpyCalls.find((c) => c.method === "pullChanged");
  assertEquals(push?.options?.namespace, "infra");
  assertEquals(pull?.options?.namespace, "infra");
});

Deno.test("datastoreSetupExtension: omits namespace when not configured", async () => {
  setupSyncSpyCalls.length = 0;
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: SETUP_NS_TYPE,
  });

  await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const push = setupSyncSpyCalls.find((c) => c.method === "pushChanged");
  const pull = setupSyncSpyCalls.find((c) => c.method === "pullChanged");
  assertEquals(push?.options?.namespace, undefined);
  assertEquals(pull?.options?.namespace, undefined);
});

Deno.test("datastoreSetupExtension: migrates to namespace-scoped cache path when namespace is set", async () => {
  let capturedDestPath: string | undefined;
  const deps = makeDeps({
    migrateData: (_sourceDir: string, destPath: string) => {
      capturedDestPath = destPath;
      return Promise.resolve({
        filesCopied: 5,
        bytesCopied: 1024,
        directoriesMigrated: ["data", "outputs"],
        errors: [],
      });
    },
  });
  const input = makeExtensionInput({
    type: SETUP_NS_TYPE,
    namespace: "infra",
  });

  await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  assertPathEquals(capturedDestPath, join("/tmp/repo", ".cache", "infra"));
});

Deno.test("datastoreSetupExtension: migrates to bare cache path when no namespace is set", async () => {
  let capturedDestPath: string | undefined;
  const deps = makeDeps({
    migrateData: (_sourceDir: string, destPath: string) => {
      capturedDestPath = destPath;
      return Promise.resolve({
        filesCopied: 5,
        bytesCopied: 1024,
        directoriesMigrated: ["data", "outputs"],
        errors: [],
      });
    },
  });
  const input = makeExtensionInput({
    type: SETUP_NS_TYPE,
  });

  await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  assertPathEquals(capturedDestPath, join("/tmp/repo", ".cache"));
});

Deno.test("datastoreSetupExtension: threads namespace on skip-migration pull-only path", async () => {
  setupSyncSpyCalls.length = 0;
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: SETUP_NS_TYPE,
    skipMigration: true,
    namespace: "staging",
  });

  await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const push = setupSyncSpyCalls.find((c) => c.method === "pushChanged");
  const pull = setupSyncSpyCalls.find((c) => c.method === "pullChanged");
  assertEquals(push, undefined, "skip-migration should not push");
  assertEquals(pull?.options?.namespace, "staging");
});

// ============================================================================
// Namespace config persistence and registration tests (issue #559)
// ============================================================================

Deno.test("datastoreSetupExtension: includes namespace in updateRepoConfig", async () => {
  ensureTestExtensionType("test-ext-ns-persist");
  let savedConfig: Record<string, unknown> | undefined;
  const deps = makeDeps({
    updateRepoConfig: (_dir: string, config: Record<string, unknown>) => {
      savedConfig = config;
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-ns-persist",
    namespace: "infra",
    skipMigration: true,
  });

  await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  assertEquals(savedConfig?.namespace, "infra");
  assertEquals(savedConfig?.type, "test-ext-ns-persist");
});

Deno.test("datastoreSetupExtension: omits namespace from config when not set", async () => {
  ensureTestExtensionType("test-ext-ns-persist-none");
  let savedConfig: Record<string, unknown> | undefined;
  const deps = makeDeps({
    updateRepoConfig: (_dir: string, config: Record<string, unknown>) => {
      savedConfig = config;
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-ns-persist-none",
    skipMigration: true,
  });

  await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  assertEquals(savedConfig?.namespace, undefined);
});

Deno.test("datastoreSetupExtension: calls registerNamespace when provider supports it", async () => {
  let registered:
    | { datastorePath: string; namespace: string; repoId: string }
    | undefined;
  const NS_REG_TYPE = "test-ext-ns-register";
  datastoreTypeRegistry.register({
    type: NS_REG_TYPE,
    name: "NS Register Test",
    description: "Test namespace registration",
    isBuiltIn: false,
    createProvider: () => ({
      ...createStubProvider(),
      registerNamespace: (
        datastorePath: string,
        namespace: string,
        repoId: string,
      ) => {
        registered = { datastorePath, namespace, repoId };
        return Promise.resolve();
      },
      listNamespaces: () => Promise.resolve([]),
    }),
  });

  try {
    const deps = makeDeps();
    const input = makeExtensionInput({
      type: NS_REG_TYPE,
      namespace: "infra",
      repoId: "repo-123",
      skipMigration: true,
    });

    await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(createLibSwampContext(), deps, input),
    );

    assertEquals(registered?.namespace, "infra");
    assertEquals(registered?.repoId, "repo-123");
    assertEquals(registered?.datastorePath, "/tmp/repo/.custom-store");
  } finally {
    datastoreTypeRegistry.invalidateType(NS_REG_TYPE);
  }
});

Deno.test("datastoreSetupExtension: skips registerNamespace when provider lacks it", async () => {
  ensureTestExtensionType("test-ext-ns-no-reg");
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-ns-no-reg",
    namespace: "infra",
    repoId: "repo-123",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors, []);
});

Deno.test("datastoreSetupExtension: skips registerNamespace when repoId is missing", async () => {
  let registerCalled = false;
  const NS_NO_REPO_TYPE = "test-ext-ns-no-repoid";
  datastoreTypeRegistry.register({
    type: NS_NO_REPO_TYPE,
    name: "NS No RepoId Test",
    description: "Test namespace registration without repoId",
    isBuiltIn: false,
    createProvider: () => ({
      ...createStubProvider(),
      registerNamespace: () => {
        registerCalled = true;
        return Promise.resolve();
      },
    }),
  });

  try {
    const deps = makeDeps();
    const input = makeExtensionInput({
      type: NS_NO_REPO_TYPE,
      namespace: "infra",
      repoId: undefined,
      skipMigration: true,
    });

    await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(createLibSwampContext(), deps, input),
    );

    assertEquals(
      registerCalled,
      false,
      "registerNamespace must not be called when repoId is missing",
    );
  } finally {
    datastoreTypeRegistry.invalidateType(NS_NO_REPO_TYPE);
  }
});

Deno.test("datastoreSetupExtension: includes namespace in completed data", async () => {
  ensureTestExtensionType("test-ext-ns-completed");
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-ns-completed",
    namespace: "infra",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.namespace, "infra");
});

Deno.test("datastoreSetupExtension: omits namespace from completed data when not set", async () => {
  ensureTestExtensionType("test-ext-ns-completed-none");
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-ns-completed-none",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.namespace, undefined);
});

Deno.test("datastoreSetupExtension: registerNamespace failure surfaces in errors", async () => {
  const NS_REG_FAIL_TYPE = "test-ext-ns-reg-fail";
  if (!datastoreTypeRegistry.has(NS_REG_FAIL_TYPE)) {
    datastoreTypeRegistry.register({
      type: NS_REG_FAIL_TYPE,
      name: "NS Register Fail Test",
      description: "Test namespace registration failure",
      isBuiltIn: false,
      createProvider: () => ({
        ...createStubProvider(),
        registerNamespace: () => {
          return Promise.reject(new Error("permission denied"));
        },
      }),
    });
  }

  const deps = makeDeps();
  const input = makeExtensionInput({
    type: NS_REG_FAIL_TYPE,
    namespace: "infra",
    repoId: "repo-123",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
});

Deno.test("datastoreSetupExtension: rejects invalid namespace slug", async () => {
  ensureTestExtensionType("test-ext-ns-invalid");
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-ns-invalid",
    namespace: "INVALID NAMESPACE!",
    skipMigration: true,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const error = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
  assertStringIncludes(error.error.message, "Invalid namespace");
});

// ============================================================================
// Namespace manifest cache materialization tests (swamp-club#834)
// ============================================================================

Deno.test("datastoreSetupExtension: push timeout commits type (decoupled from push success)", async () => {
  ensureTestExtensionType("test-ext-push-timeout", {
    pushResult: () =>
      Promise.reject(new SyncTimeoutError("test", "push", 1000)),
  });
  let configUpdated = false;
  let cleanupCalled = false;
  const deps = makeDeps({
    updateRepoConfig: () => {
      configUpdated = true;
      return Promise.resolve();
    },
    cleanupSourceDirs: () => {
      cleanupCalled = true;
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-push-timeout",
    skipMigration: false,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors.length, 1);
  assertStringIncludes(completed.data.errors[0], "timed out");
  assertEquals(
    configUpdated,
    true,
    "push timeout must still commit the datastore type",
  );
  assertEquals(
    cleanupCalled,
    false,
    "push timeout must keep migrated .swamp/ dirs intact for retry",
  );
});

Deno.test("datastoreSetupExtension: hard push failure still blocks type commit", async () => {
  ensureTestExtensionType("test-ext-push-hard-fail", {
    pushResult: () => Promise.reject(new Error("AccessDenied")),
  });
  let configUpdated = false;
  const deps = makeDeps({
    updateRepoConfig: () => {
      configUpdated = true;
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-push-hard-fail",
    skipMigration: false,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors.length, 1);
  assertEquals(
    configUpdated,
    false,
    "hard push failure must prevent .swamp.yaml writeback",
  );
});

Deno.test("datastoreSetupExtension: migration errors block type commit even when push succeeds", async () => {
  ensureTestExtensionType("test-ext-migrate-err");
  let configUpdated = false;
  const deps = makeDeps({
    migrateData: () =>
      Promise.resolve({
        filesCopied: 3,
        bytesCopied: 512,
        directoriesMigrated: ["data"],
        errors: ["failed to copy data/foo.bin: ENOSPC"],
      }),
    updateRepoConfig: () => {
      configUpdated = true;
      return Promise.resolve();
    },
  });
  const input = makeExtensionInput({
    type: "test-ext-migrate-err",
    skipMigration: false,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors.length, 1);
  assertStringIncludes(completed.data.errors[0], "ENOSPC");
  assertEquals(
    configUpdated,
    false,
    "migration errors must prevent .swamp.yaml writeback",
  );
});

Deno.test("datastoreSetupExtension: syncTimeoutMsOverride is honored", async () => {
  ensureTestExtensionType("test-ext-timeout-override");
  const deps = makeDeps();
  const input = makeExtensionInput({
    type: "test-ext-timeout-override",
    syncTimeoutMsOverride: 60_000,
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(createLibSwampContext(), deps, input),
  );

  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors.length, 0);
});

Deno.test("datastoreSetupExtension: materializes namespace manifest in local cache", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-setup-834-" });
  const NS_CACHE_TYPE = "test-ext-ns-cache-834";
  try {
    let registered = false;
    datastoreTypeRegistry.register({
      type: NS_CACHE_TYPE,
      name: "NS Cache Test",
      description: "Test namespace manifest cache materialization",
      isBuiltIn: false,
      createProvider: () => ({
        ...createStubProvider(),
        resolveDatastorePath: () => join(tmpDir, "remote"),
        resolveCachePath: () => join(tmpDir, "cache"),
        registerNamespace: () => {
          registered = true;
          return Promise.resolve();
        },
      }),
    });

    const deps = makeDeps();
    const input = makeExtensionInput({
      type: NS_CACHE_TYPE,
      repoDir: tmpDir,
      namespace: "infra",
      repoId: "repo-834",
      skipMigration: true,
    });

    await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(createLibSwampContext(), deps, input),
    );

    assertEquals(registered, true, "provider.registerNamespace must be called");

    const manifest = await readNamespaceManifest(
      join(tmpDir, "cache"),
      "infra",
    );
    assertEquals(
      manifest !== null,
      true,
      "manifest must be materialized in the local cache",
    );
    assertEquals(manifest?.namespace, "infra");
    assertEquals(manifest?.repoId, "repo-834");
  } finally {
    datastoreTypeRegistry.invalidateType(NS_CACHE_TYPE);
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ============================================================================
// managedConfig and the in-repo config dir (swamp-club#2837)
// ============================================================================

async function withSetupTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-setup-2837-" });
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

async function writeTestFile(path: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeMarker(
  repoDir: string,
  datastore: DatastoreConfigData,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  await new RepoMarkerRepository().write(RepoPath.create(repoDir), {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
    repoId: "repo-2837",
    datastore,
  });
}

async function readDatastoreBlock(
  repoDir: string,
): Promise<DatastoreConfigData | undefined> {
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repoDir),
  );
  return marker?.datastore;
}

const noTier = () => Promise.resolve(undefined);

Deno.test("createDatastoreSetupDeps.updateRepoConfig: keeps managedConfig and exclude for a filesystem block", async () => {
  await withSetupTempDir(async (repoDir) => {
    await writeMarker(repoDir, {
      type: "@swamp/s3-datastore",
      config: { bucket: "team" },
      managedConfig: true,
      exclude: ["*.tmp"],
    });
    const deps = createDatastoreSetupDeps(repoDir, noTier);

    await deps.updateRepoConfig(repoDir, {
      type: "filesystem",
      path: "/data/swamp",
    });

    assertEquals(await readDatastoreBlock(repoDir), {
      type: "filesystem",
      path: "/data/swamp",
      managedConfig: true,
      exclude: ["*.tmp"],
    });
  });
});

Deno.test("createDatastoreSetupDeps.updateRepoConfig: keeps managedConfig for an extension block", async () => {
  await withSetupTempDir(async (repoDir) => {
    await writeMarker(repoDir, {
      type: "@swamp/s3-datastore",
      config: { bucket: "team" },
      namespace: "ns",
      managedConfig: true,
    });
    const deps = createDatastoreSetupDeps(repoDir, noTier);

    await deps.updateRepoConfig(repoDir, {
      type: "@swamp/s3-datastore",
      config: { bucket: "team" },
      namespace: "ns",
    });

    assertEquals((await readDatastoreBlock(repoDir))?.managedConfig, true);
  });
});

Deno.test("createDatastoreSetupDeps.resolveInRepoConfigRole: classifies from the resolved tier", async () => {
  await withSetupTempDir(async (repoDir) => {
    const inRepoConfig = join(repoDir, ".swamp", "config");
    let resolverCalls = 0;

    await writeMarker(repoDir, { type: "filesystem", path: "/x" });
    const unmanagedDeps = createDatastoreSetupDeps(repoDir, () => {
      resolverCalls++;
      return Promise.resolve(inRepoConfig);
    });
    assertEquals(
      await unmanagedDeps.resolveInRepoConfigRole(repoDir),
      "unmanaged",
    );
    assertEquals(resolverCalls, 0);

    await writeMarker(repoDir, {
      type: "filesystem",
      path: join(repoDir, ".swamp"),
      managedConfig: true,
    });
    assertEquals(
      await createDatastoreSetupDeps(
        repoDir,
        () => Promise.resolve(inRepoConfig),
      ).resolveInRepoConfigRole(repoDir),
      "tier",
    );
    assertEquals(
      await createDatastoreSetupDeps(repoDir, noTier)
        .resolveInRepoConfigRole(repoDir),
      "instance_local",
    );
  });
});

Deno.test("createDatastoreSetupDeps.cleanupSourceDirs: leaves a kept path inside a removed dir", async () => {
  await withSetupTempDir(async (dir) => {
    await writeTestFile(join(dir, "config", "models", "m.yaml"), "m");
    await writeTestFile(
      join(dir, "config", "pulled-extensions", "ext", "mod.ts"),
      "x",
    );
    await writeTestFile(join(dir, "data", "a.json"), "{}");
    const deps = createDatastoreSetupDeps(dir, noTier);

    await deps.cleanupSourceDirs(dir, ["config", "data"], [
      join("config", "pulled-extensions"),
    ]);

    assertEquals(await pathExists(join(dir, "data")), false);
    assertEquals(await pathExists(join(dir, "config", "models")), false);
    assertEquals(
      await pathExists(
        join(dir, "config", "pulled-extensions", "ext", "mod.ts"),
      ),
      true,
    );
  });
});

Deno.test("createDatastoreSetupDeps.cleanupSourceDirs: never deletes through a symlinked dir that holds a kept path", async () => {
  await withSetupTempDir(async (dir) => {
    const target = join(dir, "shared-config");
    await writeTestFile(join(target, "models", "m.yaml"), "m");
    await writeTestFile(
      join(target, "pulled-extensions", "ext", "mod.ts"),
      "x",
    );
    const source = join(dir, "source");
    await Deno.mkdir(source, { recursive: true });
    await Deno.symlink(target, join(source, "config"), { type: "dir" });
    const deps = createDatastoreSetupDeps(source, noTier);

    await deps.cleanupSourceDirs(source, ["config"], [
      join("config", "pulled-extensions"),
    ]);

    assertEquals(
      (await Deno.lstat(join(source, "config"))).isSymlink,
      true,
    );
    assertEquals(await pathExists(join(target, "models", "m.yaml")), true);
    assertEquals(
      await pathExists(
        join(source, "config", "pulled-extensions", "ext", "mod.ts"),
      ),
      true,
    );
  });
});

Deno.test("createDatastoreSetupDeps.cleanupSourceDirs: removes only the link for a symlinked dir with nothing kept", async () => {
  await withSetupTempDir(async (dir) => {
    const target = join(dir, "shared-data");
    await writeTestFile(join(target, "a.json"), "{}");
    const source = join(dir, "source");
    await Deno.mkdir(source, { recursive: true });
    await Deno.symlink(target, join(source, "data"), { type: "dir" });
    const deps = createDatastoreSetupDeps(source, noTier);

    await deps.cleanupSourceDirs(source, ["data"], [
      join("config", "pulled-extensions"),
    ]);

    assertEquals(await pathExists(join(source, "data")), false);
    assertEquals(await pathExists(join(target, "a.json")), true);
  });
});

/**
 * Registers an extension datastore whose remote is a temp directory: push
 * copies the cache over it and pull copies it over the cache, both
 * last-writer-wins per file like the S3 and GCS sync services.
 */
function registerTempDirRemoteType(
  remoteDir: string,
  cacheDir: string,
): string {
  const type = `test-ext-2837-${crypto.randomUUID()}`;
  datastoreTypeRegistry.register({
    type,
    name: `Test ${type}`,
    description: "Temp-dir remote for swamp-club#2837",
    isBuiltIn: false,
    createProvider: () => ({
      ...createStubProvider({ hasSyncService: false }),
      resolveDatastorePath: () => remoteDir,
      resolveCachePath: () => cacheDir,
      createSyncService: () => ({
        pushChanged: async () => {
          await Deno.mkdir(cacheDir, { recursive: true });
          await copy(cacheDir, remoteDir, { overwrite: true });
        },
        pullChanged: async () => {
          await Deno.mkdir(remoteDir, { recursive: true });
          await copy(remoteDir, cacheDir, { overwrite: true });
        },
        markDirty: () => Promise.resolve(),
      }),
    }),
  });
  return type;
}

Deno.test("datastoreSetupExtension: leaves the remote config tier and the instance-local config dir intact under managedConfig", async () => {
  await withSetupTempDir(async (tmp) => {
    const repoDir = join(tmp, "repo");
    const remoteDir = join(tmp, "remote");
    const cacheDir = join(tmp, "cache");
    const type = registerTempDirRemoteType(remoteDir, cacheDir);
    await writeMarker(repoDir, { type, config: {}, managedConfig: true });

    const teamLockfile = '{"@team/ext":{"version":"2.0.0"}}';
    const localLockfile = '{"@local/ext":{"version":"1.0.0"}}';
    await writeTestFile(
      join(remoteDir, "config", "upstream_extensions.json"),
      teamLockfile,
    );
    await writeTestFile(
      join(repoDir, ".swamp", "config", "upstream_extensions.json"),
      localLockfile,
    );
    await writeTestFile(
      join(repoDir, ".swamp", "config", "pulled-extensions", "ext", "mod.ts"),
      "x",
    );
    await writeTestFile(join(repoDir, ".swamp", "data", "a.json"), "{}");

    const deps = createDatastoreSetupDeps(
      repoDir,
      () => Promise.resolve(join(cacheDir, "config")),
    );
    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(createLibSwampContext(), deps, {
        type,
        config: {},
        repoDir,
        repoId: "repo-2837",
        skipMigration: false,
      }),
    );

    assertEquals(events.at(-1)?.kind, "completed");
    assertEquals(
      await Deno.readTextFile(
        join(remoteDir, "config", "upstream_extensions.json"),
      ),
      teamLockfile,
    );
    assertEquals(
      await Deno.readTextFile(
        join(cacheDir, "config", "upstream_extensions.json"),
      ),
      teamLockfile,
    );
    assertEquals(
      await Deno.readTextFile(
        join(repoDir, ".swamp", "config", "upstream_extensions.json"),
      ),
      localLockfile,
    );
    assertEquals(
      await pathExists(
        join(repoDir, ".swamp", "config", "pulled-extensions", "ext", "mod.ts"),
      ),
      true,
    );
    assertEquals(
      await pathExists(join(remoteDir, "config", "pulled-extensions")),
      false,
    );
    assertEquals(await pathExists(join(remoteDir, "data", "a.json")), true);
    assertEquals(await pathExists(join(repoDir, ".swamp", "data")), false);
    assertEquals((await readDatastoreBlock(repoDir))?.managedConfig, true);
  });
});

Deno.test("datastoreSetupFilesystem: moves an in-repo config tier but keeps the pulled extension root", async () => {
  await withSetupTempDir(async (tmp) => {
    const repoDir = join(tmp, "repo");
    const datastorePath = join(tmp, "datastore");
    await writeMarker(repoDir, {
      type: "filesystem",
      path: join(repoDir, ".swamp"),
      managedConfig: true,
    });
    await writeTestFile(
      join(repoDir, ".swamp", "config", "models", "m.yaml"),
      "m",
    );
    await writeTestFile(
      join(repoDir, ".swamp", "config", "pulled-extensions", "ext", "mod.ts"),
      "x",
    );
    await writeTestFile(join(repoDir, ".swamp", "data", "a.json"), "{}");

    const deps = createDatastoreSetupDeps(
      repoDir,
      () => Promise.resolve(join(repoDir, ".swamp", "config")),
    );
    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupFilesystem(createLibSwampContext(), deps, {
        datastorePath,
        repoDir,
        skipMigration: false,
      }),
    );

    const completed = events.at(-1) as Extract<
      DatastoreSetupEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.kind, "completed");
    assertEquals(completed.data.errors, []);
    assertEquals(
      await pathExists(join(datastorePath, "config", "models", "m.yaml")),
      true,
    );
    assertEquals(
      await pathExists(join(datastorePath, "config", "pulled-extensions")),
      false,
    );
    assertEquals(
      await pathExists(join(repoDir, ".swamp", "config", "models")),
      false,
    );
    assertEquals(
      await pathExists(
        join(repoDir, ".swamp", "config", "pulled-extensions", "ext", "mod.ts"),
      ),
      true,
    );
    const block = await readDatastoreBlock(repoDir);
    assertEquals(block?.managedConfig, true);
    assertEquals(block?.type, "filesystem");
  });
});

Deno.test("datastoreSetupFilesystem: leaves an instance-local config dir behind", async () => {
  await withSetupTempDir(async (tmp) => {
    const repoDir = join(tmp, "repo");
    const datastorePath = join(tmp, "datastore");
    await writeMarker(repoDir, {
      type: "filesystem",
      path: join(tmp, "old"),
      managedConfig: true,
    });
    await writeTestFile(
      join(repoDir, ".swamp", "config", "pulled-extensions", "ext", "mod.ts"),
      "x",
    );
    await writeTestFile(join(repoDir, ".swamp", "data", "a.json"), "{}");

    const deps = createDatastoreSetupDeps(
      repoDir,
      () => Promise.resolve(join(tmp, "old", "config")),
    );
    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupFilesystem(createLibSwampContext(), deps, {
        datastorePath,
        repoDir,
        skipMigration: false,
      }),
    );

    assertEquals(events.at(-1)?.kind, "completed");
    assertEquals(
      await pathExists(
        join(repoDir, ".swamp", "config", "pulled-extensions", "ext", "mod.ts"),
      ),
      true,
    );
    assertEquals(
      await pathExists(join(datastorePath, "config", "pulled-extensions")),
      false,
    );
    assertEquals(await pathExists(join(datastorePath, "data", "a.json")), true);
  });
});

// ============================================================================
// Empty config tier warning (swamp-club#2845)
// ============================================================================

type WarningEvent = Extract<DatastoreSetupEvent, { kind: "warning" }>;

function warningsOf(events: DatastoreSetupEvent[]): WarningEvent[] {
  return events.filter((e): e is WarningEvent => e.kind === "warning");
}

function emptyTier(tierPath: string | undefined) {
  return () =>
    Promise.resolve({ managed: true as const, tierPath, populated: false });
}

/**
 * Registers an extension type, under a per-run name, whose sync service
 * implements hydrateFile. Returns the type name and the recorded calls.
 */
function registerHydratingType(
  hydrate: (relPath: string) => Promise<boolean>,
  extra: Partial<DatastoreProvider> = {},
): { type: string; calls: string[]; signals: (AbortSignal | undefined)[] } {
  const type = `test-ext-hydrate-${crypto.randomUUID()}`;
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const base = createStubProvider();
  datastoreTypeRegistry.register({
    type,
    name: "Hydrate Test",
    description: "Test lazy hydration of the migration sentinel",
    isBuiltIn: false,
    createProvider: () => ({
      ...base,
      createSyncService: (repoDir: string, cachePath: string) => ({
        ...base.createSyncService!(repoDir, cachePath),
        hydrateFile: (relPath: string, options?: DatastoreSyncOptions) => {
          calls.push(relPath);
          signals.push(options?.signal);
          return hydrate(relPath);
        },
      }),
      ...extra,
    }),
  });
  return { type, calls, signals };
}

Deno.test("datastoreSetupFilesystem: warns when the managed config tier is empty", async () => {
  const deps = makeDeps({
    inspectManagedConfigTier: emptyTier("/tmp/store/config"),
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(
      createLibSwampContext(),
      deps,
      makeFilesystemInput(),
    ),
  );

  const warnings = warningsOf(events);
  assertEquals(warnings.length, 1);
  assertEquals(events[events.length - 1].kind, "completed");
  const data = warnings[0].data;
  assertEquals(data.code, "empty_config_tier");
  if (data.code !== "empty_config_tier") return;
  assertEquals(data.configTierPath, "/tmp/store/config");
  assertStringIncludes(data.message, "/tmp/store/config");
  assertStringIncludes(data.message, "swamp datastore config migrate");
});

Deno.test("datastoreSetupFilesystem: no warning when the managed config tier is populated", async () => {
  const deps = makeDeps({
    inspectManagedConfigTier: () =>
      Promise.resolve({
        managed: true,
        tierPath: "/tmp/store/config",
        populated: true,
      }),
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(
      createLibSwampContext(),
      deps,
      makeFilesystemInput(),
    ),
  );

  assertEquals(warningsOf(events).length, 0);
});

Deno.test("datastoreSetupFilesystem: no warning when the config tier cannot be resolved", async () => {
  const deps = makeDeps({ inspectManagedConfigTier: emptyTier(undefined) });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(
      createLibSwampContext(),
      deps,
      makeFilesystemInput(),
    ),
  );

  assertEquals(warningsOf(events).length, 0);
});

Deno.test("datastoreSetupFilesystem: no warning without managedConfig", async () => {
  let inspected = 0;
  const deps = makeDeps({
    inspectManagedConfigTier: () => {
      inspected++;
      return Promise.resolve({ managed: false });
    },
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(
      createLibSwampContext(),
      deps,
      makeFilesystemInput(),
    ),
  );

  assertEquals(inspected, 1);
  assertEquals(warningsOf(events).length, 0);
});

Deno.test("datastoreSetupFilesystem: a failed config tier inspection does not fail setup", async () => {
  const deps = makeDeps({
    inspectManagedConfigTier: () =>
      Promise.reject(new Deno.errors.PermissionDenied("denied")),
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(
      createLibSwampContext(),
      deps,
      makeFilesystemInput(),
    ),
  );

  assertEquals(warningsOf(events).length, 0);
  const completed = events[events.length - 1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.errors, []);
});

Deno.test("datastoreSetupFilesystem: migration errors skip the config tier check", async () => {
  let inspected = 0;
  const deps = makeDeps({
    migrateData: () =>
      Promise.resolve({
        filesCopied: 1,
        bytesCopied: 1,
        directoriesMigrated: ["data"],
        errors: ["Failed to migrate data: permission denied"],
      }),
    inspectManagedConfigTier: () => {
      inspected++;
      return emptyTier("/tmp/store/config")();
    },
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(
      createLibSwampContext(),
      deps,
      makeFilesystemInput(),
    ),
  );

  assertEquals(inspected, 0);
  assertEquals(warningsOf(events).length, 0);
});

Deno.test("datastoreSetupExtension: warns when the managed config tier is empty", async () => {
  ensureTestExtensionType("test-ext-empty-tier");
  const deps = makeDeps({
    inspectManagedConfigTier: emptyTier("/tmp/repo/.custom-cache/config"),
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(
      createLibSwampContext(),
      deps,
      makeExtensionInput({ type: "test-ext-empty-tier" }),
    ),
  );

  const warnings = warningsOf(events);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].data.code, "empty_config_tier");
  assertEquals(events[events.length - 1].kind, "completed");
});

Deno.test("datastoreSetupExtension: no warning when the managed config tier is populated", async () => {
  ensureTestExtensionType("test-ext-populated-tier");
  const deps = makeDeps({
    inspectManagedConfigTier: () =>
      Promise.resolve({
        managed: true,
        tierPath: "/tmp/repo/.custom-cache/config",
        populated: true,
      }),
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(
      createLibSwampContext(),
      deps,
      makeExtensionInput({ type: "test-ext-populated-tier" }),
    ),
  );

  assertEquals(warningsOf(events).length, 0);
});

Deno.test("datastoreSetupExtension: no warning when the config tier cannot be resolved", async () => {
  ensureTestExtensionType("test-ext-unresolved-tier");
  const deps = makeDeps({ inspectManagedConfigTier: emptyTier(undefined) });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(
      createLibSwampContext(),
      deps,
      makeExtensionInput({ type: "test-ext-unresolved-tier" }),
    ),
  );

  assertEquals(warningsOf(events).length, 0);
});

Deno.test("datastoreSetupExtension: a hydrated sentinel suppresses the warning", async () => {
  const { type, calls, signals } = registerHydratingType(() =>
    Promise.resolve(true)
  );
  try {
    const deps = makeDeps({
      inspectManagedConfigTier: emptyTier(
        join("/tmp/repo", ".custom-cache", "config"),
      ),
    });

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        deps,
        makeExtensionInput({ type, hydrationStrategy: "lazy" }),
      ),
    );

    assertEquals(calls, ["config/managed-config-migrated.json"]);
    assertEquals(signals[0] instanceof AbortSignal, true);
    assertEquals(warningsOf(events).length, 0);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreSetupExtension: hydrates the namespaced sentinel path", async () => {
  const { type, calls } = registerHydratingType(() => Promise.resolve(true));
  try {
    const deps = makeDeps({
      inspectManagedConfigTier: emptyTier(
        join("/tmp/repo", ".custom-cache", "infra", "config"),
      ),
    });

    await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        deps,
        makeExtensionInput({
          type,
          namespace: "infra",
          repoId: undefined,
          hydrationStrategy: "lazy",
        }),
      ),
    );

    assertEquals(calls, ["infra/config/managed-config-migrated.json"]);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreSetupExtension: warns when the sentinel is not on the remote", async () => {
  const { type, calls } = registerHydratingType(() => Promise.resolve(false));
  try {
    const deps = makeDeps({
      inspectManagedConfigTier: emptyTier(
        join("/tmp/repo", ".custom-cache", "config"),
      ),
    });

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        deps,
        makeExtensionInput({ type, hydrationStrategy: "lazy" }),
      ),
    );

    assertEquals(calls.length, 1);
    assertEquals(warningsOf(events).length, 1);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreSetupExtension: a failed sentinel hydration still warns", async () => {
  const { type } = registerHydratingType(() =>
    Promise.reject(new Error("AccessDenied"))
  );
  try {
    const deps = makeDeps({
      inspectManagedConfigTier: emptyTier(
        join("/tmp/repo", ".custom-cache", "config"),
      ),
    });

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        deps,
        makeExtensionInput({ type, hydrationStrategy: "lazy" }),
      ),
    );

    assertEquals(warningsOf(events).length, 1);
    const completed = events[events.length - 1] as Extract<
      DatastoreSetupEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.data.errors, []);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreSetupExtension: never hydrates a config tier outside the cache", async () => {
  const { type, calls } = registerHydratingType(() => Promise.resolve(true));
  try {
    // An excluded config subdir resolves to the repo's own .swamp/config.
    const deps = makeDeps({
      inspectManagedConfigTier: emptyTier(
        join("/tmp/repo", ".swamp", "config"),
      ),
    });

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        deps,
        makeExtensionInput({ type, hydrationStrategy: "lazy" }),
      ),
    );

    assertEquals(calls, []);
    assertEquals(warningsOf(events).length, 1);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreSetupExtension: full hydration never fetches the sentinel", async () => {
  const { type, calls } = registerHydratingType(() => Promise.resolve(true));
  try {
    const deps = makeDeps({
      inspectManagedConfigTier: emptyTier(
        join("/tmp/repo", ".custom-cache", "config"),
      ),
    });

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        deps,
        makeExtensionInput({ type }),
      ),
    );

    assertEquals(calls, []);
    assertEquals(warningsOf(events).length, 1);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreSetupExtension: a stalled sentinel fetch times out and warns", async () => {
  // Never settles and ignores the signal: only the setup timeout ends it.
  const { type, calls } = registerHydratingType(() => new Promise(() => {}));
  try {
    const deps = makeDeps({
      inspectManagedConfigTier: emptyTier(
        join("/tmp/repo", ".custom-cache", "config"),
      ),
    });

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        deps,
        makeExtensionInput({
          type,
          hydrationStrategy: "lazy",
          syncTimeoutMsOverride: 10,
        }),
      ),
    );

    assertEquals(calls.length, 1);
    assertEquals(warningsOf(events).length, 1);
    assertEquals(events[events.length - 1].kind, "completed");
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreSetupExtension: hydrates a tier under a cache child whose name starts with two dots", async () => {
  const { type, calls } = registerHydratingType(() => Promise.resolve(true));
  try {
    const deps = makeDeps({
      inspectManagedConfigTier: emptyTier(
        join("/tmp/repo", ".custom-cache", "..ns", "config"),
      ),
    });

    await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        deps,
        makeExtensionInput({ type, hydrationStrategy: "lazy" }),
      ),
    );

    assertEquals(calls, ["..ns/config/managed-config-migrated.json"]);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreSetupExtension: a timeout-only commit skips the config tier check", async () => {
  ensureTestExtensionType("test-ext-tier-push-timeout", {
    pushResult: () =>
      Promise.reject(new SyncTimeoutError("test", "push", 1000)),
  });
  let inspected = 0;
  const deps = makeDeps({
    inspectManagedConfigTier: () => {
      inspected++;
      return emptyTier("/tmp/store/config")();
    },
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(
      createLibSwampContext(),
      deps,
      makeExtensionInput({ type: "test-ext-tier-push-timeout" }),
    ),
  );

  assertEquals(inspected, 0);
  assertEquals(warningsOf(events).length, 0);
});

Deno.test("datastoreSetupExtension: the existing namespaces warning carries its code", async () => {
  const type = `test-ext-ns-warning-${crypto.randomUUID()}`;
  datastoreTypeRegistry.register({
    type,
    name: "NS Warning Test",
    description: "Test the existing namespaces warning",
    isBuiltIn: false,
    createProvider: () => ({
      ...createStubProvider(),
      listNamespaces: () => Promise.resolve(["other"]),
    }),
  });
  try {
    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        makeDeps(),
        makeExtensionInput({ type }),
      ),
    );

    const warnings = warningsOf(events);
    assertEquals(warnings.length, 1);
    const data = warnings[0].data;
    assertEquals(data.code, "existing_namespaces");
    if (data.code !== "existing_namespaces") return;
    assertEquals(data.existingNamespaces, ["other"]);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("createDatastoreSetupDeps.inspectManagedConfigTier: reads the tier .swamp.yaml names", async () => {
  await withSetupTempDir(async (repoDir) => {
    const tierPath = join(repoDir, "store", "config");
    let resolverCalls = 0;
    const deps = createDatastoreSetupDeps(repoDir, () => {
      resolverCalls++;
      return Promise.resolve(tierPath);
    });

    await writeMarker(repoDir, { type: "filesystem", path: "/x" });
    assertEquals(await deps.inspectManagedConfigTier(repoDir), {
      managed: false,
    });
    assertEquals(resolverCalls, 0);

    await writeMarker(repoDir, {
      type: "filesystem",
      path: join(repoDir, "store"),
      managedConfig: true,
    });
    assertEquals(await deps.inspectManagedConfigTier(repoDir), {
      managed: true,
      tierPath,
      populated: false,
    });

    await writeTestFile(join(tierPath, "models", "m.yaml"), "m");
    assertEquals(await deps.inspectManagedConfigTier(repoDir), {
      managed: true,
      tierPath,
      populated: true,
    });

    await Deno.remove(join(tierPath, "models"), { recursive: true });
    await writeTestFile(join(tierPath, "managed-config-migrated.json"), "{}");
    assertEquals(await deps.inspectManagedConfigTier(repoDir), {
      managed: true,
      tierPath,
      populated: true,
    });

    assertEquals(
      await createDatastoreSetupDeps(repoDir, noTier)
        .inspectManagedConfigTier(repoDir),
      { managed: true, tierPath: undefined, populated: false },
    );
  });
});

// ============================================================================
// Joining a remote that already holds a config tier (swamp-club#2844)
// ============================================================================

interface RecordedSync {
  op: "pull" | "push";
  options?: DatastoreSyncOptions;
}

/**
 * Like {@link registerTempDirRemoteType}, but scoped by namespace and
 * `subdirs` the way the S3 and GCS sync services are, and recording every
 * call. `failFirstPull` makes the first pull reject with that error.
 */
function registerRecordingRemoteType(
  remoteDir: string,
  cacheDir: string,
  calls: RecordedSync[],
  failFirstPull?: Error,
): string {
  const type = `test-ext-2844-${crypto.randomUUID()}`;
  const roots = (options?: DatastoreSyncOptions) => {
    const ns = options?.namespace ?? "";
    const subdirs = options?.subdirs ?? [""];
    return subdirs.map((sub) => ({
      remote: join(remoteDir, ns, sub),
      cache: join(cacheDir, ns, sub),
    }));
  };
  datastoreTypeRegistry.register({
    type,
    name: `Test ${type}`,
    description: "Recording temp-dir remote for swamp-club#2844",
    isBuiltIn: false,
    createProvider: () => ({
      ...createStubProvider({ hasSyncService: false }),
      resolveDatastorePath: () => remoteDir,
      resolveCachePath: () => cacheDir,
      createSyncService: () => ({
        pushChanged: async (options?: DatastoreSyncOptions) => {
          calls.push({ op: "push", options });
          for (const { remote, cache } of roots(options)) {
            await Deno.mkdir(cache, { recursive: true });
            await copy(cache, remote, { overwrite: true });
          }
        },
        pullChanged: async (options?: DatastoreSyncOptions) => {
          calls.push({ op: "pull", options });
          if (failFirstPull && calls.length === 1) throw failFirstPull;
          for (const { remote, cache } of roots(options)) {
            await Deno.mkdir(remote, { recursive: true });
            await copy(remote, cache, { overwrite: true });
          }
        },
        markDirty: () => Promise.resolve(),
      }),
    }),
  });
  return type;
}

/** A repo whose filesystem datastore at .swamp holds its config tier. */
async function writeInRepoTierRepo(repoDir: string): Promise<void> {
  await writeMarker(repoDir, {
    type: "filesystem",
    path: join(repoDir, ".swamp"),
    managedConfig: true,
  });
}

function inRepoTierDeps(repoDir: string): DatastoreSetupDeps {
  return createDatastoreSetupDeps(
    repoDir,
    () => Promise.resolve(join(repoDir, ".swamp", "config")),
  );
}

function keptWarningsOf(events: DatastoreSetupEvent[]) {
  return events.filter((e): e is WarningEvent =>
    e.kind === "warning" && e.data.code === "remote_config_tier_kept"
  );
}

Deno.test("datastoreSetupExtension: an in-repo tier joining a remote tier keeps the remote copy of every shared path", async () => {
  await withSetupTempDir(async (tmp) => {
    const repoDir = join(tmp, "repo");
    const remoteDir = join(tmp, "remote");
    const cacheDir = join(tmp, "cache");
    const calls: RecordedSync[] = [];
    const type = registerRecordingRemoteType(remoteDir, cacheDir, calls);
    await writeInRepoTierRepo(repoDir);

    const remoteConfig = join(remoteDir, "config");
    const localConfig = join(repoDir, ".swamp", "config");
    await writeTestFile(join(remoteConfig, "models", "m.yaml"), "team");
    await writeTestFile(join(remoteConfig, "workflows", "w.yaml"), "same");
    await writeTestFile(
      join(remoteConfig, "managed-config-migrated.json"),
      "team-sentinel",
    );
    await writeTestFile(join(localConfig, "models", "m.yaml"), "local");
    await writeTestFile(join(localConfig, "workflows", "w.yaml"), "same");
    await writeTestFile(
      join(localConfig, "managed-config-migrated.json"),
      "local-sentinel",
    );
    await writeTestFile(join(localConfig, "models", "only-local.yaml"), "x");
    await writeTestFile(
      join(localConfig, "pulled-extensions", "ext", "mod.ts"),
      "x",
    );
    await writeTestFile(join(repoDir, ".swamp", "data", "a.json"), "{}");

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        inRepoTierDeps(repoDir),
        {
          type,
          config: {},
          repoDir,
          repoId: "repo-2844",
          skipMigration: false,
        },
      ),
    );

    const completed = events.at(-1) as Extract<
      DatastoreSetupEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.kind, "completed");
    assertEquals(completed.data.errors, []);
    // The remote config tier is pulled before anything is pushed.
    assertEquals(calls[0].op, "pull");
    assertEquals(calls[0].options?.subdirs, ["config"]);
    assertEquals(calls[1].op, "push");
    // The team's copies survive; local-only config and data migrate.
    assertEquals(
      await Deno.readTextFile(join(remoteConfig, "models", "m.yaml")),
      "team",
    );
    assertEquals(
      await Deno.readTextFile(
        join(remoteConfig, "managed-config-migrated.json"),
      ),
      "team-sentinel",
    );
    assertEquals(
      await pathExists(join(remoteConfig, "models", "only-local.yaml")),
      true,
    );
    assertEquals(await pathExists(join(remoteDir, "data", "a.json")), true);
    assertEquals(
      await pathExists(join(remoteConfig, "pulled-extensions")),
      false,
    );
    // Only the differing local copy stays behind, with pulled extensions.
    assertEquals(
      await Deno.readTextFile(join(localConfig, "models", "m.yaml")),
      "local",
    );
    assertEquals(
      await pathExists(join(localConfig, "workflows", "w.yaml")),
      false,
    );
    assertEquals(
      await pathExists(join(localConfig, "managed-config-migrated.json")),
      false,
    );
    assertEquals(
      await pathExists(join(localConfig, "models", "only-local.yaml")),
      false,
    );
    assertEquals(
      await pathExists(join(localConfig, "pulled-extensions", "ext", "mod.ts")),
      true,
    );
    const kept = keptWarningsOf(events);
    assertEquals(kept.length, 1);
    assert(kept[0].data.code === "remote_config_tier_kept");
    assertEquals(kept[0].data.keptPaths, [join("models", "m.yaml")]);
    assertPathEquals(kept[0].data.localConfigPath, localConfig);
  });
});

Deno.test("datastoreSetupExtension: an in-repo tier joining an empty remote migrates all of it without a warning", async () => {
  await withSetupTempDir(async (tmp) => {
    const repoDir = join(tmp, "repo");
    const remoteDir = join(tmp, "remote");
    const cacheDir = join(tmp, "cache");
    const calls: RecordedSync[] = [];
    const type = registerRecordingRemoteType(remoteDir, cacheDir, calls);
    await writeInRepoTierRepo(repoDir);
    const localConfig = join(repoDir, ".swamp", "config");
    await writeTestFile(join(localConfig, "models", "m.yaml"), "local");
    await writeTestFile(
      join(localConfig, "managed-config-migrated.json"),
      "local-sentinel",
    );

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        inRepoTierDeps(repoDir),
        {
          type,
          config: {},
          repoDir,
          repoId: "repo-2844",
          skipMigration: false,
        },
      ),
    );

    assertEquals(events.at(-1)?.kind, "completed");
    assertEquals(keptWarningsOf(events), []);
    assertEquals(
      await Deno.readTextFile(join(remoteDir, "config", "models", "m.yaml")),
      "local",
    );
    assertEquals(
      await Deno.readTextFile(
        join(remoteDir, "config", "managed-config-migrated.json"),
      ),
      "local-sentinel",
    );
    assertEquals(await pathExists(join(localConfig, "models")), false);
  });
});

for (
  const [label, failure] of [
    ["an error", new Error("remote unreachable")],
    ["a timeout", new SyncTimeoutError("test", "pull", 1000)],
  ] as const
) {
  Deno.test(`datastoreSetupExtension: ${label} pulling the remote config tier stops setup before anything moves`, async () => {
    await withSetupTempDir(async (tmp) => {
      const repoDir = join(tmp, "repo");
      const remoteDir = join(tmp, "remote");
      const cacheDir = join(tmp, "cache");
      const calls: RecordedSync[] = [];
      const type = registerRecordingRemoteType(
        remoteDir,
        cacheDir,
        calls,
        failure,
      );
      await writeInRepoTierRepo(repoDir);
      const localModel = join(repoDir, ".swamp", "config", "models", "m.yaml");
      await writeTestFile(localModel, "local");
      await writeTestFile(join(repoDir, ".swamp", "data", "a.json"), "{}");

      const events = await collect<DatastoreSetupEvent>(
        datastoreSetupExtension(
          createLibSwampContext(),
          inRepoTierDeps(repoDir),
          {
            type,
            config: {},
            repoDir,
            repoId: "repo-2844",
            skipMigration: false,
            namespace: "team",
          },
        ),
      );

      const completed = events.at(-1) as Extract<
        DatastoreSetupEvent,
        { kind: "completed" }
      >;
      assertEquals(completed.kind, "completed");
      assertEquals(completed.data.errors.length, 1);
      assertNotEquals(completed.data.retryHint, undefined);
      assertEquals(calls.map((c) => c.op), ["pull"]);
      assertEquals(await Deno.readTextFile(localModel), "local");
      assertEquals(
        await pathExists(join(repoDir, ".swamp", "data", "a.json")),
        true,
      );
      const block = await readDatastoreBlock(repoDir);
      assertEquals(block?.type, "filesystem");
      assertEquals(block?.namespace, undefined);
    });
  });
}

Deno.test("datastoreSetupExtension: no config tier pre-pull for an unmanaged or instance-local config dir, or with skipMigration", async () => {
  const cases: {
    role: "unmanaged" | "instance_local" | "tier";
    skipMigration: boolean;
  }[] = [
    { role: "unmanaged", skipMigration: false },
    { role: "instance_local", skipMigration: false },
    { role: "tier", skipMigration: true },
  ];
  for (const { role, skipMigration } of cases) {
    const calls: RecordedSync[] = [];
    const type = registerRecordingRemoteType(
      "/nonexistent/remote",
      "/nonexistent/cache",
      calls,
    );
    const deps = makeDeps({
      resolveInRepoConfigRole: () => Promise.resolve(role),
      ensureDir: () => Promise.resolve(),
      listConfigTierConflicts: () => {
        throw new Error("must not list conflicts");
      },
    });
    await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(createLibSwampContext(), deps, {
        type,
        config: {},
        repoDir: "/nonexistent/repo",
        repoId: "repo-2844",
        skipMigration,
      }),
    );
    assertEquals(
      calls.some((c) => c.op === "pull" && c.options?.subdirs),
      false,
      `${role} skipMigration=${skipMigration}`,
    );
  }
});

Deno.test("datastoreSetupExtension: the config tier pre-pull is namespaced and lazy when setup is", async () => {
  await withSetupTempDir(async (tmp) => {
    const repoDir = join(tmp, "repo");
    const remoteDir = join(tmp, "remote");
    const cacheDir = join(tmp, "cache");
    const calls: RecordedSync[] = [];
    const type = registerRecordingRemoteType(remoteDir, cacheDir, calls);
    await writeInRepoTierRepo(repoDir);
    await writeTestFile(
      join(remoteDir, "team", "config", "models", "m.yaml"),
      "team",
    );
    await writeTestFile(
      join(repoDir, ".swamp", "config", "models", "m.yaml"),
      "local",
    );

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        inRepoTierDeps(repoDir),
        {
          type,
          config: {},
          repoDir,
          repoId: "repo-2844",
          skipMigration: false,
          namespace: "team",
          hydrationStrategy: "lazy",
        },
      ),
    );

    assertEquals(calls[0].op, "pull");
    assertEquals(calls[0].options?.namespace, "team");
    assertEquals(calls[0].options?.subdirs, ["config"]);
    assertEquals(calls[0].options?.metadataOnly, true);
    assertEquals(
      await Deno.readTextFile(
        join(remoteDir, "team", "config", "models", "m.yaml"),
      ),
      "team",
    );
    const kept = keptWarningsOf(events);
    assertEquals(kept.length, 1);
    assert(kept[0].data.code === "remote_config_tier_kept");
    assertEquals(kept[0].data.keptPaths, [join("models", "m.yaml")]);
  });
});

Deno.test("createDatastoreSetupDeps.listConfigTierConflicts: lists shared files, skips pulled extensions, follows only the root symlink", async () => {
  await withSetupTempDir(async (tmp) => {
    const realLocal = join(tmp, "real-local");
    const local = join(tmp, "local");
    const dest = join(tmp, "dest");
    await writeTestFile(join(realLocal, "models", "a.yaml"), "a");
    await writeTestFile(join(realLocal, "models", "same.yaml"), "s");
    await writeTestFile(join(realLocal, "only-local.json"), "x");
    await writeTestFile(join(realLocal, "pulled-extensions", "e.ts"), "x");
    await writeTestFile(join(tmp, "elsewhere", "inner.yaml"), "x");
    await Deno.symlink(join(tmp, "elsewhere"), join(realLocal, "linked"), {
      type: "dir",
    });
    await Deno.symlink(realLocal, local, { type: "dir" });
    await writeTestFile(join(dest, "models", "a.yaml"), "A");
    await writeTestFile(join(dest, "models", "same.yaml"), "s");
    await writeTestFile(join(dest, "pulled-extensions", "e.ts"), "y");
    await writeTestFile(join(dest, "linked", "inner.yaml"), "x");
    await writeTestFile(join(realLocal, "dir-vs-file", "child.yaml"), "x");
    await writeTestFile(join(dest, "dir-vs-file"), "x");

    const deps = createDatastoreSetupDeps(tmp, noTier);
    const conflicts = await deps.listConfigTierConflicts(local, dest);
    conflicts.sort((a, b) => a.path.localeCompare(b.path));

    assertEquals(conflicts, [
      { path: "dir-vs-file", differs: true },
      { path: "linked", differs: true },
      { path: join("models", "a.yaml"), differs: true },
      { path: join("models", "same.yaml"), differs: false },
    ]);
    assertEquals(
      await deps.listConfigTierConflicts(join(tmp, "none"), dest),
      [],
    );
  });
});

// ============================================================================
// Setup onto the migration source (swamp-club#3162)
// ============================================================================

for (
  const [label, pathOf] of [
    ["the absolute .swamp path", (repo: string) => join(repo, ".swamp")],
    [
      "a .swamp path with a redundant segment",
      (repo: string) => join(repo, ".swamp", "data", ".."),
    ],
  ] as const
) {
  Deno.test(`datastoreSetupFilesystem: ${label} as the destination writes the block without migrating`, async () => {
    await withSetupTempDir(async (tmp) => {
      const realRepo = join(tmp, "repo");
      const linkedRepo = join(tmp, "linked-repo");
      await writeMarker(realRepo, { type: "filesystem", path: ".swamp" });
      await Deno.symlink(realRepo, linkedRepo, { type: "dir" });
      const dataFile = join(realRepo, ".swamp", "data", "a.json");
      await writeTestFile(dataFile, "{}");

      // The repo is reached through a symlink; the destination names the
      // real path, so only a real-path comparison sees they are the same.
      const calls: string[] = [];
      const deps = createDatastoreSetupDeps(linkedRepo, noTier);
      const events = await collect<DatastoreSetupEvent>(
        datastoreSetupFilesystem(
          createLibSwampContext(),
          {
            ...deps,
            migrateData: (...args) => {
              calls.push("migrate");
              return deps.migrateData(...args);
            },
            verifyMigration: (...args) => {
              calls.push("verify");
              return deps.verifyMigration(...args);
            },
            cleanupSourceDirs: (...args) => {
              calls.push("cleanup");
              return deps.cleanupSourceDirs(...args);
            },
          },
          {
            datastorePath: pathOf(realRepo),
            repoDir: linkedRepo,
            skipMigration: false,
          },
        ),
      );

      const completed = events.at(-1) as Extract<
        DatastoreSetupEvent,
        { kind: "completed" }
      >;
      assertEquals(completed.kind, "completed");
      assertEquals(completed.data.errors, []);
      assertEquals(completed.data.directoriesMigrated, []);
      assertEquals(calls, []);
      assertEquals(await Deno.readTextFile(dataFile), "{}");
      const block = await readDatastoreBlock(realRepo);
      assertEquals(block?.type, "filesystem");
      assertPathEquals(block?.path ?? "", pathOf(realRepo));
    });
  });
}

Deno.test("datastoreSetupFilesystem: a destination other than .swamp still migrates", async () => {
  await withSetupTempDir(async (tmp) => {
    const repoDir = join(tmp, "repo");
    const datastorePath = join(tmp, "datastore");
    await writeMarker(repoDir, { type: "filesystem", path: ".swamp" });
    await writeTestFile(join(repoDir, ".swamp", "data", "a.json"), "{}");

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupFilesystem(
        createLibSwampContext(),
        createDatastoreSetupDeps(repoDir, noTier),
        { datastorePath, repoDir, skipMigration: false },
      ),
    );

    assertEquals(events.at(-1)?.kind, "completed");
    assertEquals(await pathExists(join(datastorePath, "data", "a.json")), true);
    assertEquals(await pathExists(join(repoDir, ".swamp", "data")), false);
  });
});

Deno.test({
  name:
    "createDatastoreSetupDeps.listConfigTierConflicts: an unreadable file counts as differing",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withSetupTempDir(async (tmp) => {
      const local = join(tmp, "local");
      const dest = join(tmp, "dest");
      await writeTestFile(join(local, "m.yaml"), "same");
      await writeTestFile(join(dest, "m.yaml"), "same");
      await Deno.chmod(join(local, "m.yaml"), 0o000);
      try {
        const deps = createDatastoreSetupDeps(tmp, noTier);
        assertEquals(await deps.listConfigTierConflicts(local, dest), [
          { path: "m.yaml", differs: true },
        ]);
      } finally {
        await Deno.chmod(join(local, "m.yaml"), 0o644);
      }
    });
  },
});

Deno.test("datastoreSetupExtension: a retry over a cache already holding every config file still pushes and cleans up", async () => {
  await withSetupTempDir(async (tmp) => {
    const repoDir = join(tmp, "repo");
    const remoteDir = join(tmp, "remote");
    const cacheDir = join(tmp, "cache");
    const calls: RecordedSync[] = [];
    const type = registerRecordingRemoteType(remoteDir, cacheDir, calls);
    await writeInRepoTierRepo(repoDir);
    // An earlier setup copied the tier into the cache, then its push failed.
    const localModel = join(repoDir, ".swamp", "config", "models", "m.yaml");
    await writeTestFile(localModel, "local");
    await writeTestFile(join(cacheDir, "config", "models", "m.yaml"), "local");

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupExtension(
        createLibSwampContext(),
        inRepoTierDeps(repoDir),
        {
          type,
          config: {},
          repoDir,
          repoId: "repo-2844",
          skipMigration: false,
        },
      ),
    );

    const completed = events.at(-1) as Extract<
      DatastoreSetupEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.kind, "completed");
    assertEquals(completed.data.errors, []);
    assertEquals(completed.data.filesCopied, 0);
    assertEquals(calls.map((c) => c.op), ["pull", "push", "pull"]);
    assertEquals(
      await Deno.readTextFile(join(remoteDir, "config", "models", "m.yaml")),
      "local",
    );
    assertEquals(await pathExists(localModel), false);
    assertEquals(keptWarningsOf(events), []);
  });
});

Deno.test("datastoreSetupFilesystem: refuses a target with a newer format before writing to it", async () => {
  const ensured: string[] = [];
  const checked: DatastoreConfig[] = [];
  const deps = makeDeps({
    ensureDir: (path) => {
      ensured.push(path);
      return Promise.resolve();
    },
    assertDatastoreFormat: (_repoDir, config) => {
      checked.push(config);
      return Promise.reject(
        new UnsupportedDatastoreFormatError({ format: 3 }, [2]),
      );
    },
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(
      createLibSwampContext(),
      deps,
      makeFilesystemInput(),
    ),
  );

  assertEquals(events.map((e) => e.kind), ["validating", "error"]);
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.error.code, DATASTORE_FORMAT_UNSUPPORTED_CODE);
  assertStringIncludes(error.error.message, "Nothing was changed.");
  assertEquals(checked, [{ type: "filesystem", path: "/tmp/datastore" }]);
  assertEquals(ensured, []);
});

Deno.test("datastoreSetupExtension: refuses a target with a newer format before verifying or syncing it", async () => {
  ensureTestExtensionType("test-ext-setup-format");
  const ensured: string[] = [];
  const checked: Array<{ config: DatastoreConfig; provider: boolean }> = [];
  const deps = makeDeps({
    ensureDir: (path) => {
      ensured.push(path);
      return Promise.resolve();
    },
    assertDatastoreFormat: (_repoDir, config, provider) => {
      checked.push({ config, provider: provider !== undefined });
      return Promise.reject(
        new InvalidDatastoreFormatMarkerError("_control/datastore-format", "x"),
      );
    },
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(
      createLibSwampContext(),
      deps,
      makeExtensionInput({ type: "test-ext-setup-format", namespace: "infra" }),
    ),
  );

  assertEquals(events.map((e) => e.kind), ["validating", "error"]);
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.error.code, DATASTORE_FORMAT_MARKER_INVALID_CODE);
  assertEquals(checked.length, 1);
  assertEquals(checked[0].provider, true);
  assertEquals(checked[0].config.type, "test-ext-setup-format");
  assertEquals(checked[0].config.namespace, "infra");
  assertEquals(ensured, []);
});

Deno.test("datastoreSetupExtension: a format check that passes leaves setup unchanged", async () => {
  ensureTestExtensionType("test-ext-setup-format-ok");
  let calls = 0;
  const deps = makeDeps({
    assertDatastoreFormat: () => {
      calls++;
      return Promise.resolve();
    },
  });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupExtension(
      createLibSwampContext(),
      deps,
      makeExtensionInput({ type: "test-ext-setup-format-ok" }),
    ),
  );

  assertEquals(calls, 1);
  assertEquals(events.map((e) => e.kind), [
    "validating",
    "migrating",
    "hydrating",
    "completed",
  ]);
});
