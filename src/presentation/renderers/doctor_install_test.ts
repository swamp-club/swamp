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
import { createDoctorInstallRenderer } from "./doctor_install.ts";
import type { InstallHealthReport } from "../../domain/update/install_health.ts";

function createHealthyReport(): InstallHealthReport {
  return {
    binaryPath: "/home/user/.local/bin/swamp",
    owner: { uid: 501, username: "testuser", isRoot: false },
    currentVersion: "20260518.000000.0-sha.abc123",
    writable: "pass",
    writableMessage: "Binary is owned by current user",
    autoupdate: {
      enabled: true,
      cadence: "daily",
      schedulerInstalled: true,
      lastEntry: {
        timestamp: "2026-05-18T09:00:00.000Z",
        versionBefore: "20260517.000000.0-sha.old",
        versionAfter: "20260518.000000.0-sha.abc123",
        outcome: "updated",
      },
    },
  };
}

function createUnhealthyReport(): InstallHealthReport {
  return {
    binaryPath: "/usr/local/bin/swamp",
    owner: { uid: 0, username: "root", isRoot: true },
    currentVersion: "20260509.235714.0-sha.7ace6b02",
    writable: "fail",
    writableMessage: "Binary is root-owned and not writable by current user",
    autoupdate: {
      enabled: true,
      cadence: "daily",
      schedulerInstalled: true,
      lastEntry: {
        timestamp: "2026-05-17T09:22:50.722Z",
        versionBefore: "20260509.235714.0-sha.7ace6b02",
        versionAfter: null,
        outcome: "error",
        error:
          "Cannot update /usr/local/bin/swamp: permission denied. Re-run with: sudo swamp update",
      },
    },
  };
}

Deno.test("createDoctorInstallRenderer: json mode renders healthy report", () => {
  const renderer = createDoctorInstallRenderer("json");
  const report = createHealthyReport();

  const output = captureConsoleLog(() => renderer.render(report));

  assertEquals(renderer.overallStatus, "healthy");
  const parsed = JSON.parse(output);
  assertEquals(parsed.overallStatus, "healthy");
  assertEquals(parsed.binaryPath, "/home/user/.local/bin/swamp");
  assertEquals(parsed.writable, "pass");
});

Deno.test("createDoctorInstallRenderer: json mode renders unhealthy report", () => {
  const renderer = createDoctorInstallRenderer("json");
  const report = createUnhealthyReport();

  const output = captureConsoleLog(() => renderer.render(report));

  assertEquals(renderer.overallStatus, "unhealthy");
  const parsed = JSON.parse(output);
  assertEquals(parsed.overallStatus, "unhealthy");
  assertEquals(parsed.writable, "fail");
  assertEquals(parsed.owner.isRoot, true);
});

Deno.test("createDoctorInstallRenderer: log mode shows pass for healthy install", () => {
  const renderer = createDoctorInstallRenderer("log");
  const report = createHealthyReport();

  renderer.render(report);

  assertEquals(renderer.overallStatus, "healthy");
});

Deno.test("createDoctorInstallRenderer: log mode shows fail for unhealthy install", () => {
  const renderer = createDoctorInstallRenderer("log");
  const report = createUnhealthyReport();

  renderer.render(report);

  assertEquals(renderer.overallStatus, "unhealthy");
});

function captureConsoleLog(fn: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}
