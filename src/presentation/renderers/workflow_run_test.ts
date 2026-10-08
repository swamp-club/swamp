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
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { setColorEnabled } from "@std/fmt/colors";
import { consumeStream } from "../../libswamp/stream.ts";
import type { WorkflowRunEvent } from "../../libswamp/workflows/run.ts";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import { createWorkflowRunRenderer } from "./workflow_run.ts";
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";

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

Deno.test("ConsoleWorkflowRunRenderer: failed run with a cert-store error shows the remedy hint", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const runView = makeRunView("failed");
  runView.jobs[0].steps[0].error =
    "Failed to load platform certificates: No such file or directory (os error 2)";
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(simpleEvents(runView)), renderer.handlers());
  });
  const output = lines.join("\n");
  const errorAt = output.indexOf("Failed to load platform certificates");
  const hintAt = output.indexOf("Hint:");
  assertEquals(errorAt >= 0 && hintAt > errorAt, true);
  assertStringIncludes(output, "DENO_TLS_CA_STORE=mozilla");
});

Deno.test("ConsoleWorkflowRunRenderer: failed run with an unrelated error shows no hint", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const lines = await captureOutputAsync(async () => {
    await consumeStream(
      toStream(simpleEvents(makeRunView("failed"))),
      renderer.handlers(),
    );
  });
  assertEquals(lines.join("\n").includes("Hint:"), false);
});

