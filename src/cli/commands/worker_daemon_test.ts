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

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join, relative, resolve } from "@std/path";
import {
  captureExtraHeaders,
  collectWorkerEnv,
  collectWorkerExtraArgs,
  validateCaCertFile,
  validateCacheDir,
  validateWorkerDaemonOptions,
  workerDaemonBaseEnv,
  workerDaemonEnableCommand,
} from "./worker_daemon.ts";
import { workerConnectCommand } from "./worker_connect.ts";
import { getSwampConfigDir } from "../../infrastructure/persistence/paths.ts";
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

Deno.test("collectWorkerEnv: includes SWAMP_WORKER_TOKEN_FILE when provided", () => {
  const env = collectWorkerEnv({
    url: "wss://orch:9090",
    tokenFile: "/tokens/worker-token",
  });
  assertEquals(env["SWAMP_WORKER_TOKEN_FILE"], "/tokens/worker-token");
  assertEquals(env["SWAMP_WORKER_TOKEN"], undefined);
});

Deno.test("collectWorkerEnv: includes SWAMP_SERVER_TOKEN_FILE when provided", () => {
  const env = collectWorkerEnv({
    url: "wss://orch:9090",
    tokenFile: "/tokens/worker-token",
    serverTokenFile: "/tokens/server-token",
  });
  assertEquals(env["SWAMP_SERVER_TOKEN_FILE"], "/tokens/server-token");
  assertEquals(env["SWAMP_SERVER_TOKEN"], undefined);
  assertEquals(env["SWAMP_WORKER_TOKEN_FILE"], "/tokens/worker-token");
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

Deno.test("workerDaemonBaseEnv: points the daemon at this user's config dir", () => {
  const env = workerDaemonBaseEnv();
  assertEquals(Object.keys(env), ["SWAMP_CONFIG_DIR"]);
  assertEquals(env.SWAMP_CONFIG_DIR, resolve(getSwampConfigDir()));
});

Deno.test("collectWorkerEnv: writes --concurrency as SWAMP_WORKER_CONCURRENCY, keeping auto literal", () => {
  assertEquals(collectWorkerEnv({ concurrency: "auto" }), {
    SWAMP_WORKER_CONCURRENCY: "auto",
  });
  assertEquals(collectWorkerEnv({ concurrency: "4" }), {
    SWAMP_WORKER_CONCURRENCY: "4",
  });
});

Deno.test("collectWorkerEnv: writes --ca-cert as SWAMP_CA_CERT", () => {
  assertEquals(collectWorkerEnv({ caCert: "/etc/swamp/ca.pem" }), {
    SWAMP_CA_CERT: "/etc/swamp/ca.pem",
  });
});

Deno.test("collectWorkerEnv: writes captured extra headers as SWAMP_SERVE_EXTRA_HEADERS", () => {
  assertEquals(collectWorkerEnv({ extraHeaders: "Tunnel-Token: abc" }), {
    SWAMP_SERVE_EXTRA_HEADERS: "Tunnel-Token: abc",
  });
});

Deno.test("validateCaCertFile: rejects a non-existent path", async () => {
  const missing = join(Deno.cwd(), `missing-${crypto.randomUUID()}.pem`);
  await assertRejects(
    () => validateCaCertFile(missing),
    UserError,
    `--ca-cert does not exist: ${missing}`,
  );
});

Deno.test("validateCaCertFile: rejects a directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => validateCaCertFile(dir),
      UserError,
      "--ca-cert is not a file",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("validateCaCertFile: resolves a relative path to an absolute one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "ca.pem");
    await Deno.writeTextFile(file, "pem");
    assertEquals(
      await validateCaCertFile(relative(Deno.cwd(), file)),
      resolve(file),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("validateWorkerDaemonOptions: accepts valid values and reports no changed labels", () => {
  assertEquals(
    validateWorkerDaemonOptions("wss://orch:9090", {
      maxDispatches: 5,
      idleTimeout: "30m",
      concurrency: "auto",
      label: ["tier=ci", "zone=eu-1"],
    }),
    [],
  );
});

Deno.test("validateWorkerDaemonOptions: returns labels the service reads differently", () => {
  assertEquals(
    validateWorkerDaemonOptions("wss://orch:9090", {
      label: ["tier=ci", "a=x,y=z", "b=v "],
    }),
    ["a=x,y=z", "b=v "],
  );
});

Deno.test("validateWorkerDaemonOptions: refuses values worker connect refuses at start", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["https://orch:9090", {}, "Orchestrator URL must start with ws://"],
    ["wss://orch", { maxDispatches: 0 }, "--max-dispatches must be"],
    ["wss://orch", { maxDispatches: 1.5 }, "--max-dispatches must be"],
    ["wss://orch", { idleTimeout: "soon" }, "Invalid duration format"],
    ["wss://orch", { concurrency: "0" }, "--concurrency must be"],
    ["wss://orch", { label: ["noequals"] }, "Invalid label 'noequals'"],
    [
      "wss://orch",
      { label: ["tier=ci", "a=b,c"] },
      "--label 'a=b,c' cannot be read back by the service — it receives labels comma-separated",
    ],
    [
      "wss://orch",
      { label: ["a= "] },
      "--label 'a= ' cannot be read back by the service: Invalid label 'a='",
    ],
  ];
  for (const [url, options, message] of cases) {
    assertThrows(
      () => validateWorkerDaemonOptions(url, options),
      UserError,
      message,
    );
  }
});

Deno.test("captureExtraHeaders: returns the raw value and header names", () => {
  assertEquals(
    captureExtraHeaders(() => "Tunnel-Token: abc\nX-Env: prod"),
    { raw: "Tunnel-Token: abc\nX-Env: prod", names: ["Tunnel-Token", "X-Env"] },
  );
});

Deno.test("captureExtraHeaders: returns undefined when unset or empty", () => {
  assertEquals(captureExtraHeaders(() => undefined), undefined);
  assertEquals(captureExtraHeaders(() => ""), undefined);
});

Deno.test("captureExtraHeaders: refuses headers worker connect would refuse", () => {
  assertThrows(
    () => captureExtraHeaders(() => "Authorization: Bearer x"),
    UserError,
    "is reserved",
  );
  assertThrows(
    () => captureExtraHeaders(() => "no colon here"),
    UserError,
    "Invalid header format",
  );
});

// How `worker daemon enable` hands each `worker connect` option to the
// service: the env var connect reads, or a connect argument.
const CONNECT_OPTION_DELIVERY: Record<string, string> = {
  "--token": "SWAMP_WORKER_TOKEN",
  "--token-file": "SWAMP_WORKER_TOKEN_FILE",
  "--server-token": "SWAMP_SERVER_TOKEN",
  "--server-token-file": "SWAMP_SERVER_TOKEN_FILE",
  "--label": "SWAMP_WORKER_LABELS",
  "--cache-dir": "SWAMP_WORKER_CACHE_DIR",
  "--max-dispatches": "SWAMP_WORKER_MAX_DISPATCHES",
  "--idle-timeout": "SWAMP_WORKER_IDLE_TIMEOUT",
  "--concurrency": "SWAMP_WORKER_CONCURRENCY",
  "--ca-cert": "SWAMP_CA_CERT",
  "--data-plane-url": "arg",
  "--no-reconnect": "arg",
};
// worker connect options the daemon deliberately does not offer.
const CONNECT_ONLY_OPTIONS: string[] = [];
// daemon enable options that configure the service itself.
const DAEMON_ONLY_OPTIONS = ["--user"];
// Environment variables worker connect reads that have no flag; daemon
// enable carries them from the enabling shell.
const CONNECT_ENV_WITHOUT_FLAG = [
  "SWAMP_ORCHESTRATOR_URL",
  "SWAMP_SERVE_EXTRA_HEADERS",
];

function flagsOf(command: typeof workerConnectCommand): string[] {
  return command.getOptions().map((o) => o.flags[0]).sort();
}

const FULL_DAEMON_OPTIONS = {
  url: "wss://orch:9090",
  token: "t.s",
  tokenFile: "/t",
  serverToken: "s.s",
  serverTokenFile: "/s",
  label: ["a=b"],
  cacheDir: "/c",
  maxDispatches: 2,
  idleTimeout: "5m",
  concurrency: "2",
  caCert: "/ca.pem",
  extraHeaders: "X-A: b",
  dataPlaneUrl: "https://dp",
  reconnect: false,
};

Deno.test("worker daemon enable: offers every worker connect option", () => {
  const connect = flagsOf(workerConnectCommand);
  const daemon = flagsOf(workerDaemonEnableCommand);
  assertEquals(
    connect.filter((f) =>
      !daemon.includes(f) && !CONNECT_ONLY_OPTIONS.includes(f)
    ),
    [],
  );
  assertEquals(
    daemon.filter((f) => !connect.includes(f)).sort(),
    [...DAEMON_ONLY_OPTIONS].sort(),
  );
  assertEquals(
    connect.filter((f) => !CONNECT_ONLY_OPTIONS.includes(f)).sort(),
    Object.keys(CONNECT_OPTION_DELIVERY).sort(),
  );
});

Deno.test("worker daemon enable: hands every worker connect option to the service", () => {
  const env = collectWorkerEnv(FULL_DAEMON_OPTIONS);
  const args = collectWorkerExtraArgs(FULL_DAEMON_OPTIONS);
  for (const [flag, delivery] of Object.entries(CONNECT_OPTION_DELIVERY)) {
    if (delivery === "arg") {
      assertEquals(args.includes(flag), true, `${flag} not in service args`);
    } else {
      assertEquals(delivery in env, true, `${flag} not in service env`);
    }
  }
  for (const name of CONNECT_ENV_WITHOUT_FLAG) {
    assertEquals(name in env, true, `${name} not in service env`);
  }
});

Deno.test("worker daemon enable: covers every environment variable worker connect reads", async () => {
  const source = await Deno.readTextFile(
    fromFileUrl(new URL("./worker_connect.ts", import.meta.url)),
  );
  const read = [...new Set(source.match(/SWAMP_[A-Z_]+/g) ?? [])].sort();
  const covered = [
    ...Object.values(CONNECT_OPTION_DELIVERY).filter((d) => d !== "arg"),
    ...CONNECT_ENV_WITHOUT_FLAG,
  ];
  assertEquals(read.filter((name) => !covered.includes(name)), []);
});
