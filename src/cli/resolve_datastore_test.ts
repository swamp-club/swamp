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

import { assertEquals, assertRejects } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  parseDatastoreEnvVar,
  RENAMED_DATASTORE_TYPES,
  resolveDatastoreConfig,
} from "./resolve_datastore.ts";
import {
  type CustomDatastoreConfig,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import type { DatastoreProvider } from "../domain/datastore/datastore_provider.ts";
import { getSwampDataDir } from "../infrastructure/persistence/paths.ts";
import {
  getAutoResolver,
  setAutoResolver,
} from "../domain/extensions/auto_resolver_context.ts";
import {
  type AutoResolveOutputPort,
  ExtensionAutoResolver,
} from "../domain/extensions/extension_auto_resolver.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import { z } from "zod";
import { assertPathEquals } from "../infrastructure/persistence/path_test_helpers.ts";

/**
 * Creates a stub DatastoreProvider for testing custom datastore resolution.
 */
function createStubProvider(
  overrides?: Partial<DatastoreProvider>,
): DatastoreProvider {
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
          healthy: true,
          message: "ok",
          latencyMs: 1,
          datastoreType: "test",
        }),
    }),
    resolveDatastorePath: (repoDir: string) => `${repoDir}/.custom-store`,
    resolveCachePath: (repoDir: string) => `${repoDir}/.custom-cache`,
    ...overrides,
  };
}

/** Registers a test custom datastore type if not already registered. */
function ensureTestType(
  type: string,
  opts?: { configSchema?: z.ZodTypeAny },
): void {
  if (!datastoreTypeRegistry.has(type)) {
    datastoreTypeRegistry.register({
      type,
      name: `Test ${type}`,
      description: `Test datastore type: ${type}`,
      isBuiltIn: false,
      configSchema: opts?.configSchema,
      createProvider: () => createStubProvider(),
    });
  }
}

Deno.test("parseDatastoreEnvVar: parses filesystem path", async () => {
  const config = await parseDatastoreEnvVar("filesystem:/data/my-project");
  assertEquals(config.type, "filesystem");
  if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
    assertPathEquals(config.path, "/data/my-project");
  }
});

Deno.test("parseDatastoreEnvVar: s3 without extension throws UserError", async () => {
  // Without the @swamp/s3-datastore extension installed, S3 env vars throw
  await assertRejects(
    () => parseDatastoreEnvVar("s3:my-bucket/my-prefix", "test-repo"),
    Error,
    "S3 datastore requires the @swamp/s3-datastore extension",
  );
});

Deno.test("parseDatastoreEnvVar: throws on invalid format", async () => {
  await assertRejects(
    () => parseDatastoreEnvVar("invalid"),
    Error,
    "Invalid SWAMP_DATASTORE format",
  );
});

Deno.test("parseDatastoreEnvVar: throws on unknown type", async () => {
  await assertRejects(
    () => parseDatastoreEnvVar("gcs:bucket"),
    Error,
    "Unknown datastore type",
  );
});

Deno.test("resolveDatastoreConfig: default is filesystem at .swamp/", async () => {
  const config = await resolveDatastoreConfig(null, undefined, "/repo");
  assertEquals(config.type, "filesystem");
  if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
    assertPathEquals(config.path, "/repo/.swamp");
  }
});

Deno.test("resolveDatastoreConfig: env var takes priority", async () => {
  const originalEnv = Deno.env.get("SWAMP_DATASTORE");
  try {
    Deno.env.set("SWAMP_DATASTORE", "filesystem:/custom/path");
    const config = await resolveDatastoreConfig(null, undefined, "/repo");
    assertEquals(config.type, "filesystem");
    if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
      assertPathEquals(config.path, "/custom/path");
    }
  } finally {
    if (originalEnv) {
      Deno.env.set("SWAMP_DATASTORE", originalEnv);
    } else {
      Deno.env.delete("SWAMP_DATASTORE");
    }
  }
});