Deno.test("ConsoleWorkflowRunRenderer: pipe-prefixed output uses job name", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
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

Deno.test("ConsoleWorkflowRunRenderer: quiet mode buffers output and discards on success", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
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

Deno.test("ConsoleWorkflowRunRenderer: suspended workflow shows step ID and approval instructions", async () => {
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
  assertStringIncludes(output, "awaiting approval on step apply");
  assertStringIncludes(output, "swamp workflow approve test-pipeline apply");
  assertStringIncludes(output, "swamp workflow resume test-pipeline");
});

Deno.test("ConsoleWorkflowRunRenderer: nested workflow started event does not corrupt parent name in suspend hints", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "parent-workflow",
  });
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "parent-workflow",
      jobs: [
        { id: "run-child", stepCount: 1, dependsOn: [] },
        {
          id: "gate-after-child",
          stepCount: 1,
          dependsOn: ["run-child"],
        },
      ],
    },
    { kind: "job_started", jobId: "run-child" },
    {
      kind: "started",
      runId: "child-run-1",
      workflowName: "child-workflow",
      jobs: [{ id: "child-job", stepCount: 1, dependsOn: [] }],
    },
    {
      kind: "completed",
      run: makeRunView("succeeded"),
    },
    { kind: "job_started", jobId: "gate-after-child" },
    {
      kind: "approval_requested",
      runId: "run-1",
      jobId: "gate-after-child",
      stepId: "approve-the-thing",
      prompt: "PARENT gate",
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "gate-after-child",
      stepId: "approve-the-thing",
      prompt: "PARENT gate",
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(
    output,
    "swamp workflow approve parent-workflow approve-the-thing",
  );
  assertStringIncludes(
    output,
    "swamp workflow reject parent-workflow approve-the-thing",
  );
  assertStringIncludes(output, "swamp workflow resume parent-workflow");
  assertStringIncludes(
    output,
    "awaiting approval on step approve-the-thing",
  );
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

function skippedLines(lines: string[]): string[] {
  return lines.filter((l) => l.includes("skipped")).map((l) => l.trimStart());
}

Deno.test("ConsoleWorkflowRunRenderer: skipped plain steps name the step", async () => {
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
      jobs: [{ id: "main", stepCount: 3, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    { kind: "step_started", jobId: "main", stepId: "deploy" },
    { kind: "step_completed", jobId: "main", stepId: "deploy" },
    {
      kind: "step_skipped",
      jobId: "main",
      stepId: "rollback",
      reason: "dependency",
    },
    {
      kind: "step_skipped",
      jobId: "main",
      stepId: "cleanup",
      reason: "guarded",
      guardExpression: "true",
      guardResult: true,
    },
    { kind: "job_completed", jobId: "main", status: "succeeded" },
    { kind: "completed", run: makeRunView("succeeded") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(skippedLines(lines), [
    "main │ skipped rollback (dependency)",
    "main │ skipped cleanup (guarded) · guard: true",
  ]);
});

Deno.test("ConsoleWorkflowRunRenderer: skipped forEach iterations name the expanded step", async () => {
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
      jobs: [{ id: "extract", stepCount: 2, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "extract" },
    {
      kind: "step_skipped",
      jobId: "extract",
      stepId: "fetch-dev",
      reason: "guarded",
      guardExpression: 'self.env != "prod"',
      guardResult: true,
      forEachTemplate: "fetch",
      forEachIndex: 0,
    },
    { kind: "job_completed", jobId: "extract", status: "succeeded" },
    { kind: "completed", run: makeRunView("succeeded") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(skippedLines(lines), [
    'fetch[0] │ skipped fetch-dev (guarded) · guard: self.env != "prod"',
  ]);
});

Deno.test("ConsoleWorkflowRunRenderer: templated forEach steps are labelled with the expanded name", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const template = "deploy-${{ self.env }}";
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "main", stepCount: 2, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    {
      kind: "step_started",
      jobId: "main",
      stepId: "deploy-dev",
      forEachTemplate: template,
      forEachIndex: 0,
    },
    {
      kind: "step_started",
      jobId: "main",
      stepId: "deploy-prod",
      forEachTemplate: template,
      forEachIndex: 1,
    },
    {
      kind: "method_output",
      jobId: "main",
      stepId: "deploy-dev",
      modelName: "m",
      methodName: "r",
      stream: "stdout",
      line: "from dev",
    },
    {
      kind: "step_completed",
      jobId: "main",
      stepId: "deploy-dev",
      forEachTemplate: template,
      forEachIndex: 0,
    },
    {
      kind: "step_failed",
      jobId: "main",
      stepId: "deploy-prod",
      error: "process exited 1",
      forEachTemplate: template,
      forEachIndex: 1,
    },
    { kind: "job_completed", jobId: "main", status: "failed" },
    { kind: "completed", run: makeRunView("failed") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const iterationLines = lines
    .map((l) => l.trimStart())
    .filter((l) => l.startsWith("deploy-"))
    .map((l) => l.replace(/ in \S+ · \d{2}:\d{2}:\d{2} UTC$/, ""));
  assertEquals(iterationLines, [
    "deploy-dev │ from dev",
    "deploy-dev │ done deploy-dev",
    "deploy-prod │ failed deploy-prod",
  ]);
  assertEquals(lines.filter((l) => l.includes("${{")), []);
});

Deno.test("ConsoleWorkflowRunRenderer: skipped templated forEach iterations are labelled with the expanded name", async () => {
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
      jobs: [{ id: "main", stepCount: 2, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    {
      kind: "step_skipped",
      jobId: "main",
      stepId: "rollback-dev",
      reason: "dependency",
      forEachTemplate: "rollback-${{ self.env }}",
      forEachIndex: 0,
    },
    {
      kind: "step_skipped",
      jobId: "main",
      stepId: "warm-us-east-1",
      reason: "guarded",
      guardExpression: "true",
      guardResult: true,
      forEachTemplate: "warm-${{ self.region }}",
      forEachIndex: 0,
    },
    { kind: "job_completed", jobId: "main", status: "succeeded" },
    { kind: "completed", run: makeRunView("succeeded") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(skippedLines(lines), [
    "rollback-dev │ skipped rollback-dev (dependency)",
    "warm-us-east-1 │ skipped warm-us-east-1 (guarded) · guard: true",
  ]);
});

Deno.test("ConsoleWorkflowRunRenderer: skipped job line names no step", async () => {
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
      jobs: [{ id: "notify", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_skipped", jobId: "notify" },
    { kind: "completed", run: makeRunView("succeeded") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(skippedLines(lines), ["notify │ skipped"]);
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

Deno.test("JsonWorkflowRunRenderer: step_skipped guarded writes guard fields to stderr", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => stdout.push(msg);
  console.error = (msg: string) => stderr.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-pipeline",
    });
    const handler = renderer.handlers().step_skipped;
    handler({
      kind: "step_skipped",
      jobId: "main",
      stepId: "do-work",
      reason: "guarded",
      guardExpression:
        'data.latest("checker", "result").attributes.exitCode == 0',
      guardResult: true,
    });
    assertEquals(stdout.length, 0);
    assertEquals(stderr.length, 1);
    const parsed = JSON.parse(stderr[0]);
    assertEquals(parsed.step, "do-work");
    assertEquals(parsed.reason, "guarded");
    assertEquals(
      parsed.guardExpression,
      'data.latest("checker", "result").attributes.exitCode == 0',
    );
    assertEquals(parsed.guardResult, true);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("JsonWorkflowRunRenderer: step_skipped dependency emits no output", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => logs.push(msg);
  console.error = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-pipeline",
    });
    const handler = renderer.handlers().step_skipped;
    handler({
      kind: "step_skipped",
      jobId: "main",
      stepId: "cleanup",
      reason: "dependency",
    });
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("JsonWorkflowRunRenderer: superseded_runs and vault warning go to stderr", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => stdout.push(msg);
  console.error = (msg: string) => stderr.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-pipeline",
    });
    const handlers = renderer.handlers();
    handlers.superseded_runs({
      kind: "superseded_runs",
      cancelledRunIds: ["run-0"],
    });
    handlers.method_event({
      kind: "method_event",
      jobId: "main",
      stepId: "deploy",
      modelName: "deploy-shell",
      methodName: "execute",
      event: { type: "vault_single_quote_warning", message: "use quotes" },
    });
    handlers.method_event({
      kind: "method_event",
      jobId: "main",
      stepId: "deploy",
      modelName: "deploy-shell",
      methodName: "execute",
      event: {
        type: "sensitive_value_in_command_line",
        message: "use double quotes",
      },
    });
    assertEquals(stdout.length, 0);
    assertEquals(stderr.map((line) => JSON.parse(line)), [
      { event: "superseded_runs", cancelledRunIds: ["run-0"] },
      {
        warning: "vault_single_quote",
        modelName: "deploy-shell",
        message: "use quotes",
      },
      {
        warning: "sensitive_value_in_command_line",
        modelName: "deploy-shell",
        message: "use double quotes",
      },
    ]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
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

Deno.test("JsonWorkflowRunRenderer: suspended includes stepId and prompt", async () => {
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
        jobs: [{ id: "deploy", stepCount: 1, dependsOn: [] }],
      },
      {
        kind: "suspended",
        run: makeRunView("succeeded"),
        jobId: "deploy",
        stepId: "apply",
        prompt: "Review the plan",
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.approvalRequired.stepId, "apply");
    assertEquals(parsed.approvalRequired.jobId, "deploy");
    assertEquals(parsed.approvalRequired.prompt, "Review the plan");
    assertEquals(parsed.approvalRequired.workflowName, "test-pipeline");
    assertEquals(parsed.approvalRequired.runId, "run-1");
  } finally {
    console.log = originalLog;
  }
});

/**
 * Renders a run that suspends on a nested run after `gates`, and returns the
 * suspended document.
 */
async function renderNestedSuspension(
  gates: WorkflowRunEvent[],
  nested: { workflowName: string; runId: string },
): Promise<Record<string, Record<string, unknown>>> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-pipeline",
    });
    await consumeStream(
      toStream([
        ...gates,
        {
          kind: "suspended",
          run: makeRunView("succeeded"),
          jobId: "main",
          stepId: "call-child",
          prompt: "",
          nested,
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    return JSON.parse(logs[0]);
  } finally {
    console.log = originalLog;
  }
}

Deno.test("JsonWorkflowRunRenderer: a nested suspension names the nested run's gate in approvalRequired", async () => {
  const parsed = await renderNestedSuspension([{
    kind: "approval_requested",
    runId: "child-1",
    workflowName: "child",
    jobId: "child-job",
    stepId: "gate",
    prompt: "Approve the child?",
  }], { workflowName: "child", runId: "child-1" });
  assertEquals(parsed.approvalRequired, {
    workflowName: "child",
    runId: "child-1",
    stepId: "gate",
    jobId: "child-job",
    prompt: "Approve the child?",
  });
  assertEquals(parsed.waitingOnNestedRun, {
    workflowName: "child",
    runId: "child-1",
  });
});

Deno.test("JsonWorkflowRunRenderer: a suspension two levels deep names the innermost gate", async () => {
  const parsed = await renderNestedSuspension([{
    kind: "approval_requested",
    runId: "leaf-1",
    workflowName: "leaf",
    jobId: "leaf-job",
    stepId: "gate",
    prompt: "Approve the leaf?",
  }], { workflowName: "middle", runId: "middle-1" });
  assertEquals(parsed.approvalRequired.workflowName, "leaf");
  assertEquals(parsed.approvalRequired.runId, "leaf-1");
  assertEquals(parsed.approvalRequired.stepId, "gate");
});

Deno.test("JsonWorkflowRunRenderer: a nested suspension with no gate in the stream names the waiting step", async () => {
  const parsed = await renderNestedSuspension([], {
    workflowName: "child",
    runId: "child-1",
  });
  assertEquals(parsed.approvalRequired.workflowName, "test-pipeline");
  assertEquals(parsed.approvalRequired.runId, "run-1");
  assertEquals(parsed.approvalRequired.stepId, "call-child");
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

async function renderFailedRun(
  runView: WorkflowRunView,
  commandTarget?: string,
): Promise<string> {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    commandTarget,
  });
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(simpleEvents(runView)), renderer.handlers());
  });
  return lines.join("\n");
}

Deno.test("ConsoleWorkflowRunRenderer: failed run prints the retry command", async () => {
  const output = await renderFailedRun(makeRunView("failed"));
  assertStringIncludes(
    output,
    "To retry failed steps:  swamp workflow resume test-pipeline --run run-1",
  );
});

Deno.test("ConsoleWorkflowRunRenderer: retry command keeps the command target", async () => {
  const output = await renderFailedRun(
    makeRunView("failed"),
    " --server wss://swamp.example.com",
  );
  assertStringIncludes(
    output,
    "swamp workflow resume test-pipeline --run run-1 --server wss://swamp.example.com",
  );
});

Deno.test("ConsoleWorkflowRunRenderer: failed run without a failed step points to its logs", async () => {
  const runView = makeRunView("failed");
  runView.jobs[0].steps[0].status = "pending";
  const output = await renderFailedRun(runView, " --repo-dir ./infra");
  assertStringIncludes(
    output,
    "To inspect the run:  swamp workflow history logs run-1 --repo-dir ./infra",
  );
  assertEquals(output.includes("To retry failed steps"), false);
});

Deno.test("ConsoleWorkflowRunRenderer: an allowed failure is not offered for retry", async () => {
  const runView = makeRunView("failed");
  runView.jobs[0].steps[0].allowedFailure = true;
  const output = await renderFailedRun(runView);
  assertEquals(output.includes("To retry failed steps"), false);
  assertStringIncludes(output, "swamp workflow history logs run-1");
});

Deno.test("ConsoleWorkflowRunRenderer: a step stranded by a workflow change points to a new run", async () => {
  const runView = makeRunView("failed");
  runView.jobs[0].steps[0].failureKind = "workflow_changed";
  const output = await renderFailedRun(runView, " --repo-dir ./infra");
  assertStringIncludes(
    output,
    "To start a new run:  swamp workflow run test-pipeline --repo-dir ./infra",
  );
  assertEquals(output.includes("To retry failed steps"), false);
  assertEquals(output.includes("history get"), false);
  // The stranded step's own error is the one printed, so no second reason.
  assertEquals(output.includes("A step did not run"), false);
});

Deno.test("ConsoleWorkflowRunRenderer: the new-run hint points to the run's inputs in JSON, on its own line", async () => {
  const runView = makeRunView("failed");
  runView.inputs = { env: "prod" };
  runView.jobs[0].steps[0].failureKind = "workflow_changed";
  const output = await renderFailedRun(
    runView,
    " --server wss://swamp.example.com",
  );
  const lines = output.split("\n");
  const hint = lines.findIndex((l) => l.includes("To start a new run:"));
  assertStringIncludes(
    lines[hint],
    "swamp workflow run test-pipeline --server wss://swamp.example.com",
  );
  assertStringIncludes(
    lines[hint + 1],
    "Run inputs:          swamp workflow history get run-1 --json --server wss://swamp.example.com",
  );
});

Deno.test("ConsoleWorkflowRunRenderer: says why a new run is needed when a real failure is reported first", async () => {
  const runView = makeRunView("failed");
  runView.jobs[0].steps.push({
    name: "fetch-b",
    status: "failed",
    error: "Not run",
    failureKind: "workflow_changed",
  });
  const output = await renderFailedRun(runView);
  assertStringIncludes(output, "connection refused");
  assertStringIncludes(
    output,
    "A step did not run because the workflow or a forEach collection changed since the run.",
  );
  assertStringIncludes(
    output,
    "To start a new run:  swamp workflow run test-pipeline",
  );
});

Deno.test("ConsoleWorkflowRunRenderer: suspended hints keep the command target", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    commandTarget: " --server ws://build-host:9000",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "deploy", stepCount: 1, dependsOn: [] }],
    },
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
  const target = "--run run-1 --server ws://build-host:9000";
  assertStringIncludes(
    output,
    `swamp workflow approve test-pipeline apply ${target}`,
  );
  assertStringIncludes(
    output,
    `swamp workflow reject test-pipeline apply ${target}`,
  );
  assertStringIncludes(output, `swamp workflow resume test-pipeline ${target}`);
});

Deno.test("JsonWorkflowRunRenderer: a failed run's JSON output carries no retry hint", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-pipeline",
      commandTarget: " --server ws://build-host:9000",
    });
    await consumeStream(
      toStream(simpleEvents(makeRunView("failed"))),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "failed");
    assertEquals(logs[0].includes("To retry"), false);
    assertEquals(logs[0].includes("build-host"), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("WorkflowRunRenderer: error event carries the cause's marked paths (swamp-club#2830)", () => {
  const path = "/srv/acme/final report";
  for (const mode of ["log", "json"] as const) {
    const handlers = createWorkflowRunRenderer(mode, {
      workflowName: "test-pipeline",
    }).handlers();
    const error = assertThrows(
      () =>
        handlers.error({
          kind: "error",
          error: {
            code: "execution_failed",
            message: `cannot read ${path}`,
            cause: markErrorPaths(new Error(`cannot read ${path}`), [path]),
          },
        }),
      UserError,
      "cannot read",
    );
    assertEquals(error.code, "execution_failed");
    assertEquals(errorPaths(error), [path]);
  }
});

async function renderWorkflowReport(
  markdown: string,
  verbose = false,
): Promise<string[]> {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
    verbose,
  });
  const events = simpleEvents(makeRunView("succeeded"));
  const stepCompleted = events.findIndex((e) => e.kind === "step_completed");
  events.splice(
    stepCompleted,
    0,
    {
      kind: "report_started",
      reportName: "@test/summary-report",
      scope: "method",
      jobId: "extract",
      stepId: "fetch",
    },
    {
      kind: "report_completed",
      reportName: "@test/summary-report",
      scope: "method",
      markdown,
      json: {},
      jobId: "extract",
      stepId: "fetch",
    },
  );
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  return lines.join("\n").split("\n");
}

Deno.test("ConsoleWorkflowRunRenderer: report with whitespace-only markdown prints nothing", async () => {
  const lines = await renderWorkflowReport(" \n");
  const output = lines.join("\n");
  assertEquals(output.includes("@test/summary-report"), false);
  assertEquals(output.includes("── Report:"), false);
  assertStringIncludes(output, "Completed");
});

Deno.test("ConsoleWorkflowRunRenderer: report frame header and closing rule have the same width", async () => {
  const lines = await renderWorkflowReport("# Summary\n\nAll good.");
  const headerIndex = lines.findIndex((l) =>
    l.startsWith("── Report: @test/summary-report ")
  );
  assertEquals(headerIndex >= 0, true);
  const closing = lines.slice(headerIndex + 1).find((l) => /^─+$/.test(l));
  assertEquals(closing !== undefined, true);
  assertEquals(lines[headerIndex].length, closing!.length);
  assertStringIncludes(lines.join("\n"), "All good.");
});

Deno.test("ConsoleWorkflowRunRenderer: verbose renders the frame of a report with empty markdown", async () => {
  const lines = await renderWorkflowReport("", true);
  const output = lines.join("\n");
  assertStringIncludes(output, "Report @test/summary-report");
  const headerIndex = lines.findIndex((l) =>
    l.startsWith("── Report: @test/summary-report ")
  );
  assertEquals(headerIndex >= 0, true);
  const closing = lines.slice(headerIndex + 1).find((l) => /^─+$/.test(l));
  assertEquals(closing !== undefined, true);
  assertEquals(lines[headerIndex].length, closing!.length);
});

Deno.test("ConsoleWorkflowRunRenderer: a parent waiting on a nested run names the nested run's gate and the parent's resume (swamp-club#2736)", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "parent",
  });
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "parent-run",
      workflowName: "parent",
      jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    {
      kind: "approval_requested",
      runId: "child-run",
      workflowName: "child",
      jobId: "main",
      stepId: "gate",
      prompt: "Approve the child",
    },
    {
      kind: "suspended",
      run: { ...makeRunView("succeeded"), id: "parent-run" },
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-run" },
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(
    output,
    "swamp workflow approve child gate --run child-run",
  );
  assertStringIncludes(output, "waits on nested workflow child run child-run");
  assertStringIncludes(output, "swamp workflow resume parent --run parent-run");
  // Never the parent's name with the child's run id.
  assertEquals(output.includes("approve parent gate"), false);
});

