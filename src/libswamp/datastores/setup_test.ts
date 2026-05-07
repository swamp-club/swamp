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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  type DatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupExtension,
  type DatastoreSetupExtensionInput,
  datastoreSetupFilesystem,
  type DatastoreSetupFilesystemInput,
} from "./setup.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";

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
    collapseEnvVars: (path: string) => path,
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