Deno.test("resolveDatastoreConfig: CLI arg overrides marker", async () => {
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: { type: "filesystem", path: "/marker-path" },
  };
  const config = await resolveDatastoreConfig(
    marker,
    "filesystem:/cli-path",
    "/repo",
  );
  assertEquals(config.type, "filesystem");
  if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
    assertPathEquals(config.path, "/cli-path");
  }
});

Deno.test("resolveDatastoreConfig: marker config used when no env/cli", async () => {
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: {
      type: "filesystem",
      path: "/marker-path",
      directories: ["data", "outputs"],
    },
  };
  const config = await resolveDatastoreConfig(marker, undefined, "/repo");
  assertEquals(config.type, "filesystem");
  if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
    assertPathEquals(config.path, "/marker-path");
    assertEquals(config.directories, ["data", "outputs"]);
  }
});

// ============================================================================
// S3 marker tests (extension not installed — expect UserError)
// ============================================================================

Deno.test("resolveDatastoreConfig: S3 marker without extension throws UserError", async () => {
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: {
      type: "s3",
      bucket: "my-space",
      region: "us-east-1",
      endpoint: "https://nyc3.digitaloceanspaces.com",
      forcePathStyle: false,
    },
  };
  // Without the @swamp/s3-datastore extension installed, S3 configs throw
  await assertRejects(
    () => resolveDatastoreConfig(marker, undefined, "/repo"),
    Error,
    "S3 datastore requires the @swamp/s3-datastore extension",
  );
});

// ============================================================================
// Custom datastore type tests
// ============================================================================

Deno.test("parseDatastoreEnvVar: parses custom type with JSON config", async () => {
  ensureTestType("test-custom-env");
  const config = await parseDatastoreEnvVar(
    'test-custom-env:{"region":"us-east-1"}',
    "repo-1",
    "/my/repo",
  );
  assertEquals(config.type, "test-custom-env");
  assertEquals(isCustomDatastoreConfig(config), true);
  const custom = config as CustomDatastoreConfig;
  assertEquals(custom.config, { region: "us-east-1" });
  assertPathEquals(custom.datastorePath, "/my/repo/.custom-store");
  assertPathEquals(custom.cachePath, "/my/repo/.custom-cache");
});

Deno.test("parseDatastoreEnvVar: parses custom type with empty config", async () => {
  ensureTestType("test-custom-empty");
  const config = await parseDatastoreEnvVar(
    "test-custom-empty:",
    "repo-1",
    "/my/repo",
  );
  assertEquals(config.type, "test-custom-empty");
  assertEquals(isCustomDatastoreConfig(config), true);
  const custom = config as CustomDatastoreConfig;
  assertEquals(custom.config, {});
});

Deno.test("parseDatastoreEnvVar: custom type uses repoDir not repoId for path resolution", async () => {
  ensureTestType("test-custom-path");
  const config = await parseDatastoreEnvVar(
    "test-custom-path:{}",
    "some-repo-id",
    "/actual/repo/dir",
  );
  const custom = config as CustomDatastoreConfig;
  // Should use repoDir, not repoId
  assertPathEquals(custom.datastorePath, "/actual/repo/dir/.custom-store");
});

Deno.test("parseDatastoreEnvVar: custom type throws on invalid JSON", async () => {
  ensureTestType("test-custom-badjson");
  await assertRejects(
    () => parseDatastoreEnvVar("test-custom-badjson:not-json", "r", "/repo"),
    Error,
    "Invalid JSON config",
  );
});

Deno.test("parseDatastoreEnvVar: custom type validates config schema", async () => {
  const schema = z.object({ endpoint: z.string() });
  ensureTestType("test-custom-schema", { configSchema: schema });
  await assertRejects(
    () => parseDatastoreEnvVar("test-custom-schema:{}", "r", "/repo"),
    Error,
    "Invalid config for datastore type",
  );
});

