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
import {
  buildLocalEditsWarning,
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
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import { z } from "zod";

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
    assertEquals(config.path, "/data/my-project");
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
    assertEquals(config.path, "/repo/.swamp");
  }
});

Deno.test("resolveDatastoreConfig: env var takes priority", async () => {
  const originalEnv = Deno.env.get("SWAMP_DATASTORE");
  try {
    Deno.env.set("SWAMP_DATASTORE", "filesystem:/custom/path");
    const config = await resolveDatastoreConfig(null, undefined, "/repo");
    assertEquals(config.type, "filesystem");
    if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
      assertEquals(config.path, "/custom/path");
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
    assertEquals(config.path, "/cli-path");
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
    assertEquals(config.path, "/marker-path");
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
  assertEquals(custom.datastorePath, "/my/repo/.custom-store");
  assertEquals(custom.cachePath, "/my/repo/.custom-cache");
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
  assertEquals(custom.datastorePath, "/actual/repo/dir/.custom-store");
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
  assertEquals(custom.datastorePath, "/repo/.custom-store");
  assertEquals(custom.cachePath, "/repo/.custom-cache");
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

Deno.test("buildLocalEditsWarning: names the extension and the opt-in command", () => {
  const msg = buildLocalEditsWarning("@swamp/s3-datastore", {
    previousVersion: "2026.03.15.1",
    newVersion: "2026.03.30.1",
  });
  assertStringIncludes(msg, "@swamp/s3-datastore");
  assertStringIncludes(msg, "2026.03.15.1");
  assertStringIncludes(msg, "2026.03.30.1");
  assertStringIncludes(msg, ".swamp/pulled-extensions/@swamp/s3-datastore/");
  assertStringIncludes(
    msg,
    "swamp extension pull @swamp/s3-datastore --force",
  );
});
