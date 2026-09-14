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
import type { ServiceStatus } from "../../domain/serve/service_scheduler.ts";
import {
  renderDaemonDisabled,
  renderDaemonEnabled,
  renderDaemonStatus,
} from "./serve_daemon_output.ts";

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

Deno.test("renderDaemonEnabled: json mode outputs enabled true with service mode", () => {
  const output = captureLogs(() => renderDaemonEnabled("json", "user"));
  const parsed = JSON.parse(output);
  assertEquals(parsed, { enabled: true, serviceMode: "user" });
});

Deno.test("renderDaemonEnabled: json mode system service", () => {
  const output = captureLogs(() => renderDaemonEnabled("json", "system"));
  const parsed = JSON.parse(output);
  assertEquals(parsed, { enabled: true, serviceMode: "system" });
});

Deno.test("renderDaemonEnabled: log mode user service says runs while logged in", () => {
  const output = captureLogs(() => renderDaemonEnabled("log", "user"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Daemon enabled as user service");
  assertStringIncludes(stripped, "runs while you are logged in");
  assertFalse(stripped.includes("starts automatically at boot"));
});

Deno.test("renderDaemonEnabled: log mode user service shows boot hint", () => {
  const output = captureLogs(() => renderDaemonEnabled("log", "user"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "loginctl enable-linger");
});

Deno.test("renderDaemonEnabled: log mode system service says starts at boot", () => {
  const output = captureLogs(() => renderDaemonEnabled("log", "system"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Daemon enabled as system service");
  assertStringIncludes(stripped, "starts automatically at boot");
  assertFalse(stripped.includes("runs while you are logged in"));
});

Deno.test("renderDaemonEnabled: log mode system service does not show boot hint", () => {
  const output = captureLogs(() => renderDaemonEnabled("log", "system"));
  const stripped = stripAnsiCode(output);
  assertFalse(stripped.includes("loginctl enable-linger"));
});

Deno.test("renderDaemonDisabled: json mode outputs enabled false with service mode", () => {
  const output = captureLogs(() => renderDaemonDisabled("json", "user"));
  const parsed = JSON.parse(output);
  assertEquals(parsed, { enabled: false, serviceMode: "user" });
});

Deno.test("renderDaemonDisabled: log mode mentions disabled", () => {
  const output = captureLogs(() => renderDaemonDisabled("log", "system"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Daemon disabled");
  assertStringIncludes(stripped, "system service");
});

Deno.test("renderDaemonStatus: json mode outputs full status with service mode", () => {
  const status: ServiceStatus = {
    enabled: true,
    running: true,
    pid: 1234,
    logPath: "/var/log/swamp",
  };
  const output = captureLogs(() => renderDaemonStatus(status, "json", "user"));
  const parsed = JSON.parse(output);
  assertEquals(parsed, { ...status, serviceMode: "user" });
});

Deno.test("renderDaemonStatus: log mode shows not configured when disabled", () => {
  const status: ServiceStatus = { enabled: false, running: false };
  const output = captureLogs(() => renderDaemonStatus(status, "log", "user"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "not configured");
  assertStringIncludes(stripped, "user service");
});

Deno.test("renderDaemonStatus: log mode user service shows startup on login", () => {
  const status: ServiceStatus = { enabled: true, running: true, pid: 5678 };
  const output = captureLogs(() => renderDaemonStatus(status, "log", "user"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Startup: on login");
});

Deno.test("renderDaemonStatus: log mode system service shows startup at boot", () => {
  const status: ServiceStatus = { enabled: true, running: true, pid: 5678 };
  const output = captureLogs(() => renderDaemonStatus(status, "log", "system"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "Startup: at boot");
});

Deno.test("renderDaemonStatus: log mode shows running when enabled and running", () => {
  const status: ServiceStatus = {
    enabled: true,
    running: true,
    pid: 5678,
  };
  const output = captureLogs(() => renderDaemonStatus(status, "log", "system"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "running");
  assertStringIncludes(stripped, "5678");
  assertStringIncludes(stripped, "system service");
});

Deno.test("renderDaemonStatus: log mode shows stopped when enabled but not running", () => {
  const status: ServiceStatus = { enabled: true, running: false };
  const output = captureLogs(() => renderDaemonStatus(status, "log", "user"));
  const stripped = stripAnsiCode(output);
  assertStringIncludes(stripped, "stopped");
});