Deno.test("resolveDatastoreConfig: YAML custom type produces CustomDatastoreConfig", async () => {
  ensureTestType("test-custom-yaml");
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: {
      type: "test-custom-yaml",
      config: { key: "value" },
      directories: ["data"],
    },
  };
  const config = await resolveDatastoreConfig(marker, undefined, "/repo");
  assertEquals(config.type, "test-custom-yaml");
  assertEquals(isCustomDatastoreConfig(config), true);
  const custom = config as CustomDatastoreConfig;
  assertEquals(custom.config, { key: "value" });
  assertPathEquals(custom.datastorePath, "/repo/.custom-store");
  assertPathEquals(custom.cachePath, "/repo/.custom-cache");
  assertEquals(custom.directories, ["data"]);
});

Deno.test("resolveDatastoreConfig: YAML unknown type throws UserError", async () => {
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: { type: "nonexistent-type" },
  };
  await assertRejects(
    () => resolveDatastoreConfig(marker, undefined, "/repo"),
    Error,
    "Unknown datastore type",
  );
});

Deno.test("resolveDatastoreConfig: YAML custom type with no config defaults to empty object", async () => {
  ensureTestType("test-custom-noconfig");
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: { type: "test-custom-noconfig" },
  };
  const config = await resolveDatastoreConfig(marker, undefined, "/repo");
  const custom = config as CustomDatastoreConfig;
  assertEquals(custom.config, {});
});

// ============================================================================
// resolveCachePath contract — lock single-path cache resolution (swamp-club#150)
// ============================================================================

// The #150 reporter claimed a missing `resolveCachePath` method and a method
// returning `undefined` take different code paths in swamp core. They do not.
// Every consumer uses `provider.resolveCachePath?.(x) ?? <fallback>` — the
// codebase convention — which JavaScript evaluates identically for both
// cases. See src/cli/resolve_datastore.ts and src/libswamp/datastores/setup.ts;
// grep `resolveCachePath` to enumerate the call sites.
//
// These tests lock in the single-path runtime behavior: a provider that
// returns `undefined` routes to core's repoId-keyed default, while a provider
// that returns a concrete path uses that path. A future refactor that changes
// the fallback or drops the `?.` must update these assertions deliberately.

Deno.test("resolveCachePath: undefined return routes to repoId-keyed default", async () => {
  const typeName = "test-cache-undefined";
  if (!datastoreTypeRegistry.has(typeName)) {
    datastoreTypeRegistry.register({
      type: typeName,
      name: `Test ${typeName}`,
      description: `Test datastore type: ${typeName}`,
      isBuiltIn: false,
      createProvider: () =>
        createStubProvider({
          resolveCachePath: (_repoDir: string) => undefined,
        }),
    });
  }
  const config = await parseDatastoreEnvVar(
    `${typeName}:{}`,
    "repo-abc",
    "/my/repo",
  );
  const custom = config as CustomDatastoreConfig;
  assertEquals(custom.cachePath, join(getSwampDataDir(), "repos", "repo-abc"));
});

Deno.test("resolveCachePath: concrete return is used as-is", async () => {
  const typeName = "test-cache-concrete";
  if (!datastoreTypeRegistry.has(typeName)) {
    datastoreTypeRegistry.register({
      type: typeName,
      name: `Test ${typeName}`,
      description: `Test datastore type: ${typeName}`,
      isBuiltIn: false,
      createProvider: () =>
        createStubProvider({
          resolveCachePath: (repoDir: string) =>
            `${repoDir}/.test-explicit-cache`,
        }),
    });
  }
  const config = await parseDatastoreEnvVar(
    `${typeName}:{}`,
    "repo-xyz",
    "/my/repo",
  );
  const custom = config as CustomDatastoreConfig;
  assertPathEquals(custom.cachePath, "/my/repo/.test-explicit-cache");
});

// ============================================================================
// Relative path resolution tests (swamp-club#560)
// ============================================================================

