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
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { isAbsolute, join, resolve } from "@std/path";
import {
  buildServeDaemonEnv,
  collectServeExtraArgs,
  validateServeDaemonArgs,
} from "./serve.ts";
import { UserError } from "../../domain/errors.ts";
import {
  getSwampConfigDir,
  getSwampDataDir,
} from "../../infrastructure/persistence/paths.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";

Deno.test("collectServeExtraArgs: returns empty for defaults", () => {
  const args = collectServeExtraArgs({
    schedule: true,
    grantReload: "manual",
    authMode: "none",
  });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: includes --no-schedule", () => {
  const args = collectServeExtraArgs({ schedule: false });
  assertEquals(args, ["--no-schedule"]);
});

Deno.test("collectServeExtraArgs: includes --grant-reload when not manual", () => {
  const args = collectServeExtraArgs({ grantReload: "auto" });
  assertEquals(args, ["--grant-reload", "auto"]);
});

Deno.test("collectServeExtraArgs: skips --grant-reload when manual", () => {
  const args = collectServeExtraArgs({ grantReload: "manual" });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: includes multiple webhooks", () => {
  const args = collectServeExtraArgs({
    webhook: ["/hooks/a:wf1:secret1", "/hooks/b:wf2:secret2"],
  });
  assertEquals(args, [
    "--webhook",
    "/hooks/a:wf1:secret1",
    "--webhook",
    "/hooks/b:wf2:secret2",
  ]);
});

Deno.test("collectServeExtraArgs: includes --auth-mode when not none", () => {
  const args = collectServeExtraArgs({ authMode: "token" });
  assertEquals(args, ["--auth-mode", "token"]);
});

Deno.test("collectServeExtraArgs: skips --auth-mode none", () => {
  const args = collectServeExtraArgs({ authMode: "none" });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: includes --admins", () => {
  const args = collectServeExtraArgs({ admins: "user:oauth|admin-1" });
  assertEquals(args, ["--admins", "user:oauth|admin-1"]);
});

Deno.test("collectServeExtraArgs: includes OAuth flags", () => {
  const args = collectServeExtraArgs({
    allowedCollectives: "team-a,team-b",
    allowedUsers: "user1,user2",
    oauthProvider: "https://auth.example.com",
    oauthClientId: "client-123",
    groupsField: "groups",
  });
  assertEquals(args, [
    "--allowed-collectives",
    "team-a,team-b",
    "--allowed-users",
    "user1,user2",
    "--oauth-provider",
    "https://auth.example.com",
    "--oauth-client-id",
    "client-123",
    "--groups-field",
    "groups",
  ]);
});

Deno.test("collectServeExtraArgs: includes --trust-proxy", () => {
  const args = collectServeExtraArgs({ trustProxy: true });
  assertEquals(args, ["--trust-proxy"]);
});

Deno.test("collectServeExtraArgs: includes --ws-idle-timeout", () => {
  const args = collectServeExtraArgs({ wsIdleTimeout: "2m" });
  assertEquals(args, ["--ws-idle-timeout", "2m"]);
});

Deno.test("collectServeExtraArgs: skips --ws-idle-timeout when not set", () => {
  const args = collectServeExtraArgs({});
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: includes --heartbeat-interval", () => {
  const args = collectServeExtraArgs({ heartbeatInterval: "15s" });
  assertEquals(args, ["--heartbeat-interval", "15s"]);
});

Deno.test("collectServeExtraArgs: includes --datastore-poll-interval", () => {
  const args = collectServeExtraArgs({ datastorePollInterval: "5s" });
  assertEquals(args, ["--datastore-poll-interval", "5s"]);
});

Deno.test("collectServeExtraArgs: includes the token GC settings, including 0", () => {
  const args = collectServeExtraArgs({
    tokenGcInterval: "0",
    tokenGcGracePeriod: "2h",
  });
  assertEquals(args, [
    "--token-gc-interval",
    "0",
    "--token-gc-grace-period",
    "2h",
  ]);
});

Deno.test("collectServeExtraArgs: forwards 0 for the max-runs limits", () => {
  const args = collectServeExtraArgs({
    maxConcurrentRuns: 0,
    maxRunsPerPrincipal: 0,
  });
  assertEquals(args, [
    "--max-concurrent-runs",
    "0",
    "--max-runs-per-principal",
    "0",
  ]);
});

Deno.test("collectServeExtraArgs: includes --stale-ttl", () => {
  const args = collectServeExtraArgs({ staleTtl: "2m" });
  assertEquals(args, ["--stale-ttl", "2m"]);
});

Deno.test("collectServeExtraArgs: includes --reconciliation-interval", () => {
  const args = collectServeExtraArgs({ reconciliationInterval: "30s" });
  assertEquals(args, ["--reconciliation-interval", "30s"]);
});

Deno.test("collectServeExtraArgs: deprecated --detach-runs is not forwarded", () => {
  const args = collectServeExtraArgs({ detachRuns: true });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: includes --grants-file", () => {
  const args = collectServeExtraArgs({
    grantsFile: "/etc/swamp/grants.yaml",
  });
  assertEquals(args, ["--grants-file", "/etc/swamp/grants.yaml"]);
});

