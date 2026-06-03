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
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertPathStringIncludes } from "../persistence/path_test_helpers.ts";
import {
  autoupdateLogDir,
  buildPlist,
  cadenceFromInterval,
  escapeXml,
} from "./launchd_scheduler.ts";
import { detectBinaryOwnership } from "./scheduler_factory.ts";
import {
  buildService,
  buildTimer,
  escapeSystemdPath,
  systemdUnitDir,
} from "./systemd_scheduler.ts";
import {
  cadenceFromSchedule,
  cronLogPath,
  cronSchedule,
  escapeShellPath,
} from "./cron_scheduler.ts";

Deno.test("escapeXml: escapes all five predefined entities", () => {
  assertEquals(escapeXml("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

Deno.test("escapeXml: passes through clean paths", () => {
  assertEquals(escapeXml("/usr/local/bin/swamp"), "/usr/local/bin/swamp");
});

Deno.test("buildPlist: contains binary path and daily interval", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily");
  assertStringIncludes(plist, "<string>/usr/local/bin/swamp</string>");
  assertStringIncludes(plist, "<integer>86400</integer>");
});

Deno.test("buildPlist: contains weekly interval", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "weekly");
  assertStringIncludes(plist, "<integer>604800</integer>");
});

Deno.test("buildPlist: escapes special chars in path", () => {
  const plist = buildPlist('/opt/my "app/swamp', "daily");
  assertStringIncludes(plist, "&quot;");
});

Deno.test("cadenceFromInterval: daily for 86400", () => {
  assertEquals(cadenceFromInterval(86400), "daily");
});

Deno.test("cadenceFromInterval: weekly for 604800", () => {
  assertEquals(cadenceFromInterval(604800), "weekly");
});

Deno.test("escapeSystemdPath: escapes percent specifiers", () => {
  assertEquals(
    escapeSystemdPath("/home/user/100%done"),
    "/home/user/100%%done",
  );
});

Deno.test("escapeSystemdPath: escapes backslashes and quotes", () => {
  assertEquals(
    escapeSystemdPath('path with "quotes"'),
    'path with \\"quotes\\"',
  );
  assertEquals(
    escapeSystemdPath("path\\with\\backslash"),
    "path\\\\with\\\\backslash",
  );
});

Deno.test("buildService: contains quoted binary path", () => {
  const service = buildService("/usr/local/bin/swamp");
  assertStringIncludes(
    service,
    'ExecStart="/usr/local/bin/swamp" update --background',
  );
});

Deno.test("buildService: escapes quotes in path", () => {
  const service = buildService('/opt/my "app/swamp');
  assertStringIncludes(service, 'ExecStart="/opt/my \\"app/swamp"');
});

Deno.test("buildTimer: daily calendar", () => {
  const timer = buildTimer("daily");
  assertStringIncludes(timer, "OnCalendar=daily");
});

Deno.test("buildTimer: weekly calendar", () => {
  const timer = buildTimer("weekly");
  assertStringIncludes(timer, "OnCalendar=weekly");
});

Deno.test("cronSchedule: daily schedule", () => {
  assertEquals(cronSchedule("daily"), "0 9 * * *");
});

Deno.test("cronSchedule: weekly schedule", () => {
  assertEquals(cronSchedule("weekly"), "0 9 * * 1");
});

Deno.test("cadenceFromSchedule: detects daily", () => {
  assertEquals(cadenceFromSchedule("0 9 * * *"), "daily");
});

Deno.test("cadenceFromSchedule: detects weekly", () => {
  assertEquals(cadenceFromSchedule("0 9 * * 1"), "weekly");
});

Deno.test("escapeShellPath: escapes single quotes", () => {
  assertEquals(escapeShellPath("it's a path"), "it'\\''s a path");
});

Deno.test("escapeShellPath: passes through clean paths", () => {
  assertEquals(escapeShellPath("/usr/local/bin/swamp"), "/usr/local/bin/swamp");
});

Deno.test("buildPlist: uses log file paths instead of /dev/null", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily");
  assertStringIncludes(plist, "autoupdate.stdout.log");
  assertStringIncludes(plist, "autoupdate.stderr.log");
  assertEquals(plist.includes("/dev/null"), false);
});

Deno.test("autoupdateLogDir: returns an absolute path under Library/Logs", () => {
  const dir = autoupdateLogDir();
  assertPathStringIncludes(dir, "Library/Logs/swamp");
});

