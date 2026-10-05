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
  checkInstallHealth,
  hasInstallProblem,
  type InstallHealthDeps,
} from "./install_health.ts";

function createFakeDeps(
  overrides: Partial<InstallHealthDeps> = {},
): InstallHealthDeps {
  return {
    binaryPath: "/usr/local/bin/swamp",
    currentVersion: "20260518.000000.0-sha.abc123",
    statBinary: () => Promise.resolve({ uid: 501 }),
    probeBinaryWritable: () => Promise.resolve(true),
    getCurrentUid: () => 501,
    getCurrentUsername: () => "testuser",
    getPreferences: () =>
      Promise.resolve({ enabled: false, cadence: "daily" as const }),
    getSchedulerStatus: () => Promise.resolve({ installed: false }),
    getLastLogEntry: () => Promise.resolve(null),
    now: () => new Date("2026-10-05T12:00:00.000Z"),
    ...overrides,
  };
}

Deno.test("checkInstallHealth: user-owned binary passes writability", async () => {
  const report = await checkInstallHealth(createFakeDeps());

  assertEquals(report.writable, "pass");
  assertEquals(report.writableMessage, "Binary is owned by current user");
  assertEquals(report.owner.isRoot, false);
  assertEquals(report.owner.uid, 501);
});

Deno.test("checkInstallHealth: root-owned binary fails writability when not writable", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    statBinary: () => Promise.resolve({ uid: 0 }),
    probeBinaryWritable: () => Promise.resolve(false),
  }));

  assertEquals(report.writable, "fail");
  assertEquals(
    report.writableMessage,
    "Binary is root-owned and not writable by current user",
  );
  assertEquals(report.owner.isRoot, true);
  assertEquals(report.owner.username, "root");
});

Deno.test("checkInstallHealth: root-owned but writable passes", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    statBinary: () => Promise.resolve({ uid: 0 }),
    probeBinaryWritable: () => Promise.resolve(true),
  }));

  assertEquals(report.writable, "pass");
  assertEquals(
    report.writableMessage,
    "Binary is root-owned but writable (e.g. group/other write)",
  );
});

Deno.test("checkInstallHealth: null uid falls back to probe", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    statBinary: () => Promise.resolve({ uid: null }),
    probeBinaryWritable: () => Promise.resolve(false),
  }));

  assertEquals(report.writable, "fail");
  assertEquals(
    report.writableMessage,
    "Binary is not writable by current user",
  );
});

Deno.test("checkInstallHealth: reports autoupdate status", async () => {
  const lastEntry = {
    timestamp: "2026-05-17T09:22:50.722Z",
    versionBefore: "20260509.235714.0-sha.7ace6b02",
    versionAfter: null,
    outcome: "error" as const,
    error: "Cannot update /usr/local/bin/swamp: permission denied",
  };

  const report = await checkInstallHealth(createFakeDeps({
    getPreferences: () =>
      Promise.resolve({ enabled: true, cadence: "daily" as const }),
    getSchedulerStatus: () => Promise.resolve({ installed: true }),
    getLastLogEntry: () => Promise.resolve(lastEntry),
  }));

  assertEquals(report.autoupdate.enabled, true);
  assertEquals(report.autoupdate.cadence, "daily");
  assertEquals(report.autoupdate.schedulerInstalled, true);
  assertEquals(report.autoupdate.lastEntry, lastEntry);
});

Deno.test("checkInstallHealth: includes version and path", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    binaryPath: "/home/user/.local/bin/swamp",
    currentVersion: "20260518.123456.0-sha.def789",
  }));

  assertEquals(report.binaryPath, "/home/user/.local/bin/swamp");
  assertEquals(report.currentVersion, "20260518.123456.0-sha.def789");
});

const ENABLED = () =>
  Promise.resolve({ enabled: true, cadence: "daily" as const });

function lastCheckAt(timestamp: string) {
  return () =>
    Promise.resolve({
      timestamp,
      versionBefore: "20260904.171927.0-sha.aaa",
      versionAfter: null,
      outcome: "up_to_date" as const,
    });
}

Deno.test("checkInstallHealth: a month-old last check is stale and a problem", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    getPreferences: ENABLED,
    getSchedulerStatus: () => Promise.resolve({ installed: true }),
    getLastLogEntry: lastCheckAt("2026-09-04T17:53:58.961Z"),
  }));

  assertEquals(report.autoupdate.lastCheckStale, true);
  assertEquals(report.autoupdate.lastCheckAgeDays, 30);
  assertEquals(hasInstallProblem(report), true);
});

Deno.test("checkInstallHealth: a recent last check is healthy", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    getPreferences: ENABLED,
    getSchedulerStatus: () =>
      Promise.resolve({
        installed: true,
        runtime: {
          running: false,
          lastExitCode: 0,
          needsRepair: false,
          pinnedToBinary: true,
        },
      }),
    getLastLogEntry: lastCheckAt("2026-10-05T00:00:00.000Z"),
  }));

  assertEquals(report.autoupdate.lastCheckStale, false);
  assertEquals(report.autoupdate.schedulerLastExitCode, 0);
  assertEquals(report.autoupdate.schedulerNeedsRepair, false);
  assertEquals(hasInstallProblem(report), false);
});

Deno.test("checkInstallHealth: a job launchd refuses to start is a problem", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    getPreferences: ENABLED,
    getSchedulerStatus: () =>
      Promise.resolve({
        installed: true,
        runtime: {
          running: false,
          lastExitCode: 78,
          needsRepair: true,
          pinnedToBinary: true,
        },
      }),
    getLastLogEntry: lastCheckAt("2026-10-05T00:00:00.000Z"),
  }));

  assertEquals(report.autoupdate.schedulerLastExitCode, 78);
  assertEquals(report.autoupdate.schedulerNeedsRepair, true);
  assertEquals(hasInstallProblem(report), true);
});

Deno.test("checkInstallHealth: a non-zero last exit is a problem", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    getPreferences: ENABLED,
    getSchedulerStatus: () =>
      Promise.resolve({
        installed: true,
        runtime: {
          running: false,
          lastExitCode: 1,
          needsRepair: false,
          pinnedToBinary: false,
        },
      }),
    getLastLogEntry: lastCheckAt("2026-10-05T00:00:00.000Z"),
  }));

  assertEquals(hasInstallProblem(report), true);
});

Deno.test("checkInstallHealth: no runtime omits the exit code", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    getPreferences: ENABLED,
    getSchedulerStatus: () => Promise.resolve({ installed: true }),
  }));

  assertEquals("schedulerLastExitCode" in report.autoupdate, false);
  assertEquals(report.autoupdate.schedulerNeedsRepair, false);
  assertEquals(report.autoupdate.lastCheckStale, false);
  assertEquals(hasInstallProblem(report), false);
});

Deno.test("hasInstallProblem: stale or failing scheduler ignored when autoupdate is off", async () => {
  const report = await checkInstallHealth(createFakeDeps({
    getSchedulerStatus: () =>
      Promise.resolve({
        installed: true,
        runtime: {
          running: false,
          lastExitCode: 78,
          needsRepair: true,
          pinnedToBinary: true,
        },
      }),
    getLastLogEntry: lastCheckAt("2026-09-04T17:53:58.961Z"),
  }));

  assertEquals(hasInstallProblem(report), false);
});
