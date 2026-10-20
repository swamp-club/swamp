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

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, isAbsolute, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import {
  getIndexPath,
  INDEX_SCHEMA_VERSION,
  readRunIndex,
  withIndexQueue,
} from "./workflow_run_index.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  pathExists,
  recordingUnitOfWork,
  typedRecordingUnitOfWork,
} from "./test_helpers/staged_change_helpers.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { runInUnitOfWork } from "./unit_of_work_scope.ts";
import { UserError } from "../../domain/errors.ts";
import {
  captureUnreadableWarnings,
  fakeUnreadableLookup,
} from "./unreadable_records_test_helpers.ts";

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

Deno.test("YamlWorkflowRunRepository.findById loads the named run among several", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = [0, 1, 2].map(() => {
      const run = WorkflowRun.create(workflow);
      run.start();
      return run;
    });
    for (const run of runs) await repo.save(workflow.id, run);

    for (const run of runs) {
      assertEquals((await repo.findById(workflow.id, run.id))?.id, run.id);
    }
  });
});

Deno.test("YamlWorkflowRunRepository.findById returns null for an id that is not a UUID without reading a file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const runsDir = dirname(repo.getPath(workflow.id, run.id));
    // Unparseable, and named so that a substring match on "-" would read it.
    await Deno.writeTextFile(join(runsDir, "workflow-run-broken-.yaml"), "{");
    // Where a direct join of `../../x` would land.
    await Deno.writeTextFile(join(runsDir, "x.yaml"), "{");

    for (const id of ["-", "../../x", "", run.id.slice(0, 8)]) {
      assertEquals(
        await repo.findById(workflow.id, createWorkflowRunId(id)),
        null,
      );
    }
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

    // deleteAllByWorkflowId → runs directory path (not bulk)
    await repo.deleteAllByWorkflowId(workflow.id);
    assertEquals(calls.length, 2);
    assertEquals(calls[1], join(dir, ".swamp", "workflow-runs", workflow.id));

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

// Writes a raw run YAML directly (bypassing save/toData) so tests can exercise
// records the summary read must tolerate — e.g. huge inline outputs or a
// malformed jobs subtree that full-aggregate validation would reject.
async function writeRawRun(
  repo: YamlWorkflowRunRepository,
  workflowId: WorkflowId,
  runId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const path = repo.getPath(workflowId, createWorkflowRunId(runId));
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, stringifyYaml(data));
}

const WF_ID = "550e8400-e29b-41d4-a716-446655440000";

Deno.test(
  "findAllSummariesByWorkflowId: returns projections sorted startedAt desc",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflowId = createWorkflowId(WF_ID);

      await writeRawRun(
        repo,
        workflowId,
        "11111111-1111-1111-1111-111111111111",
        {
          id: "11111111-1111-1111-1111-111111111111",
          workflowId: WF_ID,
          workflowName: "deploy",
          status: "succeeded",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          jobs: [],
          tags: { env: "prod" },
          inputs: { region: "us-east-1" },
        },
      );
      await writeRawRun(
        repo,
        workflowId,
        "22222222-2222-2222-2222-222222222222",
        {
          id: "22222222-2222-2222-2222-222222222222",
          workflowId: WF_ID,
          workflowName: "deploy",
          status: "failed",
          startedAt: "2026-01-02T00:00:00.000Z",
          jobs: [],
          tags: {},
        },
      );

      const summaries = await repo.findAllSummariesByWorkflowId(workflowId);

      assertEquals(summaries.length, 2);
      // Most recent first.
      assertEquals(summaries[0].id, "22222222-2222-2222-2222-222222222222");
      assertEquals(summaries[1].id, "11111111-1111-1111-1111-111111111111");
      assertEquals(summaries[1].tags, { env: "prod" });
      assertEquals(summaries[1].inputs, { region: "us-east-1" });
      assertEquals(
        summaries[1].startedAt?.toISOString(),
        "2026-01-01T00:00:00.000Z",
      );
    });
  },
);

Deno.test(
  "findAllSummariesByWorkflowId: returns empty for a workflow with no runs",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const summaries = await repo.findAllSummariesByWorkflowId(
        createWorkflowId(WF_ID),
      );
      assertEquals(summaries, []);
    });
  },
);

Deno.test(
  "findAllSummariesByWorkflowId: does not retain heavy inline step outputs",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflowId = createWorkflowId(WF_ID);

      await writeRawRun(
        repo,
        workflowId,
        "33333333-3333-3333-3333-333333333333",
        {
          id: "33333333-3333-3333-3333-333333333333",
          workflowId: WF_ID,
          workflowName: "deploy",
          status: "succeeded",
          startedAt: "2026-01-01T00:00:00.000Z",
          jobs: [
            {
              jobName: "job1",
              status: "succeeded",
              steps: [
                {
                  stepName: "step1",
                  status: "succeeded",
                  output: "x".repeat(100000),
                },
              ],
            },
          ],
          tags: {},
        },
      );

      const summaries = await repo.findAllSummariesByWorkflowId(workflowId);

      assertEquals(summaries.length, 1);
      assert(!("jobs" in summaries[0]), "summary must not carry jobs");
      assert(!("output" in summaries[0]), "summary must not carry output");
      assertEquals(summaries[0].status, "succeeded");
    });
  },
);

Deno.test(
  "findAllSummariesByWorkflowId: tolerates a malformed jobs subtree (no aggregate rebuild)",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflowId = createWorkflowId(WF_ID);

      // jobs is not an array and the step status is invalid — WorkflowRunSchema
      // (used by findAllByWorkflowId via fromData) would reject this, but the
      // summary read only looks at the displayed fields.
      await writeRawRun(
        repo,
        workflowId,
        "44444444-4444-4444-4444-444444444444",
        {
          id: "44444444-4444-4444-4444-444444444444",
          workflowId: WF_ID,
          workflowName: "deploy",
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          jobs: "totally-not-an-array",
          tags: {},
        },
      );

      const summaries = await repo.findAllSummariesByWorkflowId(workflowId);

      assertEquals(summaries.length, 1);
      assertEquals(summaries[0].id, "44444444-4444-4444-4444-444444444444");
      assertEquals(summaries[0].status, "running");
    });
  },
);

Deno.test(
  "findAllSummariesByWorkflowId: file deleted mid-iteration is skipped, not fatal",
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

      const summaries = await repo.findAllSummariesByWorkflowId(workflow.id);

      assertEquals(summaries.length, 1);
      assertEquals(summaries[0].id, keep.id);
    });
  },
);

// --- Index-backed methods ---

Deno.test("save: creates index entry alongside YAML file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();

    await repo.save(workflow.id, run);

    const runsDir = join(
      dir,
      ".swamp",
      "workflow-runs",
      workflow.id,
    );
    const index = await readRunIndex(runsDir);
    assertNotEquals(index, null);
    assertEquals(index!.entries[run.id]?.status, "running");
    assertEquals(index!.entries[run.id]?.workflowName, "test-workflow");
  });
});

Deno.test("save: index entry includes triggerSource from run", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow, {}, undefined, "schedule");
    run.start();

    await repo.save(workflow.id, run);

    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const index = await readRunIndex(runsDir);
    assertNotEquals(index, null);
    assertEquals(index!.entries[run.id]?.triggerSource, "schedule");
  });
});

Deno.test("save: updates index entry on status change", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    run.getJob("job1")!.getStep("step1")!.succeed();
    run.getJob("job1")!.succeed();
    run.complete();
    await repo.save(workflow.id, run);

    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const index = await readRunIndex(runsDir);
    assertEquals(index!.entries[run.id]?.status, "succeeded");
  });
});

Deno.test("findAllSummariesFromIndex: returns summaries from index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    const run2 = WorkflowRun.create(workflow);
    run2.start();
    run2.getJob("job1")!.getStep("step1")!.succeed();
    run2.getJob("job1")!.succeed();
    run2.complete();
    await repo.save(workflow.id, run2);

    const summaries = await repo.findAllSummariesFromIndex(workflow.id);
    assertEquals(summaries.length, 2);
    const statuses = summaries.map((s) => s.status).sort();
    assertEquals(statuses, ["running", "succeeded"]);
  });
});

/** Sets the run index file and the records directory back a minute. */
async function settleRunIndex(dir: string, workflowId: WorkflowId) {
  const runsDir = join(dir, ".swamp", "workflow-runs", workflowId);
  const when = new Date(Date.now() - 60_000);
  await Deno.utime(getIndexPath(runsDir), when, when);
  await Deno.utime(runsDir, when, when);
}

/**
 * A run index cache clock a minute ahead, for a repository whose snapshots
 * a test expects to be kept: `Deno.utime` sets a file's mtime back but
 * moves its ctime to now, and a recent ctime is not trusted
 * (swamp-club#3467).
 */
const aheadClock = () => Date.now() + 60_000;

/** A repository whose run index cache judges file times by `aheadClock`. */
function keepingRepo(dir: string): YamlWorkflowRunRepository {
  return new YamlWorkflowRunRepository(
    dir,
    undefined,
    undefined,
    undefined,
    aheadClock,
  );
}

function runsDirOf(dir: string, workflowId: WorkflowId): string {
  return join(dir, ".swamp", "workflow-runs", workflowId);
}

/** Copies a run's record to a new run id, as another writer would add it. */
async function copyRecord(
  dir: string,
  workflowId: WorkflowId,
  from: string,
  to: string,
): Promise<void> {
  const runsDir = runsDirOf(dir, workflowId);
  const text = await Deno.readTextFile(
    join(runsDir, `workflow-run-${from}.yaml`),
  );
  await Deno.writeTextFile(
    join(runsDir, `workflow-run-${to}.yaml`),
    text.replaceAll(from, to),
  );
}

Deno.test("countRunRecords: counts the workflow's run records and nothing else in their directory", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    assertEquals(await repo.countRunRecords(workflow.id), 0);

    for (let i = 0; i < 3; i++) {
      const run = WorkflowRun.create(workflow);
      run.start();
      await repo.save(workflow.id, run);
    }
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.writeTextFile(join(runsDir, "workflow-run-stray.log"), "");
    await Deno.writeTextFile(join(runsDir, "notes.yaml"), "");

    assertEquals(await repo.countRunRecords(workflow.id), 3);
  });
});

Deno.test("countRunRecords: stops listing once its signal aborts", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const aborted = new AbortController();
    aborted.abort(new Error("stopped"));
    // No runs directory yet: an aborted count still rejects.
    await assertRejects(
      () => repo.countRunRecords(workflow.id, aborted.signal),
      Error,
      "stopped",
    );

    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    const abort = new AbortController();
    abort.abort(new Error("stopped"));
    await assertRejects(
      () => repo.countRunRecords(workflow.id, abort.signal),
      Error,
      "stopped",
    );
  });
});

