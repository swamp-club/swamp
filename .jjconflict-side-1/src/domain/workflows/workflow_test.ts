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

import { assertEquals, assertThrows } from "@std/assert";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";

function createTestJob(name: string): Job {
  return Job.create({
    name,
    steps: [
      Step.create({
        name: "step1",
        task: StepTask.model("test-model", "run"),
      }),
    ],
  });
}

Deno.test("Workflow.create generates UUID if not provided", () => {
  const workflow = Workflow.create({ name: "test-workflow" });
  assertEquals(typeof workflow.id, "string");
  assertEquals(workflow.id.length, 36); // UUID length
});

Deno.test("Workflow.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const workflow = Workflow.create({ id, name: "test-workflow" });
  assertEquals(workflow.id, id);
});

Deno.test("Workflow.create sets default version to 1", () => {
  const workflow = Workflow.create({ name: "test-workflow" });
  assertEquals(workflow.version, 1);
});

Deno.test("Workflow.create uses provided version", () => {
  const workflow = Workflow.create({
    name: "test-workflow",
    version: 3,
    jobs: [createTestJob("job1")],
  });
  assertEquals(workflow.version, 3);
});

Deno.test("Workflow.create creates workflow with all props", () => {
  const job = createTestJob("build");
  const workflow = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "my-workflow",
    description: "A test workflow",
    jobs: [job],
    version: 2,
  });

  assertEquals(workflow.id, "550e8400-e29b-41d4-a716-446655440000");
  assertEquals(workflow.name, "my-workflow");
  assertEquals(workflow.description, "A test workflow");
  assertEquals(workflow.jobs.length, 1);
  assertEquals(workflow.version, 2);
});

Deno.test("Workflow.create allows empty jobs for initial creation", () => {
  const workflow = Workflow.create({ name: "empty-workflow" });
  assertEquals(workflow.jobs.length, 0);
});

Deno.test("Workflow.getJob finds job by name", () => {
  const job1 = createTestJob("job1");
  const job2 = createTestJob("job2");
  const workflow = Workflow.create({
    name: "test",
    jobs: [job1, job2],
  });

  const found = workflow.getJob("job2");
  assertEquals(found?.name, "job2");

  const notFound = workflow.getJob("nonexistent");
  assertEquals(notFound, undefined);
});

Deno.test("Workflow.addJob adds job to workflow", () => {
  const workflow = Workflow.create({ name: "test" });
  assertEquals(workflow.jobs.length, 0);

  const job = createTestJob("new-job");
  workflow.addJob(job);
  assertEquals(workflow.jobs.length, 1);
  assertEquals(workflow.getJob("new-job")?.name, "new-job");
});

Deno.test("Workflow.addJob throws on duplicate job name", () => {
  const job1 = createTestJob("job1");
  const workflow = Workflow.create({
    name: "test",
    jobs: [job1],
  });

  const duplicate = createTestJob("job1");
  assertThrows(
    () => workflow.addJob(duplicate),
    Error,
    "already exists",
  );
});

Deno.test("Workflow.fromData reconstructs workflow correctly", () => {
  const data = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-workflow",
    description: "Test description",
    tags: {},
    inputs: undefined,
    jobs: [
      {
        name: "job1",
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
        dependsOn: [],
        weight: 0,
      },
    ],
    version: 2,
  };

  const workflow = Workflow.fromData(data);
  assertEquals(workflow.id, data.id);
  assertEquals(workflow.name, data.name);
  assertEquals(workflow.description, data.description);
  assertEquals(workflow.jobs.length, 1);
  assertEquals(workflow.version, data.version);
});

Deno.test("Workflow.toData returns correct structure", () => {
  const job = createTestJob("job1");
  const workflow = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-workflow",
    description: "Test description",
    jobs: [job],
    version: 2,
  });

  const data = workflow.toData();
  assertEquals(data.id, "550e8400-e29b-41d4-a716-446655440000");
  assertEquals(data.name, "test-workflow");
  assertEquals(data.description, "Test description");
  assertEquals(data.jobs.length, 1);
  assertEquals(data.jobs[0].name, "job1");
  assertEquals(data.version, 2);
});

