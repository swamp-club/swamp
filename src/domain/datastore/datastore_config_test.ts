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

import { assertEquals, assertFalse } from "@std/assert";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { join } from "@std/path";
import {
  ALWAYS_LOCAL_SUBDIRS,
  classifyInRepoConfig,
  type CustomDatastoreConfig,
  type DatastoreConfigData,
  DEFAULT_DATASTORE_SUBDIRS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_SYNC_TIMEOUT_MS,
  type FilesystemDatastoreConfig,
  getDatastoreDirectories,
  inRepoConfigMigrationSkips,
  isAlwaysLocal,
  LOCK_TIMEOUT_ENV_VAR,
  mergeSetupDatastoreBlock,
  planConfigTierMerge,
  PULLED_EXTENSIONS_SUBDIR,
  resolveLockTimeoutMs,
  resolveSyncTimeoutMs,
  SYNC_TIMEOUT_ENV_VAR,
} from "./datastore_config.ts";

const filesystemConfig: FilesystemDatastoreConfig = {
  type: "filesystem",
  path: "/tmp/ds",
};

const customConfig: CustomDatastoreConfig = {
  type: "s3",
  config: {},
  datastorePath: "/tmp/ds",
  cachePath: "/tmp/cache",
};

Deno.test("resolveSyncTimeoutMs: override wins over config, env, and default", () => {
  const configured: CustomDatastoreConfig = {
    ...customConfig,
    syncTimeoutMs: 60_000,
  };
  withMockedEnv({ [SYNC_TIMEOUT_ENV_VAR]: "120000" }, () => {
    assertEquals(resolveSyncTimeoutMs(configured, 30_000), 30_000);
  });
});

Deno.test("resolveSyncTimeoutMs: override works on filesystem config too", () => {
  withMockedEnv({ [SYNC_TIMEOUT_ENV_VAR]: undefined }, () => {
    assertEquals(resolveSyncTimeoutMs(filesystemConfig, 45_000), 45_000);
  });
});

Deno.test("resolveSyncTimeoutMs: non-positive override falls through", () => {
  // The CLI boundary rejects <= 0 with a UserError (see parseTimeoutFlag),
  // but if an out-of-band caller passes 0 or negative, we must not treat it
  // as a valid override — fall through to the next source.
  withMockedEnv({ [SYNC_TIMEOUT_ENV_VAR]: undefined }, () => {
    assertEquals(
      resolveSyncTimeoutMs(customConfig, 0),
      DEFAULT_SYNC_TIMEOUT_MS,
    );
    assertEquals(
      resolveSyncTimeoutMs(customConfig, -1),
      DEFAULT_SYNC_TIMEOUT_MS,
    );
  });
});

Deno.test("resolveSyncTimeoutMs: undefined override preserves existing precedence (config)", () => {
  const configured: CustomDatastoreConfig = {
    ...customConfig,
    syncTimeoutMs: 42_000,
  };
  withMockedEnv({ [SYNC_TIMEOUT_ENV_VAR]: undefined }, () => {
    assertEquals(resolveSyncTimeoutMs(configured, undefined), 42_000);
  });
});

Deno.test("resolveSyncTimeoutMs: undefined override preserves existing precedence (env)", () => {
  withMockedEnv({ [SYNC_TIMEOUT_ENV_VAR]: "180000" }, () => {
    assertEquals(resolveSyncTimeoutMs(customConfig, undefined), 180_000);
  });
});

Deno.test("resolveSyncTimeoutMs: no override, no config, no env returns default", () => {
  withMockedEnv({ [SYNC_TIMEOUT_ENV_VAR]: undefined }, () => {
    assertEquals(resolveSyncTimeoutMs(customConfig), DEFAULT_SYNC_TIMEOUT_MS);
  });
});

// --- resolveLockTimeoutMs ---

Deno.test("resolveLockTimeoutMs: override wins over env and default", () => {
  withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: "120000" }, () => {
    assertEquals(resolveLockTimeoutMs(30_000), 30_000);
  });
});