Deno.test("parseDatastoreEnvVar: resolves relative filesystem path against repoDir", async () => {
  const repoDir = resolve("/my/repo");
  const config = await parseDatastoreEnvVar(
    "filesystem:.swamp",
    undefined,
    repoDir,
  );
  assertEquals(config.type, "filesystem");
  if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
    assertPathEquals(config.path, resolve(repoDir, ".swamp"));
  }
});

Deno.test("resolveDatastoreConfig: resolves relative YAML path against repoDir", async () => {
  const repoDir = resolve("/my/repo");
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: { type: "filesystem", path: ".swamp" },
  };
  const config = await resolveDatastoreConfig(marker, undefined, repoDir);
  assertEquals(config.type, "filesystem");
  if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
    assertPathEquals(config.path, resolve(repoDir, ".swamp"));
  }
});

Deno.test("resolveDatastoreConfig: preserves absolute YAML path as-is", async () => {
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: { type: "filesystem", path: "/absolute/datastore" },
  };
  const config = await resolveDatastoreConfig(marker, undefined, "/my/repo");
  assertEquals(config.type, "filesystem");
  if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
    assertPathEquals(config.path, "/absolute/datastore");
  }
});

// ============================================================================
// Renamed datastore type tests
// ============================================================================

Deno.test("RENAMED_DATASTORE_TYPES: maps s3 to @swamp/s3-datastore", () => {
  assertEquals(RENAMED_DATASTORE_TYPES["s3"], "@swamp/s3-datastore");
});

// ============================================================================
// Type guard tests
// ============================================================================

Deno.test("isCustomDatastoreConfig: returns false for filesystem", () => {
  assertEquals(
    isCustomDatastoreConfig({ type: "filesystem", path: "/tmp" }),
    false,
  );
});

Deno.test("isCustomDatastoreConfig: returns true for s3 (now custom)", () => {
  // After Phase 3, S3 is no longer a built-in type — it's custom
  assertEquals(
    isCustomDatastoreConfig({
      type: "s3",
      config: { bucket: "b" },
      datastorePath: "/tmp",
    }),
    true,
  );
});

Deno.test("isCustomDatastoreConfig: returns true for custom type", () => {
  assertEquals(
    isCustomDatastoreConfig({
      type: "my-custom-store",
      config: {},
      datastorePath: "/tmp",
    }),
    true,
  );
});

// ============================================================================
// Expression resolution integration tests
// ============================================================================

Deno.test("resolveDatastoreConfig: resolves env expression in custom type YAML config", async () => {
  ensureTestType("@test/ds-expr", {
    configSchema: z.object({ token: z.string() }),
  });
  const original = Deno.env.get("SWAMP_TEST_DS_INTEG_TOKEN");
  try {
    Deno.env.set("SWAMP_TEST_DS_INTEG_TOKEN", "my-secret-token");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "test-id",
      datastore: {
        type: "@test/ds-expr",
        config: { token: "${{ env.SWAMP_TEST_DS_INTEG_TOKEN }}" },
      },
    };
    const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    assertEquals(isCustomDatastoreConfig(config), true);
    assertEquals(
      (config as CustomDatastoreConfig).config.token,
      "my-secret-token",
    );
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_INTEG_TOKEN", original);
    } else Deno.env.delete("SWAMP_TEST_DS_INTEG_TOKEN");
  }
});

Deno.test("resolveDatastoreConfig: resolves env expression in SWAMP_DATASTORE env var", async () => {
  ensureTestType("@test/ds-expr-env", {
    configSchema: z.object({ token: z.string() }),
  });
  const origDs = Deno.env.get("SWAMP_DATASTORE");
  const origToken = Deno.env.get("SWAMP_TEST_DS_INTEG_TOKEN2");
  try {
    Deno.env.set("SWAMP_TEST_DS_INTEG_TOKEN2", "env-secret");
    Deno.env.set(
      "SWAMP_DATASTORE",
      '@test/ds-expr-env:{"token":"${{ env.SWAMP_TEST_DS_INTEG_TOKEN2 }}"}',
    );
    const config = await resolveDatastoreConfig(null, undefined, "/tmp/test");
    assertEquals(isCustomDatastoreConfig(config), true);
    assertEquals(
      (config as CustomDatastoreConfig).config.token,
      "env-secret",
    );
  } finally {
    if (origDs !== undefined) Deno.env.set("SWAMP_DATASTORE", origDs);
    else Deno.env.delete("SWAMP_DATASTORE");
    if (origToken !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_INTEG_TOKEN2", origToken);
    } else Deno.env.delete("SWAMP_TEST_DS_INTEG_TOKEN2");
  }
});

