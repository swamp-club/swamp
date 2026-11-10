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
import type { ServeConfigFile } from "./serve_config.ts";
import {
  diffServeSettings,
  overlayAppliedSettings,
  reloadsOnHangup,
  SETTING_CATALOGUE,
} from "./serve_settings_reload.ts";

function diff(
  before: ServeConfigFile | null,
  after: ServeConfigFile | null,
  explicitFlags: string[] = [],
  env: Record<string, string> = {},
) {
  return diffServeSettings({
    before,
    after,
    explicitFlags: new Set(explicitFlags),
    envLookup: (name) => env[name],
  });
}

Deno.test("diffServeSettings: an unchanged file reports nothing", () => {
  const config: ServeConfigFile = { "max-concurrent-runs": 5, port: 9090 };
  assertEquals(diff(config, { ...config }), {
    applied: [],
    needsRestart: [],
    overridden: [],
  });
  assertEquals(diff(null, null).applied, []);
});

Deno.test("diffServeSettings: a reloadable setting is reported applied", () => {
  const report = diff({ "max-concurrent-runs": 5 }, {
    "max-concurrent-runs": 9,
    dashboard: true,
  });
  assertEquals([...report.applied].sort(), [
    "dashboard",
    "max-concurrent-runs",
  ]);
  assertEquals(report.needsRestart, []);
});

Deno.test("diffServeSettings: a listener setting needs a new process, with the reason", () => {
  const report = diff({ port: 9090 }, { port: 9191 });
  assertEquals(report.applied, []);
  assertEquals(report.needsRestart.map((r) => r.setting), ["port"]);
  assertEquals(
    report.needsRestart[0].reason.includes("needs a new process"),
    true,
  );
});

Deno.test("diffServeSettings: an auth list is not applied by reload yet", () => {
  const report = diff(
    { auth: { mode: "oauth", "allowed-users": ["alice"] } },
    { auth: { mode: "oauth", "allowed-users": ["alice", "bob"] } },
  );
  assertEquals(report.needsRestart.map((r) => r.setting), [
    "auth.allowed-users",
  ]);
});

Deno.test("diffServeSettings: a value pinned by a startup flag is overridden, naming the flag", () => {
  const report = diff(
    { "max-concurrent-runs": 5 },
    { "max-concurrent-runs": 9 },
    ["max-concurrent-runs"],
  );
  assertEquals(report.applied, []);
  assertEquals(report.overridden, [
    { setting: "max-concurrent-runs", by: "--max-concurrent-runs" },
  ]);
});

Deno.test("diffServeSettings: a value pinned by an environment variable is overridden, naming it", () => {
  const report = diff(
    { "queue-timeout": "30s" },
    { "queue-timeout": "60s" },
    [],
    { SWAMP_QUEUE_TIMEOUT: "10s" },
  );
  assertEquals(report.overridden, [
    { setting: "queue-timeout", by: "SWAMP_QUEUE_TIMEOUT" },
  ]);
});

Deno.test("diffServeSettings: --webhook flags override the file's webhooks list", () => {
  const route = { route: "/hooks/a", workflow: "a", secret: "s" };
  const report = diff({ webhooks: [] }, { webhooks: [route] }, ["webhook"]);
  assertEquals(report.overridden, [{ setting: "webhooks", by: "--webhook" }]);
});

Deno.test("diffServeSettings: an applied setting whose consumer is not running needs a restart, with that reason", () => {
  const report = diffServeSettings({
    before: { triggers: {} },
    after: { triggers: { nightly: { schedule: "0 3 * * *" } } },
    explicitFlags: new Set(),
    envLookup: () => undefined,
    notRunning: { triggerOverrides: "no scheduler runs on this serve" },
  });
  assertEquals(report.applied, []);
  assertEquals(report.needsRestart, [
    { setting: "triggers", reason: "no scheduler runs on this serve" },
  ]);
});

Deno.test("diffServeSettings: a startup-only setting is not reported", () => {
  const report = diff({ "hydration-timeout": "60s" }, {
    "hydration-timeout": "90s",
  });
  assertEquals(report, { applied: [], needsRestart: [], overridden: [] });
});

Deno.test("SETTING_CATALOGUE: every restart setting says why", () => {
  for (const [key, entry] of Object.entries(SETTING_CATALOGUE)) {
    if (entry.reloadClass === "restart") {
      assertEquals(typeof entry.reason, "string", key);
    }
  }
});

Deno.test("reloadsOnHangup: a terminal serve without --hot-reload shuts down on SIGHUP", () => {
  assertEquals(
    reloadsOnHangup({ os: "linux", hotReload: false, stdinIsTerminal: true }),
    false,
  );
});

Deno.test("reloadsOnHangup: a daemon, a container or a --hot-reload serve reloads on SIGHUP", () => {
  assertEquals(
    reloadsOnHangup({ os: "linux", hotReload: false, stdinIsTerminal: false }),
    true,
  );
  assertEquals(
    reloadsOnHangup({ os: "darwin", hotReload: true, stdinIsTerminal: true }),
    true,
  );
});

Deno.test("reloadsOnHangup: never on Windows, which has no SIGHUP", () => {
  assertEquals(
    reloadsOnHangup({ os: "windows", hotReload: true, stdinIsTerminal: false }),
    false,
  );
});

Deno.test("overlayAppliedSettings: takes only the keys the reload applied from the reloaded file", () => {
  const current = {
    port: 9090,
    allowedUsers: ["alice", "bob"],
    dashboard: false,
    maxConcurrentRuns: 5,
  } as unknown as Parameters<typeof overlayAppliedSettings>[0];
  const next = {
    port: 9191,
    allowedUsers: ["alice"],
    dashboard: true,
    maxConcurrentRuns: 9,
  } as unknown as Parameters<typeof overlayAppliedSettings>[1];
  const live = overlayAppliedSettings(current, next, [
    "dashboard",
  ]) as unknown as Record<string, unknown>;
  assertEquals(live.port, 9090);
  assertEquals(live.allowedUsers, ["alice", "bob"]);
  assertEquals(live.dashboard, true);
  // applied class, but this reload did not apply it
  assertEquals(live.maxConcurrentRuns, 5);
});
