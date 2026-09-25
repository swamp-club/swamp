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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  bundleNamespace,
  getManagedConfigBase,
  getSwampConfigDir,
  getSwampDataDir,
  globalTelemetryDir,
  homeDirectory,
  homeDirectoryIsSet,
  isManagedConfig,
  isManagedConfigBaseResolved,
  managedConfigLockfilePath,
  registerManagedConfig,
  resetManagedConfigRegistry,
  resolveManagedConfigOnce,
  resolvePulledExtensionsRoot,
  SWAMP_DATA_DIR,
  SWAMP_MARKER_FILE,
  SWAMP_SUBDIRS,
  swampMarkerPath,
  swampPath,
  toAbsolutePath,
  toRelativePath,
} from "./paths.ts";
import { assertPathEquals, withMockedEnv } from "./path_test_helpers.ts";

Deno.test("SWAMP_DATA_DIR is .swamp", () => {
  assertEquals(SWAMP_DATA_DIR, ".swamp");
});

Deno.test("SWAMP_MARKER_FILE is .swamp.yaml", () => {
  assertEquals(SWAMP_MARKER_FILE, ".swamp.yaml");
});

Deno.test("swampPath joins segments correctly", () => {
  assertPathEquals(
    swampPath("/repo", "definitions", "aws/ec2", "my-vpc.yaml"),
    "/repo/.swamp/definitions/aws/ec2/my-vpc.yaml",
  );
});

Deno.test("swampPath with no segments returns data dir", () => {
  assertPathEquals(swampPath("/repo"), "/repo/.swamp");
});

Deno.test("swampPath with single segment", () => {
  assertPathEquals(swampPath("/repo", "workflows"), "/repo/.swamp/workflows");
});

Deno.test("swampMarkerPath returns marker file path", () => {
  assertPathEquals(swampMarkerPath("/repo"), "/repo/.swamp.yaml");
});

Deno.test("SWAMP_SUBDIRS has all expected directories", () => {
  assertEquals(SWAMP_SUBDIRS.definitions, "definitions");
  assertEquals(SWAMP_SUBDIRS.definitionsEvaluated, "definitions-evaluated");
  assertEquals(SWAMP_SUBDIRS.workflows, "workflows");
  assertEquals(SWAMP_SUBDIRS.workflowsEvaluated, "workflows-evaluated");
  assertEquals(SWAMP_SUBDIRS.workflowRuns, "workflow-runs");
  assertEquals(SWAMP_SUBDIRS.outputs, "outputs");
  assertEquals(SWAMP_SUBDIRS.data, "data");
  assertEquals(SWAMP_SUBDIRS.vault, "vault");
  assertEquals(SWAMP_SUBDIRS.secrets, "secrets");
  assertEquals(SWAMP_SUBDIRS.telemetry, "telemetry");
  assertEquals(SWAMP_SUBDIRS.logs, "logs");
  assertEquals(SWAMP_SUBDIRS.files, "files");
  assertEquals(SWAMP_SUBDIRS.inputs, "inputs");
  assertEquals(SWAMP_SUBDIRS.inputsEvaluated, "inputs-evaluated");
  assertEquals(SWAMP_SUBDIRS.resources, "resources");
});

Deno.test("swampPath with SWAMP_SUBDIRS constants", () => {
  assertPathEquals(
    swampPath("/repo", SWAMP_SUBDIRS.definitions),
    "/repo/.swamp/definitions",
  );
  assertPathEquals(
    swampPath("/repo", SWAMP_SUBDIRS.workflowRuns, "workflow-123"),
    "/repo/.swamp/workflow-runs/workflow-123",
  );
});

Deno.test("toRelativePath - converts absolute path inside repo to relative", () => {
  const repoDir = "/Users/john/repo";
  const absolutePath = "/Users/john/repo/.swamp/outputs/aws/cli/run.log";

  const result = toRelativePath(repoDir, absolutePath);

  assertPathEquals(result, ".swamp/outputs/aws/cli/run.log");
});

Deno.test("toRelativePath - returns already relative path unchanged", () => {
  const repoDir = "/Users/john/repo";
  const relativePath = ".swamp/outputs/aws/cli/run.log";

  const result = toRelativePath(repoDir, relativePath);

  assertEquals(result, ".swamp/outputs/aws/cli/run.log");
});