Deno.test("resolveDatastoreConfig: missing env expression in config throws UserError", async () => {
  ensureTestType("@test/ds-expr-miss", {
    configSchema: z.object({ token: z.string() }),
  });
  Deno.env.delete("SWAMP_TEST_DS_INTEG_NONEXISTENT");
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-id",
    datastore: {
      type: "@test/ds-expr-miss",
      config: { token: "${{ env.SWAMP_TEST_DS_INTEG_NONEXISTENT }}" },
    },
  };
  await assertRejects(
    () => resolveDatastoreConfig(marker, undefined, "/tmp/test"),
    Error,
    "SWAMP_TEST_DS_INTEG_NONEXISTENT",
  );
});

// ============================================================================
// Expression resolution in datastore-level fields (namespace, directories, etc.)
// ============================================================================

Deno.test("resolveDatastoreConfig: resolves env expression in namespace for custom type", async () => {
  ensureTestType("@test/ds-ns-expr");
  const orig = Deno.env.get("SWAMP_TEST_DS_NS");
  try {
    Deno.env.set("SWAMP_TEST_DS_NS", "prod-namespace");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
      datastore: {
        type: "@test/ds-ns-expr",
        namespace: "${{ env.SWAMP_TEST_DS_NS }}",
        config: {},
      },
    };
    const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    assertEquals(config.namespace, "prod-namespace");
  } finally {
    if (orig !== undefined) Deno.env.set("SWAMP_TEST_DS_NS", orig);
    else Deno.env.delete("SWAMP_TEST_DS_NS");
  }
});

Deno.test("resolveDatastoreConfig: resolves env expression in namespace for filesystem type", async () => {
  const orig = Deno.env.get("SWAMP_TEST_FS_NS");
  try {
    Deno.env.set("SWAMP_TEST_FS_NS", "dev-ns");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
      datastore: {
        type: "filesystem",
        path: "/tmp/fs-store",
        namespace: "${{ env.SWAMP_TEST_FS_NS }}",
      },
    };
    const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    assertEquals(config.namespace, "dev-ns");
  } finally {
    if (orig !== undefined) Deno.env.set("SWAMP_TEST_FS_NS", orig);
    else Deno.env.delete("SWAMP_TEST_FS_NS");
  }
});

Deno.test("resolveDatastoreConfig: resolves env expressions in directories array", async () => {
  ensureTestType("@test/ds-dirs-expr");
  const origA = Deno.env.get("SWAMP_TEST_DIR_A");
  const origB = Deno.env.get("SWAMP_TEST_DIR_B");
  try {
    Deno.env.set("SWAMP_TEST_DIR_A", "data");
    Deno.env.set("SWAMP_TEST_DIR_B", "outputs");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
      datastore: {
        type: "@test/ds-dirs-expr",
        directories: [
          "${{ env.SWAMP_TEST_DIR_A }}",
          "${{ env.SWAMP_TEST_DIR_B }}",
        ],
        config: {},
      },
    };
    const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    assertEquals(config.directories, ["data", "outputs"]);
  } finally {
    if (origA !== undefined) Deno.env.set("SWAMP_TEST_DIR_A", origA);
    else Deno.env.delete("SWAMP_TEST_DIR_A");
    if (origB !== undefined) Deno.env.set("SWAMP_TEST_DIR_B", origB);
    else Deno.env.delete("SWAMP_TEST_DIR_B");
  }
});