Deno.test("resolveLockTimeoutMs: env var wins over default", () => {
  withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: "180000" }, () => {
    assertEquals(resolveLockTimeoutMs(), 180_000);
  });
});

Deno.test("resolveLockTimeoutMs: no override, no env returns default", () => {
  withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: undefined }, () => {
    assertEquals(resolveLockTimeoutMs(), DEFAULT_LOCK_TIMEOUT_MS);
  });
});

Deno.test("resolveLockTimeoutMs: non-positive override falls through", () => {
  withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: undefined }, () => {
    assertEquals(resolveLockTimeoutMs(0), DEFAULT_LOCK_TIMEOUT_MS);
    assertEquals(resolveLockTimeoutMs(-1), DEFAULT_LOCK_TIMEOUT_MS);
  });
});

Deno.test("resolveLockTimeoutMs: invalid env var falls through to default", () => {
  withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: "not-a-number" }, () => {
    assertEquals(resolveLockTimeoutMs(), DEFAULT_LOCK_TIMEOUT_MS);
  });
});

Deno.test("resolveLockTimeoutMs: zero env var falls through to default", () => {
  withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: "0" }, () => {
    assertEquals(resolveLockTimeoutMs(), DEFAULT_LOCK_TIMEOUT_MS);
  });
});

Deno.test("resolveLockTimeoutMs: negative env var falls through to default", () => {
  withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: "-5000" }, () => {
    assertEquals(resolveLockTimeoutMs(), DEFAULT_LOCK_TIMEOUT_MS);
  });
});

// --- getDatastoreDirectories / ALWAYS_LOCAL_SUBDIRS ---

Deno.test("getDatastoreDirectories: excludes secrets from default list", () => {
  const dirs = getDatastoreDirectories(filesystemConfig);
  assertFalse(
    dirs.includes("secrets"),
    "secrets must not appear in datastore directories",
  );
});

Deno.test("getDatastoreDirectories: excludes bundle directories from default list", () => {
  const dirs = getDatastoreDirectories(filesystemConfig);
  for (
    const bundleDir of [
      "bundles",
      "vault-bundles",
      "report-bundles",
      "webhook-bundles",
    ]
  ) {
    assertFalse(
      dirs.includes(bundleDir),
      `${bundleDir} must not appear in datastore directories`,
    );
  }
});

Deno.test("getDatastoreDirectories: excludes secrets even when explicitly listed in config", () => {
  const config: FilesystemDatastoreConfig = {
    ...filesystemConfig,
    directories: ["data", "secrets", "outputs"],
  };
  const dirs = getDatastoreDirectories(config);
  assertFalse(
    dirs.includes("secrets"),
    "secrets must be filtered even when explicitly configured",
  );
});

Deno.test("getDatastoreDirectories: excludes bundles even when explicitly listed in config", () => {
  const config: FilesystemDatastoreConfig = {
    ...filesystemConfig,
    directories: ["data", "bundles", "vault-bundles", "outputs"],
  };
  const dirs = getDatastoreDirectories(config);
  assertFalse(
    dirs.includes("bundles"),
    "bundles must be filtered even when explicitly configured",
  );
  assertFalse(
    dirs.includes("vault-bundles"),
    "vault-bundles must be filtered even when explicitly configured",
  );
});

Deno.test("getDatastoreDirectories: excludes secrets for custom datastore config", () => {
  const dirs = getDatastoreDirectories(customConfig);
  assertFalse(
    dirs.includes("secrets"),
    "secrets must not appear for custom datastore configs",
  );
});

Deno.test("getDatastoreDirectories: returns other default subdirs", () => {
  const dirs = getDatastoreDirectories(filesystemConfig);
  assertEquals(dirs.includes("data"), true);
  assertEquals(dirs.includes("outputs"), true);
  assertEquals(dirs.includes("workflow-runs"), true);
});

Deno.test("isAlwaysLocal: returns true for secrets", () => {
  assertEquals(isAlwaysLocal("secrets"), true);
});