Deno.test("runIndexSnapshot: reuses the snapshot while the index and records are unchanged", async () => {
  await withTempDir(async (dir) => {
    let offset = 0;
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      undefined,
      () => Date.now() + offset,
    );
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    // Just written: too recent to trust, so each read builds a new one.
    const fresh = await repo.runIndexSnapshot(workflow.id);
    assertNotStrictEquals(await repo.runIndexSnapshot(workflow.id), fresh);

    offset = 60_000;
    const settled = await repo.runIndexSnapshot(workflow.id);
    assertStrictEquals(await repo.runIndexSnapshot(workflow.id), settled);
    assertEquals(settled.runs.map((r) => r.summary.id), [run.id]);
  });
});

Deno.test("runIndexSnapshot: looks up unreadable records when it builds a snapshot, not when it reuses one (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    let offset = 0;
    let lookups = 0;
    const lookup = Object.assign(
      (_path: string) => Promise.resolve(undefined),
      {
        under: (_dir: string) => {
          lookups++;
          return Promise.resolve([]);
        },
      },
    );
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      undefined,
      () => Date.now() + offset,
      lookup,
    );
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    offset = 60_000;
    const settled = await repo.runIndexSnapshot(workflow.id);
    assertEquals(lookups, 1);
    assertStrictEquals(await repo.runIndexSnapshot(workflow.id), settled);
    assertStrictEquals(await repo.runIndexSnapshot(workflow.id), settled);
    assertEquals(lookups, 1);
  });
});

Deno.test("runIndexSnapshot: does not keep a snapshot while the index ctime is recent, though its mtime is old", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    // Sets the mtimes back, as a rewrite in place that restores them
    // would, and moves the index's ctime to now.
    await settleRunIndex(dir, workflow.id);
    // A platform that reports no ctime (Windows) has nothing to tell the
    // rewrite by, and keeps the snapshot.
    const indexPath = getIndexPath(runsDirOf(dir, workflow.id));
    if ((await Deno.stat(indexPath)).ctime === null) return;

    const first = await repo.runIndexSnapshot(workflow.id);
    assertNotStrictEquals(await repo.runIndexSnapshot(workflow.id), first);
  });
});

Deno.test({
  name:
    "runIndexSnapshot: a repair that cannot write the index is not kept, so a later edit of a record is seen",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (dir) => {
      const repo = keepingRepo(dir);
      const workflow = createTestWorkflow();
      const edited = WorkflowRun.create(workflow);
      edited.start();
      await repo.save(workflow.id, edited);
      const other = WorkflowRun.create(workflow);
      other.start();
      await repo.save(workflow.id, other);
      // A record the index does not list, in a directory the repair
      // cannot write its index to.
      await copyRecord(dir, workflow.id, other.id, crypto.randomUUID());
      const runsDir = runsDirOf(dir, workflow.id);
      await Deno.chmod(runsDir, 0o555);
      try {
        assertEquals((await repo.runIndexSnapshot(workflow.id)).size, 3);

        const path = join(runsDir, `workflow-run-${edited.id}.yaml`);
        const text = await Deno.readTextFile(path);
        await Deno.writeTextFile(
          path,
          text.replace("status: running", "status: failed"),
        );
        assertEquals(
          (await repo.runIndexSnapshot(workflow.id)).get(edited.id)?.summary
            .status,
          "failed",
        );
      } finally {
        await Deno.chmod(runsDir, 0o755);
      }
    });
  },
});

Deno.test({
  name:
    "runIndexSnapshot: a rebuild that cannot write the index is not kept, so a later edit of a record is seen",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (dir) => {
      const repo = keepingRepo(dir);
      const workflow = createTestWorkflow();
      const run = WorkflowRun.create(workflow);
      run.start();
      await repo.save(workflow.id, run);
      const runsDir = runsDirOf(dir, workflow.id);
      await Deno.remove(getIndexPath(runsDir));
      await Deno.chmod(runsDir, 0o555);
      try {
        const first = await repo.runIndexSnapshot(workflow.id);
        assertNotStrictEquals(await repo.runIndexSnapshot(workflow.id), first);

        const path = join(runsDir, `workflow-run-${run.id}.yaml`);
        const text = await Deno.readTextFile(path);
        await Deno.writeTextFile(
          path,
          text.replace("status: running", "status: failed"),
        );
        assertEquals(
          (await repo.runIndexSnapshot(workflow.id)).get(run.id)?.summary
            .status,
          "failed",
        );
      } finally {
        await Deno.chmod(runsDir, 0o755);
      }
    });
  },
});

Deno.test("runIndexSnapshot: an empty record is not kept out of the snapshot once it is written in place", async () => {
  await withTempDir(async (dir) => {
    const repo = keepingRepo(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    // A writer that creates the file before it fills it in.
    const late = crypto.randomUUID();
    const path = join(
      runsDirOf(dir, workflow.id),
      `workflow-run-${late}.yaml`,
    );
    await Deno.writeTextFile(path, "");
    assertEquals((await repo.runIndexSnapshot(workflow.id)).size, 1);

    await copyRecord(dir, workflow.id, run.id, late);
    assert((await repo.runIndexSnapshot(workflow.id)).get(late));
  });
});

Deno.test("runIndexSnapshot: sees a save by this repository after the snapshot was kept", async () => {
  await withTempDir(async (dir) => {
    const repo = keepingRepo(dir);
    const workflow = createTestWorkflow();
    const first = WorkflowRun.create(workflow);
    first.start();
    await repo.save(workflow.id, first);
    await settleRunIndex(dir, workflow.id);
    assertEquals((await repo.runIndexSnapshot(workflow.id)).size, 1);

    const second = WorkflowRun.create(workflow);
    second.start();
    await repo.save(workflow.id, second);
    const after = await repo.runIndexSnapshot(workflow.id);
    assertEquals(after.size, 2);
    assert(after.get(second.id));
  });
});

Deno.test("runIndexSnapshot: sees runs another process saves, and an index another process rewrites", async () => {
  await withTempDir(async (dir) => {
    const reader = keepingRepo(dir);
    const writer = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await writer.save(workflow.id, run);
    await settleRunIndex(dir, workflow.id);
    assertEquals(
      (await reader.runIndexSnapshot(workflow.id)).get(run.id)?.summary.status,
      "running",
    );

    // Same record count: only the index file changes.
    run.interruptOrphaned("test");
    await writer.save(workflow.id, run);
    assertEquals(
      (await reader.runIndexSnapshot(workflow.id)).get(run.id)?.summary.status,
      "interrupted",
    );

    await settleRunIndex(dir, workflow.id);
    await reader.runIndexSnapshot(workflow.id);
    const added = WorkflowRun.create(workflow);
    added.start();
    await writer.save(workflow.id, added);
    assertEquals((await reader.runIndexSnapshot(workflow.id)).size, 2);
  });
});

Deno.test("runIndexSnapshot: a workflow with no index is read from its records and not kept", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    assertEquals((await repo.runIndexSnapshot(workflow.id)).size, 0);

    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    await settleRunIndex(dir, workflow.id);
    assertEquals((await repo.runIndexSnapshot(workflow.id)).size, 1);
  });
});

Deno.test("runIndexSnapshot: deleteAllByWorkflowId leaves no runs behind", async () => {
  await withTempDir(async (dir) => {
    const repo = keepingRepo(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    await settleRunIndex(dir, workflow.id);
    assertEquals((await repo.runIndexSnapshot(workflow.id)).size, 1);

    await repo.deleteAllByWorkflowId(workflow.id);
    assertEquals((await repo.runIndexSnapshot(workflow.id)).size, 0);
  });
});

Deno.test("findAllSummariesFromIndex: falls back to YAML scan when index missing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    // Delete the index to force fallback
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.remove(getIndexPath(runsDir));

    const summaries = await repo.findAllSummariesFromIndex(workflow.id);
    assertEquals(summaries.length, 1);
    assertEquals(summaries[0].status, "running");
  });
});

Deno.test("findAllSummariesFromIndex: rebuilds stale index missing triggerSource", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    // Save a run with triggerSource
    const run = WorkflowRun.create(workflow, {}, undefined, "schedule");
    run.start();
    await repo.save(workflow.id, run);

    // Overwrite the index with an old-format file (flat JSON, no
    // triggerSource) simulating a pre-upgrade cache
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const oldIndex: Record<string, unknown> = {
      [run.id]: {
        status: "running",
        workflowId: run.workflowId,
        workflowName: "test-workflow",
        startedAt: run.startedAt?.toISOString(),
        tags: {},
        inputs: {},
        // triggerSource deliberately omitted
      },
    };
    await Deno.writeTextFile(
      getIndexPath(runsDir),
      JSON.stringify(oldIndex),
    );

    // The search must rebuild from YAML and return the real triggerSource
    const summaries = await repo.findAllSummariesFromIndex(workflow.id);
    assertEquals(summaries.length, 1);
    assertEquals(summaries[0].triggerSource, "schedule");
  });
});

Deno.test("findSummariesByStatus: filters by status", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    const run2 = WorkflowRun.create(workflow);
    run2.start();
    run2.getJob("job1")!.getStep("step1")!.succeed();
    run2.getJob("job1")!.succeed();
    run2.complete();
    await repo.save(workflow.id, run2);

    const running = await repo.findSummariesByStatus(workflow.id, "running");
    assertEquals(running.length, 1);
    assertEquals(running[0].id, run1.id);

    const succeeded = await repo.findSummariesByStatus(
      workflow.id,
      "succeeded",
    );
    assertEquals(succeeded.length, 1);
    assertEquals(succeeded[0].id, run2.id);

    const failed = await repo.findSummariesByStatus(workflow.id, "failed");
    assertEquals(failed.length, 0);
  });
});

Deno.test("findSummariesByStatus: rebuilds stale index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    // Manually write a second YAML file without updating the index
    // to simulate a concurrent write race
    const run2 = WorkflowRun.create(workflow);
    run2.start();
    run2.suspend();
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const yamlPath = join(runsDir, `workflow-run-${run2.id}.yaml`);
    const data = run2.toData();
    const cleanData = JSON.parse(JSON.stringify(data));
    await Deno.writeTextFile(
      yamlPath,
      stringifyYaml(cleanData as Record<string, unknown>),
    );

    // Index has 1 entry, but 2 YAML files exist — staleness detected
    const suspended = await repo.findSummariesByStatus(
      workflow.id,
      "suspended",
    );
    assertEquals(suspended.length, 1);
    assertEquals(suspended[0].id, run2.id);
  });
});

Deno.test("findSummariesByStatus: an aborted signal stops a rebuild before it writes the index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await saveRunningRuns(repo, workflow, 3);
    // An index of another schema version: the next read rebuilds it whole.
    const stale = JSON.stringify({ version: 0, entries: {} });
    await Deno.writeTextFile(getIndexPath(indexDir), stale);

    // Aborted while the rebuild reads its first record.
    const abort = new AbortController();
    const original = Deno.readTextFile;
    let recordReads = 0;
    Deno.readTextFile = ((...args: Parameters<typeof original>) => {
      if (/workflow-run-[^/\\]*\.yaml$/.test(String(args[0]))) {
        recordReads++;
        abort.abort(new DOMException("shutting down", "AbortError"));
      }
      return original(...args);
    }) as typeof original;
    try {
      await assertRejects(
        () =>
          repo.findSummariesByStatus(workflow.id, "suspended", abort.signal),
        DOMException,
        "shutting down",
      );
    } finally {
      Deno.readTextFile = original;
    }
    // It stopped before the next record, and wrote nothing.
    assertEquals(recordReads, 1);
    assertEquals(await Deno.readTextFile(getIndexPath(indexDir)), stale);

    // Without the signal the same read rebuilds it.
    assertEquals(
      (await repo.findSummariesByStatus(workflow.id, "running")).length,
      3,
    );
  });
});

