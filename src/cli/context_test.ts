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

import { assertEquals } from "@std/assert";
import { isAbsolute, resolve } from "@std/path";
import { join } from "@std/path";
import {
  createContext,
  findAncestorRepoDir,
  getExtensionsDirFromArgs,
  getOutputModeFromArgs,
  getRepoDirFromArgs,
  type GlobalOptions,
  resolveExtensionsDir,
  resolveRepoDir,
  resolveTraceparent,
  resolveTracestate,
} from "./context.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { assertPathEquals } from "../infrastructure/persistence/path_test_helpers.ts";
import { SWAMP_MARKER_FILE } from "../infrastructure/persistence/paths.ts";

// Initialize logging once before tests run
await initializeLogging({});

Deno.test("createContext returns log mode by default", () => {
  const options: GlobalOptions = {};
  const context = createContext(options);
  assertEquals(context.outputMode, "log");
});

Deno.test("createContext returns json mode when json option is true", () => {
  const options: GlobalOptions = { json: true };
  const context = createContext(options);
  assertEquals(context.outputMode, "json");
});

Deno.test("createContext returns normal verbosity by default", () => {
  const options: GlobalOptions = {};
  const context = createContext(options);
  assertEquals(context.verbosity, "normal");
});

Deno.test("createContext returns quiet verbosity when quiet option is true", () => {
  const options: GlobalOptions = { quiet: true };
  const context = createContext(options);
  assertEquals(context.verbosity, "quiet");
});

Deno.test("createContext returns verbose verbosity when verbose option is true", () => {
  const options: GlobalOptions = { verbose: true };
  const context = createContext(options);
  assertEquals(context.verbosity, "verbose");
});

Deno.test("createContext prefers quiet over verbose when both are true", () => {
  const options: GlobalOptions = { quiet: true, verbose: true };
  const context = createContext(options);
  assertEquals(context.verbosity, "quiet");
});

Deno.test("createContext returns a logger object", () => {
  const options: GlobalOptions = {};
  const context = createContext(options);
  assertEquals(typeof context.logger, "object");
  assertEquals(typeof context.logger.info, "function");
});

Deno.test("createContext uses custom logger name when provided", () => {
  const options: GlobalOptions = {};
  const context = createContext(options, ["custom", "logger"]);
  // Logger is created - we can verify it exists and has expected methods
  assertEquals(typeof context.logger.debug, "function");
  assertEquals(typeof context.logger.error, "function");
});

Deno.test("getOutputModeFromArgs returns log by default", () => {
  assertEquals(getOutputModeFromArgs([]), "log");
  assertEquals(getOutputModeFromArgs(["model", "create"]), "log");
});

Deno.test("getOutputModeFromArgs returns json when --json is present", () => {
  assertEquals(getOutputModeFromArgs(["--json"]), "json");
  assertEquals(getOutputModeFromArgs(["model", "create", "--json"]), "json");
  assertEquals(getOutputModeFromArgs(["--json", "model", "create"]), "json");
});

// ============================================================================
// getRepoDirFromArgs Tests
// ============================================================================

Deno.test("getRepoDirFromArgs returns cwd when no --repo-dir flag", () => {
  assertEquals(getRepoDirFromArgs([]), Deno.cwd());
  assertEquals(getRepoDirFromArgs(["model", "create"]), Deno.cwd());
});

Deno.test("getRepoDirFromArgs parses --repo-dir with space separator", () => {
  const result = getRepoDirFromArgs([
    "model",
    "run",
    "--repo-dir",
    "/tmp/my-repo",
  ]);
  // getRepoDirFromArgs calls resolve() — on Windows, /tmp/my-repo becomes
  // C:\tmp\my-repo, so the expected value must also go through resolve().
  assertPathEquals(result, resolve("/tmp/my-repo"));
});

Deno.test("getRepoDirFromArgs parses --repo-dir with equals separator", () => {
  const result = getRepoDirFromArgs([
    "model",
    "run",
    "--repo-dir=/tmp/my-repo",
  ]);
  assertPathEquals(result, resolve("/tmp/my-repo"));
});

Deno.test("getRepoDirFromArgs resolves relative paths to absolute", () => {
  const result = getRepoDirFromArgs(["--repo-dir", "./relative/path"]);
  assertEquals(isAbsolute(result), true);
  assertEquals(result.replaceAll("\\", "/").endsWith("relative/path"), true);
});

Deno.test("getRepoDirFromArgs returns cwd when --repo-dir is last arg with no value", () => {
  assertEquals(getRepoDirFromArgs(["model", "run", "--repo-dir"]), Deno.cwd());
});