Deno.test("isAlwaysLocal: returns false for data", () => {
  assertEquals(isAlwaysLocal("data"), false);
});

Deno.test("ALWAYS_LOCAL_SUBDIRS: contains secrets", () => {
  assertEquals(
    (ALWAYS_LOCAL_SUBDIRS as readonly string[]).includes("secrets"),
    true,
  );
});

Deno.test("ALWAYS_LOCAL_SUBDIRS: contains bundle directories", () => {
  const always = ALWAYS_LOCAL_SUBDIRS as readonly string[];
  for (
    const bundleDir of [
      "bundles",
      "vault-bundles",
      "report-bundles",
    ]
  ) {
    assertEquals(
      always.includes(bundleDir),
      true,
      `${bundleDir} must be in ALWAYS_LOCAL_SUBDIRS`,
    );
  }
});

Deno.test("isAlwaysLocal: returns true for bundle directories", () => {
  for (
    const bundleDir of [
      "bundles",
      "vault-bundles",
      "report-bundles",
    ]
  ) {
    assertEquals(
      isAlwaysLocal(bundleDir),
      true,
      `${bundleDir} must be always-local`,
    );
  }
});

Deno.test("DEFAULT_DATASTORE_SUBDIRS: still lists secrets for backwards compatibility", () => {
  assertEquals(
    (DEFAULT_DATASTORE_SUBDIRS as readonly string[]).includes("secrets"),
    true,
  );
});

Deno.test("DEFAULT_DATASTORE_SUBDIRS: includes config subdir", () => {
  assertEquals(
    (DEFAULT_DATASTORE_SUBDIRS as readonly string[]).includes("config"),
    true,
  );
});

Deno.test("getDatastoreDirectories: config subdir is included in defaults", () => {
  const dirs = getDatastoreDirectories(filesystemConfig);
  assertEquals(dirs.includes("config"), true);
});

Deno.test("DatastoreConfigData: managedConfig defaults to undefined", () => {
  const data: DatastoreConfigData = { type: "filesystem" };
  assertEquals(data.managedConfig, undefined);
});

Deno.test("DatastoreConfigData: managedConfig can be set to true", () => {
  const data: DatastoreConfigData = { type: "filesystem", managedConfig: true };
  assertEquals(data.managedConfig, true);
});

Deno.test("mergeSetupDatastoreBlock: keeps managedConfig and exclude from the existing block", () => {
  const merged = mergeSetupDatastoreBlock(
    {
      type: "@swamp/s3-datastore",
      config: { bucket: "team" },
      managedConfig: true,
      exclude: ["*.tmp"],
    },
    { type: "@swamp/s3-datastore", config: { bucket: "team" } },
  );
  assertEquals(merged, {
    type: "@swamp/s3-datastore",
    config: { bucket: "team" },
    managedConfig: true,
    exclude: ["*.tmp"],
  });
});

Deno.test("mergeSetupDatastoreBlock: drops the old backend's keys on a switch", () => {
  const merged = mergeSetupDatastoreBlock(
    {
      type: "@swamp/s3-datastore",
      config: { bucket: "team" },
      namespace: "old-ns",
      hydrationStrategy: "lazy",
      directories: ["data"],
      managedConfig: true,
    },
    { type: "filesystem", path: "/data/swamp" },
  );
  assertEquals(merged, {
    type: "filesystem",
    path: "/data/swamp",
    managedConfig: true,
  });
});

Deno.test("mergeSetupDatastoreBlock: a key the new block sets wins", () => {
  const merged = mergeSetupDatastoreBlock(
    { type: "filesystem", path: "/a", exclude: ["old"] },
    { type: "filesystem", path: "/b", exclude: ["new"] },
  );
  assertEquals(merged.exclude, ["new"]);
  assertEquals(merged.path, "/b");
});