Deno.test("cronLogPath: returns an absolute path", () => {
  const path = cronLogPath();
  assertNotEquals(path, "");
  assertPathStringIncludes(path, "autoupdate-cron.log");
});

// --- LaunchDaemon (daemon mode) tests ---

Deno.test("buildPlist: daemon mode includes UserName key", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily", "daemon");
  assertStringIncludes(plist, "<key>UserName</key>");
  assertStringIncludes(plist, "<string>root</string>");
});

Deno.test("buildPlist: agent mode does not include UserName key", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily", "agent");
  assertEquals(plist.includes("UserName"), false);
});

Deno.test("buildPlist: default mode is agent (no UserName)", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily");
  assertEquals(plist.includes("UserName"), false);
});

Deno.test("buildPlist: daemon mode uses system log path", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily", "daemon");
  assertPathStringIncludes(plist, "var/log/swamp/autoupdate.stdout.log");
  assertPathStringIncludes(plist, "var/log/swamp/autoupdate.stderr.log");
});

Deno.test("buildPlist: agent mode uses user log path", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily", "agent");
  assertPathStringIncludes(plist, "Library/Logs/swamp/autoupdate.stdout.log");
});

Deno.test("buildPlist: daemon mode still contains binary path and interval", () => {
  const plist = buildPlist("/usr/local/bin/swamp", "weekly", "daemon");
  assertStringIncludes(plist, "<string>/usr/local/bin/swamp</string>");
  assertStringIncludes(plist, "<integer>604800</integer>");
});

Deno.test("autoupdateLogDir: daemon mode returns /var/log/swamp", () => {
  assertPathStringIncludes(autoupdateLogDir("daemon"), "var/log/swamp");
});

Deno.test("autoupdateLogDir: agent mode returns user Library path", () => {
  const dir = autoupdateLogDir("agent");
  assertPathStringIncludes(dir, "Library/Logs/swamp");
});

// --- Binary ownership detection tests ---

Deno.test("detectBinaryOwnership: user-owned binary returns agent", () => {
  assertEquals(detectBinaryOwnership(501, 501), "agent");
});

Deno.test("detectBinaryOwnership: root-owned binary with non-root user returns daemon", () => {
  assertEquals(detectBinaryOwnership(0, 501), "daemon");
});

Deno.test("detectBinaryOwnership: binary owned by different non-root user returns foreign", () => {
  assertEquals(detectBinaryOwnership(502, 501), "foreign");
});

Deno.test("detectBinaryOwnership: null binary uid returns agent", () => {
  assertEquals(detectBinaryOwnership(null, 501), "agent");
});

Deno.test("detectBinaryOwnership: null current uid returns agent", () => {
  assertEquals(detectBinaryOwnership(0, null), "agent");
});

Deno.test("detectBinaryOwnership: both null returns agent", () => {
  assertEquals(detectBinaryOwnership(null, null), "agent");
});

Deno.test("detectBinaryOwnership: root-owned binary with root user returns daemon", () => {
  assertEquals(detectBinaryOwnership(0, 0), "daemon");
});

// --- Systemd system mode tests (Linux/macOS only — systemdUserDir needs HOME) ---

Deno.test({
  name: "systemdUnitDir: agent mode returns user config path",
  ignore: Deno.build.os === "windows",
  fn() {
    const dir = systemdUnitDir("agent");
    assertPathStringIncludes(dir, "systemd/user");
  },
});

Deno.test("systemdUnitDir: daemon mode returns /etc/systemd/system", () => {
  assertEquals(systemdUnitDir("daemon"), "/etc/systemd/system");
});

// --- Cron root mode tests ---

Deno.test({
  name: "cronLogPath: agent mode returns user data dir path",
  ignore: Deno.build.os === "windows",
  fn() {
    const path = cronLogPath("agent");
    assertPathStringIncludes(path, "autoupdate-cron.log");
    assertEquals(path.startsWith("/var/log/swamp"), false);
  },
});

Deno.test("cronLogPath: daemon mode returns /var/log/swamp path", () => {
  assertPathStringIncludes(cronLogPath("daemon"), "var/log/swamp");
  assertPathStringIncludes(cronLogPath("daemon"), "autoupdate-cron.log");
});
