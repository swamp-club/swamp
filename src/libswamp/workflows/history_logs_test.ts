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
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { collect } from "../testing.ts";
import {
  FAKE_REAPED_CUTOFF,
  fakeWatermarks,
} from "../retention/reaped_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowHistoryLogs,
  type WorkflowHistoryLogsDeps,
  type WorkflowHistoryLogsEvent,
} from "./history_logs.ts";
import {
  findSpan,
  isChildOf,
  withCapturedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";

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
        matches: [
          { id: "run-1", run: makeRun(makeWorkflow()) },
          { id: "run-2", run: makeRun(makeWorkflow()) },
        ],
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

Deno.test("workflowHistoryLogs acts on a passed reference without looking the argument up", async () => {
  const refused = () =>
    Promise.reject(new Error("the argument must not be looked up again"));
  const deps = makeDeps({
    isPartialId: () => {
      throw new Error("the argument must not be parsed again");
    },
    matchRunByPartialId: refused,
    findWorkflow: refused,
    findLatestRun: refused,
  });
  const workflow = makeWorkflow();
  const run = makeRun(workflow);
  const events = await collect<WorkflowHistoryLogsEvent>(
    workflowHistoryLogs(createLibSwampContext(), deps, {
      runIdOrWorkflow: "my-wf",
      repoDir: "/tmp",
      reference: { kind: "workflow", workflow, latest: run },
    }),
  );
  const completed = events[1] as Extract<
    WorkflowHistoryLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.type, "no_log_file");
});

Deno.test("workflowHistoryLogs: a missing run says runs before the retention cutoff were reaped", async () => {
  const deps = makeDeps({
    isPartialId: () => false,
    findWorkflow: () => Promise.resolve(null),
    retentionWatermarks: fakeWatermarks(["workflowRuns"]),
  });
  const events = await collect<WorkflowHistoryLogsEvent>(
    workflowHistoryLogs(createLibSwampContext(), deps, {
      runIdOrWorkflow: "abc",
      repoDir: "/repo",
    }),
  );
  const last = events[events.length - 1] as Extract<
    WorkflowHistoryLogsEvent,
    { kind: "error" }
  >;
  assertEquals(last.error.code, "not_found");
  assertEquals(
    last.error.message,
    `No workflow run or workflow found: abc; runs before ${FAKE_REAPED_CUTOFF} have been reaped by retention (14d)`,
  );
  assertEquals(
    (last.error.details as Record<string, unknown>).retention,
    "14d",
  );
});

Deno.test("workflowHistoryLogs: without a watermark repository the not-found is unchanged", async () => {
  const deps = makeDeps({
    isPartialId: () => false,
    findWorkflow: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowHistoryLogsEvent>(
    workflowHistoryLogs(createLibSwampContext(), deps, {
      runIdOrWorkflow: "abc",
      repoDir: "/repo",
    }),
  );
  const last = events[events.length - 1] as Extract<
    WorkflowHistoryLogsEvent,
    { kind: "error" }
  >;
  assertEquals(last.error.message, "No workflow run or workflow found: abc");
});

const LOGS_SPAN = "swamp.workflow.history.logs";

Deno.test("workflowHistoryLogs: records the argument, the tail, the run and the lines returned on the span", async () => {
  const workflow = makeWorkflow();
  const run = makeRun(workflow, { logFile: "/tmp/log.txt" });
  let tailAsked: number | undefined;
  const deps = makeDeps({
    matchRunByPartialId: () =>
      Promise.resolve({ status: "found" as const, match: run }),
    readLogFile: (_path, opts) => {
      tailAsked = opts?.tail;
      return Promise.resolve({
        lines: ["one", "two", "three"],
        path: "/tmp/log.txt",
      });
    },
  });
  await withCapturedSpans(async (spans) => {
    const events = await collect<WorkflowHistoryLogsEvent>(
      workflowHistoryLogs(createLibSwampContext(), deps, {
        runIdOrWorkflow: "abc123",
        repoDir: "/tmp",
        tail: 3,
      }),
    );
    assertEquals(events[1].kind, "completed");
    assertEquals(tailAsked, 3);
    const span = findSpan(spans, LOGS_SPAN);
    assertEquals(span.attributes["workflow.id_or_name"], "abc123");
    assertEquals(span.attributes["logs.tail"], 3);
    assertEquals(span.attributes["workflow.name"], run.workflowName);
    assertEquals(span.attributes["workflow.id"], run.workflowId);
    assertEquals(span.attributes["workflow.run_id"], run.id);
    assertEquals(span.attributes["logs.lines_returned"], 3);
    const resolve = findSpan(spans, "swamp.workflow.run_reference.resolve");
    assertEquals(isChildOf(resolve, span), true);
  });
});

Deno.test("workflowHistoryLogs: records no tail on the span when none is given", async () => {
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowHistoryLogsEvent>(
      workflowHistoryLogs(createLibSwampContext(), makeDeps(), {
        runIdOrWorkflow: "abc123",
        repoDir: "/tmp",
      }),
    );
    const span = findSpan(spans, LOGS_SPAN);
    assertEquals("logs.tail" in span.attributes, false);
    assertEquals(span.attributes["logs.lines_returned"], 2);
  });
});