Deno.test("collectServeExtraArgs: skips --grants-file when not set", () => {
  const args = collectServeExtraArgs({
    schedule: true,
    grantReload: "manual",
    authMode: "none",
  });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: forwards --dashboard", () => {
  const args = collectServeExtraArgs({ dashboard: true });
  assertEquals(args, ["--dashboard"]);
});

Deno.test("collectServeExtraArgs: omits --dashboard when false", () => {
  const args = collectServeExtraArgs({ dashboard: false });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: combines multiple flags", () => {
  const args = collectServeExtraArgs({
    schedule: false,
    authMode: "oauth",
    trustProxy: true,
    admins: "user:oauth|admin-1",
  });
  assertEquals(args, [
    "--no-schedule",
    "--auth-mode",
    "oauth",
    "--admins",
    "user:oauth|admin-1",
    "--trust-proxy",
  ]);
});

// Every path input is listed so the runner's real environment never leaks in.
type PathEnv = {
  SWAMP_CONFIG_DIR: string | undefined;
  SWAMP_HOME: string | undefined;
  XDG_CONFIG_HOME: string | undefined;
  HOME: string | undefined;
  USERPROFILE: string | undefined;
};

const NO_PATH_ENV: PathEnv = {
  SWAMP_CONFIG_DIR: undefined,
  SWAMP_HOME: undefined,
  XDG_CONFIG_HOME: undefined,
  HOME: undefined,
  USERPROFILE: undefined,
};

const ENABLING_SHELLS: Record<string, PathEnv> = {
  "defaults from HOME": { ...NO_PATH_ENV, HOME: "/home/alice" },
  "XDG_CONFIG_HOME set": {
    ...NO_PATH_ENV,
    HOME: "/home/alice",
    XDG_CONFIG_HOME: "/home/alice/.cfg",
  },
  "SWAMP_HOME set": {
    ...NO_PATH_ENV,
    HOME: "/home/alice",
    SWAMP_HOME: "/opt/swamp",
  },
  "relative SWAMP_HOME": {
    ...NO_PATH_ENV,
    HOME: "/home/alice",
    SWAMP_HOME: "rel-swamp",
  },
  "relative XDG_CONFIG_HOME": {
    ...NO_PATH_ENV,
    HOME: "/home/alice",
    XDG_CONFIG_HOME: "rel-config",
  },
};

// Environments a service manager may supply before the unit's own entries.
const SERVICE_MANAGERS: Record<string, PathEnv> = {
  "system unit without HOME": NO_PATH_ENV,
  "user unit with a different XDG_CONFIG_HOME": {
    ...NO_PATH_ENV,
    HOME: "/home/alice",
    XDG_CONFIG_HOME: "/elsewhere",
  },
  "stale SWAMP_HOME and SWAMP_CONFIG_DIR": {
    ...NO_PATH_ENV,
    HOME: "/home/alice",
    SWAMP_HOME: "/stale",
    SWAMP_CONFIG_DIR: "/stale-config",
  },
};

function resolveDirs(env: PathEnv): { configDir: string; dataDir: string } {
  return withMockedEnv(env, () => ({
    configDir: getSwampConfigDir(),
    dataDir: getSwampDataDir(),
  }));
}

Deno.test("buildServeDaemonEnv: pins absolute data and config dirs", () => {
  const env = withMockedEnv(
    ENABLING_SHELLS["relative SWAMP_HOME"],
    buildServeDaemonEnv,
  );
  assertEquals(Object.keys(env).sort(), ["SWAMP_CONFIG_DIR", "SWAMP_HOME"]);
  assert(isAbsolute(env.SWAMP_HOME));
  assert(isAbsolute(env.SWAMP_CONFIG_DIR));
});

for (const [shellName, shellEnv] of Object.entries(ENABLING_SHELLS)) {
  for (const [managerName, managerEnv] of Object.entries(SERVICE_MANAGERS)) {
    Deno.test(`buildServeDaemonEnv: ${shellName} resolves the same dirs under ${managerName}`, () => {
      const enabling = resolveDirs(shellEnv);
      const unitEnv = withMockedEnv(shellEnv, buildServeDaemonEnv);

      const inUnit = resolveDirs({ ...managerEnv, ...unitEnv });

      assertEquals(inUnit.configDir, resolve(enabling.configDir));
      assertEquals(inUnit.dataDir, resolve(enabling.dataDir));
    });
  }
}