Deno.test("toRelativePath - handles path at repo root", () => {
  const repoDir = "/Users/john/repo";
  const absolutePath = "/Users/john/repo/file.txt";

  const result = toRelativePath(repoDir, absolutePath);

  assertEquals(result, "file.txt");
});

Deno.test("toAbsolutePath - converts relative path to absolute", () => {
  const repoDir = "/Users/john/repo";
  const relativePath = ".swamp/outputs/aws/cli/run.log";

  const result = toAbsolutePath(repoDir, relativePath);

  assertPathEquals(result, "/Users/john/repo/.swamp/outputs/aws/cli/run.log");
});

Deno.test("toAbsolutePath - returns already absolute path unchanged (backwards compat)", () => {
  const repoDir = "/Users/john/repo";
  const absolutePath = "/Users/john/repo/.swamp/outputs/aws/cli/run.log";

  const result = toAbsolutePath(repoDir, absolutePath);

  assertEquals(result, "/Users/john/repo/.swamp/outputs/aws/cli/run.log");
});

Deno.test("toAbsolutePath - handles different repo directory", () => {
  const repoDir = "/home/alice/projects/infra";
  const relativePath = ".swamp/workflow-runs/my-workflow/run.yaml";

  const result = toAbsolutePath(repoDir, relativePath);

  assertPathEquals(
    result,
    "/home/alice/projects/infra/.swamp/workflow-runs/my-workflow/run.yaml",
  );
});

Deno.test("toRelativePath and toAbsolutePath - round trip", () => {
  const repoDir = "/Users/john/repo";
  const originalAbsolute = "/Users/john/repo/.swamp/outputs/test.log";

  const relative = toRelativePath(repoDir, originalAbsolute);
  const backToAbsolute = toAbsolutePath(repoDir, relative);

  assertPathEquals(backToAbsolute, originalAbsolute);
});

Deno.test("getSwampConfigDir uses XDG_CONFIG_HOME when set", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    XDG_CONFIG_HOME: "/custom/config",
  }, () => {
    assertPathEquals(getSwampConfigDir(), "/custom/config/swamp");
  });
});

Deno.test("getSwampConfigDir falls back to HOME/.config/swamp", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    HOME: "/home/testuser",
  }, () => {
    assertPathEquals(getSwampConfigDir(), "/home/testuser/.config/swamp");
  });
});

Deno.test("getSwampConfigDir falls back to USERPROFILE/.config/swamp", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    HOME: undefined,
    USERPROFILE: "C:\\Users\\testuser",
  }, () => {
    assertPathEquals(
      getSwampConfigDir(),
      "C:\\Users\\testuser/.config/swamp",
    );
  });
});

Deno.test("getSwampConfigDir throws when no home environment variable is set", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    HOME: undefined,
    USERPROFILE: undefined,
  }, () => {
    assertThrows(
      () => getSwampConfigDir(),
      Error,
      "Cannot determine config directory: neither HOME nor USERPROFILE is set",
    );
  });
});

Deno.test("globalTelemetryDir is the telemetry subdir under the config dir", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    XDG_CONFIG_HOME: "/custom/config",
  }, () => {
    assertPathEquals(globalTelemetryDir(), "/custom/config/swamp/telemetry");
  });
});

Deno.test("globalTelemetryDir falls back to HOME/.config/swamp/telemetry", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    HOME: "/home/testuser",
  }, () => {
    assertPathEquals(
      globalTelemetryDir(),
      "/home/testuser/.config/swamp/telemetry",
    );
  });
});

Deno.test("getSwampDataDir: SWAMP_HOME takes precedence over HOME", () => {
  withMockedEnv({ SWAMP_HOME: "/opt/swamp", HOME: "/home/testuser" }, () => {
    assertEquals(getSwampDataDir(), "/opt/swamp");
  });
});

Deno.test("getSwampDataDir: SWAMP_HOME set, HOME unset succeeds", () => {
  withMockedEnv({
    SWAMP_HOME: "/opt/swamp",
    HOME: undefined,
    USERPROFILE: undefined,
  }, () => {
    assertEquals(getSwampDataDir(), "/opt/swamp");
  });
});

