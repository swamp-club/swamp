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

import { assertEquals } from "@std/assert";
import {
  createContext,
  getOutputModeFromArgs,
  getRepoDirFromArgs,
  type GlobalOptions,
  resolveRepoDir,
} from "./context.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

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
  assertEquals(result, "/tmp/my-repo");
});

Deno.test("getRepoDirFromArgs parses --repo-dir with equals separator", () => {
  const result = getRepoDirFromArgs([
    "model",
    "run",
    "--repo-dir=/tmp/my-repo",
  ]);
  assertEquals(result, "/tmp/my-repo");
});

Deno.test("getRepoDirFromArgs resolves relative paths to absolute", () => {
  const result = getRepoDirFromArgs(["--repo-dir", "./relative/path"]);
  assertEquals(result.startsWith("/"), true);
  assertEquals(result.endsWith("relative/path"), true);
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
  assertEquals(result, "/tmp/my-repo");
});

Deno.test("getRepoDirFromArgs uses SWAMP_REPO_DIR when flag absent", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "/tmp/env-repo");
    assertEquals(getRepoDirFromArgs([]), "/tmp/env-repo");
    assertEquals(getRepoDirFromArgs(["model", "create"]), "/tmp/env-repo");
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
    assertEquals(result, "/tmp/flag-repo");
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
    assertEquals(result.startsWith("/"), true);
    assertEquals(result.endsWith("relative/env/path"), true);
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
    assertEquals(resolveRepoDir("/tmp/flag-repo"), "/tmp/flag-repo");
    // explicit "." from flag should win over env var
    assertEquals(resolveRepoDir("."), ".");
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

Deno.test("resolveRepoDir returns SWAMP_REPO_DIR when cli value undefined", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "/tmp/env-repo");
    assertEquals(resolveRepoDir(undefined), "/tmp/env-repo");
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
  }
});

Deno.test('resolveRepoDir returns "." when neither cli value nor env var set', () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.delete("SWAMP_REPO_DIR");
    assertEquals(resolveRepoDir(undefined), ".");
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
  }
});

Deno.test("resolveRepoDir treats empty SWAMP_REPO_DIR as unset", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "");
    assertEquals(resolveRepoDir(undefined), ".");
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
    else Deno.env.delete("SWAMP_REPO_DIR");
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
