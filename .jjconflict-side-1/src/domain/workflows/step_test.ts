import { assertEquals } from "@std/assert";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";

Deno.test("Step.create creates step with minimal props", () => {
  const task = StepTask.shell("echo", { args: ["hello"] });
  const step = Step.create({
    name: "say-hello",
    task,
  });

  assertEquals(step.name, "say-hello");
  assertEquals(step.description, undefined);
  assertEquals(step.task.equals(task), true);
  assertEquals(step.dependsOn.length, 0);
  assertEquals(step.weight, 0);
});

Deno.test("Step.create creates step with all props", () => {
  const task = StepTask.modelMethod("my-model", "run");
  const step = Step.create({
    name: "run-model",
    description: "Runs the model",
    task,
    dependsOn: [
      { step: "prepare", condition: TriggerCondition.succeeded("prepare") },
    ],
    weight: 10,
  });

  assertEquals(step.name, "run-model");
  assertEquals(step.description, "Runs the model");
  assertEquals(step.task.equals(task), true);
  assertEquals(step.dependsOn.length, 1);
  assertEquals(step.dependsOn[0].step, "prepare");
  assertEquals(step.weight, 10);
});

Deno.test("Step.getDependencyNames returns step names", () => {
  const task = StepTask.shell("echo");
  const step = Step.create({
    name: "final",
    task,
    dependsOn: [
      { step: "step1", condition: TriggerCondition.succeeded("step1") },
      { step: "step2", condition: TriggerCondition.succeeded("step2") },
    ],
  });

  assertEquals(step.getDependencyNames().sort(), ["step1", "step2"]);
});

Deno.test("Step.fromData reconstructs step correctly", () => {
  const data = {
    name: "test-step",
    description: "A test step",
    task: {
      type: "shell" as const,
      command: "echo",
      args: ["test"],
    },
    dependsOn: [
      {
        step: "prev",
        condition: { type: "always" as const },
      },
    ],
    weight: 5,
  };

  const step = Step.fromData(data);
  assertEquals(step.name, "test-step");
  assertEquals(step.description, "A test step");
  assertEquals(step.task.isShell(), true);
  assertEquals(step.dependsOn.length, 1);
  assertEquals(step.dependsOn[0].step, "prev");
  assertEquals(step.weight, 5);
});

Deno.test("Step.toData returns correct structure", () => {
  const task = StepTask.shell("echo", { args: ["hello"] });
  const step = Step.create({
    name: "say-hello",
    description: "Says hello",
    task,
    dependsOn: [
      { step: "prepare", condition: TriggerCondition.always() },
    ],
    weight: 3,
  });

  const data = step.toData();
  assertEquals(data.name, "say-hello");
  assertEquals(data.description, "Says hello");
  assertEquals(data.task.type, "shell");
  assertEquals(data.dependsOn.length, 1);
  assertEquals(data.dependsOn[0].step, "prepare");
  assertEquals(data.dependsOn[0].condition.type, "always");
  assertEquals(data.weight, 3);
});

Deno.test("Step.fromData and toData roundtrip correctly", () => {
  const original = Step.create({
    name: "complex-step",
    description: "A complex step",
    task: StepTask.modelMethod("model", "method"),
    dependsOn: [
      { step: "step1", condition: TriggerCondition.succeeded("step1") },
      {
        step: "step2",
        condition: TriggerCondition.or([
          TriggerCondition.failed("step2"),
          TriggerCondition.skipped("step2"),
        ]),
      },
    ],
    weight: 100,
  });

  const data = original.toData();
  const restored = Step.fromData(data);

  assertEquals(restored.name, original.name);
  assertEquals(restored.description, original.description);
  assertEquals(restored.task.equals(original.task), true);
  assertEquals(restored.dependsOn.length, original.dependsOn.length);
  assertEquals(restored.weight, original.weight);
});
