import { assertEquals, assertNotEquals } from "@std/assert";
import { YamlWorkflowRepository } from "./yaml_workflow_repository.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

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
            task: StepTask.shell("echo", { args: ["hello"] }),
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
              task: StepTask.shell("npm", {
                args: ["run", "build"],
                workingDir: "/app",
              }),
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
