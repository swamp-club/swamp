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
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowHistoryLogs,
  type WorkflowHistoryLogsDeps,
  type WorkflowHistoryLogsEvent,
} from "./history_logs.ts";

function makeWorkflow(): Workflow {
  return Workflow.create({ name: "my-wf" });
}

function makeRun(
  workflow: Workflow,
  opts?: { logFile?: string },
): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  if (opts?.logFile) {
    run.setLogFile(opts.logFile);
  }
  return run;
}

function makeDeps(
  overrides?: Partial<WorkflowHistoryLogsDeps>,
): WorkflowHistoryLogsDeps {
  const workflow = makeWorkflow();
  const run = makeRun(workflow, { logFile: "/tmp/log.txt" });
  return {
    isPartialId: () => true,
    matchRunByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: run,
      }),
    findWorkflow: () => Promise.resolve(workflow),
    findLatestRun: () => Promise.resolve(run),
    readLogFile: () =>
      Promise.resolve({ lines: ["line1", "line2"], path: "/tmp/log.txt" }),
    toRelativePath: (_repoDir, path) => path,
    ...overrides,
  };
}

Deno.test("workflowHistoryLogs yields log data for valid run", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowHistoryLogsEvent>(
    workflowHistoryLogs(createLibSwampContext(), deps, {
      runIdOrWorkflow: "run-123",
      repoDir: "/tmp",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    WorkflowHistoryLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.type, "log");
});

Deno.test("workflowHistoryLogs yields no_log_file for pre-logFile runs", async () => {
  const workflow = makeWorkflow();
  const runWithoutLog = makeRun(workflow);
  const deps = makeDeps({
    matchRunByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: runWithoutLog,
      }),
  });
  const events = await collect<WorkflowHistoryLogsEvent>(
    workflowHistoryLogs(createLibSwampContext(), deps, {
      runIdOrWorkflow: "run-old",
      repoDir: "/tmp",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistoryLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.type, "no_log_file");
});

Deno.test("workflowHistoryLogs falls through to workflow name lookup", async () => {
  const deps = makeDeps({
    isPartialId: () => false,
  });
  const events = await collect<WorkflowHistoryLogsEvent>(
    workflowHistoryLogs(createLibSwampContext(), deps, {
      runIdOrWorkflow: "my-wf",
      repoDir: "/tmp",
    }),
  );

  assertEquals(events[1].kind, "completed");
});

Deno.test("workflowHistoryLogs yields error on ambiguous ID", async () => {
  const deps = makeDeps({
    matchRunByPartialId: () =>
      Promise.resolve({
        status: "ambiguous" as const,
        matches: [{ id: "run-1" }, { id: "run-2" }],
      }),
  });
  const events = await collect<WorkflowHistoryLogsEvent>(
    workflowHistoryLogs(createLibSwampContext(), deps, {
      runIdOrWorkflow: "run",
      repoDir: "/tmp",
    }),
  );

  assertEquals(events[1].kind, "error");
});