Deno.test("findSummariesByStatus: an aborted signal stops a repair before it writes the index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const [, unlisted] = await saveRunningRuns(repo, workflow, 2);
    await dropIndexEntries(indexDir, [unlisted.id]);
    const before = await Deno.readTextFile(getIndexPath(indexDir));

    const abort = new AbortController();
    abort.abort(new DOMException("shutting down", "AbortError"));
    await assertRejects(
      () => repo.findSummariesByStatus(workflow.id, "running", abort.signal),
      DOMException,
    );
    assertEquals(await Deno.readTextFile(getIndexPath(indexDir)), before);
  });
});

Deno.test("index: corrupt JSON triggers rebuild on read", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    // Corrupt the index
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.writeTextFile(getIndexPath(runsDir), "{{corrupt}}");

    // Should fall back to YAML scan
    const summaries = await repo.findAllSummariesFromIndex(workflow.id);
    assertEquals(summaries.length, 1);
    assertEquals(summaries[0].status, "running");
  });
});

Deno.test("findLatestByWorkflowId: uses index without loading all runs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    await new Promise((r) => setTimeout(r, 10));

    const run2 = WorkflowRun.create(workflow);
    run2.start();
    await repo.save(workflow.id, run2);

    // Index exists from save — findLatestByWorkflowId should use it
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const index = await readRunIndex(runsDir);
    assertNotEquals(index, null);
    assertEquals(Object.keys(index!).length, 2);

    const latest = await repo.findLatestByWorkflowId(workflow.id);
    assertNotEquals(latest, null);
    assertEquals(latest!.id, run2.id);
  });
});

Deno.test("findLatestByWorkflowId: falls back to summary scan when index missing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    await new Promise((r) => setTimeout(r, 10));

    const run2 = WorkflowRun.create(workflow);
    run2.start();
    await repo.save(workflow.id, run2);

    // Delete the index to force fallback to summary scan
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.remove(getIndexPath(runsDir));
    const index = await readRunIndex(runsDir);
    assertEquals(index, null);

    const latest = await repo.findLatestByWorkflowId(workflow.id);
    assertNotEquals(latest, null);
    assertEquals(latest!.id, run2.id);
  });
});

Deno.test("findGlobalByStatus: returns only runs matching the target status", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const running = WorkflowRun.create(workflow);
    running.start();
    await repo.save(workflow.id, running);

    const succeeded = WorkflowRun.create(workflow);
    succeeded.start();
    const jobRun = succeeded.getJob("job1");
    jobRun?.start();
    jobRun?.getStep("step1")?.start();
    jobRun?.getStep("step1")?.succeed({ result: "ok" });
    jobRun?.succeed();
    succeeded.complete();
    await repo.save(workflow.id, succeeded);

    const found = await repo.findGlobalByStatus("running");
    assertEquals(found.length, 1);
    assertEquals(found[0].run.id, running.id);
    assertEquals(found[0].run.status, "running");
  });
});

Deno.test("findGlobalByStatus: accepts array of statuses", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const running = WorkflowRun.create(workflow);
    running.start();
    await repo.save(workflow.id, running);

    const succeeded = WorkflowRun.create(workflow);
    succeeded.start();
    const jobRun = succeeded.getJob("job1");
    jobRun?.start();
    jobRun?.getStep("step1")?.start();
    jobRun?.getStep("step1")?.succeed({ result: "ok" });
    jobRun?.succeed();
    succeeded.complete();
    await repo.save(workflow.id, succeeded);

    const found = await repo.findGlobalByStatus(["running", "succeeded"]);
    assertEquals(found.length, 2);
    const statuses = new Set(found.map((f) => f.run.status));
    assert(statuses.has("running"));
    assert(statuses.has("succeeded"));
  });
});

Deno.test("findGlobalByStatus: respects since cutoff", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const old = WorkflowRun.create(workflow);
    old.start();
    await repo.save(workflow.id, old);

    // Patch the YAML so startedAt is 7 days ago, then delete the index
    // so it rebuilds from the patched YAML on the next read.
    const oldPath = repo.getPath(workflow.id, old.id);
    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const content = await Deno.readTextFile(oldPath);
    const patched = content.replace(
      /startedAt: .*/,
      `startedAt: "${oldDate.toISOString()}"`,
    );
    await Deno.writeTextFile(oldPath, patched);
    const indexPath = getIndexPath(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    await Deno.remove(indexPath);

    const fresh = WorkflowRun.create(workflow);
    fresh.start();
    await repo.save(workflow.id, fresh);

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const found = await repo.findGlobalByStatus("running", cutoff);
    assertEquals(found.length, 1);
    assertEquals(found[0].run.id, fresh.id);
  });
});

Deno.test("findGlobalByStatus: returns empty when no runs match", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const succeeded = WorkflowRun.create(workflow);
    succeeded.start();
    const jobRun = succeeded.getJob("job1");
    jobRun?.start();
    jobRun?.getStep("step1")?.start();
    jobRun?.getStep("step1")?.succeed({ result: "ok" });
    jobRun?.succeed();
    succeeded.complete();
    await repo.save(workflow.id, succeeded);

    const found = await repo.findGlobalByStatus("running");
    assertEquals(found.length, 0);
  });
});

Deno.test("findGlobalByStatus: works across multiple workflows", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const wf1 = createTestWorkflow();
    const wf2Id = createWorkflowId(crypto.randomUUID());

    const run1 = WorkflowRun.create(wf1);
    run1.start();
    await repo.save(wf1.id, run1);

    const run2 = WorkflowRun.create(wf1);
    run2.start();
    await repo.save(wf2Id, run2);

    const found = await repo.findGlobalByStatus("running");
    assertEquals(found.length, 2);
    const workflowIds = new Set(found.map((f) => f.workflowId));
    assert(workflowIds.has(wf1.id));
    assert(workflowIds.has(wf2Id));
  });
});

Deno.test("findGlobalByStatus: returns empty for nonexistent base dir", async () => {
  const repo = new YamlWorkflowRunRepository(
    "/tmp/does-not-exist-" + crypto.randomUUID(),
  );
  const found = await repo.findGlobalByStatus("running");
  assertEquals(found.length, 0);
});

Deno.test("save: index is written to local path, not cache baseDir", async () => {
  await withTempDir(async (dir) => {
    const cacheDir = await Deno.makeTempDir();
    try {
      const repo = new YamlWorkflowRunRepository(dir, undefined, cacheDir);
      const workflow = createTestWorkflow();
      const run = WorkflowRun.create(workflow);
      run.start();
      await repo.save(workflow.id, run);

      // Index must be under the repo-local .swamp/ path
      const localIndexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
      const localIndex = await readRunIndex(localIndexDir);
      assertNotEquals(localIndex, null, "index must exist under local .swamp/");
      assertEquals(localIndex!.entries[run.id]?.status, "running");

      // Index must NOT be in the cache baseDir (would pollute sync)
      const cacheIndex = await readRunIndex(join(cacheDir, workflow.id));
      assertEquals(cacheIndex, null, "index must not exist in cache baseDir");
    } finally {
      await Deno.remove(cacheDir, { recursive: true });
    }
  });
});

const WORKFLOW_A_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_B_ID = "22222222-2222-4222-8222-222222222222";

function createWorkflowWithId(id: string, name: string): Workflow {
  return Workflow.create({
    id,
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

Deno.test("YamlWorkflowRunRepository.findGlobalById: finds a run owned by another workflow directory", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflowA = createWorkflowWithId(WORKFLOW_A_ID, "workflow-a");
    const workflowB = createWorkflowWithId(WORKFLOW_B_ID, "workflow-b");

    for (let i = 0; i < 3; i++) {
      const other = WorkflowRun.create(workflowA);
      other.start();
      await repo.save(workflowA.id, other);
    }
    const target = WorkflowRun.create(workflowB);
    target.start();
    await repo.save(workflowB.id, target);

    const found = await repo.findGlobalById(target.id);

    assertNotEquals(found, null);
    assertEquals(found!.run.id, target.id);
    assertEquals(found!.workflowId, workflowB.id);
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalById: returns the same aggregate as findById", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    run.setLogFile(join(dir, ".swamp", "logs", "run.log"));
    await repo.save(workflow.id, run);

    const viaGlobal = await repo.findGlobalById(run.id);
    const viaDirect = await repo.findById(workflow.id, run.id);

    assertNotEquals(viaGlobal, null);
    assertEquals(viaGlobal!.run.id, viaDirect!.id);
    assertEquals(viaGlobal!.run.status, viaDirect!.status);
    // logFile must come back absolute, exactly as the scan path returns it —
    // `workflow history logs` reads run.logFile directly.
    assertEquals(viaGlobal!.run.logFile, viaDirect!.logFile);
    assert(isAbsolute(viaGlobal!.run.logFile!));
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalById: returns null for an unknown run id", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    assertEquals(await repo.findGlobalById(repo.nextId()), null);
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalById: returns null for an id that is not a UUID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const runsDir = dirname(repo.getPath(workflow.id, run.id));
    await Deno.writeTextFile(join(runsDir, "x.yaml"), "{");

    for (const id of ["-", "../../x", run.id.slice(0, 8)]) {
      assertEquals(await repo.findGlobalById(createWorkflowRunId(id)), null);
    }
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalById: returns null when the base directory is absent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    assertEquals(await repo.findGlobalById(repo.nextId()), null);
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalById: keeps scanning when a directory's file holds a different run", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflowA = createWorkflowWithId(WORKFLOW_A_ID, "workflow-a");
    const workflowB = createWorkflowWithId(WORKFLOW_B_ID, "workflow-b");

    const target = WorkflowRun.create(workflowB);
    target.start();
    await repo.save(workflowB.id, target);

    // A file at the target's exact path in another workflow directory, holding
    // a different run. findById returns null for it, so the scan must continue
    // to the directory that really owns the run rather than give up — the same
    // branch a run deleted between stat and read takes.
    const decoyRun = WorkflowRun.create(workflowA);
    const decoyPath = repo.getPath(workflowA.id, target.id);
    await ensureDir(dirname(decoyPath));
    await Deno.writeTextFile(
      decoyPath,
      stringifyYaml(JSON.parse(JSON.stringify(decoyRun.toData()))),
    );

    const found = await repo.findGlobalById(target.id);

    assertNotEquals(found, null);
    assertEquals(found!.run.id, target.id);
    assertEquals(found!.workflowId, workflowB.id);
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalById: returns null when the discovered file no longer holds the run", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    // The single-directory form of the concurrent-delete race: the stat finds
    // a file, the read does not find the run in it, and nothing else owns it.
    await Deno.writeTextFile(
      repo.getPath(workflow.id, run.id),
      stringifyYaml(
        JSON.parse(JSON.stringify(WorkflowRun.create(workflow).toData())),
      ),
    );

    assertEquals(await repo.findGlobalById(run.id), null);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: reports the IDs of the runs it deletes, including on a dry run", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const finished = WorkflowRun.create(workflow);
    finished.start();
    finished.endAsCancelled("test");
    await repo.save(workflow.id, finished);
    const running = WorkflowRun.create(workflow);
    running.start();
    await repo.save(workflow.id, running);
    // An unparseable (empty) run file is deleted too; its ID comes from the
    // filename.
    const emptyId = crypto.randomUUID();
    await Deno.writeTextFile(
      join(
        dir,
        ".swamp",
        "workflow-runs",
        workflow.id,
        `workflow-run-${emptyId}.yaml`,
      ),
      "",
    );
    const cutoff = new Date(Date.now() + 60_000);

    const preview = await repo.deleteOlderThan(cutoff, { dryRun: true });
    assertEquals(preview.deletedRunIds.sort(), [finished.id, emptyId].sort());
    assertEquals((await repo.listRunIds()).size, 3);

    const result = await repo.deleteOlderThan(cutoff);
    assertEquals(result.deletedRunIds.sort(), [finished.id, emptyId].sort());
    assertEquals(await repo.listRunIds(), new Set([running.id]));
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: deletes every collectable run in one call, beside a run it keeps", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const running = WorkflowRun.create(workflow);
    running.start();
    await repo.save(workflow.id, running);
    // Each delete is followed by an attempt to remove the still non-empty
    // runs directory; on macOS a walk of that directory open at the time
    // skipped entries (swamp-club#3535).
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const collectable: string[] = [];
    for (let i = 0; i < 220; i++) {
      const id = crypto.randomUUID();
      collectable.push(id);
      await Deno.writeTextFile(join(runsDir, `workflow-run-${id}.yaml`), "");
    }

    const result = await repo.deleteOlderThan(new Date(Date.now() + 60_000));

    assertEquals(result.deletedRunIds.sort(), collectable.sort());
    assertEquals(await repo.listRunIds(), new Set([running.id]));
  });
});

