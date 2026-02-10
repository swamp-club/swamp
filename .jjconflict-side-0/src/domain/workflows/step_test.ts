import { assertEquals } from "@std/assert";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";

Deno.test("Step.create creates step with minimal props", () => {
  const task = StepTask.model("test-model", "run");
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
  const task = StepTask.model("my-model", "run");
  const step = Step.create({
    name: "run-model",
    description: "Runs the model",
    task,
    dependsOn: [
      { step: "prepare", condition: TriggerCondition.succeeded() },
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
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "final",
    task,
    dependsOn: [
      { step: "step1", condition: TriggerCondition.succeeded() },
      { step: "step2", condition: TriggerCondition.succeeded() },
    ],
  });

  assertEquals(step.getDependencyNames().sort(), ["step1", "step2"]);
});

Deno.test("Step.fromData reconstructs step correctly", () => {
  const data = {
    name: "test-step",
    description: "A test step",
    task: {
      type: "model_method" as const,
      modelIdOrName: "test-model",
      methodName: "run",
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
  assertEquals(step.task.isModelMethod(), true);
  assertEquals(step.dependsOn.length, 1);
  assertEquals(step.dependsOn[0].step, "prev");
  assertEquals(step.weight, 5);
});

Deno.test("Step.toData returns correct structure", () => {
  const task = StepTask.model("test-model", "run");
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
  assertEquals(data.task.type, "model_method");
  assertEquals(data.dependsOn.length, 1);
  assertEquals(data.dependsOn[0].step, "prepare");
  assertEquals(data.dependsOn[0].condition.type, "always");
  assertEquals(data.weight, 3);
});

Deno.test("Step.fromData and toData roundtrip correctly", () => {
  const original = Step.create({
    name: "complex-step",
    description: "A complex step",
    task: StepTask.model("model", "method"),
    dependsOn: [
      { step: "step1", condition: TriggerCondition.succeeded() },
      {
        step: "step2",
        condition: TriggerCondition.or([
          TriggerCondition.failed(),
          TriggerCondition.skipped(),
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

// forEach field tests

Deno.test("Step.create creates step with forEach", () => {
  const task = StepTask.model("echo-model", "write");
  const step = Step.create({
    name: "deploy-${{self.env}}",
    task,
    forEach: {
      item: "env",
      in: "${{ inputs.environments }}",
    },
  });

  assertEquals(step.forEach !== undefined, true);
  assertEquals(step.forEach?.item, "env");
  assertEquals(step.forEach?.in, "${{ inputs.environments }}");
});

Deno.test("Step.create creates step without forEach", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "simple-step",
    task,
  });

  assertEquals(step.forEach, undefined);
});

Deno.test("Step.fromData reconstructs step with forEach", () => {
  const data = {
    name: "process-${{self.item}}",
    task: {
      type: "model_method" as const,
      modelIdOrName: "processor",
      methodName: "run",
    },
    forEach: {
      item: "item",
      in: "${{ inputs.items }}",
    },
    dependsOn: [],
    weight: 0,
  };

  const step = Step.fromData(data);
  assertEquals(step.forEach !== undefined, true);
  assertEquals(step.forEach?.item, "item");
  assertEquals(step.forEach?.in, "${{ inputs.items }}");
});

Deno.test("Step.toData includes forEach in output", () => {
  const step = Step.create({
    name: "tag-${{self.tag.key}}",
    task: StepTask.model("tagger", "apply"),
    forEach: {
      item: "tag",
      in: "${{ inputs.tags }}",
    },
  });

  const data = step.toData();
  assertEquals(data.forEach !== undefined, true);
  assertEquals(data.forEach?.item, "tag");
  assertEquals(data.forEach?.in, "${{ inputs.tags }}");
});

Deno.test("Step.fromData and toData roundtrip with forEach", () => {
  const original = Step.create({
    name: "deploy-${{self.region}}",
    description: "Deploy to region",
    task: StepTask.model("deployer", "deploy"),
    forEach: {
      item: "region",
      in: "${{ inputs.regions }}",
    },
    weight: 5,
  });

  const data = original.toData();
  const restored = Step.fromData(data);

  assertEquals(restored.name, original.name);
  assertEquals(restored.forEach?.item, original.forEach?.item);
  assertEquals(restored.forEach?.in, original.forEach?.in);
});
