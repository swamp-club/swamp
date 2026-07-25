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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { setColorEnabled } from "@std/fmt/colors";
import {
  consumeStream,
  type WorkflowRunEvent,
  type WorkflowRunView,
} from "../../libswamp/mod.ts";
import { createWorkflowRunRenderer } from "./workflow_run.ts";
import { UserError } from "../../domain/errors.ts";
import { AUTH_NUDGE_MESSAGE } from "../../domain/auth/auth_nudge.ts";

function makeRunView(
  status: "succeeded" | "failed",
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "test-pipeline",
    status,
    duration: 3600,
    jobs: [{
      name: "extract",
      status: status === "succeeded" ? "succeeded" : "failed",
      duration: 3200,
      steps: [{
        name: "fetch",
        status: status === "succeeded" ? "succeeded" : "failed",
        duration: 3200,
        error: status === "failed" ? "connection refused" : undefined,
        dataArtifacts: [{
          dataId: "d-1",
          name: "api-records",
          version: 1,
          tags: {},
          attributes: { total_records: 1247 },
        }],
      }],
    }],
  };
}

function simpleEvents(
  runView: WorkflowRunView,
): WorkflowRunEvent[] {
  return [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "extract", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "extract" },
    { kind: "step_started", jobId: "extract", stepId: "fetch" },
    {
      kind: "model_resolved",
      jobId: "extract",
      stepId: "fetch",
      modelName: "my-api",
      modelType: "command/shell",
      modelId: "m-1",
      methodName: "extract",
    },
    {
      kind: "method_executing",
      jobId: "extract",
      stepId: "fetch",
      modelName: "my-api",
      methodName: "extract",
    },
    {
      kind: "method_output",
      jobId: "extract",
      stepId: "fetch",
      modelName: "my-api",
      methodName: "extract",
      stream: "stdout",
      line: "Downloading records...",
    },
    {
      kind: "step_completed",
      jobId: "extract",
      stepId: "fetch",
    },
    { kind: "job_completed", jobId: "extract", status: runView.status },
    { kind: "completed", run: runView },
  ];
}

async function* toStream(
  events: WorkflowRunEvent[],
): AsyncGenerator<WorkflowRunEvent> {
  for (const event of events) {
    yield event;
  }
}

async function captureOutputAsync(
  fn: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  setColorEnabled(false);
  try {
    await fn();
  } finally {
    console.log = origLog;
    setColorEnabled(true);
  }
  return lines;
}

Deno.test("ConsoleWorkflowRunRenderer: succeeded run shows Starting, pipe output, Completed", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
  });
  const events = simpleEvents(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(renderer.workflowFailed(), false);
  const output = lines.join("\n");
  assertStringIncludes(output, "Starting");
  assertStringIncludes(output, "test-pipeline");
  assertStringIncludes(output, "extract");
  assertStringIncludes(output, "Downloading records...");
  assertStringIncludes(output, "Completed");
});

Deno.test("ConsoleWorkflowRunRenderer: failed run shows Failed with error", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
  });
  const runView = makeRunView("failed");
  const events = simpleEvents(runView);
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(renderer.workflowFailed(), true);
  const output = lines.join("\n");
  assertStringIncludes(output, "Failed");
  assertStringIncludes(output, "connection refused");
});

Deno.test("ConsoleWorkflowRunRenderer: pipe-prefixed output uses job name", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
  });
  const events = simpleEvents(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const extractLines = lines.filter((l) =>
    l.includes("extract") && l.includes("│")
  );
  assertEquals(extractLines.length > 0, true);
});

Deno.test("ConsoleWorkflowRunRenderer: method_output uses same style for stdout and stderr", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
  });
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "job1", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "s1" },
    {
      kind: "method_output",
      jobId: "job1",
      stepId: "s1",
      modelName: "m",
      methodName: "r",
      stream: "stdout",
      line: "stdout-line",
    },
    {
      kind: "method_output",
      jobId: "job1",
      stepId: "s1",
      modelName: "m",
      methodName: "r",
      stream: "stderr",
      line: "stderr-line",
    },
    { kind: "step_completed", jobId: "job1", stepId: "s1" },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run: makeRunView("succeeded") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "stdout-line");
  assertStringIncludes(output, "stderr-line");
});

Deno.test("ConsoleWorkflowRunRenderer: shows inline data artifacts", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
  });
  const events = simpleEvents(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Data produced");
  assertStringIncludes(output, "api-records");
  assertStringIncludes(output, "total_records");
});

Deno.test("ConsoleWorkflowRunRenderer: error event throws UserError", () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});

Deno.test("ConsoleWorkflowRunRenderer: shows auth nudge when not authenticated", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: false,
  });
  const events = simpleEvents(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertStringIncludes(lines.join("\n"), AUTH_NUDGE_MESSAGE);
});

Deno.test("ConsoleWorkflowRunRenderer: suppresses auth nudge when authenticated", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
  });
  const events = simpleEvents(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(lines.join("\n").includes(AUTH_NUDGE_MESSAGE), false);
});

