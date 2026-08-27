// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import {
  DefaultWorkflowValidationService,
  type MethodResolution,
  type ModelMethodResolver,
  WorkflowValidationResult,
} from "./validation_service.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import type { WorkflowRepository } from "./repositories.ts";
import type { WorkflowId } from "./workflow_id.ts";

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

function mockResolver(
  responses: Record<string, MethodResolution>,
): ModelMethodResolver {
  return {
    resolve(modelIdOrName, methodName, _modelType?) {
      const key = `${modelIdOrName}.${methodName}`;
      return Promise.resolve(
        responses[key] ?? { status: "model_not_found" as const },
      );
    },
  };
}

function mockResolverWithType(
  responses: Record<string, MethodResolution>,
): ModelMethodResolver {
  return {
    resolve(_modelIdOrName, methodName, modelType?) {
      const key = modelType
        ? `type:${modelType}.${methodName}`
        : `name:${_modelIdOrName}.${methodName}`;
      return Promise.resolve(
        responses[key] ?? { status: "model_not_found" as const },
      );
    },
  };
}

function mockWorkflowRepo(
  workflows: Record<string, Workflow>,
): WorkflowRepository {
  return {
    findByName: (name) => Promise.resolve(workflows[name] ?? null),
    findById: (_id) => Promise.resolve(null),
    findAll: () => Promise.resolve(Object.values(workflows)),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => crypto.randomUUID() as WorkflowId,
    getPath: () => "",
  };
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

Deno.test("validate returns a promise", async () => {
  const workflow = createSimpleWorkflow();
  const results = await service.validate(workflow);
  assertEquals(Array.isArray(results), true);
  assertEquals(results.length > 0, true);
});

Deno.test("does not produce implicit dependency validation results", async () => {
  // Regression: implicit CEL dependency checks were removed.
  // No validation result should mention "implicit".
  const workflow = Workflow.create({
    name: "multi-model-workflow",
    jobs: [
      Job.create({
        name: "infra",
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

  const results = await service.validate(workflow);
  const implicitResults = results.filter((r) => r.name.includes("implicit"));
  assertEquals(implicitResults.length, 0);
});

Deno.test("passes validation for linear chain that old implicit system would reject", async () => {
  // Regression test for the proxmox-manager stop-allthemons failure.
  const workflow = Workflow.create({
    name: "stop-allthemons",
    jobs: [
      Job.create({
        name: "shutdown",
        steps: [
          Step.create({
            name: "auth",
            task: StepTask.model("proxmox-auth", "run"),
          }),
          Step.create({
            name: "lookup",
            task: StepTask.model("fleet", "read"),
            dependsOn: [
              { step: "auth", condition: TriggerCondition.succeeded() },
            ],
          }),
          Step.create({
            name: "warn-players",
            task: StepTask.model("allthemonsMinecraft", "warn"),
            dependsOn: [
              { step: "lookup", condition: TriggerCondition.succeeded() },
            ],
          }),
          Step.create({
            name: "stop-minecraft",
            task: StepTask.model("allthemonsMinecraft", "stop"),
            dependsOn: [
              {
                step: "warn-players",
                condition: TriggerCondition.succeeded(),
              },
            ],
          }),
          Step.create({
            name: "stop-vm",
            task: StepTask.model("fleet", "stop"),
            dependsOn: [
              {
                step: "stop-minecraft",
                condition: TriggerCondition.succeeded(),
              },
            ],
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const failed = results.filter((r) => !r.passed);
  assertEquals(
    failed.length,
    0,
    `Should pass but failed: ${
      failed.map((r) => `${r.name}: ${r.error}`).join("; ")
    }`,
  );
});

Deno.test("validation results have equals method", async () => {
  const workflow = createSimpleWorkflow();
  const results = await service.validate(workflow);

  const result1 = results[0];
  const result2 = results[0];
  assertEquals(result1.equals(result2), true);
});

// --- Step input validation tests (model_method) ---

Deno.test("validateStepInputs: fails when required model method arg is missing", async () => {
  const resolver = mockResolver({
    "my-model.deploy": {
      status: "resolved",
      requiredArgs: ["environment", "version"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "deploy", {
              environment: "prod",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("version"), true);
});

Deno.test("validateStepInputs: passes when all required args present", async () => {
  const resolver = mockResolver({
    "my-model.deploy": {
      status: "resolved",
      requiredArgs: ["environment", "version"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "deploy", {
              environment: "prod",
              version: "1.0",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: passes with CEL expression value for required arg", async () => {
  const resolver = mockResolver({
    "my-model.deploy": {
      status: "resolved",
      requiredArgs: ["environment"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "deploy", {
              environment:
                '${{ data.latest("config", "env").attributes.name }}',
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: fails when no inputs but method has required args", async () => {
  const resolver = mockResolver({
    "my-model.deploy": {
      status: "resolved",
      requiredArgs: ["environment"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "deploy"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("environment"), true);
});

Deno.test("validateStepInputs: skipped when no resolver provided", async () => {
  const svc = new DefaultWorkflowValidationService();

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "deploy"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResults = results.filter((r) => r.name.includes("Step inputs"));
  assertEquals(inputResults.length, 0);
});

Deno.test("validateStepInputs: model not found produces warning", async () => {
  const resolver = mockResolver({});
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("missing-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  // A missing model *instance* is a warning (it may be created at run time),
  // unlike an unresolvable model *type*, which fails. See swamp-club#506/#517.
  assertEquals(inputResult?.passed, true);
  assertEquals(inputResult?.warning, true);
  assertEquals(inputResult?.name.includes("skipped"), false);
  assertEquals(inputResult?.name.includes("model not found"), true);
  assertEquals(inputResult?.error?.includes("not found"), true);
});

Deno.test("WorkflowValidationResult.warning: creates result with passed=true and warning=true", () => {
  const result = WorkflowValidationResult.warning("check", "something");
  assertEquals(result.passed, true);
  assertEquals(result.warning, true);
  assertEquals(result.error, "something");
});

Deno.test("WorkflowValidationResult.pass: has warning=false", () => {
  const result = WorkflowValidationResult.pass("check");
  assertEquals(result.passed, true);
  assertEquals(result.warning, false);
  assertEquals(result.error, undefined);
});

Deno.test("WorkflowValidationResult.fail: has warning=false", () => {
  const result = WorkflowValidationResult.fail("check", "error");
  assertEquals(result.passed, false);
  assertEquals(result.warning, false);
  assertEquals(result.error, "error");
});

Deno.test("WorkflowValidationResult.equals: distinguishes warning from pass", () => {
  const warn = WorkflowValidationResult.warning("check", "msg");
  const pass = WorkflowValidationResult.pass("check");
  assertEquals(warn.equals(pass), false);
});

Deno.test("validateStepInputs: method not found on model produces failure", async () => {
  const resolver = mockResolver({
    "my-model.nonexistent": {
      status: "method_not_found",
      modelType: "test/model",
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "nonexistent"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("not found"), true);
});

Deno.test("validateStepInputs: method with no required args and no inputs passes", async () => {
  const resolver = mockResolver({
    "my-model.run": { status: "resolved", requiredArgs: [] },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

// --- Definition-provided arguments (issue #359) ---

Deno.test("validateStepInputs: passes when definition provides all required args", async () => {
  const resolver = mockResolver({
    "shell.execute": {
      status: "resolved",
      requiredArgs: ["run"],
      definitionProvidedArgs: ["run"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("shell", "execute"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: passes when definition and step inputs together cover required args", async () => {
  const resolver = mockResolver({
    "deploy.run": {
      status: "resolved",
      requiredArgs: ["environment", "version"],
      definitionProvidedArgs: ["environment"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("deploy", "run", { version: "1.0" }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: fails only on truly missing args when definition supplies some", async () => {
  const resolver = mockResolver({
    "deploy.run": {
      status: "resolved",
      requiredArgs: ["environment", "version", "region"],
      definitionProvidedArgs: ["environment"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("deploy", "run", { version: "1.0" }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error, "Missing required inputs: region");
});

Deno.test("validateStepInputs: definition and step inputs overlap on the same key (no double-count, still passes)", async () => {
  const resolver = mockResolver({
    "shell.execute": {
      status: "resolved",
      requiredArgs: ["run"],
      definitionProvidedArgs: ["run"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("shell", "execute", {
              run: "echo override",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: missing definitionProvidedArgs field preserves legacy behavior", async () => {
  // Mocks written before issue #359 omit definitionProvidedArgs entirely.
  // The validator must treat the field as empty (no args provided by the
  // definition) so existing behavior is unchanged.
  const resolver = mockResolver({
    "my-model.deploy": {
      status: "resolved",
      requiredArgs: ["environment"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "deploy"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("environment"), true);
});

Deno.test("validateStepInputs: skips dynamic CEL model reference", async () => {
  const resolver = mockResolver({});
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("${{ inputs.model_name }}", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

// --- Step input validation tests (workflow tasks) ---

Deno.test("validateStepInputs: fails when required workflow input is missing", async () => {
  const nestedWorkflow = Workflow.create({
    name: "deploy-pipeline",
    inputs: {
      type: "object",
      properties: {
        environment: { type: "string" },
        version: { type: "string" },
      },
      required: ["environment", "version"],
    },
    jobs: [
      Job.create({
        name: "deploy",
        steps: [
          Step.create({
            name: "run",
            task: StepTask.model("test", "run"),
          }),
        ],
      }),
    ],
  });

  const repo = mockWorkflowRepo({ "deploy-pipeline": nestedWorkflow });
  const svc = new DefaultWorkflowValidationService(undefined, repo);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.workflow("deploy-pipeline", {
              environment: "prod",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("version"), true);
});

Deno.test("validateStepInputs: passes when all required workflow inputs present", async () => {
  const nestedWorkflow = Workflow.create({
    name: "deploy-pipeline",
    inputs: {
      type: "object",
      properties: {
        environment: { type: "string" },
      },
      required: ["environment"],
    },
    jobs: [
      Job.create({
        name: "deploy",
        steps: [
          Step.create({
            name: "run",
            task: StepTask.model("test", "run"),
          }),
        ],
      }),
    ],
  });

  const repo = mockWorkflowRepo({ "deploy-pipeline": nestedWorkflow });
  const svc = new DefaultWorkflowValidationService(undefined, repo);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.workflow("deploy-pipeline", {
              environment: "prod",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: nested workflow not found produces passing skip", async () => {
  const repo = mockWorkflowRepo({});
  const svc = new DefaultWorkflowValidationService(undefined, repo);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.workflow("nonexistent-workflow"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
  assertEquals(inputResult?.name.includes("skipped"), true);
});

Deno.test("validateStepInputs: nested workflow with no required inputs passes", async () => {
  const nestedWorkflow = Workflow.create({
    name: "simple-nested",
    jobs: [
      Job.create({
        name: "deploy",
        steps: [
          Step.create({
            name: "run",
            task: StepTask.model("test", "run"),
          }),
        ],
      }),
    ],
  });

  const repo = mockWorkflowRepo({ "simple-nested": nestedWorkflow });
  const svc = new DefaultWorkflowValidationService(undefined, repo);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.workflow("simple-nested"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

// --- Direct-execution step validation tests ---

Deno.test("validateStepInputs: direct-execution step with resolved type and valid inputs passes", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/test/model.deploy": {
      status: "resolved",
      requiredArgs: ["region"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/test/model",
              "my-instance",
              "deploy",
              { region: "us-east-1" },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
  assertEquals(inputResult?.name.includes("skipped"), false);
});

Deno.test("validateStepInputs: direct-execution step with missing required args fails", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/test/model.deploy": {
      status: "resolved",
      requiredArgs: ["region", "version"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/test/model",
              "my-instance",
              "deploy",
              { region: "us-east-1" },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("version"), true);
});

Deno.test("validateStepInputs: direct-execution step with unresolvable type fails validation", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/nonexistent/type.deploy": {
      status: "type_unresolvable",
      modelType: "@swamp/nonexistent/type",
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/nonexistent/type",
              "my-instance",
              "deploy",
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  // An unresolvable type must NOT silently pass — it hides real contract bugs
  // (non-existent methods, wrong arg keys). See swamp-club#506.
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("could not be resolved"), true);
  assertEquals(inputResult?.error?.includes("@swamp/nonexistent/type"), true);
});

Deno.test("validateStepInputs: name-referenced step with unresolvable type fails validation", async () => {
  const resolver = mockResolver({
    "http-poll.pollUrl": {
      status: "type_unresolvable",
      modelType: "@hivemq/http-poll",
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("http-poll", "pollUrl"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("could not be resolved"), true);
});

Deno.test("validateStepInputs: direct-execution step with CEL in modelType skips validation", async () => {
  const resolver = mockResolverWithType({});
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "${{ inputs.model_type }}",
              "my-instance",
              "deploy",
              { region: "us-east-1" },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: direct-execution step with CEL modelName and unresolvable modelType fails", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/nonexistent/type.deploy": {
      status: "type_unresolvable",
      modelType: "@swamp/nonexistent/type",
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/nonexistent/type",
              '${{ "sync-" + inputs.host }}',
              "deploy",
              { region: "us-east-1" },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("could not be resolved"), true);
  assertEquals(inputResult?.error?.includes("@swamp/nonexistent/type"), true);
});

Deno.test("validateStepInputs: direct-execution step with CEL modelName and valid modelType passes", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/test/model.deploy": {
      status: "resolved",
      requiredArgs: ["region"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/test/model",
              '${{ "sync-" + inputs.host }}',
              "deploy",
              { region: "us-east-1" },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: direct-execution step with CEL modelName and method not found fails", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/test/model.nonexistent": {
      status: "method_not_found",
      modelType: "@swamp/test/model",
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/test/model",
              '${{ "sync-" + inputs.host }}',
              "nonexistent",
              { region: "us-east-1" },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(
    inputResult?.error?.includes("Method 'nonexistent' not found"),
    true,
  );
});

Deno.test("validateStepInputs: direct-execution step with globalArgs satisfying required arg passes", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/test/model.create": {
      status: "resolved",
      requiredArgs: ["name", "region"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/test/model",
              "my-instance",
              "create",
              { region: "us-east-1" },
              { name: "my-resource" },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: direct-execution step with CEL expression in globalArgs passes", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/test/model.create": {
      status: "resolved",
      requiredArgs: ["name"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/test/model",
              "my-instance",
              "create",
              undefined,
              { name: '${{ "Swamp Tests " + inputs.suffix }}' },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, true);
});

Deno.test("validateStepInputs: direct-execution step missing required globalArg still fails", async () => {
  const resolver = mockResolverWithType({
    "type:@swamp/test/model.create": {
      status: "resolved",
      requiredArgs: ["name", "region"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.directExecution(
              "@swamp/test/model",
              "my-instance",
              "create",
              { region: "us-east-1" },
            ),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const inputResult = results.find((r) => r.name.includes("Step inputs"));
  assertEquals(inputResult?.passed, false);
  assertEquals(inputResult?.error?.includes("name"), true);
});

// ---------- validateGlobalArgInputRefs ----------

Deno.test("validateGlobalArgInputRefs: fails when step does not supply referenced input", async () => {
  const resolver = mockResolver({
    "my-model.execute": {
      status: "resolved",
      requiredArgs: [],
      definitionProvidedArgs: ["run"],
      definitionProvidedArgValues: {
        run: "echo ${{ inputs.recordHost }} ${{ inputs.dnsZone }}",
      },
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "execute", {
              recordHost: "example.com",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result?.passed, false);
  assertEquals(result?.error?.includes("dnsZone"), true);
});

Deno.test("validateGlobalArgInputRefs: passes when step supplies all referenced inputs", async () => {
  const resolver = mockResolver({
    "my-model.execute": {
      status: "resolved",
      requiredArgs: [],
      definitionProvidedArgs: ["run"],
      definitionProvidedArgValues: {
        run: "echo ${{ inputs.recordHost }} ${{ inputs.dnsZone }}",
      },
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "execute", {
              recordHost: "example.com",
              dnsZone: "example.zone",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result?.passed, true);
});

Deno.test("validateGlobalArgInputRefs: passes when no expressions in globalArguments", async () => {
  const resolver = mockResolver({
    "my-model.execute": {
      status: "resolved",
      requiredArgs: [],
      definitionProvidedArgs: ["run"],
      definitionProvidedArgValues: {
        run: "echo hello",
      },
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "execute"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result?.passed, true);
});

Deno.test("validateGlobalArgInputRefs: fails when step has no inputs but globalArguments reference them", async () => {
  const resolver = mockResolver({
    "my-model.execute": {
      status: "resolved",
      requiredArgs: [],
      definitionProvidedArgs: ["run"],
      definitionProvidedArgValues: {
        run: "${{ inputs.host }}",
      },
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "execute"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result?.passed, false);
  assertEquals(result?.error?.includes("host"), true);
});

Deno.test("validateGlobalArgInputRefs: skips when model reference contains CEL expression", async () => {
  const resolver = mockResolver({});
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("${{ inputs.model_name }}", "execute"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result, undefined);
});

Deno.test("validateGlobalArgInputRefs: skips when resolution has no definitionProvidedArgValues", async () => {
  const resolver = mockResolver({
    "my-model.execute": {
      status: "resolved",
      requiredArgs: ["run"],
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "execute"),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result, undefined);
});

Deno.test("validateGlobalArgInputRefs: handles bracket notation input references", async () => {
  const resolver = mockResolver({
    "my-model.execute": {
      status: "resolved",
      requiredArgs: [],
      definitionProvidedArgs: ["run"],
      definitionProvidedArgValues: {
        run: '${{ inputs["record-host"] }}',
      },
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("my-model", "execute", {
              "record-host": "example.com",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result?.passed, true);
});

Deno.test("validateGlobalArgInputRefs: passes when step supplies model input via expression", async () => {
  const resolver = mockResolver({
    "ssh-host.exec": {
      status: "resolved",
      requiredArgs: ["command"],
      definitionProvidedArgs: ["host", "user"],
      definitionProvidedArgValues: {
        host: "${{ inputs.ip }}",
        user: "root",
      },
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    inputs: {
      properties: {
        nodeName: { type: "string" },
      },
    },
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("ssh-host", "exec", {
              ip: '${{ data.latest("node", inputs.nodeName).attributes.ipv4 }}',
              command: "docker image prune -f",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result?.passed, true);
});

Deno.test("validateGlobalArgInputRefs: skips when step inputs is a dynamic expression", async () => {
  const resolver = mockResolver({
    "my-model.execute": {
      status: "resolved",
      requiredArgs: [],
      definitionProvidedArgs: ["run"],
      definitionProvidedArgValues: {
        run: "${{ inputs.host }}",
      },
    },
  });
  const svc = new DefaultWorkflowValidationService(resolver);

  const workflow = Workflow.create({
    name: "test",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.fromData({
              type: "model_method",
              modelIdOrName: "my-model",
              methodName: "execute",
              inputs: "${{ steps.previous.output }}",
            }),
          }),
        ],
      }),
    ],
  });

  const results = await svc.validate(workflow);
  const result = results.find((r) =>
    r.name.includes("GlobalArgument input references")
  );
  assertEquals(result, undefined);
});

Deno.test("validate: warns when queueTimeout is set without placement", async () => {
  const workflow = Workflow.create({
    name: "queue-timeout-no-placement",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "misconfig",
            task: StepTask.model("test-model", "run"),
            queueTimeout: 30,
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("queueTimeout without placement")
  );
  assertEquals(warning?.passed, true);
  assertEquals(warning?.warning, true);
});

Deno.test("validate: no warning when queueTimeout is set with placement", async () => {
  const workflow = Workflow.create({
    name: "queue-timeout-with-placement",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "correct",
            task: StepTask.model("test-model", "run"),
            queueTimeout: 30,
            target: "worker-1",
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("queueTimeout without placement")
  );
  assertEquals(warning, undefined);
});

Deno.test("validate: no warning when queueTimeout is on step but placement is inherited from job", async () => {
  const workflow = Workflow.create({
    name: "queue-timeout-inherited",
    jobs: [
      Job.create({
        name: "main",
        labels: { pool: "gke" },
        steps: [
          Step.create({
            name: "inherits",
            task: StepTask.model("test-model", "run"),
            queueTimeout: 30,
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("queueTimeout without placement")
  );
  assertEquals(warning, undefined);
});

Deno.test("validate: no warning when queueTimeout is inherited from workflow with placement", async () => {
  const workflow = Workflow.create({
    name: "queue-timeout-workflow",
    labels: { pool: "gke" },
    queueTimeout: 30,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "inherits",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("queueTimeout without placement")
  );
  assertEquals(warning, undefined);
});

Deno.test("validate: warns when job clears inherited placement but queueTimeout is still inherited", async () => {
  const workflow = Workflow.create({
    name: "orphaned-queue-timeout",
    labels: { pool: "gke" },
    queueTimeout: 30,
    jobs: [
      Job.create({
        name: "main",
        labels: {},
        steps: [
          Step.create({
            name: "orphaned",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("queueTimeout without placement")
  );
  assertEquals(warning?.passed, true);
  assertEquals(warning?.warning, true);
});

// --- Assert expr interpolation validation tests ---

Deno.test("validate: fails when assert expr is wrapped in interpolation syntax", async () => {
  const workflow = Workflow.create({
    name: "test-assert-wrapped",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "verify",
            task: StepTask.assert("${{ true }}", "should pass", "high"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const assertResult = results.find((r) => r.name.includes("Assert expr"));
  assertEquals(assertResult?.passed, false);
  assertEquals(
    assertResult?.error?.includes("raw CEL expression"),
    true,
  );
});

Deno.test("validate: passes when assert expr is raw CEL", async () => {
  const workflow = Workflow.create({
    name: "test-assert-raw",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "verify",
            task: StepTask.assert("1 == 1", "should pass", "high"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const assertResult = results.find((r) => r.name.includes("Assert expr"));
  assertEquals(assertResult, undefined);
});

Deno.test("validate: fails when assert expr uses multiline interpolation", async () => {
  const workflow = Workflow.create({
    name: "test-assert-multiline",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "verify",
            task: StepTask.assert(
              '${{ data.latest("m", "s").attributes.x == 1 }}',
              "check data",
              "high",
            ),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const assertResult = results.find((r) => r.name.includes("Assert expr"));
  assertEquals(assertResult?.passed, false);
});

Deno.test("validate: warns when workflow affinity is set without placement", async () => {
  const workflow = Workflow.create({
    name: "affinity-no-placement",
    affinity: true,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "local-step",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("affinity without placement")
  );
  assertEquals(warning?.passed, true);
  assertEquals(warning?.warning, true);
});

Deno.test("validate: no warning when workflow affinity is set with placement", async () => {
  const workflow = Workflow.create({
    name: "affinity-with-placement",
    affinity: true,
    labels: { pool: "gpu" },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "remote-step",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("affinity without placement")
  );
  assertEquals(warning, undefined);
});

Deno.test("validate: warns when job affinity is set without placement", async () => {
  const workflow = Workflow.create({
    name: "job-affinity-no-placement",
    jobs: [
      Job.create({
        name: "main",
        affinity: true,
        steps: [
          Step.create({
            name: "local-step",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("affinity without placement in job")
  );
  assertEquals(warning?.passed, true);
  assertEquals(warning?.warning, true);
});

// --- Guard expression type validation tests ---

Deno.test("validate: fails when guard references boolean input", async () => {
  const workflow = Workflow.create({
    name: "guard-bool",
    inputs: {
      type: "object",
      properties: {
        dryRun: { type: "boolean" },
      },
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard: "${{ inputs.dryRun }}",
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult?.passed, false);
  assertEquals(guardResult?.error?.includes("boolean"), true);
});

Deno.test("validate: fails when guard references number input", async () => {
  const workflow = Workflow.create({
    name: "guard-number",
    inputs: {
      type: "object",
      properties: {
        count: { type: "number" },
      },
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard: "${{ inputs.count }}",
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult?.passed, false);
  assertEquals(guardResult?.error?.includes("number"), true);
});

Deno.test("validate: fails when guard references array input", async () => {
  const workflow = Workflow.create({
    name: "guard-array",
    inputs: {
      type: "object",
      properties: {
        items: { type: "array" },
      },
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard: "${{ inputs.items }}",
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult?.passed, false);
  assertEquals(guardResult?.error?.includes("array"), true);
});

Deno.test("validate: passes when guard references string input", async () => {
  const workflow = Workflow.create({
    name: "guard-string",
    inputs: {
      type: "object",
      properties: {
        condition: { type: "string" },
      },
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard: "${{ inputs.condition }}",
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult, undefined);
});

Deno.test("validate: passes when guard references untyped input", async () => {
  const workflow = Workflow.create({
    name: "guard-untyped",
    inputs: {
      type: "object",
      properties: {
        flag: { description: "no type declared" },
      },
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard: "${{ inputs.flag }}",
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult, undefined);
});

Deno.test("validate: passes when guard uses embedded expression", async () => {
  const workflow = Workflow.create({
    name: "guard-embedded",
    inputs: {
      type: "object",
      properties: {
        dryRun: { type: "boolean" },
      },
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard: "prefix-${{ inputs.dryRun }}-suffix",
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult, undefined);
});

Deno.test("validate: passes when guard uses non-input expression", async () => {
  const workflow = Workflow.create({
    name: "guard-data",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard: '${{ data.latest("m", "r").attributes.done }}',
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult, undefined);
});

Deno.test("validate: passes when step has no guard", async () => {
  const workflow = createSimpleWorkflow();
  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult, undefined);
});

Deno.test("validate: fails when guard references boolean input via bracket notation", async () => {
  const workflow = Workflow.create({
    name: "guard-bracket",
    inputs: {
      type: "object",
      properties: {
        "dry-run": { type: "boolean" },
      },
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            guard: '${{ inputs["dry-run"] }}',
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const guardResult = results.find((r) => r.name.includes("Guard type"));
  assertEquals(guardResult?.passed, false);
  assertEquals(guardResult?.error?.includes("boolean"), true);
  assertEquals(guardResult?.error?.includes('inputs["dry-run"]'), true);
});

Deno.test("validate: warns when step writes is set without placement", async () => {
  const workflow = Workflow.create({
    name: "writes-no-placement",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            writes: true,
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("writes without placement")
  );
  assertEquals(warning?.passed, true);
  assertEquals(warning?.warning, true);
});

Deno.test("validate: no warning when step writes is set with placement", async () => {
  const workflow = Workflow.create({
    name: "writes-with-placement",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
            writes: true,
            target: "deploy-worker",
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("writes without placement")
  );
  assertEquals(warning, undefined);
});

Deno.test("validate: warns when job writes is inherited without placement", async () => {
  const workflow = Workflow.create({
    name: "job-writes-no-placement",
    jobs: [
      Job.create({
        name: "main",
        writes: true,
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("writes without placement")
  );
  assertEquals(warning?.passed, true);
  assertEquals(warning?.warning, true);
});

Deno.test("validate: warns when workflow writes is inherited without placement", async () => {
  const workflow = Workflow.create({
    name: "wf-writes-no-placement",
    writes: true,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("writes without placement")
  );
  assertEquals(warning?.passed, true);
  assertEquals(warning?.warning, true);
});

Deno.test("validate: step writes false overrides job writes true — no warning", async () => {
  const workflow = Workflow.create({
    name: "writes-child-wins",
    jobs: [
      Job.create({
        name: "main",
        writes: true,
        steps: [
          Step.create({
            name: "read-only",
            task: StepTask.model("test-model", "run"),
            writes: false,
          }),
        ],
      }),
    ],
  });

  const results = await service.validate(workflow);
  const warning = results.find((r) =>
    r.name.includes("writes without placement")
  );
  assertEquals(warning, undefined);
});