Deno.test("JsonWorkflowRunRenderer: a nested suspension names the nested run (swamp-club#2736)", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "parent",
    });
    await consumeStream(
      toStream([
        {
          kind: "started",
          runId: "parent-run",
          workflowName: "parent",
          jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
        },
        {
          kind: "suspended",
          run: makeRunView("succeeded"),
          jobId: "main",
          stepId: "call-child",
          prompt: "",
          nested: { workflowName: "child", runId: "child-run" },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.waitingOnNestedRun, {
      workflowName: "child",
      runId: "child-run",
    });
    assertEquals(parsed.approvalRequired.stepId, "call-child");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("ConsoleWorkflowRunRenderer: a step name carrying an escape sequence never reaches the terminal raw from the approval block (swamp-club#3027)", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const stepId = "apply\u001b]0;pwned\u0007";
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "deploy", stepCount: 1, dependsOn: [] }],
    },
    {
      kind: "approval_requested",
      runId: "run-1",
      jobId: "deploy",
      stepId,
      prompt: "Review the plan",
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "deploy",
      stepId,
      prompt: "Review the plan",
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertEquals(output.includes("\u001b]0;pwned"), false);
  assertStringIncludes(
    output,
    "swamp workflow approve test-pipeline $'apply\\x1b]0;pwned\\x07' --run run-1",
  );
  assertStringIncludes(
    output,
    "swamp workflow reject test-pipeline $'apply\\x1b]0;pwned\\x07' --run run-1",
  );
  assertStringIncludes(
    output,
    "awaiting approval on step apply\\x1b]0;pwned\\x07",
  );
});

