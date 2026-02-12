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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { DefaultWorkflowValidationService } from "./validation_service.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import { Definition } from "../definitions/definition.ts";
import { ECHO_MODEL_TYPE } from "../models/echo/echo_model.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

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

// Implicit CEL dependency tests

async function withTempRepo(
  fn: (repo: YamlDefinitionRepository) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-validation-" });
  try {
    await ensureDir(join(dir, ".swamp/definitions"));
    const repo = new YamlDefinitionRepository(dir);
    await fn(repo);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("detects cycle from implicit CEL deps", async () => {
  await withTempRepo(async (repo) => {
    // model-a references model-b's resource
    const modelA = Definition.create({
      name: "model-a",
      methods: {
        write: {
          arguments: {
            value: "${{ model.model-b.resource.aws_thing.main.attributes.Id }}",
          },
        },
      },
    });
    // model-b is clean
    const modelB = Definition.create({
      name: "model-b",
      methods: { write: { arguments: { value: "hello" } } },
    });
    await repo.save(ECHO_MODEL_TYPE, modelA);
    await repo.save(ECHO_MODEL_TYPE, modelB);

    // Workflow has explicit dep: step-b depends on step-a
    // Implicit dep: step-a depends on step-b (from CEL expression)
    // This creates a cycle: step-a -> step-b -> step-a
    const workflow = Workflow.create({
      name: "cycle-workflow",
      jobs: [
        Job.create({
          name: "infra-job",
          steps: [
            Step.create({
              name: "step-a",
              task: StepTask.model("model-a", "write"),
            }),
            Step.create({
              name: "step-b",
              task: StepTask.model("model-b", "write"),
              dependsOn: [
                { step: "step-a", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    const implicitService = new DefaultWorkflowValidationService(repo);
    const results = await implicitService.validate(workflow);

    const implicitCycleResult = results.find((r) =>
      r.name.includes("including implicit")
    );
    assertEquals(implicitCycleResult?.passed, false);
    assertEquals(implicitCycleResult?.error?.includes("Cyclic"), true);
    assertEquals(
      implicitCycleResult?.error?.includes("implicit dependencies from CEL"),
      true,
    );
  });
});

Deno.test("passes when implicit deps exist but no cycle", async () => {
  await withTempRepo(async (repo) => {
    const vpcModel = Definition.create({
      name: "networking-vpc",
      methods: { write: { arguments: { cidr: "10.0.0.0/16" } } },
    });
    const routeTableModel = Definition.create({
      name: "route-table",
      methods: {
        write: {
          arguments: {
            vpcId:
              "${{ model.networking-vpc.resource.aws_vpc.main.attributes.VpcId }}",
          },
        },
      },
    });
    await repo.save(ECHO_MODEL_TYPE, vpcModel);
    await repo.save(ECHO_MODEL_TYPE, routeTableModel);

    // Implicit dep: route-table -> vpc (same direction, no cycle)
    const workflow = Workflow.create({
      name: "no-cycle-workflow",
      jobs: [
        Job.create({
          name: "infra-job",
          steps: [
            Step.create({
              name: "create-vpc",
              task: StepTask.model("networking-vpc", "write"),
            }),
            Step.create({
              name: "create-route-table",
              task: StepTask.model("route-table", "write"),
            }),
          ],
        }),
      ],
    });

    const implicitService = new DefaultWorkflowValidationService(repo);
    const results = await implicitService.validate(workflow);

    const implicitResult = results.find((r) =>
      r.name.includes("including implicit")
    );
    assertEquals(implicitResult?.passed, true);
  });
});

Deno.test("graceful when no definition repo provided (skips implicit check)", async () => {
  const workflow = createSimpleWorkflow();
  const noRepoService = new DefaultWorkflowValidationService();
  const results = await noRepoService.validate(workflow);

  // Should not have any implicit cycle check results
  const implicitResults = results.filter((r) =>
    r.name.includes("including implicit")
  );
  assertEquals(implicitResults.length, 0);
});

Deno.test("graceful when model definitions are missing", async () => {
  await withTempRepo(async (repo) => {
    // Don't save any definitions — models won't be found
    const workflow = Workflow.create({
      name: "missing-models-workflow",
      jobs: [
        Job.create({
          name: "test-job",
          steps: [
            Step.create({
              name: "step-a",
              task: StepTask.model("nonexistent-a", "write"),
            }),
            Step.create({
              name: "step-b",
              task: StepTask.model("nonexistent-b", "write"),
              dependsOn: [
                { step: "step-a", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    const implicitService = new DefaultWorkflowValidationService(repo);
    const results = await implicitService.validate(workflow);

    // Should still pass — missing models just means no implicit deps found
    const implicitResult = results.find((r) =>
      r.name.includes("including implicit")
    );
    assertEquals(implicitResult?.passed, true);
  });
});
