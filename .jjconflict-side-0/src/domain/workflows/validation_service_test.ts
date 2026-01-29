import { assertEquals } from "@std/assert";
import { DefaultWorkflowValidationService } from "./validation_service.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";

const service = new DefaultWorkflowValidationService();

function createSimpleWorkflow(): Workflow {
  return Workflow.create({
    name: "simple-workflow",
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.shell("npm", { args: ["run", "build"] }),
          }),
        ],
      }),
    ],
  });
}

Deno.test("validates simple valid workflow", async () => {
  const workflow = createSimpleWorkflow();
  const results = await service.validate(workflow);

  const failed = results.filter((r) => !r.passed);
  assertEquals(
    failed.length,
    0,
    `Failed validations: ${failed.map((r) => r.name).join(", ")}`,
  );
});

Deno.test("validates workflow with job dependencies", async () => {
  const workflow = Workflow.create({
    name: "test-workflow",
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.shell("echo", { args: ["build"] }),
          }),
        ],
      }),
      Job.create({
        name: "test",
        steps: [
          Step.create({
            name: "run-tests",
            task: StepTask.shell("echo", { args: ["test"] }),
          }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded("build") },
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const failed = results.filter((r) => !r.passed);
  assertEquals(failed.length, 0);
});

Deno.test("validates workflow with step dependencies", async () => {
  const workflow = Workflow.create({
    name: "test-workflow",
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "setup",
            task: StepTask.shell("echo", { args: ["setup"] }),
          }),
          Step.create({
            name: "compile",
            task: StepTask.shell("echo", { args: ["compile"] }),
            dependsOn: [
              { step: "setup", condition: TriggerCondition.succeeded("setup") },
            ],
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const failed = results.filter((r) => !r.passed);
  assertEquals(failed.length, 0);
});

Deno.test("fails on duplicate job names", async () => {
  const workflow = Workflow.create({
    name: "test-workflow",
    jobs: [],
  });

  // Manually add duplicate jobs (bypassing addJob's check)
  const job1 = Job.create({
    name: "build",
    steps: [
      Step.create({ name: "s1", task: StepTask.shell("echo") }),
    ],
  });
  const job2 = Job.create({
    name: "build", // duplicate!
    steps: [
      Step.create({ name: "s1", task: StepTask.shell("echo") }),
    ],
  });

  // Access private _jobs directly for test purposes
  (workflow as unknown as { _jobs: Job[] })._jobs = [job1, job2];

  const results = await service.validate(workflow);
  const uniqueJobNamesResult = results.find((r) =>
    r.name === "Unique job names"
  );
  assertEquals(uniqueJobNamesResult?.passed, false);
  assertEquals(uniqueJobNamesResult?.error?.includes("build"), true);
});

Deno.test("fails on duplicate step names within job", async () => {
  const step1 = Step.create({
    name: "compile",
    task: StepTask.shell("echo"),
  });
  const step2 = Step.create({
    name: "compile", // duplicate!
    task: StepTask.shell("echo"),
  });

  const job = Job.create({
    name: "build",
    steps: [step1],
  });

  // Manually add duplicate step
  (job as unknown as { _steps: Step[] })._steps = [step1, step2];

  const workflow = Workflow.create({
    name: "test-workflow",
    jobs: [job],
  });

  const results = await service.validate(workflow);
  const stepNamesResult = results.find((r) =>
    r.name.includes("Unique step names")
  );
  assertEquals(stepNamesResult?.passed, false);
  assertEquals(stepNamesResult?.error?.includes("compile"), true);
});

Deno.test("fails on invalid job dependency reference", async () => {
  const workflow = Workflow.create({
    name: "test-workflow",
    jobs: [
      Job.create({
        name: "test",
        steps: [
          Step.create({ name: "s1", task: StepTask.shell("echo") }),
        ],
        dependsOn: [
          { job: "nonexistent", condition: TriggerCondition.always() },
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const jobRefsResult = results.find((r) =>
    r.name === "Valid job dependency references"
  );
  assertEquals(jobRefsResult?.passed, false);
  assertEquals(jobRefsResult?.error?.includes("nonexistent"), true);
});

Deno.test("fails on invalid step dependency reference", async () => {
  const workflow = Workflow.create({
    name: "test-workflow",
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.shell("echo"),
            dependsOn: [
              { step: "nonexistent", condition: TriggerCondition.always() },
            ],
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const stepRefsResult = results.find((r) =>
    r.name.includes("Valid step dependency references")
  );
  assertEquals(stepRefsResult?.passed, false);
  assertEquals(stepRefsResult?.error?.includes("nonexistent"), true);
});

Deno.test("fails on cyclic job dependencies", async () => {
  const jobA = Job.create({
    name: "a",
    steps: [Step.create({ name: "s", task: StepTask.shell("echo") })],
  });
  const jobB = Job.create({
    name: "b",
    steps: [Step.create({ name: "s", task: StepTask.shell("echo") })],
  });

  // Create cycle: a -> b -> a
  (jobA as unknown as {
    _dependsOn: { job: string; condition: TriggerCondition }[];
  })._dependsOn = [
    { job: "b", condition: TriggerCondition.always() },
  ];
  (jobB as unknown as {
    _dependsOn: { job: string; condition: TriggerCondition }[];
  })._dependsOn = [
    { job: "a", condition: TriggerCondition.always() },
  ];

  const workflow = Workflow.create({
    name: "test-workflow",
    jobs: [jobA, jobB],
  });

  const results = await service.validate(workflow);
  const cycleResult = results.find((r) =>
    r.name === "No cyclic job dependencies"
  );
  assertEquals(cycleResult?.passed, false);
  assertEquals(cycleResult?.error?.includes("Cyclic"), true);
});

Deno.test("fails on cyclic step dependencies", async () => {
  const stepA = Step.create({
    name: "a",
    task: StepTask.shell("echo"),
  });
  const stepB = Step.create({
    name: "b",
    task: StepTask.shell("echo"),
  });

  // Create cycle: a -> b -> a
  (stepA as unknown as {
    _dependsOn: { step: string; condition: TriggerCondition }[];
  })._dependsOn = [
    { step: "b", condition: TriggerCondition.always() },
  ];
  (stepB as unknown as {
    _dependsOn: { step: string; condition: TriggerCondition }[];
  })._dependsOn = [
    { step: "a", condition: TriggerCondition.always() },
  ];

  const workflow = Workflow.create({
    name: "test-workflow",
    jobs: [
      Job.create({
        name: "build",
        steps: [stepA, stepB],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const cycleResult = results.find((r) =>
    r.name.includes("No cyclic step dependencies")
  );
  assertEquals(cycleResult?.passed, false);
  assertEquals(cycleResult?.error?.includes("Cyclic"), true);
});

Deno.test("passes all validations for complex valid workflow", async () => {
  const workflow = Workflow.create({
    name: "ci-pipeline",
    description: "Complete CI pipeline",
    jobs: [
      Job.create({
        name: "setup",
        steps: [
          Step.create({
            name: "checkout",
            task: StepTask.shell("git", { args: ["checkout"] }),
          }),
          Step.create({
            name: "install",
            task: StepTask.shell("npm", { args: ["install"] }),
            dependsOn: [
              {
                step: "checkout",
                condition: TriggerCondition.succeeded("checkout"),
              },
            ],
          }),
        ],
      }),
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.shell("npm", { args: ["run", "build"] }),
          }),
        ],
        dependsOn: [
          { job: "setup", condition: TriggerCondition.succeeded("setup") },
        ],
      }),
      Job.create({
        name: "test",
        steps: [
          Step.create({
            name: "unit",
            task: StepTask.shell("npm", { args: ["test"] }),
          }),
          Step.create({
            name: "integration",
            task: StepTask.shell("npm", { args: ["run", "test:integration"] }),
            dependsOn: [
              { step: "unit", condition: TriggerCondition.succeeded("unit") },
            ],
          }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded("build") },
        ],
      }),
      Job.create({
        name: "deploy",
        steps: [
          Step.create({
            name: "push",
            task: StepTask.shell("npm", { args: ["run", "deploy"] }),
          }),
        ],
        dependsOn: [
          { job: "test", condition: TriggerCondition.succeeded("test") },
        ],
      }),
    ],
    version: 1,
  });

  const results = await service.validate(workflow);
  const failed = results.filter((r) => !r.passed);
  assertEquals(
    failed.length,
    0,
    `Failed: ${failed.map((r) => `${r.name}: ${r.error}`).join("; ")}`,
  );
});

Deno.test("validation results have equals method", async () => {
  const workflow = createSimpleWorkflow();
  const results = await service.validate(workflow);

  const result1 = results[0];
  const result2 = results[0];
  assertEquals(result1.equals(result2), true);
});