Deno.test("ConsoleWorkflowRunRenderer: a plain ESC in a step name is escaped in the approval block", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "deploy", stepCount: 1, dependsOn: [] }],
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "deploy",
      stepId: "ap\u001bply",
      prompt: "Review the plan",
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertEquals(output.includes("\u001b"), false);
  assertStringIncludes(
    output,
    "swamp workflow approve test-pipeline $'ap\\x1bply' --run run-1",
  );
});

Deno.test("ConsoleWorkflowRunRenderer: the approval block shell-quotes a step name with a space, as the other hints do", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-pipeline",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test-pipeline",
      jobs: [{ id: "deploy", stepCount: 1, dependsOn: [] }],
    },
    {
      kind: "approval_requested",
      runId: "run-1",
      jobId: "deploy",
      stepId: "verify build",
      prompt: "Review the plan",
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "deploy",
      stepId: "verify build",
      prompt: "Review the plan",
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(
    output,
    "swamp workflow approve test-pipeline 'verify build' --run run-1",
  );
  assertStringIncludes(
    output,
    "swamp workflow reject test-pipeline 'verify build' --run run-1",
  );
  assertStringIncludes(output, "awaiting approval on step verify build");
});

const WAIT_ID = "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90";
const WAIT_DEADLINE = "2026-01-02T00:00:00.000Z";

