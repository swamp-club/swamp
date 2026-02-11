import { assertEquals, assertThrows } from "@std/assert";
import { StepTask, StepTaskSchema } from "./step_task.ts";

Deno.test("StepTask.modelMethod creates model method task", () => {
  const task = StepTask.modelMethod("my-model", "run");
  assertEquals(task.data, {
    type: "model_method",
    modelIdOrName: "my-model",
    methodName: "run",
    inputs: undefined,
  });
  assertEquals(task.isModelMethod(), true);
  assertEquals(task.isWorkflow(), false);
});

Deno.test("StepTask.modelMethod creates model method task with inputs", () => {
  const task = StepTask.modelMethod("my-model", "run", {
    environment: "dev",
    count: 5,
  });
  assertEquals(task.data, {
    type: "model_method",
    modelIdOrName: "my-model",
    methodName: "run",
    inputs: {
      environment: "dev",
      count: 5,
    },
  });
  assertEquals(task.isModelMethod(), true);
});

Deno.test("StepTask.model is an alias for modelMethod", () => {
  const task = StepTask.model("my-model", "run");
  assertEquals(task.data.type, "model_method");
  assertEquals(task.isModelMethod(), true);
});

Deno.test("StepTask.workflow creates workflow task", () => {
  const task = StepTask.workflow("deploy-pipeline");
  assertEquals(task.data, {
    type: "workflow",
    workflowIdOrName: "deploy-pipeline",
    inputs: undefined,
  });
  assertEquals(task.isWorkflow(), true);
  assertEquals(task.isModelMethod(), false);
});

Deno.test("StepTask.workflow creates workflow task with inputs", () => {
  const task = StepTask.workflow("deploy-pipeline", {
    environment: "production",
    replicas: 3,
  });
  assertEquals(task.data, {
    type: "workflow",
    workflowIdOrName: "deploy-pipeline",
    inputs: {
      environment: "production",
      replicas: 3,
    },
  });
  assertEquals(task.isWorkflow(), true);
});

Deno.test("StepTask.fromData creates model method task", () => {
  const task = StepTask.fromData({
    type: "model_method",
    modelIdOrName: "my-model",
    methodName: "execute",
  });
  assertEquals(task.isModelMethod(), true);
  assertEquals(task.data.type, "model_method");
});

Deno.test("StepTask.fromData creates workflow task", () => {
  const task = StepTask.fromData({
    type: "workflow",
    workflowIdOrName: "my-workflow",
  });
  assertEquals(task.isWorkflow(), true);
  assertEquals(task.data.type, "workflow");
});

Deno.test("StepTask.toData returns correct structure for model method task", () => {
  const task = StepTask.modelMethod("my-model", "run", { key: "value" });
  const data = task.toData();
  assertEquals(data, {
    type: "model_method",
    modelIdOrName: "my-model",
    methodName: "run",
    inputs: { key: "value" },
  });
});

Deno.test("StepTask.toData returns correct structure for workflow task", () => {
  const task = StepTask.workflow("my-workflow", { env: "dev" });
  const data = task.toData();
  assertEquals(data, {
    type: "workflow",
    workflowIdOrName: "my-workflow",
    inputs: { env: "dev" },
  });
});

Deno.test("StepTask.equals returns true for identical model method tasks", () => {
  const task1 = StepTask.modelMethod("model", "method");
  const task2 = StepTask.modelMethod("model", "method");
  assertEquals(task1.equals(task2), true);
});

Deno.test("StepTask.equals returns false for different model method tasks", () => {
  const task1 = StepTask.modelMethod("model1", "method");
  const task2 = StepTask.modelMethod("model2", "method");
  assertEquals(task1.equals(task2), false);
});

Deno.test("StepTask.equals returns true for identical workflow tasks", () => {
  const task1 = StepTask.workflow("wf", { env: "dev" });
  const task2 = StepTask.workflow("wf", { env: "dev" });
  assertEquals(task1.equals(task2), true);
});

Deno.test("StepTask.equals returns false for different task types", () => {
  const task1 = StepTask.modelMethod("model", "run");
  const task2 = StepTask.workflow("model");
  assertEquals(task1.equals(task2), false);
});

// Schema validation tests

Deno.test("StepTaskSchema rejects empty modelIdOrName", () => {
  assertThrows(() => {
    StepTaskSchema.parse({
      type: "model_method",
      modelIdOrName: "",
      methodName: "run",
    });
  });
});

Deno.test("StepTaskSchema rejects empty methodName", () => {
  assertThrows(() => {
    StepTaskSchema.parse({
      type: "model_method",
      modelIdOrName: "model",
      methodName: "",
    });
  });
});

Deno.test("StepTaskSchema rejects empty workflowIdOrName", () => {
  assertThrows(() => {
    StepTaskSchema.parse({
      type: "workflow",
      workflowIdOrName: "",
    });
  });
});

// Backward compatibility tests

Deno.test("StepTaskSchema throws clear error for shell type", () => {
  assertThrows(
    () => {
      StepTaskSchema.parse({
        type: "shell",
        command: "echo",
      });
    },
    Error,
    'Step task type "shell" is no longer supported',
  );
});

Deno.test("StepTaskSchema shell error suggests keeb/shell model", () => {
  assertThrows(
    () => {
      StepTaskSchema.parse({
        type: "shell",
        command: "echo",
      });
    },
    Error,
    "keeb/shell",
  );
});
