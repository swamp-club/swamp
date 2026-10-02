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
  createSafeMethodEnv,
  isDeniedEnvVar,
  isSwampEnvVar,
  NESTED_SWAMP_ENV_VARS,
  overlayEnvironment,
  stripInheritedTraceContext,
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
  assertEquals(isDeniedEnvVar("SWAMP_LOCK_ANCESTOR_PIDS"), true);
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

Deno.test("isSwampEnvVar: matches SWAMP_ prefix case-insensitively", () => {
  assertEquals(isSwampEnvVar("SWAMP_SERVER_TOKEN"), true);
  assertEquals(isSwampEnvVar("SWAMP_API_KEY"), true);
  assertEquals(isSwampEnvVar("SWAMP_HOME"), true);
  assertEquals(isSwampEnvVar("swamp_log_level"), true);
  assertEquals(isSwampEnvVar("Swamp_Foo"), true);
});

Deno.test("isSwampEnvVar: rejects non-SWAMP variables", () => {
  assertEquals(isSwampEnvVar("HOME"), false);
  assertEquals(isSwampEnvVar("PATH"), false);
  assertEquals(isSwampEnvVar("AWS_ACCESS_KEY_ID"), false);
  assertEquals(isSwampEnvVar("DENO_DIR"), false);
});

Deno.test("createSafeMethodEnv: strips all SWAMP_* variables", () => {
  const env = {
    HOME: "/home/user",
    PATH: "/usr/bin",
    SHELL: "/bin/bash",
    SWAMP_SERVER_TOKEN: "srv.secret",
    SWAMP_API_KEY: "api-key-123",
    SWAMP_SERVER_URL: "wss://orch:9090",
    SWAMP_SERVE_URL: "wss://demo.swamp-club.ai",
    SWAMP_SERVE_EXTRA_HEADERS: "Tunnel-Token: abc",
    SWAMP_HOME: "/custom/swamp",
    SWAMP_LOG_LEVEL: "debug",
    AWS_ACCESS_KEY_ID: "AKIA123",
    DEPLOY_ENV: "prod",
  };
  assertEquals(createSafeMethodEnv(env), {
    HOME: "/home/user",
    PATH: "/usr/bin",
    SHELL: "/bin/bash",
    AWS_ACCESS_KEY_ID: "AKIA123",
    DEPLOY_ENV: "prod",
  });
});

Deno.test("createSafeMethodEnv: case-insensitive matching", () => {
  const env = {
    swamp_server_token: "secret",
    Swamp_Api_Key: "key",
    PATH: "/usr/bin",
  };
  assertEquals(createSafeMethodEnv(env), {
    PATH: "/usr/bin",
  });
});

Deno.test("createSafeMethodEnv: allowlist opts specific vars back in", () => {
  const env = {
    SWAMP_SERVER_TOKEN: "secret",
    SWAMP_HOME: "/custom",
    SWAMP_LOG_LEVEL: "debug",
    PATH: "/usr/bin",
  };
  assertEquals(createSafeMethodEnv(env, ["SWAMP_HOME", "SWAMP_LOG_LEVEL"]), {
    SWAMP_HOME: "/custom",
    SWAMP_LOG_LEVEL: "debug",
    PATH: "/usr/bin",
  });
});

Deno.test("createSafeMethodEnv: allowlist is case-sensitive", () => {
  const env = {
    SWAMP_HOME: "/custom",
    swamp_home: "/other",
    PATH: "/usr/bin",
  };
  assertEquals(createSafeMethodEnv(env, ["SWAMP_HOME"]), {
    SWAMP_HOME: "/custom",
    PATH: "/usr/bin",
  });
});

Deno.test("createSafeMethodEnv: empty env returns empty", () => {
  assertEquals(createSafeMethodEnv({}), {});
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

Deno.test("isDeniedEnvVar: denies the orchestrator's OTEL_ settings and trace context", () => {
  for (
    const name of [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_SERVICE_NAME",
      "OTEL_TRACES_EXPORTER",
      "otel_resource_attributes",
      "TRACEPARENT",
      "TRACESTATE",
      "traceparent",
    ]
  ) {
    assertEquals(isDeniedEnvVar(name), true, name);
  }
  assertEquals(isDeniedEnvVar("MY_TRACEPARENT_COPY"), false);
});

Deno.test("captureEnvironmentSnapshot: never ships OTEL_ settings or trace context", () => {
  const snapshot = captureEnvironmentSnapshot({
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer collector-secret",
    OTEL_TRACES_EXPORTER: "console",
    TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    API_KEY: "key123",
  });
  assertEquals(snapshot, { API_KEY: "key123" });
});

Deno.test("stripInheritedTraceContext: removes TRACEPARENT and TRACESTATE in any case", () => {
  assertEquals(
    stripInheritedTraceContext({
      TRACEPARENT: "a",
      tracestate: "b",
      OTEL_SERVICE_NAME: "worker",
      KEEP: "c",
    }),
    { OTEL_SERVICE_NAME: "worker", KEEP: "c" },
  );
});

Deno.test("createSafeMethodEnv: NESTED_SWAMP_ENV_VARS keeps the nested-swamp vars and no credential", () => {
  const env = {
    SWAMP_NESTED_GATE_PASS: "4242.e30.c2ln",
    SWAMP_LOCK_HOLDER_PID: "4242",
    SWAMP_LOCK_ANCESTOR_PIDS: "4141,4242",
    SWAMP_API_KEY: "swamp_secret",
    SWAMP_API_KEY_FILE: "/run/secrets/swamp",
    SWAMP_SIGNIN_TOKEN: "e30.c2ln",
    SWAMP_CLUB_URL: "https://swamp-club.test",
    SWAMP_SERVER_TOKEN: "secret",
    SWAMP_SERVER_TOKEN_FILE: "/run/secrets/server",
    SWAMP_WORKER_TOKEN: "secret",
    SWAMP_WORKER_TOKEN_FILE: "/run/secrets/worker",
    SWAMP_ORCHESTRATOR_URL: "wss://orchestrator.test",
    PATH: "/usr/bin",
  };
  assertEquals(createSafeMethodEnv(env, NESTED_SWAMP_ENV_VARS), {
    SWAMP_NESTED_GATE_PASS: "4242.e30.c2ln",
    SWAMP_LOCK_HOLDER_PID: "4242",
    SWAMP_LOCK_ANCESTOR_PIDS: "4141,4242",
    PATH: "/usr/bin",
  });
});