Deno.test("getRepoDirFromArgs finds flag among other args", () => {
  const result = getRepoDirFromArgs([
    "model",
    "method",
    "run",
    "--json",
    "--repo-dir",
    "/tmp/my-repo",
    "my-model",
    "my-method",
  ]);
  assertPathEquals(result, resolve("/tmp/my-repo"));
});

Deno.test("getRepoDirFromArgs uses SWAMP_REPO_DIR when flag absent", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "/tmp/env-repo");
    assertPathEquals(getRepoDirFromArgs([]), resolve("/tmp/env-repo"));
    assertPathEquals(
      getRepoDirFromArgs(["model", "create"]),
      resolve("/tmp/env-repo"),
    );
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

Deno.test("getRepoDirFromArgs prefers --repo-dir flag over SWAMP_REPO_DIR", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "/tmp/env-repo");
    const result = getRepoDirFromArgs(["--repo-dir", "/tmp/flag-repo"]);
    assertPathEquals(result, resolve("/tmp/flag-repo"));
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

Deno.test("getRepoDirFromArgs ignores empty SWAMP_REPO_DIR and falls back to cwd", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "");
    assertEquals(getRepoDirFromArgs([]), Deno.cwd());
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

Deno.test("getRepoDirFromArgs resolves SWAMP_REPO_DIR to absolute path", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "./relative/env/path");
    const result = getRepoDirFromArgs([]);
    assertEquals(isAbsolute(result), true);
    assertEquals(
      result.replaceAll("\\", "/").endsWith("relative/env/path"),
      true,
    );
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

// ============================================================================
// resolveRepoDir Tests
// ============================================================================

Deno.test("resolveRepoDir returns cli value when provided", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "/tmp/env-repo");
    assertPathEquals(
      resolveRepoDir("/tmp/flag-repo"),
      resolve("/tmp/flag-repo"),
    );
    // explicit "." from flag resolves to absolute cwd
    assertPathEquals(resolveRepoDir("."), resolve("."));
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

Deno.test("resolveRepoDir returns SWAMP_REPO_DIR when cli value undefined", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "/tmp/env-repo");
    assertPathEquals(resolveRepoDir(undefined), resolve("/tmp/env-repo"));
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

Deno.test("resolveRepoDir returns absolute cwd when neither cli value nor env var set", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.delete("SWAMP_REPO_DIR");
    const result = resolveRepoDir(undefined);
    assertEquals(isAbsolute(result), true);
    assertPathEquals(result, Deno.cwd());
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
  }
});

Deno.test("resolveRepoDir treats empty SWAMP_REPO_DIR as unset", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "");
    const result = resolveRepoDir(undefined);
    assertEquals(isAbsolute(result), true);
    assertPathEquals(result, Deno.cwd());
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

// ============================================================================
// findAncestorRepoDir Tests
// ============================================================================

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-context-" });
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

Deno.test("findAncestorRepoDir: returns dir when marker exists at startDir", async () => {
  await withTempDir(async (dir) => {
    const realDir = Deno.realPathSync(dir);
    await Deno.writeTextFile(join(dir, SWAMP_MARKER_FILE), "swampVersion: 1");
    const result = findAncestorRepoDir(dir);
    assertPathEquals(result!, realDir);
  });
});

Deno.test("findAncestorRepoDir: finds marker in parent directory", async () => {
  await withTempDir(async (dir) => {
    const realDir = Deno.realPathSync(dir);
    await Deno.writeTextFile(join(dir, SWAMP_MARKER_FILE), "swampVersion: 1");
    const subdir = join(dir, "models");
    await Deno.mkdir(subdir);
    const result = findAncestorRepoDir(subdir);
    assertPathEquals(result!, realDir);
  });
});

Deno.test("findAncestorRepoDir: finds marker in grandparent directory", async () => {
  await withTempDir(async (dir) => {
    const realDir = Deno.realPathSync(dir);
    await Deno.writeTextFile(join(dir, SWAMP_MARKER_FILE), "swampVersion: 1");
    const nested = join(dir, "models", "my-type");
    await Deno.mkdir(nested, { recursive: true });
    const result = findAncestorRepoDir(nested);
    assertPathEquals(result!, realDir);
  });
});

Deno.test("findAncestorRepoDir: returns null when no marker in any ancestor", async () => {
  await withTempDir(async (dir) => {
    const subdir = join(dir, "some", "path");
    await Deno.mkdir(subdir, { recursive: true });
    const result = findAncestorRepoDir(subdir);
    assertEquals(result, null);
  });
});

