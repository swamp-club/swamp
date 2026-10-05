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
import type { SchedulerRefreshResult } from "../domain/update/autoupdate_scheduler.ts";
import type { UpdatePreferences } from "../domain/update/update_preferences.ts";
import {
  type AutoupdateRefreshDeps,
  refreshAutoupdateSchedulerIfOwed,
  schedulerRepairCommand,
} from "./autoupdate_refresh.ts";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const VERSION = "20261005.120000.0-sha.bbb";

function fakeDeps(
  options: {
    prefs?: UpdatePreferences;
    os?: string;
    job?: "agent" | "daemon" | null;
    refresh?: () => Promise<SchedulerRefreshResult>;
  } = {},
): AutoupdateRefreshDeps & {
  written: UpdatePreferences[];
  refreshes: string[];
} {
  const written: UpdatePreferences[] = [];
  const refreshes: string[] = [];
  return {
    written,
    refreshes,
    os: options.os ?? "darwin",
    readPreferences: () =>
      Promise.resolve(options.prefs ?? { enabled: true, cadence: "daily" }),
    writePreferences: (p) => {
      written.push(p);
      return Promise.resolve();
    },
    detectInstalledLaunchdJob: () =>
      Promise.resolve(options.job === undefined ? "agent" : options.job),
    isRoot: () => false,
    configDirOwned: () => true,
    refreshScheduler: (job) => {
      refreshes.push(job);
      return options.refresh?.() ?? Promise.resolve("refreshed");
    },
    now: () => NOW,
  };
}

Deno.test("refreshAutoupdateSchedulerIfOwed: refreshes and records the version", async () => {
  const deps = fakeDeps({
    prefs: {
      enabled: true,
      cadence: "daily",
      notifiedVersion: "x",
      lastSchedulerRefreshAttempt: "2026-10-01T00:00:00.000Z",
    },
  });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, { outcome: "refreshed" });
  assertEquals(deps.refreshes, ["agent"]);
  assertEquals(deps.written, [{
    enabled: true,
    cadence: "daily",
    notifiedVersion: "x",
    schedulerRefreshedVersion: VERSION,
    lastSchedulerRefreshAttempt: undefined,
  }]);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: records the attempt when refresh fails", async () => {
  const deps = fakeDeps({
    refresh: () => Promise.reject(new Error("bootstrap failed")),
  });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, {
    outcome: "failed",
    job: "agent",
    error: "bootstrap failed",
  });
  assertEquals(deps.written, [{
    enabled: true,
    cadence: "daily",
    lastSchedulerRefreshAttempt: NOW.toISOString(),
  }]);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: writes nothing while the job is running", async () => {
  const deps = fakeDeps({ refresh: () => Promise.resolve("skipped") });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, { outcome: "skipped" });
  assertEquals(deps.written, []);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: does nothing once refreshed for this version", async () => {
  const deps = fakeDeps({
    prefs: {
      enabled: true,
      cadence: "daily",
      schedulerRefreshedVersion: VERSION,
    },
  });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, { outcome: "not_owed" });
  assertEquals(deps.refreshes, []);
  assertEquals(deps.written, []);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: does nothing off macOS or without a job", async () => {
  for (const deps of [fakeDeps({ os: "linux" }), fakeDeps({ job: null })]) {
    assertEquals(await refreshAutoupdateSchedulerIfOwed(deps, VERSION), {
      outcome: "not_owed",
    });
    assertEquals(deps.refreshes, []);
  }
});

Deno.test("refreshAutoupdateSchedulerIfOwed: never throws when preferences fail", async () => {
  const deps = fakeDeps();
  deps.readPreferences = () => Promise.reject(new Error("disk"));
  assertEquals(await refreshAutoupdateSchedulerIfOwed(deps, VERSION), {
    outcome: "not_owed",
  });
});

Deno.test("schedulerRepairCommand: sudo only for a LaunchDaemon", () => {
  assertEquals(schedulerRepairCommand("agent"), "swamp update --setup-auto");
  assertEquals(
    schedulerRepairCommand("daemon"),
    "sudo swamp update --setup-auto",
  );
});