Deno.test("ConsoleWorkflowRunRenderer: a run suspended on a signal wait shows the wait ID and the signal and resume commands", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "release",
  });
  const events: WorkflowRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "evaluating_workflow" },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "release",
      jobs: [{ id: "release", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "release" },
    {
      kind: "signal_wait_requested",
      runId: "run-1",
      workflowName: "release",
      jobId: "release",
      stepId: "review",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "release",
      stepId: "review",
      prompt: "",
      wait: { id: WAIT_ID, deadline: WAIT_DEADLINE },
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "signal required on step review");
  assertEquals(output.includes("waiting waiting"), false);
  assertStringIncludes(output, WAIT_DEADLINE);
  assertStringIncludes(output, "Suspended");
  assertStringIncludes(output, `step review waits for signal ${WAIT_ID}`);
  assertStringIncludes(
    output,
    `swamp workflow signal ${WAIT_ID} --payload '<json>'`,
  );
  assertStringIncludes(output, "swamp workflow resume release --run run-1");
  assertEquals(output.includes("workflow approve"), false);
});

Deno.test("ConsoleWorkflowRunRenderer: a run on a server prints the signal and resume commands with the server target", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "release",
    commandTarget: " --server ws://localhost:9090",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "release",
      jobs: [{ id: "release", stepCount: 1, dependsOn: [] }],
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "release",
      stepId: "review",
      prompt: "",
      wait: { id: WAIT_ID, deadline: WAIT_DEADLINE },
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const signalLine = lines.find((line) => line.includes("workflow signal"));
  const resumeLine = lines.find((line) => line.includes("workflow resume"));
  assertStringIncludes(
    signalLine ?? "",
    `swamp workflow signal ${WAIT_ID} --payload '<json>' --server ws://localhost:9090`,
  );
  assertStringIncludes(resumeLine ?? "", "--server ws://localhost:9090");
});

Deno.test("ConsoleWorkflowRunRenderer: the signal command keeps a local repository target", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "release",
    commandTarget: " --repo-dir /repo",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "release",
      jobs: [{ id: "release", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "release" },
    {
      kind: "signal_wait_requested",
      runId: "run-1",
      jobId: "release",
      stepId: "review",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "release",
      stepId: "review",
      prompt: "",
      wait: { id: WAIT_ID, deadline: WAIT_DEADLINE },
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const signalLines = lines.filter((line) => line.includes("workflow signal"));
  assertEquals(signalLines.length, 2);
  for (const line of signalLines) {
    assertStringIncludes(
      line,
      `swamp workflow signal ${WAIT_ID} --payload '<json>' --repo-dir /repo`,
    );
  }
});

Deno.test("ConsoleWorkflowRunRenderer: a matching run kept because it waits for a signal is reported with its wait IDs", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "release",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "superseded_runs",
      cancelledRunIds: [],
      skippedRuns: [{ runId: "run-0", waitIds: [WAIT_ID] }],
    },
    {
      kind: "started",
      runId: "run-1",
      workflowName: "release",
      jobs: [{ id: "release", stepCount: 1, dependsOn: [] }],
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Kept");
  assertStringIncludes(
    output,
    `suspended run run-0 (matching inputs) still waits for a signal: ${WAIT_ID}`,
  );
  assertEquals(output.includes("Superseded"), false);
});