Deno.test("getSwampDataDir: falls back to HOME/.swamp when SWAMP_HOME unset", () => {
  withMockedEnv({ SWAMP_HOME: undefined, HOME: "/home/testuser" }, () => {
    assertPathEquals(getSwampDataDir(), "/home/testuser/.swamp");
  });
});

Deno.test("getSwampDataDir: falls back to USERPROFILE/.swamp", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    HOME: undefined,
    USERPROFILE: "C:\\Users\\testuser",
  }, () => {
    assertPathEquals(getSwampDataDir(), "C:\\Users\\testuser/.swamp");
  });
});

Deno.test("getSwampDataDir: throws when no env var is set", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    HOME: undefined,
    USERPROFILE: undefined,
  }, () => {
    assertThrows(
      () => getSwampDataDir(),
      Error,
      "Cannot determine home directory",
    );
  });
});

Deno.test("getSwampConfigDir: SWAMP_HOME takes precedence over XDG and HOME", () => {
  withMockedEnv({
    SWAMP_HOME: "/opt/swamp",
    XDG_CONFIG_HOME: "/custom/config",
    HOME: "/home/testuser",
  }, () => {
    assertPathEquals(getSwampConfigDir(), "/opt/swamp/config");
  });
});

Deno.test("getSwampConfigDir: SWAMP_HOME set, HOME unset succeeds", () => {
  withMockedEnv({
    SWAMP_HOME: "/opt/swamp",
    XDG_CONFIG_HOME: undefined,
    HOME: undefined,
  }, () => {
    assertPathEquals(getSwampConfigDir(), "/opt/swamp/config");
  });
});

Deno.test("homeDirectoryIsSet: true when only SWAMP_HOME is set", () => {
  withMockedEnv({
    SWAMP_HOME: "/opt/swamp",
    HOME: undefined,
    USERPROFILE: undefined,
  }, () => {
    assertEquals(homeDirectoryIsSet(), true);
  });
});

Deno.test("homeDirectory: returns HOME when set", () => {
  // Set USERPROFILE too — HOME must take precedence on every OS so
  // POSIX behavior is consistent regardless of stray Windows-style env
  // vars in the inherited environment.
  withMockedEnv({
    HOME: "/home/testuser",
    USERPROFILE: "C:\\Users\\other",
  }, () => {
    assertEquals(homeDirectory(), "/home/testuser");
  });
});

Deno.test("homeDirectory: falls back to USERPROFILE when HOME is unset", () => {
  withMockedEnv({ HOME: undefined, USERPROFILE: "C:\\Users\\testuser" }, () => {
    assertEquals(homeDirectory(), "C:\\Users\\testuser");
  });
});

Deno.test("homeDirectory: throws when neither HOME nor USERPROFILE is set", () => {
  withMockedEnv({ HOME: undefined, USERPROFILE: undefined }, () => {
    assertThrows(
      () => homeDirectory(),
      Error,
      "Cannot determine home directory: neither HOME nor USERPROFILE is set",
    );
  });
});

Deno.test("homeDirectoryIsSet: true when HOME is set", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    HOME: "/home/testuser",
    USERPROFILE: undefined,
  }, () => {
    assertEquals(homeDirectoryIsSet(), true);
  });
});

Deno.test("homeDirectoryIsSet: true when only USERPROFILE is set", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    HOME: undefined,
    USERPROFILE: "C:\\Users\\testuser",
  }, () => {
    assertEquals(homeDirectoryIsSet(), true);
  });
});

Deno.test("homeDirectoryIsSet: false when no env var is set", () => {
  withMockedEnv({
    SWAMP_HOME: undefined,
    HOME: undefined,
    USERPROFILE: undefined,
  }, () => {
    assertEquals(homeDirectoryIsSet(), false);
  });
});

Deno.test("bundleNamespace: same relative relationship produces same hash", () => {
  // Simulates /var/... vs /private/var/... — different absolute prefixes,
  // same relative relationship
  const hash1 = bundleNamespace(
    "/var/tmp/repo/.swamp/pulled-extensions/models",
    "/var/tmp/repo",
  );
  const hash2 = bundleNamespace(
    "/private/var/tmp/repo/.swamp/pulled-extensions/models",
    "/private/var/tmp/repo",
  );
  assertEquals(hash1, hash2);
});

