import { assertEquals, assertThrows } from "@std/assert";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";

function createTestStep(name: string): Step {
  return Step.create({
    name,
    task: StepTask.model("test-model", "run"),
  });
}

Deno.test("Job.create creates job with minimal props", () => {
  const step = createTestStep("step1");
  const job = Job.create({
    name: "build",
    steps: [step],
  });

  assertEquals(job.name, "build");
  assertEquals(job.description, undefined);
  assertEquals(job.steps.length, 1);
  assertEquals(job.dependsOn.length, 0);
  assertEquals(job.weight, 0);
});

Deno.test("Job.create creates job with all props", () => {
  const step1 = createTestStep("step1");
  const step2 = createTestStep("step2");
  const job = Job.create({
    name: "deploy",
    description: "Deploys the application",
    steps: [step1, step2],
    dependsOn: [
      { job: "build", condition: TriggerCondition.succeeded() },
    ],
    weight: 10,
  });

  assertEquals(job.name, "deploy");
  assertEquals(job.description, "Deploys the application");
  assertEquals(job.steps.length, 2);
  assertEquals(job.dependsOn.length, 1);
  assertEquals(job.dependsOn[0].job, "build");
  assertEquals(job.weight, 10);
});

Deno.test("Job.create throws on empty steps", () => {
  assertThrows(
    () =>
      Job.create({
        name: "empty",
        steps: [],
      }),
    Error,
    "at least one step",
  );
});

Deno.test("Job.getDependencyNames returns job names", () => {
  const step = createTestStep("step1");
  const job = Job.create({
    name: "final",
    steps: [step],
    dependsOn: [
      { job: "job1", condition: TriggerCondition.succeeded() },
      { job: "job2", condition: TriggerCondition.completed() },
    ],
  });

  assertEquals(job.getDependencyNames().sort(), ["job1", "job2"]);
});

Deno.test("Job.getStep finds step by name", () => {
  const step1 = createTestStep("step1");
  const step2 = createTestStep("step2");
  const job = Job.create({
    name: "test",
    steps: [step1, step2],
  });

  const found = job.getStep("step2");
  assertEquals(found?.name, "step2");

  const notFound = job.getStep("nonexistent");
  assertEquals(notFound, undefined);
});

Deno.test("Job.fromData reconstructs job correctly", () => {
  const data = {
    name: "test-job",
    description: "A test job",
    steps: [
      {
        name: "step1",
        task: {
          type: "model_method" as const,
          modelIdOrName: "test-model",
          methodName: "run",
        },
        dependsOn: [],
        weight: 0,
      },
    ],
    dependsOn: [
      {
        job: "prev-job",
        condition: { type: "always" as const },
      },
    ],
    weight: 5,
  };

  const job = Job.fromData(data);
  assertEquals(job.name, "test-job");
  assertEquals(job.description, "A test job");
  assertEquals(job.steps.length, 1);
  assertEquals(job.dependsOn.length, 1);
  assertEquals(job.dependsOn[0].job, "prev-job");
  assertEquals(job.weight, 5);
});

Deno.test("Job.toData returns correct structure", () => {
  const step = createTestStep("step1");
  const job = Job.create({
    name: "test-job",
    description: "Test description",
    steps: [step],
    dependsOn: [
      { job: "dependency", condition: TriggerCondition.always() },
    ],
    weight: 3,
  });

  const data = job.toData();
  assertEquals(data.name, "test-job");
  assertEquals(data.description, "Test description");
  assertEquals(data.steps.length, 1);
  assertEquals(data.steps[0].name, "step1");
  assertEquals(data.dependsOn.length, 1);
  assertEquals(data.dependsOn[0].job, "dependency");
  assertEquals(data.weight, 3);
});

Deno.test("Job.fromData and toData roundtrip correctly", () => {
  const original = Job.create({
    name: "complex-job",
    description: "A complex job",
    steps: [
      Step.create({
        name: "step1",
        task: StepTask.model("test-model", "run"),
      }),
      Step.create({
        name: "step2",
        task: StepTask.model("model", "run"),
        dependsOn: [
          { step: "step1", condition: TriggerCondition.succeeded() },
        ],
      }),
    ],
    dependsOn: [
      { job: "setup", condition: TriggerCondition.succeeded() },
      {
        job: "check",
        condition: TriggerCondition.or([
          TriggerCondition.succeeded(),
          TriggerCondition.skipped(),
        ]),
      },
    ],
    weight: 50,
  });

  const data = original.toData();
  const restored = Job.fromData(data);

  assertEquals(restored.name, original.name);
  assertEquals(restored.description, original.description);
  assertEquals(restored.steps.length, original.steps.length);
  assertEquals(restored.dependsOn.length, original.dependsOn.length);
  assertEquals(restored.weight, original.weight);
});