/** Renders `events` in JSON mode and returns stdout and stderr documents. */
async function renderJson(
  events: WorkflowRunEvent[],
): Promise<{ stdout: unknown[]; stderr: unknown[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => stdout.push(msg);
  console.error = (msg: string) => stderr.push(msg);
  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "release",
    });
    await consumeStream(toStream(events), renderer.handlers());
    return {
      stdout: stdout.map((line) => JSON.parse(line)),
      stderr: stderr.map((line) => JSON.parse(line)),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

Deno.test("JsonWorkflowRunRenderer: a run suspended on a signal wait reports signalRequired with the wait ID, not approvalRequired", async () => {
  const { stdout } = await renderJson([
    {
      kind: "signal_wait_requested",
      runId: "run-1",
      workflowName: "release",
      jobId: "release",
      stepId: "review",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "release",
      stepId: "review",
      prompt: "",
      wait: { id: WAIT_ID, deadline: WAIT_DEADLINE },
    },
  ]);

  assertEquals(stdout.length, 1);
  const parsed = stdout[0] as Record<string, unknown>;
  assertEquals(parsed.signalRequired, {
    workflowName: "test-pipeline",
    runId: "run-1",
    stepId: "review",
    jobId: "release",
    waitId: WAIT_ID,
    deadline: WAIT_DEADLINE,
  });
  assertEquals(parsed.approvalRequired, undefined);
});

Deno.test("JsonWorkflowRunRenderer: a nested suspension names the nested run's signal wait", async () => {
  const { stdout } = await renderJson([
    {
      kind: "signal_wait_requested",
      runId: "child-1",
      workflowName: "child",
      jobId: "child-job",
      stepId: "review",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
    },
  ]);

  const parsed = stdout[0] as Record<string, unknown>;
  assertEquals(parsed.signalRequired, {
    workflowName: "child",
    runId: "child-1",
    stepId: "review",
    jobId: "child-job",
    waitId: WAIT_ID,
    deadline: WAIT_DEADLINE,
  });
  assertEquals(parsed.approvalRequired, undefined);
  assertEquals(parsed.waitingOnNestedRun, {
    workflowName: "child",
    runId: "child-1",
  });
});

Deno.test("JsonWorkflowRunRenderer: a nested suspension with a gate in the stream still names the gate", async () => {
  const { stdout } = await renderJson([
    {
      kind: "signal_wait_requested",
      runId: "child-1",
      workflowName: "child",
      jobId: "child-job",
      stepId: "review",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      kind: "approval_requested",
      runId: "child-1",
      workflowName: "child",
      jobId: "child-job",
      stepId: "gate",
      prompt: "Approve?",
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
    },
  ]);

  const parsed = stdout[0] as Record<string, Record<string, unknown>>;
  assertEquals(parsed.approvalRequired.stepId, "gate");
  assertEquals(parsed.signalRequired, undefined);
});

Deno.test("JsonWorkflowRunRenderer: a nested suspension names the nested run's wait, not a sibling run's earlier gate", async () => {
  const { stdout } = await renderJson([
    {
      kind: "approval_requested",
      runId: "child-a",
      workflowName: "child",
      jobId: "child-job",
      stepId: "gate",
      prompt: "Approve?",
    },
    {
      kind: "signal_wait_requested",
      runId: "child-b",
      workflowName: "child",
      jobId: "child-job",
      stepId: "review",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child-b",
      prompt: "",
      nested: { workflowName: "child", runId: "child-b" },
    },
  ]);

  const parsed = stdout[0] as Record<string, Record<string, unknown>>;
  assertEquals(parsed.signalRequired.runId, "child-b");
  assertEquals(parsed.signalRequired.waitId, WAIT_ID);
  assertEquals(parsed.approvalRequired, undefined);
});

Deno.test("JsonWorkflowRunRenderer: skipped supersedes go to stderr with their wait IDs", async () => {
  const { stdout, stderr } = await renderJson([
    {
      kind: "superseded_runs",
      cancelledRunIds: [],
      skippedRuns: [{ runId: "run-0", waitIds: [WAIT_ID] }],
    },
  ]);

  assertEquals(stdout, []);
  assertEquals(stderr, [{
    event: "superseded_runs",
    cancelledRunIds: [],
    skippedRuns: [{ runId: "run-0", waitIds: [WAIT_ID] }],
  }]);
});

/** A suspended run view whose `release` job has the given steps. */
function waitingRunView(
  steps: WorkflowRunView["jobs"][number]["steps"],
): WorkflowRunView {
  return {
    ...makeRunView("succeeded"),
    jobs: [{ name: "release", status: "running", steps }],
  };
}

Deno.test("JsonWorkflowRunRenderer: a run with several waits lists every one in signalWaits", async () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const { stdout } = await renderJson([
    {
      kind: "suspended",
      run: waitingRunView([
        {
          name: "review-eu",
          status: "waiting",
          wait: { id: WAIT_ID, deadline: WAIT_DEADLINE },
        },
        {
          name: "review-us",
          status: "waiting",
          wait: { id: other, deadline: WAIT_DEADLINE },
        },
        // Settled, so no longer something to signal.
        {
          name: "review-done",
          status: "succeeded",
          wait: { id: "22222222-2222-4222-8222-222222222222", deadline: "x" },
        },
      ]),
      jobId: "release",
      stepId: "review-eu",
      prompt: "",
      wait: { id: WAIT_ID, deadline: WAIT_DEADLINE },
    },
  ]);

  const parsed = stdout[0] as Record<string, unknown>;
  assertEquals(parsed.signalWaits, [
    {
      stepId: "review-eu",
      jobId: "release",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      stepId: "review-us",
      jobId: "release",
      waitId: other,
      deadline: WAIT_DEADLINE,
    },
  ]);
  assertEquals(
    (parsed.signalRequired as Record<string, unknown>).waitId,
    WAIT_ID,
  );
});

Deno.test("JsonWorkflowRunRenderer: a gate beside a wait reports the gate and still lists the wait", async () => {
  const { stdout } = await renderJson([
    {
      kind: "suspended",
      run: waitingRunView([
        { name: "gate", status: "waiting_approval" },
        {
          name: "review",
          status: "waiting",
          wait: { id: WAIT_ID, deadline: WAIT_DEADLINE },
        },
      ]),
      jobId: "release",
      stepId: "gate",
      prompt: "Approve?",
    },
  ]);

  const parsed = stdout[0] as Record<string, unknown>;
  assertEquals(
    (parsed.approvalRequired as Record<string, unknown>).stepId,
    "gate",
  );
  assertEquals(parsed.signalRequired, undefined);
  assertEquals(parsed.signalWaits, [{
    stepId: "review",
    jobId: "release",
    waitId: WAIT_ID,
    deadline: WAIT_DEADLINE,
  }]);
});