Deno.test("Workflow.fromData and toData roundtrip correctly", () => {
  const original = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "complex-workflow",
    description: "A complex workflow",
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
            name: "unit",
            task: StepTask.model("test-model", "run"),
          }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded() },
        ],
      }),
    ],
    version: 3,
  });

  const data = original.toData();
  const restored = Workflow.fromData(data);

  assertEquals(restored.id, original.id);
  assertEquals(restored.name, original.name);
  assertEquals(restored.description, original.description);
  assertEquals(restored.jobs.length, original.jobs.length);
  assertEquals(restored.version, original.version);
});

// Inputs field tests

Deno.test("Workflow.create creates workflow with inputs schema", () => {
  const workflow = Workflow.create({
    name: "workflow-with-inputs",
    inputs: {
      properties: {
        environment: {
          type: "string",
          enum: ["dev", "staging", "production"],
          description: "Target environment",
        },
        count: {
          type: "integer",
          default: 1,
        },
      },
      required: ["environment"],
    },
  });

  assertEquals(workflow.inputs !== undefined, true);
  assertEquals(workflow.inputs?.properties?.environment?.type, "string");
  assertEquals(workflow.inputs?.properties?.environment?.enum, [
    "dev",
    "staging",
    "production",
  ]);
  assertEquals(workflow.inputs?.required, ["environment"]);
});

Deno.test("Workflow.create creates workflow without inputs", () => {
  const workflow = Workflow.create({
    name: "workflow-no-inputs",
  });

  assertEquals(workflow.inputs, undefined);
});

Deno.test("Workflow.fromData reconstructs workflow with inputs correctly", () => {
  const data = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-workflow-inputs",
    description: "Test with inputs",
    tags: {},
    inputs: {
      properties: {
        message: {
          type: "string" as const,
          description: "A message to display",
        },
        verbose: {
          type: "boolean" as const,
          default: false,
        },
      },
      required: ["message"],
    },
    jobs: [
      {
        name: "job1",
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
        dependsOn: [],
        weight: 0,
      },
    ],
    version: 1,
  };

  const workflow = Workflow.fromData(data);
  assertEquals(workflow.inputs !== undefined, true);
  assertEquals(workflow.inputs?.properties?.message?.type, "string");
  assertEquals(workflow.inputs?.properties?.verbose?.default, false);
  assertEquals(workflow.inputs?.required, ["message"]);
});

Deno.test("Workflow.toData includes inputs in output", () => {
  const workflow = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-workflow",
    inputs: {
      properties: {
        env: { type: "string" },
      },
    },
    jobs: [createTestJob("job1")],
  });

  const data = workflow.toData();
  assertEquals(data.inputs !== undefined, true);
  assertEquals(data.inputs?.properties?.env?.type, "string");
});

Deno.test("Workflow.fromData and toData roundtrip with inputs", () => {
  const original = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "roundtrip-inputs",
    inputs: {
      properties: {
        environment: {
          type: "string",
          enum: ["dev", "staging", "production"],
        },
        replicas: {
          type: "integer",
          default: 3,
        },
      },
      required: ["environment"],
    },
    jobs: [createTestJob("deploy")],
  });

  const data = original.toData();
  const restored = Workflow.fromData(data);

  assertEquals(restored.inputs?.properties?.environment?.type, "string");
  assertEquals(restored.inputs?.properties?.environment?.enum, [
    "dev",
    "staging",
    "production",
  ]);
  assertEquals(restored.inputs?.properties?.replicas?.default, 3);
  assertEquals(restored.inputs?.required, ["environment"]);
});

// Tags field tests

