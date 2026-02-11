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
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
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

function createTestWorkflow(): Workflow {
  return Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-workflow",
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

Deno.test("YamlWorkflowRunRepository.save and findById roundtrip", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();

    await repo.save(workflow.id, run);
    const loaded = await repo.findById(workflow.id, run.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.id, run.id);
    assertEquals(loaded!.workflowId, workflow.id);
    assertEquals(loaded!.workflowName, workflow.name);
    assertEquals(loaded!.status, "running");
  });
});

Deno.test("YamlWorkflowRunRepository.findById returns null for nonexistent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");
    const runId = repo.nextId();

    const result = await repo.findById(workflowId, runId);
    assertEquals(result, null);
  });
});

Deno.test("YamlWorkflowRunRepository.findAllByWorkflowId returns all runs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    // Create and save multiple runs
    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    const run2 = WorkflowRun.create(workflow);
    run2.start();
    await repo.save(workflow.id, run2);

    const all = await repo.findAllByWorkflowId(workflow.id);
    assertEquals(all.length, 2);
  });
});

Deno.test("YamlWorkflowRunRepository.findAllByWorkflowId returns empty for no runs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");

    const all = await repo.findAllByWorkflowId(workflowId);
    assertEquals(all, []);
  });
});

Deno.test("YamlWorkflowRunRepository.findLatestByWorkflowId returns most recent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    // Create and save first run
    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    // Create and save second run (should be latest)
    const run2 = WorkflowRun.create(workflow);
    run2.start();
    await repo.save(workflow.id, run2);

    const latest = await repo.findLatestByWorkflowId(workflow.id);
    assertNotEquals(latest, null);
    assertEquals(latest!.id, run2.id);
  });
});

Deno.test("YamlWorkflowRunRepository.findLatestByWorkflowId returns null for no runs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");

    const latest = await repo.findLatestByWorkflowId(workflowId);
    assertEquals(latest, null);
  });
});

Deno.test("YamlWorkflowRunRepository.nextId returns unique IDs", () => {
  const repo = new YamlWorkflowRunRepository("/tmp/test-workflow-run-repo");

  const id1 = repo.nextId();
  const id2 = repo.nextId();

  assertNotEquals(id1, id2);
  assertEquals(id1.length, 36); // UUID length
});

Deno.test("YamlWorkflowRunRepository preserves run state", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    // Set various states
    run.start();
    const jobRun = run.getJob("job1");
    jobRun?.start();
    jobRun?.getStep("step1")?.start();
    jobRun?.getStep("step1")?.succeed({ result: "success" });
    jobRun?.succeed();
    run.complete();

    await repo.save(workflow.id, run);
    const loaded = await repo.findById(workflow.id, run.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.status, "succeeded");
    assertEquals(loaded!.getJob("job1")?.status, "succeeded");
    assertEquals(loaded!.getJob("job1")?.getStep("step1")?.status, "succeeded");
    assertEquals(loaded!.getJob("job1")?.getStep("step1")?.output, {
      result: "success",
    });
  });
});

Deno.test("YamlWorkflowRunRepository preserves error information", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

    run.start();
    const jobRun = run.getJob("job1");
    jobRun?.start();
    jobRun?.getStep("step1")?.start();
    jobRun?.getStep("step1")?.fail("Something went wrong");
    jobRun?.fail();
    run.complete();

    await repo.save(workflow.id, run);
    const loaded = await repo.findById(workflow.id, run.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.status, "failed");
    assertEquals(
      loaded!.getJob("job1")?.getStep("step1")?.error,
      "Something went wrong",
    );
  });
});

function createTestWorkflow2(): Workflow {
  return Workflow.create({
    id: "660e8400-e29b-41d4-a716-446655440001",
    name: "test-workflow-2",
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

Deno.test("YamlWorkflowRunRepository.findAllGlobal returns runs from multiple workflows", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow1 = createTestWorkflow();
    const workflow2 = createTestWorkflow2();

    // Create runs for workflow 1
    const run1 = WorkflowRun.create(workflow1);
    run1.start();
    await repo.save(workflow1.id, run1);

    // Create runs for workflow 2
    const run2 = WorkflowRun.create(workflow2);
    run2.start();
    await repo.save(workflow2.id, run2);

    const allRuns = await repo.findAllGlobal();
    assertEquals(allRuns.length, 2);

    // Verify both workflows are represented
    const workflowIds = allRuns.map((r) => r.workflowId);
    assertEquals(workflowIds.includes(workflow1.id), true);
    assertEquals(workflowIds.includes(workflow2.id), true);
  });
});

Deno.test("YamlWorkflowRunRepository.findAllGlobal returns empty for no workflows", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);

    const allRuns = await repo.findAllGlobal();
    assertEquals(allRuns, []);
  });
});

Deno.test("YamlWorkflowRunRepository.findAllGlobal sorts by startedAt descending", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow1 = createTestWorkflow();
    const workflow2 = createTestWorkflow2();

    // Create first run (older)
    const run1 = WorkflowRun.create(workflow1);
    run1.start();
    await repo.save(workflow1.id, run1);

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    // Create second run (newer)
    const run2 = WorkflowRun.create(workflow2);
    run2.start();
    await repo.save(workflow2.id, run2);

    const allRuns = await repo.findAllGlobal();
    assertEquals(allRuns.length, 2);

    // Most recent should be first
    assertEquals(allRuns[0].run.id, run2.id);
    assertEquals(allRuns[1].run.id, run1.id);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteAllByWorkflowId deletes all runs for workflow", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    // Create and save multiple runs
    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    const run2 = WorkflowRun.create(workflow);
    run2.start();
    await repo.save(workflow.id, run2);

    // Verify runs exist
    const runsBefore = await repo.findAllByWorkflowId(workflow.id);
    assertEquals(runsBefore.length, 2);

    // Delete all runs
    const deletedCount = await repo.deleteAllByWorkflowId(workflow.id);
    assertEquals(deletedCount, 2);

    // Verify runs are gone
    const runsAfter = await repo.findAllByWorkflowId(workflow.id);
    assertEquals(runsAfter.length, 0);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteAllByWorkflowId returns 0 for no runs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");

    const deletedCount = await repo.deleteAllByWorkflowId(workflowId);
    assertEquals(deletedCount, 0);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteAllByWorkflowId does not affect other workflows", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow1 = createTestWorkflow();
    const workflow2 = createTestWorkflow2();

    // Create runs for both workflows
    const run1 = WorkflowRun.create(workflow1);
    run1.start();
    await repo.save(workflow1.id, run1);

    const run2 = WorkflowRun.create(workflow2);
    run2.start();
    await repo.save(workflow2.id, run2);

    // Delete only workflow1's runs
    await repo.deleteAllByWorkflowId(workflow1.id);

    // Verify workflow1 runs are gone
    const runs1After = await repo.findAllByWorkflowId(workflow1.id);
    assertEquals(runs1After.length, 0);

    // Verify workflow2 runs still exist
    const runs2After = await repo.findAllByWorkflowId(workflow2.id);
    assertEquals(runs2After.length, 1);
  });
});
