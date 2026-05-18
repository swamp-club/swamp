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
  checkInstallHealth,
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
