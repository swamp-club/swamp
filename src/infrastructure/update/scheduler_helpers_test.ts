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
import {
  buildService,
  buildTimer,
  escapeSystemdPath,
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