Deno.test("JsonWorkflowRunRenderer: a run suspended only on a gate has no signalWaits", async () => {
  const { stdout } = await renderJson([
    {
      kind: "suspended",
      run: waitingRunView([{ name: "gate", status: "waiting_approval" }]),
      jobId: "release",
      stepId: "gate",
      prompt: "Approve?",
    },
  ]);

  assertEquals(
    "signalWaits" in (stdout[0] as Record<string, unknown>),
    false,
  );
});

Deno.test("ConsoleWorkflowRunRenderer: a parent suspended on a child that waits for a signal says to signal, not approve", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "parent",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "parent",
      jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    {
      kind: "signal_wait_requested",
      runId: "child-1",
      workflowName: "child",
      jobId: "main",
      stepId: "review",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "signal its wait as shown above");
  assertEquals(output.includes("approve its gate"), false);
  assertStringIncludes(output, "swamp workflow resume child --run child-1");
});

Deno.test("ConsoleWorkflowRunRenderer: a parent suspended on a child that showed neither a gate nor a wait names both ways to decide it", async () => {
  // A server that predates nestedSignalWaits names no wait, and its stream
  // carries no signal_wait_requested.
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "parent",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "parent",
      jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "approve its gate or signal its wait, then");
  assertEquals(output.includes("as shown above"), false);
  assertStringIncludes(output, "swamp workflow resume child --run child-1");
});

const NESTED_WAIT = {
  workflowId: "wf-child",
  workflowName: "child",
  runId: "child-1",
  jobId: "child-job",
  stepId: "review",
  waitId: WAIT_ID,
  deadline: WAIT_DEADLINE,
};

Deno.test("ConsoleWorkflowRunRenderer: a run on a server names a nested run's wait from the suspension, with a signal command for the server", async () => {
  // A remote stream carries no signal_wait_requested: the suspended event's
  // nestedSignalWaits is all the client is told (swamp-club#3110).
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "parent",
    commandTarget: " --server ws://localhost:9090",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "parent",
      jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
      nestedSignalWaits: [NESTED_WAIT],
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(
    output,
    `signal required on step review in nested workflow child until ${WAIT_DEADLINE}`,
  );
  assertStringIncludes(
    output,
    `swamp workflow signal ${WAIT_ID} --payload '<json>' --server ws://localhost:9090`,
  );
  assertStringIncludes(output, "signal its wait as shown above");
  assertEquals(output.includes("approve its gate"), false);
});

Deno.test("ConsoleWorkflowRunRenderer: a nested wait shown when it was requested is not printed again at the suspension", async () => {
  const renderer = createWorkflowRunRenderer("log", { workflowName: "parent" });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "parent",
      jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    {
      kind: "signal_wait_requested",
      runId: "child-1",
      workflowName: "child",
      jobId: "main",
      stepId: "review",
      waitId: WAIT_ID,
      deadline: WAIT_DEADLINE,
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
      nestedSignalWaits: [NESTED_WAIT],
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(
    lines.filter((line) => line.includes("workflow signal")).length,
    1,
  );
});

Deno.test("ConsoleWorkflowRunRenderer: a run suspended on its own gate also names a nested run's wait", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "parent",
    commandTarget: " --server ws://localhost:9090",
  });
  const events: WorkflowRunEvent[] = [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "parent",
      jobs: [{ id: "main", stepCount: 2, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "gate",
      prompt: "Approve?",
      nestedSignalWaits: [NESTED_WAIT],
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "swamp workflow approve");
  assertStringIncludes(
    output,
    `swamp workflow signal ${WAIT_ID} --payload '<json>' --server ws://localhost:9090`,
  );
});

Deno.test("JsonWorkflowRunRenderer: a nested suspension names the nested run's wait from the suspension when the stream requested none", async () => {
  const { stdout } = await renderJson([
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
      nestedSignalWaits: [NESTED_WAIT],
    },
  ]);

  const parsed = stdout[0] as Record<string, unknown>;
  assertEquals(parsed.signalRequired, {
    workflowName: "child",
    runId: "child-1",
    stepId: "review",
    jobId: "child-job",
    waitId: WAIT_ID,
    deadline: WAIT_DEADLINE,
  });
  assertEquals(parsed.approvalRequired, undefined);
  assertEquals(parsed.nestedSignalWaits, [NESTED_WAIT]);
});

Deno.test("JsonWorkflowRunRenderer: a wait named for a grandchild is reported when the direct child requested nothing", async () => {
  const grandchild = { ...NESTED_WAIT, workflowName: "leaf", runId: "leaf-1" };
  const { stdout } = await renderJson([
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
      nestedSignalWaits: [grandchild],
    },
  ]);

  const parsed = stdout[0] as Record<string, { runId: string }>;
  assertEquals(parsed.signalRequired.runId, "leaf-1");
});

Deno.test("JsonWorkflowRunRenderer: a suspension with no nested wait carries no nestedSignalWaits", async () => {
  const { stdout } = await renderJson([
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "release",
      stepId: "gate",
      prompt: "Approve?",
    },
  ]);

  assertEquals(
    "nestedSignalWaits" in (stdout[0] as Record<string, unknown>),
    false,
  );
});

// What a caller who may read the leaf workflow but not the middle one is
// sent: redaction removed `nested`, and the leaf's wait is still named.
const HIDDEN_CHILD_SUSPENSION: WorkflowRunEvent = {
  kind: "suspended",
  run: waitingRunView([{ name: "call-nested", status: "waiting_approval" }]),
  jobId: "release",
  stepId: "call-nested",
  prompt: "",
  nestedSignalWaits: [{
    ...NESTED_WAIT,
    workflowName: "leaf",
    runId: "leaf-1",
  }],
};

