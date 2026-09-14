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
import { assertFalse } from "@std/assert/false";
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

Deno.test("renderWorkerDaemonEnabled: log mode user service says runs while logged in", () => {
  const output = captureLogs(() => renderWorkerDaemonEnabled("log", "user"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Worker daemon enabled");
  assertStringIncludes(stripped, "user service");
  assertStringIncludes(stripped, "runs while you are logged in");
  assertStringIncludes(stripped, "loginctl enable-linger");
});

Deno.test("renderWorkerDaemonEnabled: log mode system service says starts at boot", () => {
  const output = captureLogs(() => renderWorkerDaemonEnabled("log", "system"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Worker daemon enabled");
  assertStringIncludes(stripped, "system service");
  assertStringIncludes(stripped, "starts automatically at boot");
  assertFalse(stripped.includes("runs while you are logged in"));
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

Deno.test("renderWorkerDaemonStatus: log mode user service shows startup on login", () => {
  const status: WorkerDaemonStatus = { enabled: true, running: true, pid: 42 };
  const output = captureLogs(() =>
    renderWorkerDaemonStatus(status, "log", "user")
  );
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Startup: on login");
});

Deno.test("renderWorkerDaemonStatus: log mode system service shows startup at boot", () => {
  const status: WorkerDaemonStatus = { enabled: true, running: true, pid: 42 };
  const output = captureLogs(() =>
    renderWorkerDaemonStatus(status, "log", "system")
  );
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Startup: at boot");
});
