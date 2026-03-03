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
import { configure, type LogRecord } from "@logtape/logtape";
import { createLogProgressCallback } from "./log_progress_callback.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";

// Create a minimal workflow for testing
function createTestWorkflow(): Workflow {
  return Workflow.fromData({
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    name: "test-workflow",
    description: "Test workflow",
    tags: {},
    inputs: undefined,
    version: 1,
    jobs: [
      {
        name: "test-job",
        description: "Test job",
        steps: [
          {
            name: "test-step",
            description: "Test step",
            task: {
              type: "model_method",
              modelIdOrName: "test-model",
              methodName: "run",
            },
            dependsOn: [],
            weight: 0,
          },
        ],
        dependsOn: [],
        weight: 0,
      },
    ],
  });
}

Deno.test("createLogProgressCallback returns all lifecycle callbacks", () => {
  const callback = createLogProgressCallback("test-workflow");

  assertEquals(typeof callback.onWorkflowStart, "function");
  assertEquals(typeof callback.onJobStart, "function");
  assertEquals(typeof callback.onJobComplete, "function");
  assertEquals(typeof callback.onJobSkip, "function");
  assertEquals(typeof callback.onStepStart, "function");
  assertEquals(typeof callback.onStepComplete, "function");
  assertEquals(typeof callback.onStepSkip, "function");
  assertEquals(typeof callback.onStepFail, "function");
  assertEquals(typeof callback.onWorkflowComplete, "function");
});

Deno.test("createLogProgressCallback does not include stdout/stderr callbacks", () => {
  const callback = createLogProgressCallback("test-workflow");

  // onStepStdout/onStepStderr were removed from ExecutionProgressCallback.
  // Process output now flows through LogTape loggers and RunFileSink.
  const callbackKeys = Object.keys(callback);
  assertEquals(callbackKeys.includes("onStepStdout"), false);
  assertEquals(callbackKeys.includes("onStepStderr"), false);
});

Deno.test("createLogProgressCallback lifecycle callbacks do not throw", () => {
  const callback = createLogProgressCallback("test-workflow");
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);

  // All callbacks should execute without throwing
  callback.onWorkflowStart?.(run);
  callback.onJobStart?.(run, "test-job");
  callback.onStepStart?.(run, "test-job", "test-step");
  callback.onStepComplete?.(run, "test-job", "test-step");
  callback.onStepSkip?.(run, "test-job", "test-step");
  callback.onStepFail?.(run, "test-job", "test-step", "some error");
  callback.onJobComplete?.(run, "test-job");
  callback.onJobSkip?.(run, "test-job");

  run.start();
  run.complete();
  callback.onWorkflowComplete?.(run);
});

// Helper: configure LogTape to capture records, run fn, then reset.
async function withLogCapture(
  fn: (records: LogRecord[]) => void,
): Promise<void> {
  const records: LogRecord[] = [];
  await configure({
    sinks: {
      test: (record: LogRecord) => {
        records.push(record);
      },
    },
    loggers: [
      {
        category: ["workflow", "run"],
        lowestLevel: "debug",
        sinks: ["test"],
      },
    ],
    reset: true,
  });
  try {
    fn(records);
  } finally {
    await configure({ sinks: {}, loggers: [], reset: true });
  }
}

Deno.test("onWorkflowComplete logs data commands for successful run with artifacts", async () => {
  await withLogCapture((records) => {
    const callback = createLogProgressCallback("test-workflow");
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    // Add data artifacts to the step
    const step = run.getJob("test-job")!.getStep("test-step")!;
    step.addDataArtifact({
      dataId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "my-data",
      version: 1,
      tags: {},
    });

    run.start();
    run.complete();
    callback.onWorkflowComplete?.(run);

    const messages = records.map((r) => r.rawMessage);
    assertEquals(messages.includes("View produced data:"), true);
    assertEquals(
      messages.includes(
        "  swamp data list --workflow {workflowName}",
      ),
      true,
    );
    assertEquals(
      messages.includes(
        "  swamp data get --workflow {workflowName} {artifactName}",
      ),
      true,
    );

    // Verify the artifact name was passed as a property
    const getRecord = records.find(
      (r) =>
        r.rawMessage ===
          "  swamp data get --workflow {workflowName} {artifactName}",
    );
    assertEquals(getRecord?.properties.artifactName, "my-data");
    assertEquals(getRecord?.properties.workflowName, "test-workflow");
  });
});

Deno.test("onWorkflowComplete does not log data commands for failed run", async () => {
  await withLogCapture((records) => {
    const callback = createLogProgressCallback("test-workflow");
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    // Add data artifacts to the step
    const step = run.getJob("test-job")!.getStep("test-step")!;
    step.addDataArtifact({
      dataId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "my-data",
      version: 1,
      tags: {},
    });

    // Force a failed run
    run.start();
    run.getJob("test-job")!.start();
    run.getJob("test-job")!.fail();
    run.complete();
    callback.onWorkflowComplete?.(run);

    const messages = records.map((r) => r.rawMessage);
    assertEquals(messages.includes("View produced data:"), false);
    assertEquals(
      messages.includes(
        "  swamp data get --workflow {workflowName} {artifactName}",
      ),
      false,
    );
  });
});

Deno.test("onWorkflowComplete does not log data commands when no artifacts exist", async () => {
  await withLogCapture((records) => {
    const callback = createLogProgressCallback("test-workflow");
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    // No data artifacts added
    run.start();
    run.complete();
    callback.onWorkflowComplete?.(run);

    const messages = records.map((r) => r.rawMessage);
    assertEquals(messages.includes("View produced data:"), false);
    assertEquals(
      messages.includes(
        "  swamp data list --workflow {workflowName}",
      ),
      false,
    );
  });
});