Deno.test("findAncestorRepoDir: stops at git root and does not traverse above it", async () => {
  await withTempDir(async (dir) => {
    // Create a .swamp.yaml ABOVE the git root — should not be found
    await Deno.writeTextFile(join(dir, SWAMP_MARKER_FILE), "swampVersion: 1");

    // Create a git repo in a subdirectory
    const gitRepo = join(dir, "git-project");
    await Deno.mkdir(gitRepo);
    const gitInit = new Deno.Command("git", {
      args: ["init"],
      cwd: gitRepo,
      stdout: "null",
      stderr: "null",
    });
    const result = await gitInit.output();
    if (!result.success) {
      // git not available — skip this test
      return;
    }

    const subdir = join(gitRepo, "src");
    await Deno.mkdir(subdir);

    const found = findAncestorRepoDir(subdir);
    assertEquals(found, null);
  });
});

Deno.test("findAncestorRepoDir: finds marker inside git root", async () => {
  await withTempDir(async (dir) => {
    const realDir = Deno.realPathSync(dir);
    const gitInit = new Deno.Command("git", {
      args: ["init"],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    });
    const result = await gitInit.output();
    if (!result.success) {
      return;
    }

    await Deno.writeTextFile(join(dir, SWAMP_MARKER_FILE), "swampVersion: 1");
    const subdir = join(dir, "models", "my-type");
    await Deno.mkdir(subdir, { recursive: true });

    const found = findAncestorRepoDir(subdir);
    assertPathEquals(found!, realDir);
  });
});

// ============================================================================
// getExtensionsDirFromArgs Tests
// ============================================================================

Deno.test("getExtensionsDirFromArgs: returns undefined when no flag or env var", () => {
  const original = Deno.env.get("SWAMP_EXTENSIONS_DIR");
  try {
    Deno.env.delete("SWAMP_EXTENSIONS_DIR");
    assertEquals(getExtensionsDirFromArgs([]), undefined);
    assertEquals(getExtensionsDirFromArgs(["model", "create"]), undefined);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_EXTENSIONS_DIR", original);
    }
  }
});

Deno.test("getExtensionsDirFromArgs: parses --extensions-dir with space separator", () => {
  const result = getExtensionsDirFromArgs([
    "--extensions-dir",
    "/tmp/my-extensions",
  ]);
  assertPathEquals(result!, resolve("/tmp/my-extensions"));
});

Deno.test("getExtensionsDirFromArgs: parses --extensions-dir with equals separator", () => {
  const result = getExtensionsDirFromArgs([
    "--extensions-dir=/tmp/my-extensions",
  ]);
  assertPathEquals(result!, resolve("/tmp/my-extensions"));
});

Deno.test("getExtensionsDirFromArgs: resolves relative paths to absolute", () => {
  const result = getExtensionsDirFromArgs(["--extensions-dir", "./relative"]);
  assertEquals(isAbsolute(result!), true);
  assertPathEquals(result!, resolve("./relative"));
});

Deno.test("getExtensionsDirFromArgs: uses SWAMP_EXTENSIONS_DIR when flag absent", () => {
  const original = Deno.env.get("SWAMP_EXTENSIONS_DIR");
  try {
    Deno.env.set("SWAMP_EXTENSIONS_DIR", "/tmp/env-ext");
    assertPathEquals(getExtensionsDirFromArgs([])!, resolve("/tmp/env-ext"));
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_EXTENSIONS_DIR", original);
    } else Deno.env.delete("SWAMP_EXTENSIONS_DIR");
  }
});

Deno.test("getExtensionsDirFromArgs: prefers flag over env var", () => {
  const original = Deno.env.get("SWAMP_EXTENSIONS_DIR");
  try {
    Deno.env.set("SWAMP_EXTENSIONS_DIR", "/tmp/env-ext");
    const result = getExtensionsDirFromArgs([
      "--extensions-dir",
      "/tmp/flag-ext",
    ]);
    assertPathEquals(result!, resolve("/tmp/flag-ext"));
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_EXTENSIONS_DIR", original);
    } else Deno.env.delete("SWAMP_EXTENSIONS_DIR");
  }
});

Deno.test("getExtensionsDirFromArgs: ignores empty env var", () => {
  const original = Deno.env.get("SWAMP_EXTENSIONS_DIR");
  try {
    Deno.env.set("SWAMP_EXTENSIONS_DIR", "");
    assertEquals(getExtensionsDirFromArgs([]), undefined);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_EXTENSIONS_DIR", original);
    } else Deno.env.delete("SWAMP_EXTENSIONS_DIR");
  }
});

// ============================================================================
// resolveExtensionsDir Tests
// ============================================================================

Deno.test("resolveExtensionsDir: returns resolved cli value when provided", () => {
  assertPathEquals(
    resolveExtensionsDir("/tmp/flag-ext")!,
    resolve("/tmp/flag-ext"),
  );
});