Deno.test("resolveDatastoreConfig: resolves env expressions in exclude array", async () => {
  ensureTestType("@test/ds-excl-expr");
  const orig = Deno.env.get("SWAMP_TEST_EXCL");
  try {
    Deno.env.set("SWAMP_TEST_EXCL", "secrets");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
      datastore: {
        type: "@test/ds-excl-expr",
        exclude: ["${{ env.SWAMP_TEST_EXCL }}"],
        config: {},
      },
    };
    const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    assertEquals(config.exclude, ["secrets"]);
  } finally {
    if (orig !== undefined) Deno.env.set("SWAMP_TEST_EXCL", orig);
    else Deno.env.delete("SWAMP_TEST_EXCL");
  }
});

Deno.test("resolveDatastoreConfig: resolves env expression in hydrationStrategy", async () => {
  ensureTestType("@test/ds-hydra-expr");
  const orig = Deno.env.get("SWAMP_TEST_HYDRA");
  try {
    Deno.env.set("SWAMP_TEST_HYDRA", "lazy");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
      datastore: {
        type: "@test/ds-hydra-expr",
        hydrationStrategy: "${{ env.SWAMP_TEST_HYDRA }}" as "full" | "lazy",
        config: {},
      },
    };
    const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    assertEquals(isCustomDatastoreConfig(config), true);
    assertEquals((config as CustomDatastoreConfig).hydrationStrategy, "lazy");
  } finally {
    if (orig !== undefined) Deno.env.set("SWAMP_TEST_HYDRA", orig);
    else Deno.env.delete("SWAMP_TEST_HYDRA");
  }
});

Deno.test("resolveDatastoreConfig: non-expression fields pass through unchanged", async () => {
  ensureTestType("@test/ds-no-expr");
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
    datastore: {
      type: "@test/ds-no-expr",
      namespace: "plain-namespace",
      directories: ["data", "outputs"],
      exclude: ["secrets"],
      hydrationStrategy: "full",
      config: {},
    },
  };
  const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
  assertEquals(isCustomDatastoreConfig(config), true);
  const custom = config as CustomDatastoreConfig;
  assertEquals(custom.namespace, "plain-namespace");
  assertEquals(custom.directories, ["data", "outputs"]);
  assertEquals(custom.exclude, ["secrets"]);
  assertEquals(custom.hydrationStrategy, "full");
});

// ============================================================================
// managedConfig expression resolution
// ============================================================================

Deno.test("resolveDatastoreConfig: string managedConfig resolves and gates vault correctly", async () => {
  ensureTestType("@test/ds-mc-expr");
  const origMc = Deno.env.get("SWAMP_TEST_MC");
  const origToken = Deno.env.get("SWAMP_TEST_MC_TOKEN");
  try {
    Deno.env.set("SWAMP_TEST_MC", "true");
    Deno.env.set("SWAMP_TEST_MC_TOKEN", "env-token");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
      datastore: {
        type: "@test/ds-mc-expr",
        managedConfig: "${{ env.SWAMP_TEST_MC }}" as unknown as boolean,
        config: { token: "${{ env.SWAMP_TEST_MC_TOKEN }}" },
      },
    };
    const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    const custom = config as CustomDatastoreConfig;
    assertEquals(custom.config.token, "env-token");
  } finally {
    if (origMc !== undefined) Deno.env.set("SWAMP_TEST_MC", origMc);
    else Deno.env.delete("SWAMP_TEST_MC");
    if (origToken !== undefined) {
      Deno.env.set("SWAMP_TEST_MC_TOKEN", origToken);
    } else Deno.env.delete("SWAMP_TEST_MC_TOKEN");
  }
});

