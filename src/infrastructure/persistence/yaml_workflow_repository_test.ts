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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { YamlWorkflowRepository } from "./yaml_workflow_repository.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

function createTestWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

Deno.test("YamlWorkflowRepository.save and findById roundtrip", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const workflow = createTestWorkflow("test-workflow");

    await repo.save(workflow);
    const loaded = await repo.findById(workflow.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.id, workflow.id);
    assertEquals(loaded!.name, workflow.name);
    assertEquals(loaded!.jobs.length, 1);
  });
});

Deno.test("YamlWorkflowRepository.findById returns null for nonexistent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const id = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");

    const result = await repo.findById(id);
    assertEquals(result, null);
  });
});

Deno.test("YamlWorkflowRepository.findByName finds workflow", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const workflow = createTestWorkflow("unique-name");

    await repo.save(workflow);
    const loaded = await repo.findByName("unique-name");

    assertNotEquals(loaded, null);
    assertEquals(loaded!.name, "unique-name");
  });
});

Deno.test("YamlWorkflowRepository.findByName returns null for nonexistent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);

    const result = await repo.findByName("nonexistent");
    assertEquals(result, null);
  });
});

Deno.test("YamlWorkflowRepository.findAll returns all workflows", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const workflow1 = createTestWorkflow("workflow-1");
    const workflow2 = createTestWorkflow("workflow-2");

    await repo.save(workflow1);
    await repo.save(workflow2);

    const all = await repo.findAll();
    assertEquals(all.length, 2);

    const names = all.map((w) => w.name).sort();
    assertEquals(names, ["workflow-1", "workflow-2"]);
  });
});

Deno.test("YamlWorkflowRepository.findAll returns empty for no workflows", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);

    const all = await repo.findAll();
    assertEquals(all, []);
  });
});

Deno.test("YamlWorkflowRepository.delete removes workflow", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const workflow = createTestWorkflow("to-delete");

    await repo.save(workflow);
    assertEquals((await repo.findById(workflow.id)) !== null, true);

    await repo.delete(workflow.id);
    assertEquals(await repo.findById(workflow.id), null);
  });
});

Deno.test("YamlWorkflowRepository.delete does not throw for nonexistent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const id = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");

    // Should not throw
    await repo.delete(id);
  });
});

Deno.test("YamlWorkflowRepository.nextId returns unique IDs", () => {
  const repo = new YamlWorkflowRepository("/tmp/test-workflow-repo");

  const id1 = repo.nextId();
  const id2 = repo.nextId();

  assertNotEquals(id1, id2);
  assertEquals(id1.length, 36); // UUID length
});

Deno.test("YamlWorkflowRepository.getPath returns correct path", () => {
  const repo = new YamlWorkflowRepository("/tmp/test-workflow-repo");
  const id = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");

  const path = repo.getPath(id);
  assertEquals(path.includes("workflows"), true);
  assertEquals(
    path.includes("workflow-550e8400-e29b-41d4-a716-446655440000.yaml"),
    true,
  );
});

Deno.test("YamlWorkflowRepository preserves complex workflow data", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const workflow = Workflow.create({
      name: "complex-workflow",
      description: "A complex test workflow",
      jobs: [
        Job.create({
          name: "build",
          description: "Build job",
          steps: [
            Step.create({
              name: "compile",
              description: "Compile step",
              task: StepTask.model("test-model", "run"),
              weight: 10,
            }),
          ],
          weight: 5,
        }),
      ],
      version: 2,
    });

    await repo.save(workflow);
    const loaded = await repo.findById(workflow.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.name, "complex-workflow");
    assertEquals(loaded!.description, "A complex test workflow");
    assertEquals(loaded!.version, 2);
    assertEquals(loaded!.jobs[0].name, "build");
    assertEquals(loaded!.jobs[0].description, "Build job");
    assertEquals(loaded!.jobs[0].weight, 5);
    assertEquals(loaded!.jobs[0].steps[0].name, "compile");
    assertEquals(loaded!.jobs[0].steps[0].weight, 10);
  });
});

Deno.test("YamlWorkflowRepository.findAll skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const goodWorkflow = createTestWorkflow("good-workflow");

    await repo.save(goodWorkflow);

    // Write a broken YAML file in the workflows directory
    const workflowsDir = swampPath(dir, SWAMP_SUBDIRS.workflows);
    await Deno.writeTextFile(
      join(workflowsDir, "workflow-00000000-0000-4000-8000-000000000000.yaml"),
      "this: is: not: valid: yaml: [",
    );

    const results = await repo.findAll();

    // Should return the good workflow and skip the broken one
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "good-workflow");
  });
});

Deno.test("YamlWorkflowRepository.findAll skips schema-invalid YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const goodWorkflow = createTestWorkflow("good-workflow");

    await repo.save(goodWorkflow);

    // Write a valid YAML file that fails schema validation (missing required fields)
    const workflowsDir = swampPath(dir, SWAMP_SUBDIRS.workflows);
    const invalidData = { description: "no name or id field" };
    await Deno.writeTextFile(
      join(
        workflowsDir,
        "workflow-00000000-0000-4000-8000-000000000001.yaml",
      ),
      stringifyYaml(invalidData),
    );

    const results = await repo.findAll();

    // Should return only the good workflow
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "good-workflow");
  });
});

Deno.test("YamlWorkflowRepository.findByName skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRepository(dir);
    const goodWorkflow = createTestWorkflow("good-workflow");

    await repo.save(goodWorkflow);

    // Write a broken YAML file in the workflows directory
    const workflowsDir = swampPath(dir, SWAMP_SUBDIRS.workflows);
    await Deno.writeTextFile(
      join(workflowsDir, "workflow-00000000-0000-4000-8000-000000000000.yaml"),
      "not valid yaml content {{{",
    );

    // Should still find the good workflow despite the broken file
    const result = await repo.findByName("good-workflow");
    assertNotEquals(result, null);
    assertEquals(result!.name, "good-workflow");
  });
});