Deno.test("YamlWorkflowRunRepository.listRunIds: lists run IDs across workflows and ignores other files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    assertEquals(await repo.listRunIds(), new Set());

    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const otherWorkflowId = createWorkflowId(crypto.randomUUID());
    const otherRunId = crypto.randomUUID();
    const otherDir = join(dir, ".swamp", "workflow-runs", otherWorkflowId);
    await ensureDir(otherDir);
    await Deno.writeTextFile(
      join(otherDir, `workflow-run-${otherRunId}.yaml`),
      "",
    );
    await Deno.writeTextFile(
      join(otherDir, `workflow-run-${otherRunId}.log`),
      "",
    );

    assertEquals(await repo.listRunIds(), new Set([run.id, otherRunId]));
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: never reports a run ID that is not one path segment", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    for (const badId of ["", "..", "a/b"]) {
      const run = WorkflowRun.create(workflow);
      run.start();
      run.endAsCancelled("test");
      await repo.save(workflow.id, run);
      // Rewrite the persisted ID as a tampered or corrupt record would.
      const path = repo.getPath(workflow.id, run.id);
      const content = await Deno.readTextFile(path);
      await Deno.writeTextFile(
        path,
        content.replace(`id: ${run.id}`, `id: ${JSON.stringify(badId)}`),
      );
    }
    // Empty (unparseable) files whose filename yields "." or "..".
    await Deno.writeTextFile(join(runsDir, "workflow-run-..yaml"), "");
    await Deno.writeTextFile(join(runsDir, "workflow-run-...yaml"), "");

    const result = await repo.deleteOlderThan(new Date(Date.now() + 60_000));

    assertEquals(result.deleted, 5);
    // The filename fallback yields the real run IDs for the three tampered
    // records; the two dot names are dropped.
    assertEquals(result.deletedRunIds.length, 3);
    assertEquals(result.deletedRunIds.includes(""), false);
    assertEquals(result.deletedRunIds.includes(".."), false);
    assertEquals(result.deletedRunIds.includes("."), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: reports the deleted file's run ID, not the ID in its body", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const finished = WorkflowRun.create(workflow);
    finished.start();
    finished.endAsCancelled("test");
    await repo.save(workflow.id, finished);
    // The body names another, live run.
    const liveRunId = crypto.randomUUID();
    const path = repo.getPath(workflow.id, finished.id);
    const content = await Deno.readTextFile(path);
    await Deno.writeTextFile(
      path,
      content.replace(`id: ${finished.id}`, `id: ${liveRunId}`),
    );

    const result = await repo.deleteOlderThan(new Date(Date.now() + 60_000));

    assertEquals(result.deletedRunIds, [finished.id]);
  });
});

Deno.test("YamlWorkflowRunRepository.listRunIdsForWorkflow: lists one workflow's run IDs from filenames, including empty files", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    assertEquals(await repo.listRunIdsForWorkflow(workflow.id), []);

    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const emptyId = crypto.randomUUID();
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.writeTextFile(join(runsDir, `workflow-run-${emptyId}.yaml`), "");
    await Deno.writeTextFile(join(runsDir, "workflow-run-..yaml"), "");
    // Another workflow's run is not included.
    const otherDir = join(dir, ".swamp", "workflow-runs", crypto.randomUUID());
    await ensureDir(otherDir);
    await Deno.writeTextFile(
      join(otherDir, `workflow-run-${crypto.randomUUID()}.yaml`),
      "",
    );

    assertEquals(
      (await repo.listRunIdsForWorkflow(workflow.id)).sort(),
      [run.id, emptyId].sort(),
    );
  });
});

Deno.test("YamlWorkflowRunRepository.listWorkflowIds: lists every runs directory without reading a run file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    assertEquals(await repo.listWorkflowIds(), []);

    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    // A directory no definition owns, holding a file that is not a run.
    const otherId = crypto.randomUUID();
    const otherDir = join(dir, ".swamp", "workflow-runs", otherId);
    await ensureDir(otherDir);
    await Deno.writeTextFile(
      join(otherDir, `workflow-run-${crypto.randomUUID()}.yaml`),
      "id: x\njobs: [\n",
    );
    // A stray file beside the directories is not a workflow.
    await Deno.writeTextFile(
      join(dir, ".swamp", "workflow-runs", "notes.txt"),
      "",
    );

    assertEquals(
      (await repo.listWorkflowIds()).map(String).sort(),
      [workflow.id as string, otherId].sort(),
    );
  });
});