Deno.test("workflowHistoryLogs: records zero lines returned on the span for an empty log", async () => {
  const deps = makeDeps({
    readLogFile: () => Promise.resolve({ lines: [], path: "/tmp/log.txt" }),
  });
  await withCapturedSpans(async (spans) => {
    const events = await collect<WorkflowHistoryLogsEvent>(
      workflowHistoryLogs(createLibSwampContext(), deps, {
        runIdOrWorkflow: "abc123",
        repoDir: "/tmp",
      }),
    );
    const completed = events[1] as Extract<
      WorkflowHistoryLogsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.data.type, "empty_log");
    const span = findSpan(spans, LOGS_SPAN);
    assertEquals(span.attributes["logs.lines_returned"], 0);
  });
});

Deno.test("workflowHistoryLogs: records the run but no lines returned on the span when the run has no log file", async () => {
  const run = makeRun(makeWorkflow());
  const deps = makeDeps({
    matchRunByPartialId: () =>
      Promise.resolve({ status: "found" as const, match: run }),
    readLogFile: () => Promise.reject(new Error("no log file to read")),
  });
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowHistoryLogsEvent>(
      workflowHistoryLogs(createLibSwampContext(), deps, {
        runIdOrWorkflow: "abc123",
        repoDir: "/tmp",
      }),
    );
    const span = findSpan(spans, LOGS_SPAN);
    assertEquals(span.attributes["workflow.run_id"], run.id);
    assertEquals("logs.lines_returned" in span.attributes, false);
  });
});

Deno.test("workflowHistoryLogs: records no run on the span when nothing is found", async () => {
  const deps = makeDeps({
    isPartialId: () => false,
    findWorkflow: () => Promise.resolve(null),
  });
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowHistoryLogsEvent>(
      workflowHistoryLogs(createLibSwampContext(), deps, {
        runIdOrWorkflow: "missing-wf",
        repoDir: "/tmp",
      }),
    );
    const span = findSpan(spans, LOGS_SPAN);
    assertEquals(span.attributes["workflow.id_or_name"], "missing-wf");
    assertEquals("workflow.run_id" in span.attributes, false);
    assertEquals("workflow.name" in span.attributes, false);
    assertEquals("logs.lines_returned" in span.attributes, false);
  });
});

Deno.test("workflowHistoryLogs: records a long argument on the span cut to 256 characters", async () => {
  const long = `wf-${crypto.randomUUID()}-`.padEnd(300, "x");
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowHistoryLogsEvent>(
      workflowHistoryLogs(
        createLibSwampContext(),
        makeDeps({ isPartialId: () => false }),
        { runIdOrWorkflow: long, repoDir: "/tmp" },
      ),
    );
    const span = findSpan(spans, LOGS_SPAN);
    assertEquals(span.attributes["workflow.id_or_name"], long.slice(0, 256));
  });
});
