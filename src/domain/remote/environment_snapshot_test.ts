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
import {
  captureEnvironmentSnapshot,
  isDeniedEnvVar,
  overlayEnvironment,
  stripWorkerCredentials,
} from "./environment_snapshot.ts";

Deno.test("isDeniedEnvVar: denies process-identity variables", () => {
  for (
    const name of [
      "HOME",
      "USER",
      "USERNAME",
      "USERPROFILE",
      "LOGNAME",
      "SHELL",
      "PATH",
      "PWD",
      "TMPDIR",
      "TEMP",
      "TMP",
      "HOSTNAME",
      "TERM",
    ]
  ) {
    assertEquals(isDeniedEnvVar(name), true, `${name} should be denied`);
  }
});

Deno.test("isDeniedEnvVar: denies XDG_/DENO_/SWAMP_ prefixes", () => {
  assertEquals(isDeniedEnvVar("XDG_CONFIG_HOME"), true);
  assertEquals(isDeniedEnvVar("DENO_DIR"), true);
  assertEquals(isDeniedEnvVar("SWAMP_LOCK_HOLDER_PID"), true);
});

Deno.test("isDeniedEnvVar: is case-insensitive (Windows env names)", () => {
  assertEquals(isDeniedEnvVar("Path"), true);
  assertEquals(isDeniedEnvVar("home"), true);
  assertEquals(isDeniedEnvVar("Deno_Dir"), true);
});

Deno.test("isDeniedEnvVar: allows ordinary variables", () => {
  assertEquals(isDeniedEnvVar("AWS_ACCESS_KEY_ID"), false);
  assertEquals(isDeniedEnvVar("MY_APP_TOKEN"), false);
  assertEquals(isDeniedEnvVar("TERMINAL_VELOCITY"), false);
  assertEquals(isDeniedEnvVar("TMPX"), false);
});

Deno.test("captureEnvironmentSnapshot: drops denylisted variables", () => {
  const snapshot = captureEnvironmentSnapshot({
    HOME: "/home/orchestrator",
    PATH: "/usr/bin",
    AWS_ACCESS_KEY_ID: "AKIA123",
    DEPLOY_ENV: "prod",
    DENO_DIR: "/cache/deno",
  });
  assertEquals(snapshot, {
    AWS_ACCESS_KEY_ID: "AKIA123",
    DEPLOY_ENV: "prod",
  });
});

Deno.test("overlayEnvironment: snapshot wins for shipped variables", () => {
  const merged = overlayEnvironment(
    { DEPLOY_ENV: "dev", WORKER_ONLY: "yes" },
    { DEPLOY_ENV: "prod", AWS_ACCESS_KEY_ID: "AKIA123" },
  );
  assertEquals(merged, {
    DEPLOY_ENV: "prod",
    WORKER_ONLY: "yes",
    AWS_ACCESS_KEY_ID: "AKIA123",
  });
});

Deno.test("overlayEnvironment: worker base survives for denylisted names even from a non-conforming peer", () => {
  const merged = overlayEnvironment(
    { HOME: "/home/worker", PATH: "/worker/bin" },
    { HOME: "/home/orchestrator", EXTRA: "1" },
  );
  assertEquals(merged, {
    HOME: "/home/worker",
    PATH: "/worker/bin",
    EXTRA: "1",
  });
});

Deno.test("stripWorkerCredentials: removes worker control-plane credentials", () => {
  const env = {
    SWAMP_WORKER_TOKEN: "tok.secret",
    SWAMP_SERVER_TOKEN: "srv.secret",
    SWAMP_ORCHESTRATOR_URL: "wss://orch:4000",
    DEPLOY_ENV: "prod",
    AWS_ACCESS_KEY_ID: "AKIA123",
  };
  assertEquals(stripWorkerCredentials(env), {
    DEPLOY_ENV: "prod",
    AWS_ACCESS_KEY_ID: "AKIA123",
  });
});

Deno.test("stripWorkerCredentials: preserves SWAMP_SERVE_EXTRA_HEADERS and worker config vars", () => {
  const env = {
    SWAMP_WORKER_TOKEN: "tok.secret",
    SWAMP_SERVE_EXTRA_HEADERS: "Tunnel-Token: abc123",
    SWAMP_WORKER_LABELS: "gpu=true",
    SWAMP_WORKER_CACHE_DIR: "/var/cache/swamp",
    HOME: "/home/worker",
  };
  assertEquals(stripWorkerCredentials(env), {
    SWAMP_SERVE_EXTRA_HEADERS: "Tunnel-Token: abc123",
    SWAMP_WORKER_LABELS: "gpu=true",
    SWAMP_WORKER_CACHE_DIR: "/var/cache/swamp",
    HOME: "/home/worker",
  });
});
