import { assertEquals } from "@std/assert";
import { createLogProgressCallback } from "./log_progress_callback.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";

// Create a minimal workflow for testing
function createTestWorkflow(): Workflow {
  return Workflow.fromData({
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    name: "test-workflow",
    description: "Test workflow",
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
  assertEquals(typeof callback.onImplicitDependencies, "function");
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

Deno.test("createLogProgressCallback onImplicitDependencies does not throw", () => {
  const callback = createLogProgressCallback("test-workflow");

  const deps = new Map<string, Map<string, string[]>>();
  const stepDeps = new Map<string, string[]>();
  stepDeps.set("step-b", ["step-a"]);
  deps.set("test-job", stepDeps);

  callback.onImplicitDependencies?.(deps);
});
