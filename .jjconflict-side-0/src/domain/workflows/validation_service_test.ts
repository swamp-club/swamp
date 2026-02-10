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
            task: StepTask.model("test-model", "run"),
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
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
      Job.create({
        name: "test",
        steps: [
          Step.create({
            name: "run-tests",
            task: StepTask.model("test-model", "run"),
          }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded() },
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
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "compile",
            task: StepTask.model("test-model", "run"),
            dependsOn: [
              { step: "setup", condition: TriggerCondition.succeeded() },
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
      Step.create({ name: "s1", task: StepTask.model("test-model", "run") }),
    ],
  });
  const job2 = Job.create({
    name: "build", // duplicate!
    steps: [
      Step.create({ name: "s1", task: StepTask.model("test-model", "run") }),
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
    task: StepTask.model("test-model", "run"),
  });
  const step2 = Step.create({
    name: "compile", // duplicate!
    task: StepTask.model("test-model", "run"),
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
          Step.create({
            name: "s1",
            task: StepTask.model("test-model", "run"),
          }),
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
            task: StepTask.model("test-model", "run"),
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
    steps: [
      Step.create({ name: "s", task: StepTask.model("test-model", "run") }),
    ],
  });
  const jobB = Job.create({
    name: "b",
    steps: [
      Step.create({ name: "s", task: StepTask.model("test-model", "run") }),
    ],
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
    task: StepTask.model("test-model", "run"),
  });
  const stepB = Step.create({
    name: "b",
    task: StepTask.model("test-model", "run"),
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
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "install",
            task: StepTask.model("test-model", "run"),
            dependsOn: [
              {
                step: "checkout",
                condition: TriggerCondition.succeeded(),
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
            task: StepTask.model("test-model", "run"),
          }),
        ],
        dependsOn: [
          { job: "setup", condition: TriggerCondition.succeeded() },
        ],
      }),
      Job.create({
        name: "test",
        steps: [
          Step.create({
            name: "unit",
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "integration",
            task: StepTask.model("test-model", "run"),
            dependsOn: [
              { step: "unit", condition: TriggerCondition.succeeded() },
            ],
          }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded() },
        ],
      }),
      Job.create({
        name: "deploy",
        steps: [
          Step.create({
            name: "push",
            task: StepTask.model("test-model", "run"),
          }),
        ],
        dependsOn: [
          { job: "test", condition: TriggerCondition.succeeded() },
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