Deno.test("bundleNamespace: different base dirs produce different hashes", () => {
  const local = bundleNamespace("/repo/extensions/models", "/repo");
  const pulled = bundleNamespace(
    "/repo/.swamp/pulled-extensions/models",
    "/repo",
  );
  assertEquals(local !== pulled, true);
});

Deno.test("bundleNamespace: returns 8-char hex string", () => {
  const hash = bundleNamespace("/repo/extensions/models", "/repo");
  assertEquals(hash.length, 8);
  assertEquals(/^[0-9a-f]{8}$/.test(hash), true);
});

// --- registerManagedConfig / isManagedConfig ---

Deno.test("registerManagedConfig: throws on active with no configBasePath", () => {
  assertThrows(
    () => registerManagedConfig("/repo/throw-test-1", true),
    Error,
    "active is true but configBasePath is missing",
  );
});

Deno.test("registerManagedConfig: throws on active with undefined configBasePath", () => {
  assertThrows(
    () => registerManagedConfig("/repo/throw-test-2", true, undefined),
    Error,
    "active is true but configBasePath is missing",
  );
});

Deno.test("isManagedConfig: returns false when registry has no entry", () => {
  assertEquals(isManagedConfig("/repo/unregistered-test-1"), false);
});

Deno.test("isManagedConfig: returns false when registered as inactive", () => {
  registerManagedConfig("/repo/inactive-test-1", false);
  assertEquals(isManagedConfig("/repo/inactive-test-1"), false);
});

Deno.test("isManagedConfig: returns true when registered as active", () => {
  registerManagedConfig(
    "/repo/active-test-1",
    true,
    "/repo/active-test-1/.swamp/config",
  );
  assertEquals(isManagedConfig("/repo/active-test-1"), true);
});

// --- managed config provenance (swamp-club#2483) ---

Deno.test("registerManagedConfig: defaults to a resolved base", () => {
  const repo = `/repo/provenance-${crypto.randomUUID()}`;
  registerManagedConfig(repo, true, "/cache/ns/config");
  assertEquals(isManagedConfigBaseResolved(repo), true);
  assertEquals(getManagedConfigBase(repo), "/cache/ns/config");
});

Deno.test("registerManagedConfig: a fallback registration is recorded as unresolved", () => {
  const repo = `/repo/provenance-${crypto.randomUUID()}`;
  registerManagedConfig(repo, true, `${repo}/.swamp/config`, false);
  assertEquals(isManagedConfig(repo), true);
  assertEquals(isManagedConfigBaseResolved(repo), false);
  assertEquals(getManagedConfigBase(repo), `${repo}/.swamp/config`);
});

Deno.test("registerManagedConfig: a fallback never overwrites a resolved base", () => {
  const repo = `/repo/provenance-${crypto.randomUUID()}`;
  registerManagedConfig(repo, true, "/cache/ns/config", true);
  registerManagedConfig(repo, true, `${repo}/.swamp/config`, false);
  assertEquals(getManagedConfigBase(repo), "/cache/ns/config");
  assertEquals(isManagedConfigBaseResolved(repo), true);
});

Deno.test("registerManagedConfig: a resolved base replaces a fallback", () => {
  const repo = `/repo/provenance-${crypto.randomUUID()}`;
  registerManagedConfig(repo, true, `${repo}/.swamp/config`, false);
  registerManagedConfig(repo, true, "/cache/ns/config", true);
  assertEquals(getManagedConfigBase(repo), "/cache/ns/config");
  assertEquals(isManagedConfigBaseResolved(repo), true);
});

Deno.test("isManagedConfigBaseResolved: false for unregistered and inactive repos", () => {
  const unregistered = `/repo/provenance-${crypto.randomUUID()}`;
  assertEquals(isManagedConfigBaseResolved(unregistered), false);
  const inactive = `/repo/provenance-${crypto.randomUUID()}`;
  registerManagedConfig(inactive, false);
  assertEquals(isManagedConfigBaseResolved(inactive), false);
});