Deno.test("ConsoleWorkflowRunRenderer: quiet mode buffers output and discards on success", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
    quiet: true,
  });
  const events = simpleEvents(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertEquals(output.includes("Downloading records..."), false);
  assertStringIncludes(output, "Completed");
});

Deno.test("ConsoleWorkflowRunRenderer: quiet mode replays buffer on step failure", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
    quiet: true,
  });
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "job1", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "s1" },
    {
      kind: "method_output",
      jobId: "job1",
      stepId: "s1",
      modelName: "m",
      methodName: "r",
      stream: "stdout",
      line: "important error context",
    },
    {
      kind: "step_failed",
      jobId: "job1",
      stepId: "s1",
      error: "process exited 1",
    },
    { kind: "job_completed", jobId: "job1", status: "failed" },
    { kind: "completed", run: makeRunView("failed") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "important error context");
  assertStringIncludes(output, "Failed");
});

Deno.test("ConsoleWorkflowRunRenderer: suspended workflow shows approval instructions", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "deploy", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "deploy" },
    {
      kind: "approval_requested",
      runId: "run-1",
      jobId: "deploy",
      stepId: "apply",
      prompt: "Review the plan",
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "deploy",
      stepId: "apply",
      prompt: "Review the plan",
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Suspended");
  assertStringIncludes(output, "swamp workflow approve");
  assertStringIncludes(output, "swamp workflow resume");
});

Deno.test("ConsoleWorkflowRunRenderer: cancelled run sets workflowFailed()", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [],
    },
    { kind: "cancelled", run: makeRunView("failed"), reason: "user interrupt" },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(renderer.workflowFailed(), true);
  assertStringIncludes(lines.join("\n"), "Cancelled");
  assertStringIncludes(lines.join("\n"), "user interrupt");
});

Deno.test("ConsoleWorkflowRunRenderer: forEach steps show [index] notation", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    isAuthenticated: true,
  });
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "extract", stepCount: 2, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "extract" },
    {
      kind: "step_started",
      jobId: "extract",
      stepId: "fetch-dev",
      forEachTemplate: "fetch",
      forEachIndex: 0,
    },
    {
      kind: "step_started",
      jobId: "extract",
      stepId: "fetch-prod",
      forEachTemplate: "fetch",
      forEachIndex: 1,
    },
    {
      kind: "method_output",
      jobId: "extract",
      stepId: "fetch-dev",
      modelName: "m",
      methodName: "r",
      stream: "stdout",
      line: "from dev",
    },
    {
      kind: "step_completed",
      jobId: "extract",
      stepId: "fetch-dev",
      forEachTemplate: "fetch",
      forEachIndex: 0,
    },
    {
      kind: "step_completed",
      jobId: "extract",
      stepId: "fetch-prod",
      forEachTemplate: "fetch",
      forEachIndex: 1,
    },
    { kind: "job_completed", jobId: "extract", status: "succeeded" },
    { kind: "completed", run: makeRunView("succeeded") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "fetch[0]");
  assertStringIncludes(output, "fetch[1]");
});

// --- JsonWorkflowRunRenderer tests ---

Deno.test("JsonWorkflowRunRenderer: intermediate events produce no output", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-pipeline",
    });
    const events: WorkflowRunEvent[] = [
      { kind: "validating_inputs" },
      { kind: "evaluating_workflow" },
      {
        kind: "started",
        runId: "run-1",
        workflowName: "test-pipeline",
        jobs: [],
      },
      { kind: "job_started", jobId: "job1" },
      { kind: "step_started", jobId: "job1", stepId: "s1" },
      {
        kind: "method_output",
        jobId: "job1",
        stepId: "s1",
        modelName: "m",
        methodName: "r",
        stream: "stdout",
        line: "hello",
      },
    ];
    for (const event of events) {
      const handler = renderer.handlers()[event.kind];
      // deno-lint-ignore no-explicit-any
      handler(event as any);
    }
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonWorkflowRunRenderer: completed serializes WorkflowRunView", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-pipeline",
    });
    const runView = makeRunView("succeeded");
    const events = simpleEvents(runView);
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.workflowName, "test-pipeline");
    assertEquals(parsed.status, "succeeded");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonWorkflowRunRenderer: error event throws UserError", () => {
  const renderer = createWorkflowRunRenderer("json", {
    workflowName: "test-pipeline",
  });
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});

Deno.test("JsonWorkflowRunRenderer: never shows auth nudge", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-pipeline",
      isAuthenticated: false,
    });
    const events = simpleEvents(makeRunView("succeeded"));
    await consumeStream(toStream(events), renderer.handlers());
    const combined = logs.join("\n");
    assertEquals(combined.includes(AUTH_NUDGE_MESSAGE), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("createWorkflowRunRenderer: factory returns correct type per mode", () => {
  const logRenderer = createWorkflowRunRenderer("log", {
    workflowName: "w",
  });
  const jsonRenderer = createWorkflowRunRenderer("json", {
    workflowName: "w",
  });

  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof logRenderer.workflowFailed, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.workflowFailed, "function");
});

Deno.test("createWorkflowRunRenderer: forceLog flag accepted but irrelevant", () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "w",
    forceLog: true,
  });
  assertEquals(typeof renderer.handlers, "function");
});