Deno.test("JsonWorkflowRunRenderer: a suspension whose direct nested run is hidden still reports the named wait as signalRequired", async () => {
  const { stdout } = await renderJson([HIDDEN_CHILD_SUSPENSION]);

  const parsed = stdout[0] as Record<string, unknown>;
  assertEquals(parsed.signalRequired, {
    workflowName: "leaf",
    runId: "leaf-1",
    stepId: "review",
    jobId: "child-job",
    waitId: WAIT_ID,
    deadline: WAIT_DEADLINE,
  });
  assertEquals(parsed.approvalRequired, undefined);
});

Deno.test("ConsoleWorkflowRunRenderer: a suspension whose direct nested run is hidden offers no approve command, and names the wait it may", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "top",
    commandTarget: " --server ws://localhost:9090",
  });
  const lines = await captureOutputAsync(async () => {
    await consumeStream(
      toStream([
        {
          kind: "started",
          runId: "run-1",
          workflowName: "top",
          jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
        },
        HIDDEN_CHILD_SUSPENSION,
      ]),
      renderer.handlers(),
    );
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "step call-nested waits on a nested run");
  assertEquals(output.includes("workflow approve"), false);
  assertEquals(output.includes("awaiting approval"), false);
  assertStringIncludes(
    output,
    `swamp workflow signal ${WAIT_ID} --payload '<json>' --server ws://localhost:9090`,
  );
  assertStringIncludes(
    output,
    "swamp workflow resume leaf --run leaf-1 --server ws://localhost:9090",
  );
  assertStringIncludes(output, "swamp workflow resume top --run run-1");
});

Deno.test("ConsoleWorkflowRunRenderer: a step waiting on a signal wait that cannot be read is not taken for a nested run", async () => {
  const renderer = createWorkflowRunRenderer("log", { workflowName: "top" });
  const run = waitingRunView([{ name: "review", status: "waiting" }]);
  const lines = await captureOutputAsync(async () => {
    await consumeStream(
      toStream([
        {
          kind: "started",
          runId: "run-1",
          workflowName: "top",
          jobs: [{ id: "release", stepCount: 1, dependsOn: [] }],
        },
        {
          kind: "suspended",
          run,
          jobId: run.jobs[0].name,
          stepId: "review",
          prompt: "",
        },
      ]),
      renderer.handlers(),
    );
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Suspended");
  assertEquals(output.includes("waits on a nested run"), false);
});

function threeLevelEvents(requested: boolean): WorkflowRunEvent[] {
  return [
    {
      kind: "started",
      runId: "run-1",
      workflowName: "top",
      jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "main" },
    ...(requested
      ? [{
        kind: "signal_wait_requested" as const,
        runId: "leaf-1",
        workflowName: "leaf",
        jobId: "main",
        stepId: "review",
        waitId: WAIT_ID,
        deadline: WAIT_DEADLINE,
      }]
      : []),
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-middle",
      prompt: "",
      nested: { workflowName: "middle", runId: "middle-1" },
      nestedSignalWaits: [
        { ...NESTED_WAIT, workflowName: "leaf", runId: "leaf-1" },
      ],
    },
  ];
}

for (const requested of [false, true]) {
  Deno.test(
    `ConsoleWorkflowRunRenderer: a wait two levels down says to resume the run that holds it before the run above it (wait ${
      requested ? "shown when requested" : "named only by the suspension"
    })`,
    async () => {
      const renderer = createWorkflowRunRenderer("log", {
        workflowName: "top",
      });
      const lines = await captureOutputAsync(async () => {
        await consumeStream(
          toStream(threeLevelEvents(requested)),
          renderer.handlers(),
        );
      });
      const output = lines.join("\n");
      assertEquals(
        lines.filter((line) => line.includes("workflow signal")).length,
        1,
      );
      const leaf = output.indexOf("swamp workflow resume leaf --run leaf-1");
      const middle = output.indexOf(
        "once the run it waits on finishes,  swamp workflow resume middle --run middle-1",
      );
      const top = output.indexOf("swamp workflow resume top --run run-1");
      assert(leaf >= 0 && middle > leaf && top > middle, output);
      assertEquals(output.includes("approve its gate"), false);
    },
  );
}

Deno.test("JsonWorkflowRunRenderer: a wait named for another run does not displace a gate another run requested", async () => {
  // Two nested steps: the one the suspension names waits on a gate further
  // down, and the wait named belongs to its sibling.
  const { stdout } = await renderJson([
    {
      kind: "approval_requested",
      runId: "leaf-gate-1",
      workflowName: "leaf",
      jobId: "main",
      stepId: "gate",
      prompt: "Ship it?",
    },
    {
      kind: "suspended",
      run: makeRunView("succeeded"),
      jobId: "main",
      stepId: "call-child",
      prompt: "",
      nested: { workflowName: "child", runId: "child-1" },
      nestedSignalWaits: [
        { ...NESTED_WAIT, workflowName: "sibling", runId: "sibling-1" },
      ],
    },
  ]);

  const parsed = stdout[0] as Record<string, { runId: string } | undefined>;
  assertEquals(parsed.approvalRequired?.runId, "leaf-gate-1");
  assertEquals(parsed.signalRequired, undefined);
});

Deno.test("ConsoleWorkflowRunRenderer: a suspension whose step is not in the run view keeps the gate wording", async () => {
  const renderer = createWorkflowRunRenderer("log", { workflowName: "top" });
  const lines = await captureOutputAsync(async () => {
    await consumeStream(
      toStream([
        {
          kind: "started",
          runId: "run-1",
          workflowName: "top",
          jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
        },
        {
          kind: "suspended",
          run: makeRunView("succeeded"),
          jobId: "nowhere",
          stepId: "gone",
          prompt: "",
        },
      ]),
      renderer.handlers(),
    );
  });
  const output = lines.join("\n");
  assertEquals(output.includes("waits on a nested run"), false);
  assertStringIncludes(output, "awaiting approval on step gone");
});