Deno.test("resolveManagedConfigOnce: runs concurrent callers once and caches success", async () => {
  const repo = `/repo/memo-${crypto.randomUUID()}`;
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => release = r);
  const resolveOnce = async () => {
    calls++;
    await gate;
    return true;
  };
  const first = resolveManagedConfigOnce(repo, resolveOnce);
  const second = resolveManagedConfigOnce(repo, resolveOnce);
  release();
  assertEquals(await first, true);
  assertEquals(await second, true);
  assertEquals(await resolveManagedConfigOnce(repo, resolveOnce), true);
  assertEquals(calls, 1);
});

Deno.test("resolveManagedConfigOnce: does not cache an unresolved outcome", async () => {
  const repo = `/repo/memo-${crypto.randomUUID()}`;
  let calls = 0;
  const resolveOnce = () => {
    calls++;
    return Promise.resolve(calls > 1);
  };
  assertEquals(await resolveManagedConfigOnce(repo, resolveOnce), false);
  assertEquals(await resolveManagedConfigOnce(repo, resolveOnce), true);
  assertEquals(calls, 2);
});

Deno.test("resolveManagedConfigOnce: does not cache a thrown error", async () => {
  const repo = `/repo/memo-${crypto.randomUUID()}`;
  let calls = 0;
  const resolveOnce = () => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error("boom"))
      : Promise.resolve(true);
  };
  await assertRejects(() => resolveManagedConfigOnce(repo, resolveOnce));
  assertEquals(await resolveManagedConfigOnce(repo, resolveOnce), true);
  assertEquals(calls, 2);
});

Deno.test("resetManagedConfigRegistry: clears registrations and the memo", async () => {
  const repo = `/repo/reset-${crypto.randomUUID()}`;
  registerManagedConfig(repo, true, "/cache/ns/config");
  let calls = 0;
  const resolveOnce = () => {
    calls++;
    return Promise.resolve(true);
  };
  await resolveManagedConfigOnce(repo, resolveOnce);
  resetManagedConfigRegistry();
  assertEquals(isManagedConfig(repo), false);
  await resolveManagedConfigOnce(repo, resolveOnce);
  assertEquals(calls, 2);
});

// --- resolvePulledExtensionsRoot / managedConfigLockfilePath ---

Deno.test("resolvePulledExtensionsRoot: unregistered returns .swamp/pulled-extensions", () => {
  assertPathEquals(
    resolvePulledExtensionsRoot("/repo/unregistered-test-2"),
    "/repo/unregistered-test-2/.swamp/pulled-extensions",
  );
});

Deno.test("resolvePulledExtensionsRoot: inactive returns .swamp/pulled-extensions", () => {
  registerManagedConfig("/repo/inactive-test-2", false);
  assertPathEquals(
    resolvePulledExtensionsRoot("/repo/inactive-test-2"),
    "/repo/inactive-test-2/.swamp/pulled-extensions",
  );
});

Deno.test("resolvePulledExtensionsRoot: active returns .swamp/config/pulled-extensions", () => {
  registerManagedConfig(
    "/repo/active-test-2",
    true,
    "/repo/active-test-2/.swamp/config",
  );
  assertPathEquals(
    resolvePulledExtensionsRoot("/repo/active-test-2"),
    "/repo/active-test-2/.swamp/config/pulled-extensions",
  );
});

// Pulled sources are not synced to the datastore tier (swamp-club#2429), so
// unlike definitions, workflows and vaults they never follow a managed config
// base that points outside the repo (swamp-club#2530).
Deno.test("resolvePulledExtensionsRoot: stays in the repo when the base is a datastore cache", () => {
  const repo = `/repo/cache-base-${crypto.randomUUID()}`;
  registerManagedConfig(repo, true, "/cache/ns/config");
  assertPathEquals(
    resolvePulledExtensionsRoot(repo),
    `${repo}/.swamp/config/pulled-extensions`,
  );
});

Deno.test("managedConfigLockfilePath: returns .swamp/config/upstream_extensions.json", () => {
  assertPathEquals(
    managedConfigLockfilePath("/repo"),
    "/repo/.swamp/config/upstream_extensions.json",
  );
});
