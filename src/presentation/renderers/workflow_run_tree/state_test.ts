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
import {
  createInitialState,
  MAX_OUTPUT_LINES,
  treeReducer,
  type TreeState,
} from "./state.ts";
import type { WorkflowRunEvent } from "../../../libswamp/mod.ts";

function reduce(
  state: TreeState,
  ...events: WorkflowRunEvent[]
): TreeState {
  let s = state;
  for (const e of events) {
    s = treeReducer(s, e);
  }
  return s;
}

const startedEvent: WorkflowRunEvent = {
  kind: "started",
  runId: "run-1",
  workflowName: "deploy",
  jobs: [
    { id: "provision", stepCount: 1, dependsOn: [] },
    { id: "configure", stepCount: 2, dependsOn: ["provision"] },
    { id: "security", stepCount: 1, dependsOn: ["configure"] },
  ],
};

Deno.test("treeReducer: started populates jobs with waiting/blocked", () => {
  const state = reduce(createInitialState("deploy"), startedEvent);

  assertEquals(state.phase, "running");
  assertEquals(state.workflowName, "deploy");
  assertEquals(state.jobOrder, ["provision", "configure", "security"]);

  const provision = state.jobs.get("provision")!;
  assertEquals(provision.status, "waiting");
  assertEquals(provision.stepOrder.length, 0); // no steps seen yet

  const configure = state.jobs.get("configure")!;
  assertEquals(configure.status, "blocked");

  const security = state.jobs.get("security")!;
  assertEquals(security.status, "blocked");
});

Deno.test("treeReducer: job_started transitions waiting to running", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "provision" },
  );

  const job = state.jobs.get("provision")!;
  assertEquals(job.status, "running");
  assertEquals(typeof job.startedAt, "number");
});

Deno.test("treeReducer: model_resolved creates step with model info", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "step-1" },
    {
      kind: "model_resolved",
      jobId: "provision",
      stepId: "step-1",
      modelName: "ec2-instance",
      modelType: "aws/ec2",
      modelId: "test-model-id",
      methodName: "create",
    },
  );

  const job = state.jobs.get("provision")!;
  const step = job.steps.get("step-1")!;
  assertEquals(step.modelName, "ec2-instance");
  assertEquals(step.methodName, "create");
  assertEquals(step.status, "running");
});

Deno.test("treeReducer: method_output appends to buffer", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "step-1" },
    {
      kind: "method_output",
      jobId: "provision",
      stepId: "step-1",
      modelName: "ec2",
      methodName: "create",
      stream: "stdout",
      line: "Creating instance...",
    },
    {
      kind: "method_output",
      jobId: "provision",
      stepId: "step-1",
      modelName: "ec2",
      methodName: "create",
      stream: "stdout",
      line: "Instance running.",
    },
  );

  const step = state.jobs.get("provision")!.steps.get("step-1")!;
  assertEquals(step.outputBuffer, [
    "Creating instance...",
    "Instance running.",
  ]);
});

Deno.test("treeReducer: method_output caps at MAX_OUTPUT_LINES", () => {
  let state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "step-1" },
  );

  // Fill to MAX
  for (let i = 0; i < MAX_OUTPUT_LINES + 5; i++) {
    state = treeReducer(state, {
      kind: "method_output",
      jobId: "provision",
      stepId: "step-1",
      modelName: "ec2",
      methodName: "create",
      stream: "stdout",
      line: `line-${i}`,
    });
  }

  const step = state.jobs.get("provision")!.steps.get("step-1")!;
  assertEquals(step.outputBuffer.length, MAX_OUTPUT_LINES);
  // Oldest lines should have been dropped
  assertEquals(step.outputBuffer[0], "line-5");
  assertEquals(
    step.outputBuffer[MAX_OUTPUT_LINES - 1],
    `line-${MAX_OUTPUT_LINES + 4}`,
  );
});

Deno.test("treeReducer: job_completed graduates to scrollback and unblocks dependents", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "step-1" },
    {
      kind: "model_resolved",
      jobId: "provision",
      stepId: "step-1",
      modelName: "ec2-instance",
      modelType: "aws/ec2",
      modelId: "test-model-id",
      methodName: "create",
    },
    { kind: "step_completed", jobId: "provision", stepId: "step-1" },
    { kind: "job_completed", jobId: "provision", status: "succeeded" },
  );

  // Job should be graduated to scrollback
  assertEquals(state.scrollback.length, 1);
  const item = state.scrollback[0];
  assertEquals(item.type, "job");
  if (item.type === "job") {
    assertEquals(item.jobId, "provision");
    assertEquals(item.status, "succeeded");
    assertEquals(item.singleStepLabel, "step-1: ec2-instance \u2192 create");
  }

  // configure should now be waiting (provision dependency resolved)
  const configure = state.jobs.get("configure")!;
  assertEquals(configure.status, "waiting");

  // security still blocked (configure not done)
  const security = state.jobs.get("security")!;
  assertEquals(security.status, "blocked");
});