Deno.test("resolveExtensionsDir: returns env var when cli value undefined", () => {
  const original = Deno.env.get("SWAMP_EXTENSIONS_DIR");
  try {
    Deno.env.set("SWAMP_EXTENSIONS_DIR", "/tmp/env-ext");
    assertPathEquals(resolveExtensionsDir(undefined)!, resolve("/tmp/env-ext"));
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_EXTENSIONS_DIR", original);
    } else Deno.env.delete("SWAMP_EXTENSIONS_DIR");
  }
});

Deno.test("resolveExtensionsDir: returns undefined when neither set", () => {
  const original = Deno.env.get("SWAMP_EXTENSIONS_DIR");
  try {
    Deno.env.delete("SWAMP_EXTENSIONS_DIR");
    assertEquals(resolveExtensionsDir(undefined), undefined);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_EXTENSIONS_DIR", original);
    }
  }
});

// ============================================================================
// forceLog Tests
// ============================================================================

Deno.test("createContext: forceLog defaults to false", () => {
  const ctx = createContext({});
  assertEquals(ctx.forceLog, false);
});

Deno.test("createContext: log=true sets forceLog", () => {
  const ctx = createContext({ log: true });
  assertEquals(ctx.forceLog, true);
  assertEquals(ctx.outputMode, "log");
});

Deno.test("createContext: log and json can both be set", () => {
  const ctx = createContext({ json: true, log: true });
  assertEquals(ctx.outputMode, "json");
  assertEquals(ctx.forceLog, true);
});

// ============================================================================
// resolveTraceparent Tests
// ============================================================================

Deno.test("resolveTraceparent: returns cli value when provided", () => {
  const original = Deno.env.get("TRACEPARENT");
  try {
    Deno.env.set("TRACEPARENT", "00-env-trace-id-env-span-01");
    assertEquals(
      resolveTraceparent("00-cli-trace-id-cli-span-01"),
      "00-cli-trace-id-cli-span-01",
    );
  } finally {
    if (original !== undefined) Deno.env.set("TRACEPARENT", original);
    else Deno.env.delete("TRACEPARENT");
  }
});

Deno.test("resolveTraceparent: returns TRACEPARENT env var when cli value undefined", () => {
  const original = Deno.env.get("TRACEPARENT");
  try {
    Deno.env.set("TRACEPARENT", "00-env-trace-id-env-span-01");
    assertEquals(
      resolveTraceparent(undefined),
      "00-env-trace-id-env-span-01",
    );
  } finally {
    if (original !== undefined) Deno.env.set("TRACEPARENT", original);
    else Deno.env.delete("TRACEPARENT");
  }
});

Deno.test("resolveTraceparent: returns undefined when neither cli nor env set", () => {
  const original = Deno.env.get("TRACEPARENT");
  try {
    Deno.env.delete("TRACEPARENT");
    assertEquals(resolveTraceparent(undefined), undefined);
  } finally {
    if (original !== undefined) Deno.env.set("TRACEPARENT", original);
  }
});

Deno.test("resolveTraceparent: returns undefined for empty TRACEPARENT env var", () => {
  const original = Deno.env.get("TRACEPARENT");
  try {
    Deno.env.set("TRACEPARENT", "");
    assertEquals(resolveTraceparent(undefined), undefined);
  } finally {
    if (original !== undefined) Deno.env.set("TRACEPARENT", original);
    else Deno.env.delete("TRACEPARENT");
  }
});

// ============================================================================
// resolveTracestate Tests
// ============================================================================

Deno.test("resolveTracestate: returns cli value when provided", () => {
  const original = Deno.env.get("TRACESTATE");
  try {
    Deno.env.set("TRACESTATE", "vendor=env-value");
    assertEquals(resolveTracestate("vendor=cli-value"), "vendor=cli-value");
  } finally {
    if (original !== undefined) Deno.env.set("TRACESTATE", original);
    else Deno.env.delete("TRACESTATE");
  }
});

Deno.test("resolveTracestate: returns TRACESTATE env var when cli value undefined", () => {
  const original = Deno.env.get("TRACESTATE");
  try {
    Deno.env.set("TRACESTATE", "vendor=env-value");
    assertEquals(resolveTracestate(undefined), "vendor=env-value");
  } finally {
    if (original !== undefined) Deno.env.set("TRACESTATE", original);
    else Deno.env.delete("TRACESTATE");
  }
});

Deno.test("resolveTracestate: returns undefined when neither cli nor env set", () => {
  const original = Deno.env.get("TRACESTATE");
  try {
    Deno.env.delete("TRACESTATE");
    assertEquals(resolveTracestate(undefined), undefined);
  } finally {
    if (original !== undefined) Deno.env.set("TRACESTATE", original);
  }
});