Deno.test("buildServeDaemonEnv: pinning SWAMP_HOME alone moves the config dir (swamp-club#2824)", () => {
  const shellEnv = ENABLING_SHELLS["defaults from HOME"];
  const enabling = resolveDirs(shellEnv);

  const inUnit = resolveDirs({
    ...SERVICE_MANAGERS["user unit with a different XDG_CONFIG_HOME"],
    SWAMP_HOME: resolve(enabling.dataDir),
  });

  assertNotEquals(inUnit.configDir, resolve(enabling.configDir));
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-daemon-test-" });
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

/** `daemon enable` options with Cliffy's defaults applied. */
function enableOptions(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    port: 9090,
    host: "127.0.0.1",
    schedule: true,
    grantReload: "manual",
    authMode: "none",
    ...overrides,
  };
}

const NO_UNIT_ENV: Readonly<Record<string, string>> = {};

Deno.test("validateServeDaemonArgs: rejects token mode without --admins", async () => {
  await withTempDir((repoDir) => {
    assertThrows(
      () =>
        validateServeDaemonArgs(
          enableOptions({ authMode: "token" }),
          repoDir,
          NO_UNIT_ENV,
        ),
      UserError,
      '--admins is required when --auth-mode is "token"',
    );
    return Promise.resolve();
  });
});

Deno.test("validateServeDaemonArgs: rejects a malformed --admins value", async () => {
  await withTempDir((repoDir) => {
    assertThrows(
      () =>
        validateServeDaemonArgs(
          enableOptions({ authMode: "token", admins: "hammz" }),
          repoDir,
          NO_UNIT_ENV,
        ),
      UserError,
      'Invalid --admins value "hammz"',
    );
    return Promise.resolve();
  });
});

Deno.test("validateServeDaemonArgs: rejects --cert-file without --key-file", async () => {
  await withTempDir((repoDir) => {
    assertThrows(
      () =>
        validateServeDaemonArgs(
          enableOptions({ certFile: "cert.pem" }),
          repoDir,
          NO_UNIT_ENV,
        ),
      UserError,
      "Both --cert-file and --key-file must be provided together for TLS",
    );
    return Promise.resolve();
  });
});

Deno.test("validateServeDaemonArgs: rejects an unparseable duration", async () => {
  await withTempDir((repoDir) => {
    assertThrows(
      () =>
        validateServeDaemonArgs(
          enableOptions({ heartbeatInterval: "soon" }),
          repoDir,
          NO_UNIT_ENV,
        ),
      UserError,
      'Invalid duration format: "soon"',
    );
    return Promise.resolve();
  });
});

Deno.test("validateServeDaemonArgs: rejects --max-concurrent-runs 0", async () => {
  await withTempDir((repoDir) => {
    assertThrows(
      () =>
        validateServeDaemonArgs(
          enableOptions({ maxConcurrentRuns: 0 }),
          repoDir,
          NO_UNIT_ENV,
        ),
      UserError,
      "--max-concurrent-runs must be a positive integer, got 0",
    );
    return Promise.resolve();
  });
});

Deno.test("validateServeDaemonArgs: rejects token mode from serve.yaml without admins", async () => {
  await withTempDir(async (repoDir) => {
    await Deno.mkdir(join(repoDir, ".swamp"));
    await Deno.writeTextFile(
      join(repoDir, ".swamp", "serve.yaml"),
      "auth:\n  mode: token\n",
    );
    assertThrows(
      () => validateServeDaemonArgs(enableOptions(), repoDir, NO_UNIT_ENV),
      UserError,
      '--admins is required when --auth-mode is "token"',
    );
  });
});

Deno.test("validateServeDaemonArgs: resolves a relative --config against the repo dir", async () => {
  await withTempDir(async (repoDir) => {
    await Deno.mkdir(join(repoDir, "deploy"));
    await Deno.writeTextFile(
      join(repoDir, "deploy", "serve.yaml"),
      "auth:\n  mode: token\n  admins:\n    - user:alice\n",
    );
    const settings = validateServeDaemonArgs(
      enableOptions({ config: join("deploy", "serve.yaml") }),
      repoDir,
      NO_UNIT_ENV,
    );
    assertEquals(settings.authConfig.mode, "token");
    assertEquals(settings.authConfig.admins, ["user:alice"]);
  });
});

Deno.test("validateServeDaemonArgs: reads env vars from the unit env, not the shell", async () => {
  await withTempDir((repoDir) => {
    const settings = withMockedEnv(
      { SWAMP_HEARTBEAT_INTERVAL: "soon" },
      () => validateServeDaemonArgs(enableOptions(), repoDir, NO_UNIT_ENV),
    );
    assertEquals(settings.heartbeatIntervalMs, undefined);
    assertThrows(
      () =>
        validateServeDaemonArgs(enableOptions(), repoDir, {
          SWAMP_HEARTBEAT_INTERVAL: "soon",
        }),
      UserError,
      'Invalid duration format: "soon"',
    );
    return Promise.resolve();
  });
});

Deno.test("validateServeDaemonArgs: accepts a valid token-mode argument set", async () => {
  await withTempDir((repoDir) => {
    const settings = validateServeDaemonArgs(
      enableOptions({
        authMode: "token",
        admins: "user:alice",
        maxConcurrentRuns: 4,
      }),
      repoDir,
      NO_UNIT_ENV,
    );
    assertEquals(settings.authConfig.mode, "token");
    assertEquals(settings.maxConcurrentRuns, 4);
    return Promise.resolve();
  });
});