Deno.test("YamlWorkflowRunRepository.save: stages a write of the run file", async () => {
  await withTempDir(async (dir) => {
    const { markDirty, marks, uow } = recordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    const path = repo.getPath(workflow.id, run.id);

    await runInUnitOfWork(uow, () => repo.save(workflow.id, run));

    assertEquals(uow.staged(), [{ kind: "write", path }]);
    assertEquals(marks, [path]);
    assertEquals(await pathExists(path), true);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteAllByWorkflowId: stages a remove of the runs directory", async () => {
  await withTempDir(async (dir) => {
    const workflow = createTestWorkflow();
    const seed = new YamlWorkflowRunRepository(dir);
    const run = WorkflowRun.create(workflow);
    run.start();
    await seed.save(workflow.id, run);
    const runsDir = dirname(seed.getPath(workflow.id, run.id));
    const { markDirty, marks, uow } = recordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );

    await runInUnitOfWork(uow, () => repo.deleteAllByWorkflowId(workflow.id));

    assertEquals(uow.staged(), [{ kind: "remove", path: runsDir }]);
    assertEquals(marks, [runsDir]);
    assertEquals(await pathExists(runsDir), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: stages a remove of each terminal run file it deletes", async () => {
  await withTempDir(async (dir) => {
    const workflow = createTestWorkflow();
    const seed = new YamlWorkflowRunRepository(dir);
    const finished = WorkflowRun.create(workflow);
    finished.start();
    finished.endAsCancelled("test");
    await seed.save(workflow.id, finished);
    const path = seed.getPath(workflow.id, finished.id);
    const { markDirty, marks, uow } = recordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );

    const result = await runInUnitOfWork(
      uow,
      () => repo.deleteOlderThan(new Date(Date.now() + 60_000)),
    );

    assertEquals(result.deletedRunIds, [finished.id]);
    assertEquals(uow.staged(), [{ kind: "remove", path }]);
    assertEquals(marks, [path]);
    assertEquals(await pathExists(path), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: stages a remove of each unparseable run file it deletes", async () => {
  await withTempDir(async (dir) => {
    const workflow = createTestWorkflow();
    const seed = new YamlWorkflowRunRepository(dir);
    const runId = crypto.randomUUID();
    const path = join(
      dirname(seed.getPath(workflow.id, seed.nextId())),
      `workflow-run-${runId}.yaml`,
    );
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, "");
    const { markDirty, marks, uow } = recordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );

    const result = await runInUnitOfWork(
      uow,
      () => repo.deleteOlderThan(new Date(Date.now() + 60_000)),
    );

    assertEquals(result.deletedRunIds, [runId]);
    assertEquals(uow.staged(), [{ kind: "remove", path }]);
    assertEquals(marks, [path]);
    assertEquals(await pathExists(path), false);
  });
});

/** Each typed change's op kind, key and intent kind, for comparison. */
function typedShape(change: TypedChange): Record<string, unknown> {
  if ("put" in change) {
    return {
      partition: change.partition.toString(),
      put: change.put.key.toString(),
      intent: change.put.intent.kind,
      expect: change.put.expect,
    };
  }
  const op = change.op;
  return op.kind === "tombstone"
    ? {
      partition: change.partition.toString(),
      tombstone: op.key.toString(),
      intent: op.intent.kind,
      expect: op.expect,
    }
    : { op: op.kind };
}

async function contentOf(change: TypedChange): Promise<string> {
  assert("put" in change);
  const content = change.put.content;
  const bytes = content instanceof Uint8Array
    ? content
    : new Uint8Array(await new Response(await content()).arrayBuffer());
  return new TextDecoder().decode(bytes);
}

Deno.test("YamlWorkflowRunRepository.save: on v3, stages run.create then run.update streams of the written record, with no precondition (swamp-club#3257)", async () => {
  await withTempDir(async (dir) => {
    const { markDirty, uow, batches, staged } = typedRecordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    const key = `workflow-runs/${workflow.id}/workflow-run-${run.id}.yaml`;
    const partition = `run--${workflow.id}--${run.id}`;

    await runInUnitOfWork(uow, async () => {
      await repo.save(workflow.id, run);
      run.start();
      await repo.save(workflow.id, run);
    });

    assertEquals(staged, []);
    assertEquals(batches.map((batch) => batch.map(typedShape)), [
      [{ partition, put: key, intent: "run.create", expect: undefined }],
      [{ partition, put: key, intent: "run.update", expect: undefined }],
    ]);
    // The content is a stream of the file, read when the unit commits: the
    // record as the last save left it.
    for (const [change] of batches) {
      assert(!("put" in change && change.put.content instanceof Uint8Array));
      assertEquals(
        await contentOf(change),
        await Deno.readTextFile(repo.getPath(workflow.id, run.id)),
      );
    }
  });
});

Deno.test("YamlWorkflowRunRepository.deleteAllByWorkflowId: on v3, stages one run.delete tombstone per run, each its own batch (swamp-club#3257)", async () => {
  await withTempDir(async (dir) => {
    const workflow = createTestWorkflow();
    const seed = new YamlWorkflowRunRepository(dir);
    const runs = [WorkflowRun.create(workflow), WorkflowRun.create(workflow)];
    for (const run of runs) await seed.save(workflow.id, run);
    const { markDirty, uow, batches, staged } = typedRecordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );

    await runInUnitOfWork(uow, () => repo.deleteAllByWorkflowId(workflow.id));

    assertEquals(staged, []);
    assertEquals(
      batches.map((batch) => batch.map(typedShape)),
      runs.map((run) => run.id).sort().map((runId) => [{
        partition: `run--${workflow.id}--${runId}`,
        tombstone: `workflow-runs/${workflow.id}/workflow-run-${runId}.yaml`,
        intent: "run.delete",
        expect: undefined,
      }]),
    );
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: on v3, tombstones each removed record, terminal or unparseable, and stages nothing for a stray or a dry run (swamp-club#3257)", async () => {
  await withTempDir(async (dir) => {
    const workflow = createTestWorkflow();
    const seed = new YamlWorkflowRunRepository(dir);
    const finished = WorkflowRun.create(workflow);
    finished.start();
    finished.endAsCancelled("test");
    await seed.save(workflow.id, finished);
    const runsDir = dirname(seed.getPath(workflow.id, finished.id));
    const unparseable = crypto.randomUUID();
    await Deno.writeTextFile(
      join(runsDir, `workflow-run-${unparseable}.yaml`),
      "",
    );
    // A stray file whose name holds no UUID: no repository put it.
    await Deno.writeTextFile(join(runsDir, "workflow-run-stray.yaml"), "");
    const cutoff = new Date(Date.now() + 60_000);

    const dry = typedRecordingUnitOfWork();
    const dryRepo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      dry.markDirty,
    );
    await runInUnitOfWork(
      dry.uow,
      () => dryRepo.deleteOlderThan(cutoff, { dryRun: true }),
    );
    assertEquals(dry.batches, []);

    const { markDirty, uow, batches } = typedRecordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );
    const result = await runInUnitOfWork(
      uow,
      () => repo.deleteOlderThan(cutoff),
    );

    assertEquals(result.deleted, 3);
    const tombstoned = batches.flat().map(typedShape);
    assertEquals(
      tombstoned.sort((a, b) =>
        String(a.tombstone).localeCompare(String(b.tombstone))
      ),
      [finished.id, unparseable].sort().map((runId) => ({
        partition: `run--${workflow.id}--${runId}`,
        tombstone: `workflow-runs/${workflow.id}/workflow-run-${runId}.yaml`,
        intent: "run.delete",
        expect: undefined,
      })),
    );
  });
});

Deno.test("save: concurrent saves of different runs of one workflow keep every index entry (swamp-club#2518)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs: WorkflowRun[] = [];
    for (let i = 0; i < 6; i++) {
      const run = WorkflowRun.create(workflow);
      run.start();
      await repo.save(workflow.id, run);
      runs.push(run);
    }

    await Promise.all(runs.map((run) => {
      run.interruptOrphaned("test");
      return repo.save(workflow.id, run);
    }));

    const index = await readRunIndex(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    for (const run of runs) {
      assertEquals(index?.entries[run.id]?.status, "interrupted");
    }
    const running = await repo.findGlobalByStatus("running");
    assertEquals(running.length, 0);
  });
});

/** Puts a run's record back to `content` without a save, as a pull does. */
async function replaceRecord(
  repo: YamlWorkflowRunRepository,
  workflowId: WorkflowId,
  run: WorkflowRun,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(repo.getPath(workflowId, run.id), content);
}

Deno.test("findGlobalById: repairs an index entry that disagrees with the record", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const runningRecord = await Deno.readTextFile(
      repo.getPath(workflow.id, run.id),
    );
    run.interruptOrphaned("test");
    await repo.save(workflow.id, run);
    await replaceRecord(repo, workflow.id, run, runningRecord);
    assertEquals((await repo.findGlobalByStatus("running")).length, 0);

    const found = await repo.findGlobalById(run.id);

    assertEquals(found?.run.status, "running");
    const running = await repo.findGlobalByStatus("running");
    assertEquals(running.map((r) => r.run.id), [run.id]);
  });
});

Deno.test("findGlobalByStatus: repairs an entry the index lists under a status its record left", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const staleIndex = await Deno.readTextFile(getIndexPath(indexDir));
    run.interruptOrphaned("test");
    await repo.save(workflow.id, run);
    await Deno.writeTextFile(getIndexPath(indexDir), staleIndex);

    assertEquals((await repo.findGlobalByStatus("running")).length, 0);

    const index = await readRunIndex(indexDir);
    assertEquals(index?.entries[run.id]?.status, "interrupted");
  });
});

Deno.test("findGlobalById: returns the run when its index cannot be repaired", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.writeTextFile(getIndexPath(indexDir), "{ not json");

    const found = await repo.findGlobalById(run.id);

    assertEquals(found?.run.id, run.id);
  });
});

Deno.test("verifyIndexes: corrects entries of records replaced without a save", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const runningRecord = await Deno.readTextFile(
      repo.getPath(workflow.id, run.id),
    );
    run.interruptOrphaned("test");
    await repo.save(workflow.id, run);
    await replaceRecord(repo, workflow.id, run, runningRecord);

    await repo.verifyIndexes();

    const running = await repo.findGlobalByStatus("running");
    assertEquals(running.map((r) => r.run.id), [run.id]);
  });
});

Deno.test("verifyIndexes: does nothing when no run was ever saved", async () => {
  await withTempDir(async (dir) => {
    await new YamlWorkflowRunRepository(dir).verifyIndexes();
  });
});

Deno.test("verifyIndexes: keeps the entry of a run saved while it verifies", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs: WorkflowRun[] = [];
    for (let i = 0; i < 4; i++) {
      const run = WorkflowRun.create(workflow);
      run.start();
      await repo.save(workflow.id, run);
      runs.push(run);
    }

    runs[0].interruptOrphaned("test");
    await Promise.all([
      repo.verifyIndexes(),
      repo.save(workflow.id, runs[0]),
    ]);

    const index = await readRunIndex(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    assertEquals(index?.entries[runs[0].id]?.status, "interrupted");
    assertEquals(Object.keys(index?.entries ?? {}).length, 4);
  });
});

Deno.test("findGlobalById: a read racing a save never leaves the index behind the record (swamp-club#2518)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    for (let round = 0; round < 20; round++) {
      const run = WorkflowRun.create(workflow);
      run.start();
      await repo.save(workflow.id, run);

      run.interruptOrphaned("test");
      await Promise.all([
        repo.findGlobalById(run.id),
        repo.save(workflow.id, run),
        repo.findGlobalById(run.id),
      ]);

      const index = await readRunIndex(indexDir);
      assertEquals(index?.entries[run.id]?.status, "interrupted");
    }
  });
});

Deno.test("verifyIndexes: a workflow with an unreadable record does not stop the others", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const broken = createTestWorkflow();
    const brokenDir = join(dir, ".swamp", "workflow-runs", broken.id);
    await ensureDir(brokenDir);
    await Deno.writeTextFile(
      join(brokenDir, `workflow-run-${crypto.randomUUID()}.yaml`),
      "status: [unclosed",
    );
    const otherId = createWorkflowId(crypto.randomUUID());
    const run = WorkflowRun.create(createTestWorkflow());
    run.start();
    await repo.save(otherId, run);
    const runningRecord = await Deno.readTextFile(
      repo.getPath(otherId, run.id),
    );
    run.interruptOrphaned("test");
    await repo.save(otherId, run);
    await replaceRecord(repo, otherId, run, runningRecord);

    await repo.verifyIndexes();

    const index = await readRunIndex(
      join(dir, ".swamp", "workflow-runs", otherId),
    );
    assertEquals(index?.entries[run.id]?.status, "running");
  });
});

/** Saves `count` running runs of one workflow and returns them. */
async function saveRunningRuns(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
  count: number,
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  for (let i = 0; i < count; i++) {
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    runs.push(run);
  }
  return runs;
}

Deno.test("verifyIndexes: writes no index whose entries all match their records (swamp-club#3051)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    await saveRunningRuns(repo, workflow, 3);
    const indexPath = getIndexPath(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    const past = new Date("2020-01-01T00:00:00Z");
    await Deno.utime(indexPath, past, past);
    const before = await Deno.readTextFile(indexPath);

    await repo.verifyIndexes();

    assertEquals(
      (await Deno.stat(indexPath)).mtime?.getTime(),
      past.getTime(),
    );
    assertEquals(await Deno.readTextFile(indexPath), before);
  });
});

Deno.test("verifyIndexes: reads and fingerprints entries written without a fingerprint", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = await saveRunningRuns(repo, workflow, 2);
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const legacy = await readRunIndex(indexDir);
    for (const entry of Object.values(legacy?.entries ?? {})) {
      delete entry.record;
    }
    await Deno.writeTextFile(
      getIndexPath(indexDir),
      JSON.stringify({ version: legacy?.version, entries: legacy?.entries }),
    );

    await repo.verifyIndexes();

    const index = await readRunIndex(indexDir);
    for (const run of runs) {
      assertEquals(index?.entries[run.id]?.status, "running");
      assert(index?.entries[run.id]?.record, "entry has a fingerprint");
    }
  });
});

Deno.test("verifyIndexes: treats a malformed fingerprint as none", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const [run] = await saveRunningRuns(repo, workflow, 1);
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const index = await readRunIndex(indexDir);
    const entries = index?.entries ?? {};
    entries[run.id] = {
      ...entries[run.id],
      status: "succeeded",
      record: "junk" as unknown as typeof entries[string]["record"],
    };
    await Deno.writeTextFile(
      getIndexPath(indexDir),
      JSON.stringify({ version: index?.version, entries }),
    );

    await repo.verifyIndexes();

    const verified = await readRunIndex(indexDir);
    assertEquals(verified?.entries[run.id]?.status, "running");
  });
});