Deno.test("mergeSetupDatastoreBlock: an absent existing block returns the new block", () => {
  const next: DatastoreConfigData = { type: "filesystem", path: "/b" };
  assertEquals(mergeSetupDatastoreBlock(undefined, next), next);
});

Deno.test("mergeSetupDatastoreBlock: does not mutate either block", () => {
  const existing: DatastoreConfigData = {
    type: "filesystem",
    path: "/a",
    managedConfig: true,
  };
  const next: DatastoreConfigData = { type: "filesystem", path: "/b" };
  mergeSetupDatastoreBlock(existing, next);
  assertEquals(existing, {
    type: "filesystem",
    path: "/a",
    managedConfig: true,
  });
  assertEquals(next, { type: "filesystem", path: "/b" });
});

const repoConfig = join("/repo", ".swamp", "config");

Deno.test("classifyInRepoConfig: unmanaged when managedConfig is off", () => {
  assertEquals(
    classifyInRepoConfig(false, repoConfig, repoConfig),
    "unmanaged",
  );
  assertEquals(classifyInRepoConfig(false, undefined, repoConfig), "unmanaged");
});

Deno.test("classifyInRepoConfig: tier when the resolved tier is the in-repo config dir", () => {
  assertEquals(
    classifyInRepoConfig(
      true,
      join("/repo", ".swamp", ".", "config"),
      repoConfig,
    ),
    "tier",
  );
});

Deno.test("classifyInRepoConfig: instance_local when the tier is in an extension cache", () => {
  assertEquals(
    classifyInRepoConfig(
      true,
      join("/home", "u", ".swamp", "repos", "id", "ns", "config"),
      repoConfig,
    ),
    "instance_local",
  );
});

Deno.test("classifyInRepoConfig: instance_local for a namespaced filesystem datastore at .swamp", () => {
  assertEquals(
    classifyInRepoConfig(
      true,
      join("/repo", ".swamp", "ns", "config"),
      repoConfig,
    ),
    "instance_local",
  );
});

Deno.test("classifyInRepoConfig: instance_local when the current datastore cannot be resolved", () => {
  assertEquals(
    classifyInRepoConfig(true, undefined, repoConfig),
    "instance_local",
  );
});

Deno.test("inRepoConfigMigrationSkips: maps each role to the paths setup leaves behind", () => {
  assertEquals(inRepoConfigMigrationSkips("unmanaged"), []);
  assertEquals(inRepoConfigMigrationSkips("tier"), [
    join("config", PULLED_EXTENSIONS_SUBDIR),
  ]);
  assertEquals(inRepoConfigMigrationSkips("instance_local"), ["config"]);
});

Deno.test("planConfigTierMerge: skips every conflict, keeps and reports only differing ones", () => {
  const merge = planConfigTierMerge([
    { path: join("models", "a.yaml"), differs: true },
    { path: join("workflows", "w.yaml"), differs: false },
    { path: "upstream_extensions.json", differs: true },
  ]);
  assertEquals(merge.copySkips, [
    join("config", "models", "a.yaml"),
    join("config", "workflows", "w.yaml"),
    join("config", "upstream_extensions.json"),
  ]);
  assertEquals(merge.cleanupKeeps, [
    join("config", "models", "a.yaml"),
    join("config", "upstream_extensions.json"),
  ]);
  assertEquals(merge.keptPaths, [
    join("models", "a.yaml"),
    "upstream_extensions.json",
  ]);
});

Deno.test("planConfigTierMerge: never keeps or reports the migration sentinel", () => {
  const merge = planConfigTierMerge([
    { path: "managed-config-migrated.json", differs: true },
  ]);
  assertEquals(merge.copySkips, [
    join("config", "managed-config-migrated.json"),
  ]);
  assertEquals(merge.cleanupKeeps, []);
  assertEquals(merge.keptPaths, []);
});

Deno.test("planConfigTierMerge: no conflicts leaves everything to migrate", () => {
  assertEquals(planConfigTierMerge([]), {
    copySkips: [],
    cleanupKeeps: [],
    keptPaths: [],
  });
});
