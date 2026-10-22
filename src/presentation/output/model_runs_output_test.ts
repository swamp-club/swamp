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
import { ActiveRun } from "../../domain/models/active_run.ts";
import type { DoctorRunProgress } from "./model_runs_output.ts";
import type { WebhookAdmissionSnapshot } from "../../domain/remote/run_progress.ts";
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

Deno.test("doctor output: preserves live blocked-step diagnostics in both modes", () => {
  const run = ActiveRun.createWorkflowRun({
    id: "run",
    workflowName: "workflow",
    pid: 1,
    hostname: "host",
  });
  const diagnostics: DoctorRunProgress = {
    progressScope: "process_local_admitted_steps",
    progress: [{
      runId: "run",
      workflow: "workflow",
      job: "job",
      step: "step",
      phase: "waiting_for_lock",
      phaseElapsedMs: 1200,
      lastProgressAt: "2026-10-22T10:00:00Z",
      resource: "resource",
      holderKnown: true,
      holderRunId: "holder",
      traceId: "trace",
      worker: "worker",
    }],
  };
  const progress = new Map([[run.id, diagnostics]]);
  const parsed = JSON.parse(
    captureLogs(() =>
      writeDoctorRunsJson(
        1,
        [run],
        [],
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        progress,
      )
    ),
  );
  assertEquals(parsed.activeRuns[0].progress, diagnostics.progress);
  assertEquals(parsed.activeRuns[0].progressScope, diagnostics.progressScope);
  const output = captureLogs(() =>
    writeDoctorRunsLog(
      [run],
      [],
      0,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      progress,
    )
  );
  for (
    const value of [
      "waiting_for_lock",
      "holder run: holder",
      "resource",
      "Trace: trace",
      "Worker: worker",
      "2026-10-22T10:00:00Z",
    ]
  ) assertStringIncludes(output, value);
});

Deno.test("writeDoctorRunsJson: reports orphaned method runs when counted", () => {
  const parsed = JSON.parse(
    captureLogs(() => writeDoctorRunsJson(0, [], [], 0, 0, 0, 2, 2)),
  );
  assertEquals(parsed.orphanedMethodRuns, 2);
  assertEquals(parsed.orphanedMethodReaped, 2);
  assertEquals(parsed.orphanedWorkflowRuns, 0);
});

Deno.test("doctor output: a queued receipt is visible before any tracked run exists", () => {
  const admissions: WebhookAdmissionSnapshot[] = [{
    receiptId: "receipt",
    workflow: "workflow",
    phase: "queued",
    phaseElapsedMs: 1000,
    enqueuedAt: "2026-10-22T10:00:00Z",
    lastProgressAt: "2026-10-22T10:00:00Z",
    blockingRunIds: [],
    unknownBlockers: 1,
  }];
  const json = JSON.parse(
    captureLogs(() =>
      writeDoctorRunsJson(
        0,
        [],
        [],
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        admissions,
      )
    ),
  );
  assertEquals(json.webhookAdmissions, admissions);
  const log = captureLogs(() =>
    writeDoctorRunsLog(
      [],
      [],
      0,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      admissions,
    )
  );
  assertStringIncludes(log, "receipt (workflow): queued");
  assertStringIncludes(log, "Holders without a run ID yet: 1");
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
