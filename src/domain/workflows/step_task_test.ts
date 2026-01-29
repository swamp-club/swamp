import { assertEquals, assertThrows } from "@std/assert";
import { StepTask, StepTaskSchema } from "./step_task.ts";

Deno.test("StepTask.modelMethod creates model method task", () => {
  const task = StepTask.modelMethod("my-model", "run");
  assertEquals(task.data, {
    type: "model_method",
    modelIdOrName: "my-model",
    methodName: "run",
  });
  assertEquals(task.isModelMethod(), true);
  assertEquals(task.isShell(), false);
});

Deno.test("StepTask.shell creates shell task with defaults", () => {
  const task = StepTask.shell("echo");
  assertEquals(task.data, {
    type: "shell",
    command: "echo",
    args: [],
    workingDir: undefined,
    timeout: undefined,
  });
  assertEquals(task.isModelMethod(), false);
  assertEquals(task.isShell(), true);
});

Deno.test("StepTask.shell creates shell task with options", () => {
  const task = StepTask.shell("npm", {
    args: ["install", "--production"],
    workingDir: "/app",
    timeout: 60000,
  });
  assertEquals(task.data, {
    type: "shell",
    command: "npm",
    args: ["install", "--production"],
    workingDir: "/app",
    timeout: 60000,
  });
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

Deno.test("StepTask.fromData creates shell task", () => {
  const task = StepTask.fromData({
    type: "shell",
    command: "ls",
    args: ["-la"],
  });
  assertEquals(task.isShell(), true);
  assertEquals(task.data.type, "shell");
});

Deno.test("StepTask.toData returns correct structure", () => {
  const task = StepTask.shell("echo", { args: ["hello"] });
  const data = task.toData();
  assertEquals(data, {
    type: "shell",
    command: "echo",
    args: ["hello"],
    workingDir: undefined,
    timeout: undefined,
  });
});

Deno.test("StepTask.equals returns true for identical tasks", () => {
  const task1 = StepTask.modelMethod("model", "method");
  const task2 = StepTask.modelMethod("model", "method");
  assertEquals(task1.equals(task2), true);
});

Deno.test("StepTask.equals returns false for different tasks", () => {
  const task1 = StepTask.modelMethod("model1", "method");
  const task2 = StepTask.modelMethod("model2", "method");
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

Deno.test("StepTaskSchema rejects empty command", () => {
  assertThrows(() => {
    StepTaskSchema.parse({
      type: "shell",
      command: "",
    });
  });
});

Deno.test("StepTaskSchema rejects non-positive timeout", () => {
  assertThrows(() => {
    StepTaskSchema.parse({
      type: "shell",
      command: "echo",
      timeout: 0,
    });
  });
});

Deno.test("StepTaskSchema sets default args for shell task", () => {
  const result = StepTaskSchema.parse({
    type: "shell",
    command: "echo",
  });
  assertEquals(result.type, "shell");
  if (result.type === "shell") {
    assertEquals(result.args, []);
  }
});
