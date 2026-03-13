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

import { assertEquals, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  consumeStream,
  type WorkflowRunEvent,
  type WorkflowRunView,
} from "../../libswamp/mod.ts";
import { createWorkflowRunRenderer } from "./workflow_run.ts";
import { UserError } from "../../domain/errors.ts";

await initializeLogging({});

function makeRunData(
  status: "succeeded" | "failed",
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "test-workflow",
    status,
    jobs: [{
      name: "job-1",
      status: status === "succeeded" ? "succeeded" : "failed",
      steps: [{
        name: "step-1",
        status: status === "succeeded" ? "succeeded" : "failed",
      }],
    }],
  };
}

function makeRunDataWithArtifacts(): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "test-workflow",
    status: "succeeded",
    jobs: [{
      name: "job-1",
      status: "succeeded",
      steps: [{
        name: "step-1",
        status: "succeeded",
        dataArtifacts: [{
          dataId: "d-1",
          name: "my-data",
          version: 1,
          tags: {},
        }],
      }],
    }],
  };
}

function fullEventStream(
  runData: WorkflowRunView,
): WorkflowRunEvent[] {
  return [
    { step: "validating_inputs" },
    { step: "evaluating_workflow" },
    { step: "started", runId: "run-1", workflowName: "test-workflow" },
    { step: "job_started", jobId: "job-1" },
    { step: "step_started", jobId: "job-1", stepId: "step-1" },
    { step: "step_completed", jobId: "job-1", stepId: "step-1" },
    { step: "job_completed", jobId: "job-1", status: "succeeded" },
    { step: "completed", run: runData },
  ];
}

async function* toStream(
  events: WorkflowRunEvent[],
): AsyncGenerator<WorkflowRunEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogWorkflowRunRenderer - succeeded workflow sets workflowFailed() to false", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-workflow",
  });
  const events = fullEventStream(makeRunData("succeeded"));
  await consumeStream(toStream(events), renderer.handlers());
  assertEquals(renderer.workflowFailed(), false);
});

Deno.test("LogWorkflowRunRenderer - failed workflow sets workflowFailed() to true", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-workflow",
  });
  const events: WorkflowRunEvent[] = [
    { step: "validating_inputs" },
    { step: "started", runId: "run-1", workflowName: "test-workflow" },
    { step: "job_started", jobId: "job-1" },
    {
      step: "step_failed",
      jobId: "job-1",
      stepId: "step-1",
      error: "something broke",
    },
    { step: "job_completed", jobId: "job-1", status: "failed" },
    { step: "completed", run: makeRunData("failed") },
  ];
  await consumeStream(toStream(events), renderer.handlers());
  assertEquals(renderer.workflowFailed(), true);
});

Deno.test("LogWorkflowRunRenderer - handles data artifact hints without error", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-workflow",
  });
  const events = fullEventStream(makeRunDataWithArtifacts());
  await consumeStream(toStream(events), renderer.handlers());
  assertEquals(renderer.workflowFailed(), false);
});

Deno.test("LogWorkflowRunRenderer - handles skipped events", async () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-workflow",
  });
  const events: WorkflowRunEvent[] = [
    { step: "validating_inputs" },
    { step: "evaluating_workflow" },
    { step: "started", runId: "run-1", workflowName: "test-workflow" },
    { step: "job_started", jobId: "job-1" },
    { step: "step_skipped", jobId: "job-1", stepId: "step-1" },
    { step: "job_skipped", jobId: "job-1" },
    { step: "completed", run: makeRunData("succeeded") },
  ];
  await consumeStream(toStream(events), renderer.handlers());
  assertEquals(renderer.workflowFailed(), false);
});

Deno.test("LogWorkflowRunRenderer - error event throws UserError", () => {
  const renderer = createWorkflowRunRenderer("log", {
    workflowName: "test-workflow",
  });
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        step: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});

Deno.test("JsonWorkflowRunRenderer - intermediate events produce no output", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-workflow",
    });
    const events: WorkflowRunEvent[] = [
      { step: "validating_inputs" },
      { step: "evaluating_workflow" },
      { step: "started", runId: "run-1", workflowName: "test-workflow" },
      { step: "job_started", jobId: "job-1" },
      { step: "step_started", jobId: "job-1", stepId: "step-1" },
      { step: "step_completed", jobId: "job-1", stepId: "step-1" },
      { step: "job_completed", jobId: "job-1", status: "succeeded" },
    ];
    for (const event of events) {
      const handler = renderer.handlers()[event.step];
      // deno-lint-ignore no-explicit-any
      handler(event as any);
    }
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonWorkflowRunRenderer - completed serializes JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-workflow",
    });
    const runData = makeRunData("succeeded");
    const events = fullEventStream(runData);
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, "run-1");
    assertEquals(parsed.workflowName, "test-workflow");
    assertEquals(parsed.status, "succeeded");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonWorkflowRunRenderer - failed workflow sets workflowFailed() to true", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-workflow",
    });
    const events: WorkflowRunEvent[] = [
      { step: "validating_inputs" },
      { step: "completed", run: makeRunData("failed") },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(renderer.workflowFailed(), true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonWorkflowRunRenderer - succeeded workflow sets workflowFailed() to false", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowRunRenderer("json", {
      workflowName: "test-workflow",
    });
    const events: WorkflowRunEvent[] = [
      { step: "validating_inputs" },
      { step: "completed", run: makeRunData("succeeded") },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(renderer.workflowFailed(), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonWorkflowRunRenderer - error event throws UserError", () => {
  const renderer = createWorkflowRunRenderer("json", {
    workflowName: "test-workflow",
  });
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        step: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});

Deno.test("createWorkflowRunRenderer - factory returns correct type per mode", () => {
  const logRenderer = createWorkflowRunRenderer("log", {
    workflowName: "wf",
  });
  const jsonRenderer = createWorkflowRunRenderer("json", {
    workflowName: "wf",
  });

  // Both should implement the WorkflowRunRenderer interface
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof logRenderer.workflowFailed, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.workflowFailed, "function");
});
