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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { WorkerDaemonStatus } from "../../domain/worker/worker_daemon_scheduler.ts";
import {
  renderWorkerDaemonDisabled,
  renderWorkerDaemonEnabled,
  renderWorkerDaemonStatus,
} from "./worker_daemon_output.ts";

function captureLogs(run: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

Deno.test("renderWorkerDaemonEnabled: json mode outputs enabled true with service mode", () => {
  const output = captureLogs(() => renderWorkerDaemonEnabled("json", "user"));
  const parsed = JSON.parse(output);
  assertEquals(parsed, { enabled: true, serviceMode: "user" });
});

Deno.test("renderWorkerDaemonEnabled: json mode system service", () => {
  const output = captureLogs(() => renderWorkerDaemonEnabled("json", "system"));
  const parsed = JSON.parse(output);
  assertEquals(parsed, { enabled: true, serviceMode: "system" });
});

Deno.test("renderWorkerDaemonEnabled: log mode mentions worker daemon", () => {
  const output = captureLogs(() => renderWorkerDaemonEnabled("log", "user"));
  assertStringIncludes(stripAnsiCode(output), "Worker daemon enabled");
  assertStringIncludes(stripAnsiCode(output), "user service");
});

Deno.test("renderWorkerDaemonDisabled: json mode outputs enabled false with service mode", () => {
  const output = captureLogs(() => renderWorkerDaemonDisabled("json", "user"));
  const parsed = JSON.parse(output);
  assertEquals(parsed, { enabled: false, serviceMode: "user" });
});

Deno.test("renderWorkerDaemonDisabled: log mode mentions disabled", () => {
  const output = captureLogs(() => renderWorkerDaemonDisabled("log", "system"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Worker daemon disabled");
  assertStringIncludes(stripped, "system service");
});

Deno.test("renderWorkerDaemonStatus: json mode outputs full status with service mode", () => {
  const status: WorkerDaemonStatus = {
    enabled: true,
    running: true,
    pid: 1234,
    logPath: "/var/log/swamp",
  };
  const output = captureLogs(() =>
    renderWorkerDaemonStatus(status, "json", "user")
  );
  const parsed = JSON.parse(output);
  assertEquals(parsed, { ...status, serviceMode: "user" });
});

Deno.test("renderWorkerDaemonStatus: log mode shows not configured when disabled", () => {
  const status: WorkerDaemonStatus = { enabled: false, running: false };
  const output = captureLogs(() =>
    renderWorkerDaemonStatus(status, "log", "user")
  );
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "not configured");
  assertStringIncludes(stripped, "user service");
});

Deno.test("renderWorkerDaemonStatus: log mode shows running when enabled and running", () => {
  const status: WorkerDaemonStatus = {
    enabled: true,
    running: true,
    pid: 5678,
  };
  const output = captureLogs(() =>
    renderWorkerDaemonStatus(status, "log", "system")
  );
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "running");
  assertStringIncludes(stripped, "5678");
  assertStringIncludes(stripped, "system service");
});

Deno.test("renderWorkerDaemonStatus: log mode shows stopped when enabled but not running", () => {
  const status: WorkerDaemonStatus = { enabled: true, running: false };
  const output = captureLogs(() =>
    renderWorkerDaemonStatus(status, "log", "user")
  );
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "stopped");
});