Deno.test("treeReducer: step_failed records error", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "step-1" },
    {
      kind: "step_failed",
      jobId: "provision",
      stepId: "step-1",
      error: "Connection timeout",
    },
  );

  const step = state.jobs.get("provision")!.steps.get("step-1")!;
  assertEquals(step.status, "failed");
  assertEquals(step.error, "Connection timeout");
  assertEquals(step.allowedFailure, false);
});

Deno.test("treeReducer: step_failed with allowedFailure increments completed count", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "step-1" },
    {
      kind: "step_failed",
      jobId: "provision",
      stepId: "step-1",
      error: "Non-critical",
      allowedFailure: true,
    },
  );

  const job = state.jobs.get("provision")!;
  assertEquals(job.completedStepCount, 1);
  const step = job.steps.get("step-1")!;
  assertEquals(step.allowedFailure, true);
});

Deno.test("treeReducer: report_completed with jobId attaches to step", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "step-1" },
    {
      kind: "report_completed",
      reportName: "@swamp/method-summary",
      scope: "method",
      markdown: "# Summary",
      json: {},
      jobId: "provision",
      stepId: "step-1",
    },
  );

  const step = state.jobs.get("provision")!.steps.get("step-1")!;
  assertEquals(step.reports.length, 1);
  assertEquals(step.reports[0].name, "@swamp/method-summary");
  if (step.reports[0].success) {
    assertEquals(step.reports[0].markdown, "# Summary");
  }
});

Deno.test("treeReducer: report_completed without jobId goes to scrollback", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    {
      kind: "report_completed",
      reportName: "@swamp/workflow-summary",
      scope: "workflow",
      markdown: "# Workflow Summary",
      json: {},
    },
  );

  assertEquals(state.scrollback.length, 1);
  const item = state.scrollback[0];
  assertEquals(item.type, "report");
  if (item.type === "report") {
    assertEquals(item.name, "@swamp/workflow-summary");
  }
});

Deno.test("treeReducer: completed sets phase to done", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    {
      kind: "completed",
      run: {
        id: "run-1",
        workflowId: "wf-1",
        workflowName: "deploy",
        status: "succeeded",
        jobs: [{
          name: "provision",
          status: "succeeded",
          steps: [{
            name: "step-1",
            status: "succeeded",
          }],
        }],
      },
    },
  );

  assertEquals(state.phase, "done");
  assertEquals(state.failed, false);
});

Deno.test("treeReducer: error sets failed state", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    {
      kind: "error",
      error: { code: "workflow_execution_failed", message: "boom" },
    },
  );

  assertEquals(state.phase, "done");
  assertEquals(state.failed, true);
});

Deno.test("treeReducer: full sequential workflow lifecycle", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    // provision
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "s1" },
    {
      kind: "model_resolved",
      jobId: "provision",
      stepId: "s1",
      modelName: "ec2",
      modelType: "aws/ec2",
      modelId: "test-model-id",
      methodName: "create",
    },
    {
      kind: "method_output",
      jobId: "provision",
      stepId: "s1",
      modelName: "ec2",
      methodName: "create",
      stream: "stdout",
      line: "Creating...",
    },
    { kind: "step_completed", jobId: "provision", stepId: "s1" },
    { kind: "job_completed", jobId: "provision", status: "succeeded" },
    // configure
    { kind: "job_started", jobId: "configure" },
    { kind: "step_started", jobId: "configure", stepId: "s1" },
    { kind: "step_completed", jobId: "configure", stepId: "s1" },
    { kind: "step_started", jobId: "configure", stepId: "s2" },
    { kind: "step_completed", jobId: "configure", stepId: "s2" },
    { kind: "job_completed", jobId: "configure", status: "succeeded" },
    // security
    { kind: "job_started", jobId: "security" },
    { kind: "step_started", jobId: "security", stepId: "s1" },
    { kind: "step_completed", jobId: "security", stepId: "s1" },
    { kind: "job_completed", jobId: "security", status: "succeeded" },
    // complete
    {
      kind: "completed",
      run: {
        id: "run-1",
        workflowId: "wf-1",
        workflowName: "deploy",
        status: "succeeded",
        jobs: [],
      },
    },
  );

  assertEquals(state.phase, "done");
  assertEquals(state.failed, false);
  // 3 jobs graduated to scrollback
  assertEquals(
    state.scrollback.filter((s) => s.type === "job").length,
    3,
  );
});