Deno.test("verifyIndexes: catches a record replaced with one of the same size and mtime", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const [run] = await saveRunningRuns(repo, workflow, 1);
    const path = repo.getPath(workflow.id, run.id);
    const original = await Deno.stat(path);
    // Without an inode the fingerprint is mtime and size alone (Windows).
    if (original.ino === null || original.mtime === null) return;
    const content = await Deno.readTextFile(path);
    const swapped = content.replace(/^status: running$/m, "status: pending");
    assertNotEquals(swapped, content);
    // A replacement written aside and renamed in, as a pull would, with its
    // mtime set back to the version the index saw.
    await Deno.writeTextFile(`${path}.tmp`, swapped);
    await Deno.rename(`${path}.tmp`, path);
    await Deno.utime(path, original.mtime, original.mtime);
    assertEquals((await Deno.stat(path)).size, original.size);

    await repo.verifyIndexes();

    const index = await readRunIndex(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    assertEquals(index?.entries[run.id]?.status, "pending");
  });
});

Deno.test("verifyIndexes: drops the entry of a record that is gone", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const [kept, removed] = await saveRunningRuns(repo, workflow, 2);
    await Deno.remove(repo.getPath(workflow.id, removed.id));

    await repo.verifyIndexes();

    const index = await readRunIndex(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    assertEquals(Object.keys(index?.entries ?? {}), [kept.id]);
  });
});

Deno.test("verifyIndexes: keeps the entry a save writes while a replaced record is being verified", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    for (let round = 0; round < 10; round++) {
      const [run] = await saveRunningRuns(repo, workflow, 1);
      const runningRecord = await Deno.readTextFile(
        repo.getPath(workflow.id, run.id),
      );
      run.complete();
      await repo.save(workflow.id, run);
      await replaceRecord(repo, workflow.id, run, runningRecord);

      // The same run saved again while the record behind the index is read.
      await Promise.all([
        repo.verifyIndexes(),
        repo.save(workflow.id, run),
      ]);

      const index = await readRunIndex(
        join(dir, ".swamp", "workflow-runs", workflow.id),
      );
      assertEquals(index?.entries[run.id]?.status, "failed");
    }
  });
});

Deno.test("save: an entry is not fingerprinted against a record another writer replaced", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const [run] = await saveRunningRuns(repo, workflow, 1);
    const path = repo.getPath(workflow.id, run.id);
    const runningRecord = await Deno.readTextFile(path);
    run.complete();

    // Hold the index queue so the save's entry waits behind it, then put
    // the running version back as another writer would.
    let release!: () => void;
    const held = withIndexQueue(
      indexDir,
      () => new Promise<void>((resolve) => release = resolve),
    );
    const saving = repo.save(workflow.id, run);
    await waitFor(
      async () => (await Deno.readTextFile(path)).includes("status: failed"),
      "the save to write its record",
    );
    await Deno.writeTextFile(path, runningRecord);
    release();
    await Promise.all([held, saving]);

    assertEquals(
      (await readRunIndex(indexDir))?.entries[run.id]?.record,
      undefined,
    );
    await repo.verifyIndexes();
    assertEquals(
      (await readRunIndex(indexDir))?.entries[run.id]?.status,
      "running",
    );
  });
});

Deno.test("verifyIndexes: a record whose body names another run is not rewritten each time", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const [run] = await saveRunningRuns(repo, workflow, 1);
    // The record is stored under a file name that is not its own id.
    await Deno.rename(
      repo.getPath(workflow.id, run.id),
      join(
        dir,
        ".swamp",
        "workflow-runs",
        workflow.id,
        `workflow-run-${crypto.randomUUID()}.yaml`,
      ),
    );
    const indexPath = getIndexPath(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    await repo.verifyIndexes();
    const past = new Date("2020-01-01T00:00:00Z");
    await Deno.utime(indexPath, past, past);

    await repo.verifyIndexes();

    assertEquals((await Deno.stat(indexPath)).mtime?.getTime(), past.getTime());
    const index = await readRunIndex(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    assertEquals(Object.keys(index?.entries ?? {}), [run.id]);
  });
});

const orderedIds = [
  "11111111-1111-4111-8111-111111111111",
  "88888888-8888-4888-8888-888888888888",
  "ffffffff-ffff-4fff-8fff-ffffffffffff",
];
// Written in an order no sorted listing would return.
const unorderedIds = [orderedIds[1], orderedIds[2], orderedIds[0]];

Deno.test("YamlWorkflowRunRepository.listWorkflowIds: returns ids in name order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    for (const id of unorderedIds) {
      await ensureDir(join(dir, ".swamp", "workflow-runs", id));
    }

    assertEquals((await repo.listWorkflowIds()).map(String), orderedIds);
  });
});

Deno.test("YamlWorkflowRunRepository.listRunIdsForWorkflow: returns ids in name order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await ensureDir(runsDir);
    for (const id of unorderedIds) {
      await Deno.writeTextFile(join(runsDir, `workflow-run-${id}.yaml`), "");
    }

    assertEquals(await repo.listRunIdsForWorkflow(workflow.id), orderedIds);
  });
});

Deno.test("YamlWorkflowRunRepository.findAllByWorkflowId: runs that never started come back in id order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const run = WorkflowRun.create(workflow);
      await repo.save(workflow.id, run);
      ids.push(run.id);
    }

    assertEquals(
      (await repo.findAllByWorkflowId(workflow.id)).map((r) => r.id as string),
      [...ids].sort(),
    );
    assertEquals(
      (await repo.findAllSummariesByWorkflowId(workflow.id)).map((r) =>
        r.id as string
      ),
      [...ids].sort(),
    );
  });
});

Deno.test("YamlWorkflowRunRepository.verifyIndexes: a rebuilt index lists runs in id order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const run = WorkflowRun.create(workflow);
      await repo.save(workflow.id, run);
      ids.push(run.id);
    }
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.remove(getIndexPath(runsDir));

    await new YamlWorkflowRunRepository(dir).verifyIndexes();

    const index = await readRunIndex(runsDir);
    assertEquals(Object.keys(index!.entries), [...ids].sort());
  });
});

// Run logs are written under the repo-local .swamp/workflow-runs whichever
// datastore holds the run records (swamp-club#3266).

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

async function withRepoAndStore(
  fn: (
    repoDir: string,
    storeDir: string,
    repo: YamlWorkflowRunRepository,
  ) => Promise<void>,
  storeSubdir = "workflow-runs",
): Promise<void> {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const storeDir = join(dir, "store", storeSubdir);
    await ensureDir(repoDir);
    await ensureDir(storeDir);
    await fn(
      repoDir,
      storeDir,
      new YamlWorkflowRunRepository(repoDir, undefined, storeDir),
    );
  });
}

function localRunsDir(repoDir: string, workflowId: string): string {
  return join(repoDir, ".swamp", "workflow-runs", workflowId);
}

async function writeLocalLog(
  repoDir: string,
  workflowId: string,
  runId: string,
  content = "log line\n",
): Promise<string> {
  const path = join(
    localRunsDir(repoDir, workflowId),
    `workflow-run-${runId}.log`,
  );
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, content);
  return path;
}

async function saveFinishedRun(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const run = WorkflowRun.create(workflow);
  run.start();
  run.endAsCancelled("test");
  await repo.save(workflow.id, run);
  return run;
}

async function backdate(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await Deno.utime(path, when, when);
}

