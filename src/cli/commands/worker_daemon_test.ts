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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { resolve } from "@std/path";
import {
  collectWorkerEnv,
  collectWorkerExtraArgs,
  validateCacheDir,
} from "./worker_daemon.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("collectWorkerExtraArgs: includes data-plane-url when provided", () => {
  const args = collectWorkerExtraArgs({
    dataPlaneUrl: "https://dp.internal",
  });
  assertEquals(args, ["--data-plane-url", "https://dp.internal"]);
});

Deno.test("collectWorkerExtraArgs: includes no-reconnect when false", () => {
  const args = collectWorkerExtraArgs({ reconnect: false });
  assertEquals(args, ["--no-reconnect"]);
});

Deno.test("collectWorkerExtraArgs: returns empty when no relevant options", () => {
  const args = collectWorkerExtraArgs({});
  assertEquals(args, []);
});

Deno.test("collectWorkerExtraArgs: combines multiple options", () => {
  const args = collectWorkerExtraArgs({
    dataPlaneUrl: "https://dp.internal",
    reconnect: false,
  });
  assertEquals(args, [
    "--data-plane-url",
    "https://dp.internal",
    "--no-reconnect",
  ]);
});

Deno.test("collectWorkerEnv: includes SWAMP_SERVER_TOKEN when provided", () => {
  const env = collectWorkerEnv({
    url: "wss://orch:9090",
    token: "tok.secret",
    serverToken: "admin.secret",
  });
  assertEquals(env["SWAMP_SERVER_TOKEN"], "admin.secret");
  assertEquals(env["SWAMP_WORKER_TOKEN"], "tok.secret");
  assertEquals(env["SWAMP_ORCHESTRATOR_URL"], "wss://orch:9090");
});

Deno.test("collectWorkerEnv: omits SWAMP_SERVER_TOKEN when not provided", () => {
  const env = collectWorkerEnv({
    url: "wss://orch:9090",
    token: "tok.secret",
  });
  assertEquals(env["SWAMP_SERVER_TOKEN"], undefined);
  assertEquals(env["SWAMP_WORKER_TOKEN"], "tok.secret");
});

Deno.test("collectWorkerEnv: returns empty when no options", () => {
  const env = collectWorkerEnv({});
  assertEquals(Object.keys(env).length, 0);
});

Deno.test("validateCacheDir: rejects non-existent absolute path", async () => {
  const err = await assertRejects(
    () => validateCacheDir("/tmp/swamp-nonexistent-dir-abc123"),
    UserError,
  );
  assertStringIncludes(err.message, "--cache-dir does not exist");
  assertStringIncludes(err.message, "mkdir -p");
});

Deno.test("validateCacheDir: resolves relative path and rejects if missing", async () => {
  const err = await assertRejects(
    () => validateCacheDir("./nonexistent-relative-dir-abc123"),
    UserError,
  );
  assertStringIncludes(err.message, "--cache-dir does not exist");
  const expected = resolve("./nonexistent-relative-dir-abc123");
  assertStringIncludes(err.message, expected);
});

Deno.test("validateCacheDir: accepts existing directory and returns absolute path", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cache-" });
  try {
    const result = await validateCacheDir(tmpDir);
    assertEquals(result, tmpDir);
  } finally {
    await Deno.remove(tmpDir).catch(() => {});
  }
});

Deno.test("validateCacheDir: rejects path that is a file, not a directory", async () => {
  const tmpFile = await Deno.makeTempFile({ prefix: "swamp-test-cache-" });
  try {
    const err = await assertRejects(
      () => validateCacheDir(tmpFile),
      UserError,
    );
    assertStringIncludes(err.message, "--cache-dir is not a directory");
    assertStringIncludes(err.message, "mkdir -p");
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
});
