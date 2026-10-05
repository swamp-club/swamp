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
  SchedulerRefreshError,
  type SchedulerRefreshOptions,
  type SchedulerRefreshResult,
} from "../domain/update/autoupdate_scheduler.ts";
import type { UpdatePreferences } from "../domain/update/update_preferences.ts";
import { join } from "@std/path";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";
import {
  type AutoupdateRefreshDeps,
  createAutoupdateRefreshDeps,
  refreshAutoupdateSchedulerIfOwed,
} from "./autoupdate_refresh.ts";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const VERSION = "20261005.120000.0-sha.bbb";

function fakeDeps(
  options: {
    prefs?: UpdatePreferences;
    os?: string;
    job?: "agent" | "daemon" | null;
    refresh?: (
      options: SchedulerRefreshOptions,
    ) => Promise<SchedulerRefreshResult>;
    lockHeld?: boolean;
  } = {},
): AutoupdateRefreshDeps & {
  written: UpdatePreferences[];
  refreshes: string[];
  refreshOptions: SchedulerRefreshOptions[];
} {
  const written: UpdatePreferences[] = [];
  const refreshes: string[] = [];
  const refreshOptions: SchedulerRefreshOptions[] = [];
  return {
    written,
    refreshes,
    refreshOptions,
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
    refreshScheduler: (job, opts) => {
      refreshes.push(job);
      refreshOptions.push(opts);
      return options.refresh?.(opts) ?? Promise.resolve("refreshed");
    },
    withRefreshLock: (fn) => options.lockHeld ? Promise.resolve(null) : fn(),
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
    schedulerLeftUnloaded: undefined,
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
    schedulerLeftUnloaded: undefined,
  }]);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: loads an unloaded job only when a refresh left it unloaded", async () => {
  const fresh = fakeDeps();
  await refreshAutoupdateSchedulerIfOwed(fresh, VERSION);
  assertEquals(fresh.refreshOptions[0].loadIfNotLoaded, false);

  // An attempt that never booted the job out (unknown, or a failure before
  // bootout) must not force-load a job the user may have turned off.
  const afterUnknown = fakeDeps({
    prefs: {
      enabled: true,
      cadence: "daily",
      lastSchedulerRefreshAttempt: "2026-10-01T00:00:00.000Z",
    },
  });
  await refreshAutoupdateSchedulerIfOwed(afterUnknown, VERSION);
  assertEquals(afterUnknown.refreshOptions[0].loadIfNotLoaded, false);

  const leftUnloaded = fakeDeps({
    prefs: {
      enabled: true,
      cadence: "daily",
      lastSchedulerRefreshAttempt: "2026-10-01T00:00:00.000Z",
      schedulerLeftUnloaded: true,
    },
  });
  await refreshAutoupdateSchedulerIfOwed(leftUnloaded, VERSION);
  assertEquals(leftUnloaded.refreshOptions[0].loadIfNotLoaded, true);
  assertEquals(leftUnloaded.written[0].schedulerLeftUnloaded, undefined);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: records the unloaded mark before bootout, so a killed process leaves a trail", async () => {
  let onDiskAtBootout: UpdatePreferences | undefined;
  const deps = fakeDeps({
    refresh: async (opts) => {
      await opts.beforeUnload?.();
      // What a process killed between bootout and bootstrap leaves behind.
      onDiskAtBootout = deps.written.at(-1);
      return "refreshed";
    },
  });
  await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(onDiskAtBootout?.schedulerLeftUnloaded, true);
  // A successful refresh then clears it.
  assertEquals(deps.written.at(-1)?.schedulerLeftUnloaded, undefined);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: remembers a refresh that left the job unloaded", async () => {
  const deps = fakeDeps({
    refresh: () =>
      Promise.reject(new SchedulerRefreshError("bootstrap failed", true)),
  });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result.outcome, "failed");
  assertEquals(deps.written[0].schedulerLeftUnloaded, true);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: a failure before bootout does not mark the job unloaded", async () => {
  const deps = fakeDeps({
    refresh: () => Promise.reject(new Error("cannot read the plist")),
  });
  await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(deps.written[0].schedulerLeftUnloaded, undefined);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: writes nothing while the job is running", async () => {
  const deps = fakeDeps({ refresh: () => Promise.resolve("skipped") });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, { outcome: "skipped" });
  assertEquals(deps.written, []);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: an unreadable job state waits a day before re-checking", async () => {
  const deps = fakeDeps({ refresh: () => Promise.resolve("unknown") });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, { outcome: "skipped" });
  assertEquals(deps.written, [{
    enabled: true,
    cadence: "daily",
    lastSchedulerRefreshAttempt: NOW.toISOString(),
  }]);
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

Deno.test("refreshAutoupdateSchedulerIfOwed: records the version when no refresh was needed", async () => {
  const deps = fakeDeps({ refresh: () => Promise.resolve("not_needed") });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, { outcome: "not_owed" });
  assertEquals(deps.written[0]?.schedulerRefreshedVersion, VERSION);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: leaves the job to the process holding the lock", async () => {
  const deps = fakeDeps({ lockHeld: true });
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, { outcome: "skipped" });
  assertEquals(deps.refreshes, []);
  assertEquals(deps.written, []);
});

Deno.test("refreshAutoupdateSchedulerIfOwed: re-checks under the lock and skips a job another process refreshed", async () => {
  const deps = fakeDeps();
  let reads = 0;
  deps.readPreferences = () =>
    Promise.resolve(
      reads++ === 0 ? { enabled: true, cadence: "daily" } : {
        enabled: true,
        cadence: "daily",
        schedulerRefreshedVersion: VERSION,
      },
    );
  const result = await refreshAutoupdateSchedulerIfOwed(deps, VERSION);

  assertEquals(result, { outcome: "not_owed" });
  assertEquals(deps.refreshes, []);
});

async function withConfigDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await withMockedEnv({ SWAMP_CONFIG_DIR: dir }, () => fn(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("createAutoupdateRefreshDeps: the refresh lock admits one holder at a time", async () => {
  await withConfigDir(async (dir) => {
    const deps = createAutoupdateRefreshDeps();
    const inner = await deps.withRefreshLock(() =>
      deps.withRefreshLock(() => Promise.resolve("inner"))
    );
    assertEquals(inner, null);
    // Released afterwards.
    assertEquals(
      await deps.withRefreshLock(() => Promise.resolve("again")),
      "again",
    );
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name),
      [],
    );
  });
});

Deno.test("createAutoupdateRefreshDeps: a lock left by a dead process is taken over", async () => {
  await withConfigDir(async (dir) => {
    const lock = join(dir, "autoupdate-refresh.lock");
    await Deno.writeTextFile(lock, "");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await Deno.utime(lock, old, old);

    const deps = createAutoupdateRefreshDeps();
    assertEquals(
      await deps.withRefreshLock(() => Promise.resolve("taken")),
      "taken",
    );
  });
});

Deno.test("createAutoupdateRefreshDeps: a fresh lock held elsewhere is respected", async () => {
  await withConfigDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "autoupdate-refresh.lock"), "");
    const deps = createAutoupdateRefreshDeps();
    assertEquals(
      await deps.withRefreshLock(() => Promise.resolve("ran")),
      null,
    );
  });
});
