import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createModelMethodStreamCallback,
  createStreamProgressCallback,
} from "./stream_output.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";

// Helper to capture console output
function captureConsole(): {
  logs: string[];
  errors: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

// Create a minimal workflow for testing
function createTestWorkflow(): Workflow {
  return Workflow.fromData({
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    name: "test-workflow",
    description: "Test workflow",
    version: 1,
    jobs: [
      {
        name: "test-job",
        description: "Test job",
        steps: [
          {
            name: "test-step",
            description: "Test step",
            task: { type: "shell", command: "echo", args: ["hello"] },
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

Deno.test("createStreamProgressCallback onWorkflowStart logs workflow name", () => {
  const capture = captureConsole();
  try {
    const callback = createStreamProgressCallback();
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    callback.onWorkflowStart?.(run);

    assertEquals(capture.logs.length, 1);
    assertStringIncludes(capture.logs[0], "[workflow]");
    assertStringIncludes(capture.logs[0], "test-workflow");
  } finally {
    capture.restore();
  }
});

Deno.test("createStreamProgressCallback onJobStart logs job name", () => {
  const capture = captureConsole();
  try {
    const callback = createStreamProgressCallback();
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    callback.onJobStart?.(run, "test-job");

    assertEquals(capture.logs.length, 1);
    assertStringIncludes(capture.logs[0], "[test-job]");
    assertStringIncludes(capture.logs[0], "Job started");
  } finally {
    capture.restore();
  }
});

Deno.test("createStreamProgressCallback onStepStart logs step name with job prefix", () => {
  const capture = captureConsole();
  try {
    const callback = createStreamProgressCallback();
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    callback.onStepStart?.(run, "test-job", "test-step");

    assertEquals(capture.logs.length, 1);
    assertStringIncludes(capture.logs[0], "[test-job/test-step]");
    assertStringIncludes(capture.logs[0], "Step started");
  } finally {
    capture.restore();
  }
});

Deno.test("createStreamProgressCallback onStepStdout logs line with green color", () => {
  const capture = captureConsole();
  try {
    const callback = createStreamProgressCallback();
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    callback.onStepStdout?.(run, "test-job", "test-step", "hello world");

    assertEquals(capture.logs.length, 1);
    assertStringIncludes(capture.logs[0], "[test-job/test-step]");
    assertStringIncludes(capture.logs[0], "hello world");
    // Check for green ANSI code
    assertStringIncludes(capture.logs[0], "\x1b[32m");
  } finally {
    capture.restore();
  }
});

Deno.test("createStreamProgressCallback onStepStderr logs to console.error with red color", () => {
  const capture = captureConsole();
  try {
    const callback = createStreamProgressCallback();
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    callback.onStepStderr?.(run, "test-job", "test-step", "error message");

    assertEquals(capture.errors.length, 1);
    assertStringIncludes(capture.errors[0], "[test-job/test-step]");
    assertStringIncludes(capture.errors[0], "error message");
    // Check for red ANSI code
    assertStringIncludes(capture.errors[0], "\x1b[31m");
  } finally {
    capture.restore();
  }
});

Deno.test("createStreamProgressCallback onStepFail logs error to console.error", () => {
  const capture = captureConsole();
  try {
    const callback = createStreamProgressCallback();
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    callback.onStepFail?.(run, "test-job", "test-step", "Command failed");

    assertEquals(capture.errors.length, 1);
    assertStringIncludes(capture.errors[0], "[test-job/test-step]");
    assertStringIncludes(capture.errors[0], "Step failed");
    assertStringIncludes(capture.errors[0], "Command failed");
  } finally {
    capture.restore();
  }
});

Deno.test("createStreamProgressCallback onWorkflowComplete logs success status with green", () => {
  const capture = captureConsole();
  try {
    const callback = createStreamProgressCallback();
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    run.complete();

    callback.onWorkflowComplete?.(run);

    assertEquals(capture.logs.length, 1);
    assertStringIncludes(capture.logs[0], "[workflow]");
    assertStringIncludes(capture.logs[0], "succeeded");
  } finally {
    capture.restore();
  }
});

Deno.test("createModelMethodStreamCallback creates callbacks with correct prefix", () => {
  const capture = captureConsole();
  try {
    const callbacks = createModelMethodStreamCallback("my-model", "execute");

    callbacks.onStdout("stdout line");
    callbacks.onStderr("stderr line");

    assertEquals(capture.logs.length, 1);
    assertEquals(capture.errors.length, 1);
    assertStringIncludes(capture.logs[0], "[my-model/execute]");
    assertStringIncludes(capture.logs[0], "stdout line");
    assertStringIncludes(capture.errors[0], "[my-model/execute]");
    assertStringIncludes(capture.errors[0], "stderr line");
  } finally {
    capture.restore();
  }
});