const FUTURE_CUTOFF = () => new Date(Date.now() + 60_000);

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: removes the repo-local log of a run whose record is in another datastore", async () => {
  await withRepoAndStore(async (repoDir, storeDir, repo) => {
    const workflow = createTestWorkflow();
    const run = await saveFinishedRun(repo, workflow);
    const log = await writeLocalLog(repoDir, workflow.id, run.id, "12345");
    const recordSize = (await Deno.stat(
      join(storeDir, workflow.id, `workflow-run-${run.id}.yaml`),
    )).size;

    const result = await repo.deleteOlderThan(FUTURE_CUTOFF());

    assertEquals(result.deleted, 1);
    assertEquals(result.bytesReclaimed, recordSize + 5);
    assertEquals(await pathExists(log), false);
    assertEquals(
      await pathExists(localRunsDir(repoDir, workflow.id)),
      false,
      "the emptied local workflow dir is removed",
    );
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: removes the repo-local log of an unparseable record in another datastore", async () => {
  await withRepoAndStore(async (repoDir, storeDir, repo) => {
    const workflowId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await ensureDir(join(storeDir, workflowId));
    await Deno.writeTextFile(
      join(storeDir, workflowId, `workflow-run-${runId}.yaml`),
      "",
    );
    const log = await writeLocalLog(repoDir, workflowId, runId);

    const result = await repo.deleteOlderThan(FUTURE_CUTOFF());

    assertEquals(result.deletedRunIds, [runId]);
    assertEquals(await pathExists(log), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: a dry run counts the repo-local log but keeps it", async () => {
  await withRepoAndStore(async (repoDir, storeDir, repo) => {
    const workflow = createTestWorkflow();
    const run = await saveFinishedRun(repo, workflow);
    const log = await writeLocalLog(repoDir, workflow.id, run.id, "12345");
    const recordSize = (await Deno.stat(
      join(storeDir, workflow.id, `workflow-run-${run.id}.yaml`),
    )).size;

    const result = await repo.deleteOlderThan(FUTURE_CUTOFF(), {
      dryRun: true,
    });

    assertEquals(result.bytesReclaimed, recordSize + 5);
    assertEquals(await pathExists(log), true);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: never deletes the file a record's logFile names", async () => {
  await withRepoAndStore(async (repoDir, storeDir, repo) => {
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    run.endAsCancelled("test");
    const outside = join(dirname(storeDir), "precious.log");
    await Deno.writeTextFile(outside, "keep me");
    run.setLogFile(outside);
    await repo.save(workflow.id, run);
    const log = await writeLocalLog(repoDir, workflow.id, run.id);

    await repo.deleteOlderThan(FUTURE_CUTOFF());

    assertEquals(await pathExists(outside), true);
    assertEquals(await pathExists(log), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: removes a log a datastore migration moved beside the record", async () => {
  await withRepoAndStore(async (_repoDir, storeDir, repo) => {
    const workflow = createTestWorkflow();
    const run = await saveFinishedRun(repo, workflow);
    const moved = join(storeDir, workflow.id, `workflow-run-${run.id}.log`);
    await Deno.writeTextFile(moved, "migrated");

    await repo.deleteOlderThan(FUTURE_CUTOFF());

    assertEquals(await pathExists(moved), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: keeps the repo-local log of a run it keeps", async () => {
  await withRepoAndStore(async (repoDir, _storeDir, repo) => {
    const workflow = createTestWorkflow();
    const finished = await saveFinishedRun(repo, workflow);
    const running = WorkflowRun.create(workflow);
    running.start();
    await repo.save(workflow.id, running);
    const finishedLog = await writeLocalLog(repoDir, workflow.id, finished.id);
    const runningLog = await writeLocalLog(repoDir, workflow.id, running.id);
    // Old and silent: only its record keeps it.
    await backdate(runningLog, EIGHT_DAYS_MS);

    // Cutoff in the past: the finished run is too recent to collect.
    await repo.deleteOlderThan(new Date(Date.now() - 60_000));
    assertEquals(await pathExists(finishedLog), true);
    assertEquals(await pathExists(runningLog), true);

    await repo.deleteOlderThan(FUTURE_CUTOFF());
    assertEquals(await pathExists(finishedLog), false);
    assertEquals(await pathExists(runningLog), true);
    assertEquals(await pathExists(localRunsDir(repoDir, workflow.id)), true);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: keeps the repo-local log of a finished child its unfinished parent still reads", async () => {
  await withRepoAndStore(async (repoDir, _storeDir, repo) => {
    const parentWorkflow = createWorkflowWithId(WORKFLOW_A_ID, "parent");
    const childWorkflow = createWorkflowWithId(WORKFLOW_B_ID, "child");
    const parent = WorkflowRun.create(parentWorkflow);
    parent.start();
    await repo.save(parentWorkflow.id, parent);
    const child = WorkflowRun.create(childWorkflow);
    child.recordParentRun({
      workflowId: parentWorkflow.id,
      workflowName: "parent",
      runId: parent.id,
      jobName: "job1",
      stepName: "step1",
      nestingDepth: 1,
      ancestorWorkflowNames: ["parent"],
    });
    child.start();
    child.endAsCancelled("test");
    await repo.save(childWorkflow.id, child);
    const childLog = await writeLocalLog(repoDir, childWorkflow.id, child.id);

    await repo.deleteOlderThan(FUTURE_CUTOFF());

    assertEquals(await pathExists(childLog), true);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: sweeps an old repo-local log whose record is gone", async () => {
  await withRepoAndStore(async (repoDir, _storeDir, repo) => {
    const workflowId = crypto.randomUUID();
    const orphan = await writeLocalLog(
      repoDir,
      workflowId,
      crypto.randomUUID(),
      "1234567",
    );
    await backdate(orphan, EIGHT_DAYS_MS);

    const preview = await repo.deleteOlderThan(FUTURE_CUTOFF(), {
      dryRun: true,
    });
    assertEquals(preview.deleted, 0);
    assertEquals(preview.deletedRunIds, []);
    assertEquals(preview.bytesReclaimed, 7);
    assertEquals(await pathExists(orphan), true);

    const result = await repo.deleteOlderThan(FUTURE_CUTOFF());
    assertEquals(result.deleted, 0);
    assertEquals(result.deletedRunIds, []);
    assertEquals(result.bytesReclaimed, 7);
    assertEquals(await pathExists(orphan), false);
    assertEquals(await pathExists(localRunsDir(repoDir, workflowId)), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: keeps an orphaned log newer than the cutoff or the seven-day floor", async () => {
  await withRepoAndStore(async (repoDir, _storeDir, repo) => {
    const workflowId = crypto.randomUUID();
    // A run that has written its log but not yet saved its record.
    const fresh = await writeLocalLog(repoDir, workflowId, crypto.randomUUID());
    await backdate(fresh, 60 * 60 * 1000);
    const old = await writeLocalLog(repoDir, workflowId, crypto.randomUUID());
    await backdate(old, EIGHT_DAYS_MS);

    // Past the floor but not past a cutoff further back.
    await repo.deleteOlderThan(new Date(Date.now() - 2 * EIGHT_DAYS_MS));
    assertEquals(await pathExists(old), true);

    await repo.deleteOlderThan(FUTURE_CUTOFF());
    assertEquals(await pathExists(fresh), true);
    assertEquals(await pathExists(old), false);
    assertEquals(await pathExists(localRunsDir(repoDir, workflowId)), true);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: resolves the repo-local log under a namespaced datastore", async () => {
  await withRepoAndStore(async (repoDir, _storeDir, repo) => {
    const workflow = createTestWorkflow();
    const run = await saveFinishedRun(repo, workflow);
    const log = await writeLocalLog(repoDir, workflow.id, run.id);
    const orphan = await writeLocalLog(
      repoDir,
      workflow.id,
      crypto.randomUUID(),
    );
    await backdate(orphan, EIGHT_DAYS_MS);

    await repo.deleteOlderThan(FUTURE_CUTOFF());

    assertEquals(await pathExists(log), false);
    assertEquals(await pathExists(orphan), false);
  }, join("my-namespace", "workflow-runs"));
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: removes the log and keeps other logs with the default datastore", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const finished = await saveFinishedRun(repo, workflow);
    const running = WorkflowRun.create(workflow);
    running.start();
    await repo.save(workflow.id, running);
    const finishedLog = await writeLocalLog(dir, workflow.id, finished.id);
    const runningLog = await writeLocalLog(dir, workflow.id, running.id);
    const recentOrphan = await writeLocalLog(
      dir,
      workflow.id,
      crypto.randomUUID(),
    );

    const result = await repo.deleteOlderThan(FUTURE_CUTOFF());

    assertEquals(result.deletedRunIds, [finished.id]);
    assertEquals(await pathExists(finishedLog), false);
    assertEquals(await pathExists(runningLog), true);
    assertEquals(await pathExists(recentOrphan), true);
    assertEquals(await repo.listRunIds(), new Set([running.id]));
  });
});

Deno.test("YamlWorkflowRunRepository.deleteAllByWorkflowId: removes the repo-local logs of runs in another datastore", async () => {
  await withRepoAndStore(async (repoDir, storeDir, repo) => {
    const workflowA = createWorkflowWithId(WORKFLOW_A_ID, "a");
    const workflowB = createWorkflowWithId(WORKFLOW_B_ID, "b");
    const runA = await saveFinishedRun(repo, workflowA);
    const runB = await saveFinishedRun(repo, workflowB);
    const logA = await writeLocalLog(repoDir, workflowA.id, runA.id);
    const logB = await writeLocalLog(repoDir, workflowB.id, runB.id);

    assertEquals(await repo.deleteAllByWorkflowId(workflowA.id), 1);

    assertEquals(await pathExists(logA), false);
    assertEquals(await pathExists(localRunsDir(repoDir, workflowA.id)), false);
    assertEquals(await pathExists(join(storeDir, workflowA.id)), false);
    assertEquals(await pathExists(logB), true);
  });
});

// --- Incremental index repair (swamp-club#3443, swamp-club#3407) ---

/** Rewrites a workflow's run index without the entries of `runIds`. */
async function dropIndexEntries(indexDir: string, runIds: string[]) {
  const result = await readRunIndex(indexDir);
  const entries = { ...result!.entries };
  for (const id of runIds) delete entries[id];
  await Deno.writeTextFile(
    getIndexPath(indexDir),
    JSON.stringify({ version: INDEX_SCHEMA_VERSION, entries }),
  );
}

/** Counts reads of run record files while `fn` runs. */
async function countingRecordReads<T>(
  fn: () => Promise<T>,
): Promise<[T, number]> {
  const original = Deno.readTextFile;
  let count = 0;
  Deno.readTextFile = ((...args: Parameters<typeof original>) => {
    if (/workflow-run-[^/\\]*\.yaml$/.test(String(args[0]))) count++;
    return original(...args);
  }) as typeof original;
  try {
    return [await fn(), count];
  } finally {
    Deno.readTextFile = original;
  }
}

Deno.test("getValidatedIndex: a count mismatch reads only the records the index does not list", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const runs = await saveRunningRuns(repo, workflow, 3);
    const unlisted = runs[1];
    await dropIndexEntries(indexDir, [unlisted.id]);

    const [summaries, reads] = await countingRecordReads(() =>
      repo.findAllSummariesFromIndex(workflow.id)
    );
    assertEquals(
      summaries.map((s) => s.id).sort(),
      runs.map((r) => r.id).sort(),
    );
    // The other records still match the stat their entries were built from.
    assertEquals(reads, 1);
    assertEquals(
      Object.keys((await readRunIndex(indexDir))!.entries).sort(),
      runs.map((r) => r.id).sort(),
    );
  });
});

Deno.test("getValidatedIndex: a count mismatch also corrects an entry whose record another writer replaced", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const [replaced] = await saveRunningRuns(repo, workflow, 1);
    const runningEntry = (await readRunIndex(indexDir))!.entries[replaced.id];

    // The record moves on, but the index keeps the entry it had, as when
    // another repository's save replaces a record in a shared datastore.
    replaced.interruptOrphaned("test");
    await repo.save(workflow.id, replaced);
    const result = await readRunIndex(indexDir);
    await Deno.writeTextFile(
      getIndexPath(indexDir),
      JSON.stringify({
        version: INDEX_SCHEMA_VERSION,
        entries: { ...result!.entries, [replaced.id]: runningEntry },
      }),
    );
    assertEquals(
      (await repo.findAllSummariesFromIndex(workflow.id))[0].status,
      "running",
    );

    // A new run arrives the same way, so the count is off by one.
    const [added] = await saveRunningRuns(repo, workflow, 1);
    await dropIndexEntries(indexDir, [added.id]);

    const summaries = await repo.findAllSummariesFromIndex(workflow.id);
    assertEquals(
      summaries.find((s) => s.id === replaced.id)?.status,
      "interrupted",
    );
    assert(summaries.some((s) => s.id === added.id));
  });
});

Deno.test("getValidatedIndex: a count mismatch drops the entries of records that are gone", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const [kept, gone] = await saveRunningRuns(repo, workflow, 2);
    await Deno.remove(repo.getPath(workflow.id, gone.id));

    const summaries = await repo.findAllSummariesFromIndex(workflow.id);
    assertEquals(summaries.map((s) => s.id), [kept.id]);
  });
});

Deno.test("getValidatedIndex: a reader that counted before a save's entry landed reads no record and writes no index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const indexPath = getIndexPath(indexDir);
    const [first, second] = await saveRunningRuns(repo, workflow, 2);
    const secondEntry = (await readRunIndex(indexDir))!.entries[second.id];
    await dropIndexEntries(indexDir, [second.id]);

    // Hold the queue as a save does between its record and its entry.
    const past = new Date("2020-01-01T00:00:00Z");
    let landed!: string;
    let release!: () => void;
    const held = withIndexQueue(indexDir, async () => {
      await new Promise<void>((resolve) => release = resolve);
      const result = await readRunIndex(indexDir);
      landed = JSON.stringify({
        version: INDEX_SCHEMA_VERSION,
        entries: { ...result!.entries, [second.id]: secondEntry },
      });
      await Deno.writeTextFile(indexPath, landed);
      await Deno.utime(indexPath, past, past);
    });

    const original = Deno.readTextFile;
    let indexReads = 0;
    let recordReads = 0;
    Deno.readTextFile = ((...args: Parameters<typeof original>) => {
      if (String(args[0]) === indexPath) indexReads++;
      if (/workflow-run-[^/\\]*\.yaml$/.test(String(args[0]))) recordReads++;
      return original(...args);
    }) as typeof original;
    try {
      const reading = repo.findAllSummariesFromIndex(workflow.id);
      await waitFor(
        () => Promise.resolve(indexReads > 0),
        "the reader to count against the stale index",
      );
      release();
      await held;
      const summaries = await reading;
      assertEquals(
        summaries.map((s) => s.id).sort(),
        [first.id, second.id].sort(),
      );
      // Every record still matches the stat its entry was built from.
      assertEquals(recordReads, 0);
    } finally {
      Deno.readTextFile = original;
    }
    // Nothing differed, so the reader left the save's index as it was.
    assertEquals((await Deno.stat(indexPath)).mtime?.getTime(), past.getTime());
    assertEquals(await Deno.readTextFile(indexPath), landed);
  });
});

Deno.test("getValidatedIndex: a reader that counted before a save's entry landed corrects an entry another process overwrote (swamp-club#3452)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const indexPath = getIndexPath(indexDir);
    const [finished] = await saveRunningRuns(repo, workflow, 1);
    const runningEntry = (await readRunIndex(indexDir))!.entries[finished.id];

    // A save in another process, made from the index as it was before this
    // run moved on, overwrites the run's entry with the one it had: the
    // record and entry counts still agree.
    finished.interruptOrphaned("test");
    await repo.save(workflow.id, finished);
    const result = await readRunIndex(indexDir);
    await Deno.writeTextFile(
      indexPath,
      JSON.stringify({
        version: INDEX_SCHEMA_VERSION,
        entries: { ...result!.entries, [finished.id]: runningEntry },
      }),
    );

    // A new run's record is written, and its entry is still to come.
    const [added] = await saveRunningRuns(repo, workflow, 1);
    const addedEntry = (await readRunIndex(indexDir))!.entries[added.id];
    await dropIndexEntries(indexDir, [added.id]);

    // Hold the queue as that save does between its record and its entry.
    let release!: () => void;
    const held = withIndexQueue(indexDir, async () => {
      await new Promise<void>((resolve) => release = resolve);
      const current = await readRunIndex(indexDir);
      await Deno.writeTextFile(
        indexPath,
        JSON.stringify({
          version: INDEX_SCHEMA_VERSION,
          entries: { ...current!.entries, [added.id]: addedEntry },
        }),
      );
    });

    const original = Deno.readTextFile;
    let indexReads = 0;
    Deno.readTextFile = ((...args: Parameters<typeof original>) => {
      if (String(args[0]) === indexPath) indexReads++;
      return original(...args);
    }) as typeof original;
    try {
      const reading = repo.findAllSummariesFromIndex(workflow.id);
      await waitFor(
        () => Promise.resolve(indexReads > 0),
        "the reader to count against the stale index",
      );
      release();
      await held;
      const summaries = await reading;
      assertEquals(
        summaries.find((s) => s.id === finished.id)?.status,
        "interrupted",
      );
      assert(summaries.some((s) => s.id === added.id));
    } finally {
      Deno.readTextFile = original;
    }
    const entries = (await readRunIndex(indexDir))!.entries;
    assertEquals(entries[finished.id].status, "interrupted");
    assertEquals(entries[added.id], addedEntry);
  });
});

Deno.test("runIndexSnapshot: an aborted signal stops a rebuild before it writes the index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await saveRunningRuns(repo, workflow, 3);
    // An index of another schema version: the next read rebuilds it whole.
    const stale = JSON.stringify({ version: 0, entries: {} });
    await Deno.writeTextFile(getIndexPath(indexDir), stale);

    // Aborted while the rebuild reads its first record.
    const abort = new AbortController();
    const original = Deno.readTextFile;
    let recordReads = 0;
    Deno.readTextFile = ((...args: Parameters<typeof original>) => {
      if (/workflow-run-[^/\\]*\.yaml$/.test(String(args[0]))) {
        recordReads++;
        abort.abort(new DOMException("shutting down", "AbortError"));
      }
      return original(...args);
    }) as typeof original;
    try {
      await assertRejects(
        () => repo.runIndexSnapshot(workflow.id, abort.signal),
        DOMException,
        "shutting down",
      );
    } finally {
      Deno.readTextFile = original;
    }
    // It stopped before the next record, and wrote nothing.
    assertEquals(recordReads, 1);
    assertEquals(await Deno.readTextFile(getIndexPath(indexDir)), stale);

    // Without the signal the same read rebuilds it.
    assertEquals((await repo.runIndexSnapshot(workflow.id)).size, 3);
  });
});

