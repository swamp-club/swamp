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
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
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

Deno.test("YamlWorkflowRunRepository save/load roundtrip preserves tags", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const tags = { env: "prod", region: "us-east-1" };
    const run = WorkflowRun.create(workflow, tags);
    run.start();

    await repo.save(workflow.id, run);
    const loaded = await repo.findById(workflow.id, run.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.tags, { env: "prod", region: "us-east-1" });
  });
});

Deno.test("YamlWorkflowRunRepository save/load roundtrip with no tags", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();

    await repo.save(workflow.id, run);
    const loaded = await repo.findById(workflow.id, run.id);

    assertNotEquals(loaded, null);
    assertEquals(loaded!.tags, {});
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

Deno.test("YamlWorkflowRunRepository invokes markDirty with relPath on mutations", async () => {
  await withTempDir(async (dir) => {
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );

    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();

    // save → per-run yaml path
    await repo.save(workflow.id, run);
    assertEquals(calls.length, 1);
    assertEquals(calls[0], repo.getPath(workflow.id, run.id));

    await repo.findById(workflow.id, run.id);
    await repo.findAllByWorkflowId(workflow.id);
    assertEquals(calls.length, 1);

    // deleteAllByWorkflowId → bulk (whole runs directory removed)
    await repo.deleteAllByWorkflowId(workflow.id);
    assertEquals(calls.length, 2);
    assertEquals(calls[1], undefined);

    // deleteAllByWorkflowId on an empty workflow is a no-op and must not
    // notify — nothing was written or removed.
    await repo.deleteAllByWorkflowId(workflow.id);
    assertEquals(calls.length, 2);
  });
});

Deno.test("findAllGlobalSince: returns only in-window runs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const old = WorkflowRun.create(workflow);
    old.start();
    await repo.save(workflow.id, old);

    // Backdate the file so its mtime falls before the cutoff.
    const oldPath = repo.getPath(workflow.id, old.id);
    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await Deno.utime(oldPath, oldDate, oldDate);

    const fresh = WorkflowRun.create(workflow);
    fresh.start();
    await repo.save(workflow.id, fresh);

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const found = await repo.findAllGlobalSince(cutoff);

    assertEquals(found.length, 1);
    assertEquals(found[0].run.id, fresh.id);
  });
});

Deno.test(
  "findAllGlobalSince: rejects long-running runs that started before the cutoff",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();

      // A run that started 2 days ago.
      const longRunning = WorkflowRun.create(workflow);
      longRunning.start();
      await repo.save(workflow.id, longRunning);
      const path = repo.getPath(workflow.id, longRunning.id);
      const startedLongAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      // Re-write the YAML with a startedAt 2 days in the past, then bump
      // mtime to "now" to simulate a long-running workflow that the engine
      // saved into recently — Stage A passes, Stage B must reject.
      const content = await Deno.readTextFile(path);
      const patched = content.replace(
        /startedAt: .*/,
        `startedAt: "${startedLongAgo.toISOString()}"`,
      );
      await Deno.writeTextFile(path, patched);
      const now = new Date();
      await Deno.utime(path, now, now);

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.length, 0);
    });
  },
);

Deno.test(
  "findAllGlobalSince: backup-restore (mtime in the future) keeps correctness",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();

      // An old run whose mtime got scrambled by a backup-restore — mtime is
      // "now" but the YAML startedAt is far in the past. Stage A is defeated
      // (we won't skip), but Stage B catches it.
      const old = WorkflowRun.create(workflow);
      old.start();
      await repo.save(workflow.id, old);
      const path = repo.getPath(workflow.id, old.id);
      const startedLongAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const content = await Deno.readTextFile(path);
      const patched = content.replace(
        /startedAt: .*/,
        `startedAt: "${startedLongAgo.toISOString()}"`,
      );
      await Deno.writeTextFile(path, patched);
      const now = new Date();
      await Deno.utime(path, now, now);

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.length, 0);
    });
  },
);

Deno.test(
  "findAllGlobalSince: file deleted mid-iteration is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();

      const keep = WorkflowRun.create(workflow);
      keep.start();
      await repo.save(workflow.id, keep);

      const doomed = WorkflowRun.create(workflow);
      doomed.start();
      await repo.save(workflow.id, doomed);

      // Simulate a concurrent deletion by removing the file. Pre-fix
      // behavior: NotFound thrown by Deno.stat propagates to the
      // workflow-level catch, returning [] and losing `keep` too.
      await Deno.remove(repo.getPath(workflow.id, doomed.id));

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.length, 1);
      assertEquals(found[0].run.id, keep.id);
    });
  },
);

Deno.test(
  "findAllByWorkflowId: file deleted mid-iteration is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();

      const keep = WorkflowRun.create(workflow);
      keep.start();
      await repo.save(workflow.id, keep);

      const doomed = WorkflowRun.create(workflow);
      doomed.start();
      await repo.save(workflow.id, doomed);

      await Deno.remove(repo.getPath(workflow.id, doomed.id));

      const found = await repo.findAllByWorkflowId(workflow.id);

      assertEquals(found.length, 1);
      assertEquals(found[0].id, keep.id);
    });
  },
);