Deno.test("treeReducer: parallel jobs without dependencies all start as waiting", () => {
  const state = reduce(createInitialState("ci"), {
    kind: "started",
    runId: "run-1",
    workflowName: "ci",
    jobs: [
      { id: "build", stepCount: 1, dependsOn: [] },
      { id: "test", stepCount: 1, dependsOn: [] },
      { id: "lint", stepCount: 1, dependsOn: [] },
    ],
  });

  assertEquals(state.jobs.get("build")!.status, "waiting");
  assertEquals(state.jobs.get("test")!.status, "waiting");
  assertEquals(state.jobs.get("lint")!.status, "waiting");
});

Deno.test("treeReducer: job_completed multi-step shows step count", () => {
  const state = reduce(
    createInitialState("deploy"),
    startedEvent,
    { kind: "job_started", jobId: "configure" },
    { kind: "step_started", jobId: "configure", stepId: "s1" },
    {
      kind: "model_resolved",
      jobId: "configure",
      stepId: "s1",
      modelName: "nginx",
      modelType: "config",
      modelId: "test-model-id",
      methodName: "validate",
    },
    { kind: "step_completed", jobId: "configure", stepId: "s1" },
    { kind: "step_started", jobId: "configure", stepId: "s2" },
    {
      kind: "model_resolved",
      jobId: "configure",
      stepId: "s2",
      modelName: "app",
      modelType: "config",
      modelId: "test-model-id",
      methodName: "validate",
    },
    { kind: "step_completed", jobId: "configure", stepId: "s2" },
    { kind: "job_completed", jobId: "configure", status: "succeeded" },
  );

  const jobItem = state.scrollback.find(
    (s) => s.type === "job" && s.jobId === "configure",
  );
  assertEquals(jobItem?.type, "job");
  if (jobItem?.type === "job") {
    // Multi-step job should not have a single step label
    assertEquals(jobItem.singleStepLabel, null);
    assertEquals(jobItem.completedStepCount, 2);
  }
});

Deno.test("treeReducer: batch action processes multiple events atomically", () => {
  const initial = createInitialState("deploy");

  const state = treeReducer(initial, {
    type: "batch",
    events: [
      startedEvent,
      { kind: "job_started", jobId: "provision" },
      { kind: "step_started", jobId: "provision", stepId: "s1" },
      {
        kind: "model_resolved",
        jobId: "provision",
        stepId: "s1",
        modelName: "ec2",
        modelType: "aws/ec2",
        modelId: "test-model-id",
        methodName: "create",
      },
      {
        kind: "method_output",
        jobId: "provision",
        stepId: "s1",
        modelName: "ec2",
        methodName: "create",
        stream: "stdout" as const,
        line: "Creating...",
      },
    ],
  });

  // All events should have been processed
  assertEquals(state.phase, "running");
  const job = state.jobs.get("provision")!;
  assertEquals(job.status, "running");
  const step = job.steps.get("s1")!;
  assertEquals(step.modelName, "ec2");
  assertEquals(step.outputBuffer, ["Creating..."]);
});

Deno.test("treeReducer: singleStepLabel includes step name prefix for forEach-expanded steps", () => {
  const state = reduce(
    createInitialState("test"),
    {
      kind: "started",
      runId: "run-1",
      workflowName: "test",
      jobs: [{ id: "test-job", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "test-job" },
    { kind: "step_started", jobId: "test-job", stepId: "test-alpine" },
    {
      kind: "model_resolved",
      jobId: "test-job",
      stepId: "test-alpine",
      modelName: "tester",
      modelType: "test/runner",
      modelId: "test-model-id",
      methodName: "smokeTest",
    },
    { kind: "step_completed", jobId: "test-job", stepId: "test-alpine" },
    { kind: "job_completed", jobId: "test-job", status: "succeeded" },
  );

  const item = state.scrollback[0];
  assertEquals(item.type, "job");
  if (item.type === "job") {
    assertEquals(item.singleStepLabel, "test-alpine: tester \u2192 smokeTest");
  }
});

Deno.test("treeReducer: singleStepLabel omits prefix when stepId matches modelName", () => {
  const state = reduce(
    createInitialState("deploy"),
    {
      kind: "started",
      runId: "run-1",
      workflowName: "deploy",
      jobs: [{ id: "provision", stepCount: 1, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "provision" },
    { kind: "step_started", jobId: "provision", stepId: "ec2-instance" },
    {
      kind: "model_resolved",
      jobId: "provision",
      stepId: "ec2-instance",
      modelName: "ec2-instance",
      modelType: "aws/ec2",
      modelId: "test-model-id",
      methodName: "create",
    },
    { kind: "step_completed", jobId: "provision", stepId: "ec2-instance" },
    { kind: "job_completed", jobId: "provision", status: "succeeded" },
  );

  const item = state.scrollback[0];
  assertEquals(item.type, "job");
  if (item.type === "job") {
    // No prefix when stepId matches modelName
    assertEquals(item.singleStepLabel, "ec2-instance \u2192 create");
  }
});