Deno.test("runIndexSnapshot: an aborted signal stops a repair before it writes the index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const [, unlisted] = await saveRunningRuns(repo, workflow, 2);
    await dropIndexEntries(indexDir, [unlisted.id]);
    const before = await Deno.readTextFile(getIndexPath(indexDir));

    const abort = new AbortController();
    abort.abort(new DOMException("shutting down", "AbortError"));
    await assertRejects(
      () => repo.runIndexSnapshot(workflow.id, abort.signal),
      DOMException,
    );
    assertEquals(await Deno.readTextFile(getIndexPath(indexDir)), before);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: a limit stops early with more, and the next call continues", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const finished: string[] = [];
    for (let i = 0; i < 3; i++) {
      finished.push((await saveFinishedRun(repo, workflow)).id);
    }
    const running = WorkflowRun.create(workflow);
    running.start();
    await repo.save(workflow.id, running);

    const preview = await repo.deleteOlderThan(FUTURE_CUTOFF(), {
      dryRun: true,
      limit: 2,
    });
    assertEquals(preview.deleted, 2);
    assertEquals(preview.more, true);
    assertEquals((await repo.listRunIds()).size, 4);

    const first = await repo.deleteOlderThan(FUTURE_CUTOFF(), { limit: 2 });
    assertEquals(first.deleted, 2);
    assertEquals(first.deletedRunIds.length, 2);
    assertEquals(first.more, true);
    assertEquals((await repo.listRunIds()).size, 2);
    // The index no longer lists the runs the batch deleted.
    assertEquals(
      (await repo.findAllSummariesFromIndex(workflow.id)).map((s) => s.id)
        .sort(),
      [...await repo.listRunIds()].sort(),
    );

    const second = await repo.deleteOlderThan(FUTURE_CUTOFF(), { limit: 2 });
    assertEquals(second.deleted, 1);
    assertEquals(second.more, false);
    assertEquals(
      [...first.deletedRunIds, ...second.deletedRunIds].sort(),
      finished.sort(),
    );
    assertEquals(await repo.listRunIds(), new Set([running.id]));
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: a limit equal to the collectible runs reports no more", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    await saveFinishedRun(repo, workflow);
    await saveFinishedRun(repo, workflow);

    const result = await repo.deleteOlderThan(FUTURE_CUTOFF(), { limit: 2 });

    assertEquals(result.deleted, 2);
    assertEquals(result.more, false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: without a limit deletes every collectible run and reports no more", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    for (let i = 0; i < 3; i++) await saveFinishedRun(repo, workflow);

    const result = await repo.deleteOlderThan(FUTURE_CUTOFF());

    assertEquals(result.deleted, 3);
    assertEquals(result.more, false);
    assertEquals((await repo.listRunIds()).size, 0);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: an invalid cutoff deletes nothing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const finished = WorkflowRun.create(workflow);
    finished.start();
    finished.endAsCancelled("test");
    await repo.save(workflow.id, finished);

    // A retention too long for a date gives an invalid cutoff, against
    // which every age check fails.
    const result = await repo.deleteOlderThan(new Date(Number.NaN));

    assertEquals(result.deleted, 0);
    assertEquals(await repo.listRunIds(), new Set([finished.id]));
  });
});

Deno.test("YamlWorkflowRunRepository: a run record the lookup names unreadable fails findById and findGlobalById, an absent one reads as not found (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const workflowId = createWorkflowId(crypto.randomUUID());
    const unreadableId = createWorkflowRunId(crypto.randomUUID());
    const asked: string[] = [];
    const unreadablePath = new YamlWorkflowRunRepository(dir).getPath(
      workflowId,
      unreadableId,
    );
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      undefined,
      undefined,
      (path: string) => {
        asked.push(path);
        return Promise.resolve(
          path === unreadablePath
            ? new UserError("unreadable", "datastore_v3_record_unreadable")
            : undefined,
        );
      },
    );
    // Another run of the workflow is there, so its directory is.
    const workflow = Workflow.create({
      name: "flow",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "s",
          task: StepTask.modelMethod("m", "noop", {}),
        })],
      })],
    });
    await repo.save(workflowId, WorkflowRun.create(workflow));

    await assertRejects(
      () => repo.findById(workflowId, unreadableId),
      UserError,
      "unreadable",
    );
    await assertRejects(
      () => repo.findGlobalById(unreadableId),
      UserError,
      "unreadable",
    );
    const absent = createWorkflowRunId(crypto.randomUUID());
    assertEquals(await repo.findById(workflowId, absent), null);
    assertEquals(await repo.findGlobalById(absent), null);
    assert(asked.includes(repo.getPath(workflowId, absent)));
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalById: a run whose workflow has no directory, because every run of it is unreadable, fails with its error (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const workflowId = createWorkflowId(crypto.randomUUID());
    const runId = createWorkflowRunId(crypto.randomUUID());
    const { lookup, errors } = fakeUnreadableLookup([
      new YamlWorkflowRunRepository(dir).getPath(workflowId, runId),
    ]);
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      undefined,
      undefined,
      lookup,
    );
    // Not even the runs directory exists in this checkout.
    const error = await assertRejects(() => repo.findGlobalById(runId));
    assert(error === [...errors.values()][0]);
    assertEquals(
      await repo.findGlobalById(createWorkflowRunId(crypto.randomUUID())),
      null,
    );
  });
});

Deno.test("YamlWorkflowRunRepository: listings keep their readable runs and warn once naming the unreadable ones (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const workflow = Workflow.create({
      name: "flow",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "s",
          task: StepTask.modelMethod("m", "noop", {}),
        })],
      })],
    });
    const workflowId = workflow.id as WorkflowId;
    const lostPath = new YamlWorkflowRunRepository(dir).getPath(
      workflowId,
      createWorkflowRunId(crypto.randomUUID()),
    );
    const { lookup, stats } = fakeUnreadableLookup([lostPath]);
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      undefined,
      undefined,
      lookup,
    );
    const run = WorkflowRun.create(workflow);
    await repo.save(workflowId, run);

    const warnings = await captureUnreadableWarnings(async () => {
      assertEquals(
        (await repo.findAllGlobal()).map((r) => r.run.id),
        [run.id],
      );
      // One listing query for the whole listing, not one per workflow.
      assertEquals(stats.listings, 1);
      assertEquals(
        (await repo.findAllByWorkflowId(workflowId)).map((r) => r.id),
        [run.id],
      );
      assertEquals(
        (await repo.findAllSummariesByWorkflowId(workflowId)).map((s) => s.id),
        [run.id],
      );
      assertEquals((await repo.findLatestByWorkflowId(workflowId))?.id, run.id);
      assertEquals((await repo.runIndexSnapshot(workflowId)).size, 1);
    });
    // Named once in this process, though five listings left it out.
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], lostPath);
    assertEquals(stats.listings, 5);
  });
});