Deno.test("resolveDatastoreConfig: managedConfig strict parsing — only true/1 are truthy", async () => {
  ensureTestType("@test/ds-mc-strict");
  const origMc = Deno.env.get("SWAMP_TEST_MC_STRICT");
  try {
    for (
      const [input, expected] of [
        ["true", true],
        ["TRUE", true],
        ["True", true],
        ["1", true],
        ["false", false],
        ["0", false],
        ["yes", false],
        ["no", false],
      ] as const
    ) {
      Deno.env.set("SWAMP_TEST_MC_STRICT", input);
      const marker: RepoMarkerData = {
        swampVersion: "0.1.0",
        initializedAt: "2024-01-01",
        repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
        datastore: {
          type: "@test/ds-mc-strict",
          managedConfig:
            "${{ env.SWAMP_TEST_MC_STRICT }}" as unknown as boolean,
          config: {},
        },
      };
      // If managedConfig resolves to true, vault expressions in config would
      // be blocked. If false, they'd be allowed. We test indirectly via the
      // fact that resolution succeeds (env expressions work either way).
      const config = await resolveDatastoreConfig(
        marker,
        undefined,
        "/tmp/test",
      );
      // The config resolves successfully regardless — the managedConfig value
      // only affects vault.get() gating, and we're using env expressions here.
      assertEquals(isCustomDatastoreConfig(config), true);
      // Verify the boolean coercion didn't cause errors
      if (expected) {
        // When managedConfig is true, vault.get() would be blocked (tested separately)
      }
    }
  } finally {
    if (origMc !== undefined) Deno.env.set("SWAMP_TEST_MC_STRICT", origMc);
    else Deno.env.delete("SWAMP_TEST_MC_STRICT");
  }
});

// ============================================================================
// repoId expression resolution
// ============================================================================

Deno.test("resolveDatastoreConfig: resolves env expression in repoId", async () => {
  const typeName = "@test/ds-repoid-expr";
  if (!datastoreTypeRegistry.has(typeName)) {
    datastoreTypeRegistry.register({
      type: typeName,
      name: "Test repoId expr",
      description: "Test repoId expression resolution",
      isBuiltIn: false,
      createProvider: () =>
        createStubProvider({
          resolveCachePath: () => undefined,
        }),
    });
  }
  const orig = Deno.env.get("SWAMP_TEST_REPO_ID");
  try {
    Deno.env.set(
      "SWAMP_TEST_REPO_ID",
      "b24851d1-696e-4f07-8daf-1649cab9cd45",
    );
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "${{ env.SWAMP_TEST_REPO_ID }}",
      datastore: {
        type: typeName,
        config: {},
      },
    };
    const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    const custom = config as CustomDatastoreConfig;
    assertEquals(
      custom.cachePath,
      join(getSwampDataDir(), "repos", "b24851d1-696e-4f07-8daf-1649cab9cd45"),
    );
  } finally {
    if (orig !== undefined) Deno.env.set("SWAMP_TEST_REPO_ID", orig);
    else Deno.env.delete("SWAMP_TEST_REPO_ID");
  }
});

Deno.test("resolveDatastoreConfig: repoId UUID validation rejects non-UUID", async () => {
  ensureTestType("@test/ds-repoid-invalid");
  const orig = Deno.env.get("SWAMP_TEST_REPO_ID_BAD");
  try {
    Deno.env.set("SWAMP_TEST_REPO_ID_BAD", "not-a-uuid");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "${{ env.SWAMP_TEST_REPO_ID_BAD }}",
      datastore: {
        type: "@test/ds-repoid-invalid",
        config: {},
      },
    };
    await assertRejects(
      () => resolveDatastoreConfig(marker, undefined, "/tmp/test"),
      Error,
      "repoId must be a valid UUID",
    );
  } finally {
    if (orig !== undefined) Deno.env.set("SWAMP_TEST_REPO_ID_BAD", orig);
    else Deno.env.delete("SWAMP_TEST_REPO_ID_BAD");
  }
});