Deno.test("Workflow.create creates workflow with tags", () => {
  const workflow = Workflow.create({
    name: "tagged-workflow",
    tags: { env: "dev", team: "platform" },
    jobs: [createTestJob("job1")],
  });

  assertEquals(workflow.tags, { env: "dev", team: "platform" });
});

Deno.test("Workflow.create defaults tags to empty object", () => {
  const workflow = Workflow.create({
    name: "no-tags-workflow",
  });

  assertEquals(workflow.tags, {});
});

Deno.test("Workflow.toData includes tags in output", () => {
  const workflow = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-workflow",
    tags: { project: "alpha" },
    jobs: [createTestJob("job1")],
  });

  const data = workflow.toData();
  assertEquals(data.tags, { project: "alpha" });
});

Deno.test("Workflow.fromData and toData roundtrip with tags", () => {
  const original = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "roundtrip-tags",
    tags: { env: "prod", region: "us-east-1" },
    jobs: [createTestJob("deploy")],
  });

  const data = original.toData();
  const restored = Workflow.fromData(data);

  assertEquals(restored.tags, { env: "prod", region: "us-east-1" });
});

// Path traversal validation tests

Deno.test("Workflow.create rejects name with '..'", () => {
  assertThrows(
    () =>
      Workflow.create({ name: "../../etc/passwd", jobs: [createTestJob("j")] }),
    Error,
    "path traversal",
  );
});

Deno.test("Workflow.create rejects name with '/'", () => {
  assertThrows(
    () => Workflow.create({ name: "a/b", jobs: [createTestJob("j")] }),
    Error,
    "path traversal",
  );
});

Deno.test("Workflow.create rejects name with '\\'", () => {
  assertThrows(
    () => Workflow.create({ name: "a\\b", jobs: [createTestJob("j")] }),
    Error,
    "path traversal",
  );
});

Deno.test("Workflow.create rejects path traversal even without jobs", () => {
  assertThrows(
    () => Workflow.create({ name: "../../../tmp/evil" }),
    Error,
    "path traversal",
  );
});

// Driver field tests

Deno.test("Workflow.create defaults driver to undefined", () => {
  const workflow = Workflow.create({ name: "test-workflow" });
  assertEquals(workflow.driver, undefined);
  assertEquals(workflow.driverConfig, undefined);
});

Deno.test("Workflow.create uses provided driver and driverConfig", () => {
  const workflow = Workflow.create({
    name: "test-workflow",
    driver: "docker",
    driverConfig: { image: "node:18" },
    jobs: [createTestJob("job1")],
  });
  assertEquals(workflow.driver, "docker");
  assertEquals(workflow.driverConfig, { image: "node:18" });
});

Deno.test("Workflow.toData includes driver and driverConfig", () => {
  const workflow = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-workflow",
    driver: "docker",
    driverConfig: { timeout: 60 },
    jobs: [createTestJob("job1")],
  });
  const data = workflow.toData();
  assertEquals(data.driver, "docker");
  assertEquals(data.driverConfig, { timeout: 60 });
});

Deno.test("Workflow.fromData and toData roundtrip with driver", () => {
  const original = Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "driver-workflow",
    driver: "docker",
    driverConfig: { image: "deno:latest" },
    jobs: [createTestJob("job1")],
  });
  const data = original.toData();
  const restored = Workflow.fromData(data);
  assertEquals(restored.driver, "docker");
  assertEquals(restored.driverConfig, { image: "deno:latest" });
});

Deno.test("Workflow.fromData handles missing tags (backward compat)", () => {
  // Simulate legacy data without tags field — Zod .default({}) fills it in
  const data = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "legacy-workflow",
    jobs: [
      {
        name: "job1",
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
        dependsOn: [],
        weight: 0,
      },
    ],
    version: 1,
  };

  // Cast to bypass TypeScript requiring tags — tests runtime backward compat
  const workflow = Workflow.fromData(
    data as unknown as import("./workflow.ts").WorkflowData,
  );
  assertEquals(workflow.tags, {});
});
