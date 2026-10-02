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
import {
  writeDoctorRunsJson,
  writeDoctorRunsLog,
} from "./model_runs_output.ts";

function captureLogs(fn: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

Deno.test("writeDoctorRunsJson: reports orphaned method runs when counted", () => {
  const parsed = JSON.parse(
    captureLogs(() => writeDoctorRunsJson(0, [], [], 0, 0, 0, 2, 2)),
  );
  assertEquals(parsed.orphanedMethodRuns, 2);
  assertEquals(parsed.orphanedMethodReaped, 2);
  assertEquals(parsed.orphanedWorkflowRuns, 0);
});

Deno.test("writeDoctorRunsJson: omits the method run keys when not counted, as for a server", () => {
  const parsed = JSON.parse(
    captureLogs(() => writeDoctorRunsJson(0, [], [], 0, 1, 0)),
  );
  assertEquals("orphanedMethodRuns" in parsed, false);
  assertEquals("orphanedMethodReaped" in parsed, false);
});

Deno.test("writeDoctorRunsLog: suggests --fix for orphaned method runs", () => {
  const output = captureLogs(() =>
    writeDoctorRunsLog([], [], 0, false, 0, 0, 3, 0)
  );
  assertStringIncludes(output, "3 orphaned method run(s) whose owner is gone:");
  assertStringIncludes(
    output,
    "Run with --fix to cancel orphaned method runs.",
  );
});

Deno.test("writeDoctorRunsLog: reports cancelled orphaned method runs with --fix", () => {
  const output = captureLogs(() =>
    writeDoctorRunsLog([], [], 0, true, 0, 0, 3, 3)
  );
  assertStringIncludes(output, "Cancelled 3 orphaned method run(s).");
});

Deno.test("writeDoctorRunsLog: no orphans or runs reads as nothing to report", () => {
  const output = captureLogs(() =>
    writeDoctorRunsLog([], [], 0, false, 0, 0, 0, 0)
  );
  assertEquals(output, "No active or stale runs.");
});

Deno.test("writeDoctorRunsJson and writeDoctorRunsLog: report a method-run check that failed", () => {
  const parsed = JSON.parse(
    captureLogs(() =>
      writeDoctorRunsJson(0, [], [], 0, 0, 0, 0, 0, "permission denied")
    ),
  );
  assertEquals(parsed.orphanedMethodError, "permission denied");

  const output = captureLogs(() =>
    writeDoctorRunsLog([], [], 0, true, 0, 0, 0, 0, "permission denied")
  );
  assertStringIncludes(
    output,
    "Could not check method runs for a gone owner: permission denied",
  );
});