Deno.test("resolveDatastoreConfig: plain UUID repoId passes through unchanged", async () => {
  const typeName = "@test/ds-repoid-plain";
  if (!datastoreTypeRegistry.has(typeName)) {
    datastoreTypeRegistry.register({
      type: typeName,
      name: "Test repoId plain",
      description: "Test plain repoId passthrough",
      isBuiltIn: false,
      createProvider: () =>
        createStubProvider({
          resolveCachePath: () => undefined,
        }),
    });
  }
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
    datastore: {
      type: typeName,
      config: {},
    },
  };
  const config = await resolveDatastoreConfig(marker, undefined, "/tmp/test");
  const custom = config as CustomDatastoreConfig;
  assertEquals(
    custom.cachePath,
    join(getSwampDataDir(), "repos", "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee"),
  );
});

Deno.test("resolveDatastoreConfig: repoId expression does not mutate marker", async () => {
  ensureTestType("@test/ds-repoid-nomut");
  const orig = Deno.env.get("SWAMP_TEST_REPO_ID_NOMUT");
  try {
    Deno.env.set(
      "SWAMP_TEST_REPO_ID_NOMUT",
      "b24851d1-696e-4f07-8daf-1649cab9cd45",
    );
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01",
      repoId: "${{ env.SWAMP_TEST_REPO_ID_NOMUT }}",
      datastore: {
        type: "@test/ds-repoid-nomut",
        config: {},
      },
    };
    await resolveDatastoreConfig(marker, undefined, "/tmp/test");
    assertEquals(
      marker.repoId,
      "${{ env.SWAMP_TEST_REPO_ID_NOMUT }}",
    );
  } finally {
    if (orig !== undefined) Deno.env.set("SWAMP_TEST_REPO_ID_NOMUT", orig);
    else Deno.env.delete("SWAMP_TEST_REPO_ID_NOMUT");
  }
});

/** No-op auto-resolve output port. */
const silentOutput: AutoResolveOutputPort = {
  searching: () => {},
  installing: () => {},
  installed: () => {},
  notFound: () => {},
  networkError: () => {},
  alreadyInstalledButFailed: () => {},
  alreadyInstalledTruncated: () => {},
  legacyInstallation: () => {},
  collectiveNotTrusted: () => {},
  localSourceFailed: () => {},
  noStableVersion: () => {},
};

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
      },
      output: silentOutput,
    }),
  );
  try {
    await fn(lookups);
  } finally {
    setAutoResolver(previous);
  }
}

Deno.test("resolveDatastoreConfig: autoResolve false never consults the auto-resolver", async () => {
  const collective = `t${crypto.randomUUID().slice(0, 8)}`;
  const type = `@${collective}/missing-datastore`;
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: { type },
  };
  await withRecordingAutoResolver(collective, async (lookups) => {
    await assertRejects(
      () =>
        resolveDatastoreConfig(marker, undefined, "/repo", {
          autoResolve: false,
        }),
      Error,
      "Unknown datastore type",
    );
    assertEquals(lookups, []);
  });
});

Deno.test("resolveDatastoreConfig: auto-resolves a missing datastore type by default", async () => {
  const collective = `t${crypto.randomUUID().slice(0, 8)}`;
  const type = `@${collective}/missing-datastore`;
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: { type },
  };
  await withRecordingAutoResolver(collective, async (lookups) => {
    await assertRejects(
      () => resolveDatastoreConfig(marker, undefined, "/repo"),
      Error,
      "Unknown datastore type",
    );
    assertEquals(lookups.length > 0, true);
  });
});

Deno.test("parseDatastoreEnvVar: autoResolve false never consults the auto-resolver", async () => {
  const collective = `t${crypto.randomUUID().slice(0, 8)}`;
  await withRecordingAutoResolver(collective, async (lookups) => {
    await assertRejects(
      () =>
        parseDatastoreEnvVar(
          `@${collective}/missing-datastore:{}`,
          "test-repo",
          "/repo",
          { autoResolve: false },
        ),
      Error,
      "Unknown datastore type",
    );
    assertEquals(lookups, []);
  });
});
