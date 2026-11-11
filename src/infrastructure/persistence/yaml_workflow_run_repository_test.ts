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
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import { SCAN_CONCURRENCY, SEARCH_SCAN_SHARE } from "./scan_permits.ts";
import {
  compactRunIndex,
  getIndexPath,
  INDEX_COMPACTION_FLOOR_BYTES,
  INDEX_SCHEMA_VERSION,
  readRunIndex,
  withIndexQueue,
  writeRunIndex,
} from "./workflow_run_index.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { UnreadableRunRecordError } from "../../domain/workflows/unreadable_run_record.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { SCHEDULED_FOR_TAG } from "../../domain/workflows/schedule_catch_up.ts";
import { StepStart } from "../../domain/workflows/step_start.ts";
import { INDEXED_INPUT_MAX_BYTES } from "../../domain/workflows/workflow_run_summary.ts";
import { RunSensitiveValues } from "../../domain/secrets/run_sensitive_values.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
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
import { createHash } from "node:crypto";
import type { PutExpect } from "../../domain/datastore_v3/op.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import {
  bindCommitLogEngine,
  type CommitLogEngine,
} from "./repo_unit_of_work.ts";
import { UserError } from "../../domain/errors.ts";
import {
  captureUnreadableWarnings,
  fakeUnreadableLookup,
} from "./unreadable_records_test_helpers.ts";
import {
  findSpan,
  isChildOf,
  type ReadableSpan,
  withCapturedSpans,
} from "../tracing/span_test_helpers.ts";

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

    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

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

    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    await new Promise((r) => setTimeout(r, 10));

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
  assertEquals(id1.length, 36);
});

Deno.test("YamlWorkflowRunRepository preserves run state", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);

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

    const run1 = WorkflowRun.create(workflow1);
    run1.start();
    await repo.save(workflow1.id, run1);

    const run2 = WorkflowRun.create(workflow2);
    run2.start();
    await repo.save(workflow2.id, run2);

    const allRuns = await repo.findAllGlobal();
    assertEquals(allRuns.length, 2);

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

    const run1 = WorkflowRun.create(workflow1);
    run1.start();
    await repo.save(workflow1.id, run1);

    await new Promise((r) => setTimeout(r, 10));

    const run2 = WorkflowRun.create(workflow2);
    run2.start();
    await repo.save(workflow2.id, run2);

    const allRuns = await repo.findAllGlobal();
    assertEquals(allRuns.length, 2);

    assertEquals(allRuns[0].run.id, run2.id);
    assertEquals(allRuns[1].run.id, run1.id);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteAllByWorkflowId deletes all runs for workflow", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const run1 = WorkflowRun.create(workflow);
    run1.start();
    await repo.save(workflow.id, run1);

    const run2 = WorkflowRun.create(workflow);
    run2.start();
    await repo.save(workflow.id, run2);

    const runsBefore = await repo.findAllByWorkflowId(workflow.id);
    assertEquals(runsBefore.length, 2);

    const deletedCount = await repo.deleteAllByWorkflowId(workflow.id);
    assertEquals(deletedCount, 2);

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

    const run1 = WorkflowRun.create(workflow1);
    run1.start();
    await repo.save(workflow1.id, run1);

    const run2 = WorkflowRun.create(workflow2);
    run2.start();
    await repo.save(workflow2.id, run2);

    await repo.deleteAllByWorkflowId(workflow1.id);

    const runs1After = await repo.findAllByWorkflowId(workflow1.id);
    assertEquals(runs1After.length, 0);

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

    await repo.save(workflow.id, run);
    const runPath = repo.getPath(workflow.id, run.id);
    assertEquals(calls, [runPath, runPath]);

    await repo.findById(workflow.id, run.id);
    await repo.findAllByWorkflowId(workflow.id);
    assertEquals(calls.length, 2);

    await repo.deleteAllByWorkflowId(workflow.id);
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    assertEquals(calls.slice(2), [runsDir, runsDir]);

    // deleteAllByWorkflowId on an empty workflow is a no-op and must not
    // notify — nothing was written or removed.
    await repo.deleteAllByWorkflowId(workflow.id);
    assertEquals(calls.length, 4);
  });
});

Deno.test("findAllGlobalSince: returns only in-window runs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();

    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const old = await saveRunStartedAt(repo, workflow.id, workflow, oldDate);
    const oldPath = repo.getPath(workflow.id, old.id);
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

      const longRunning = WorkflowRun.create(workflow);
      longRunning.start();
      await repo.save(workflow.id, longRunning);
      const path = repo.getPath(workflow.id, longRunning.id);
      const startedLongAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      // startedAt is old but mtime is bumped to now, as for a long-running
      // workflow saved recently: the mtime pre-filter passes it and the
      // startedAt check must reject it
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

      // an old run whose mtime was scrambled by a backup restore: the mtime
      // pre-filter will not skip it, the startedAt check catches it
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

      await Deno.remove(repo.getPath(workflow.id, doomed.id));

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.length, 1);
      assertEquals(found[0].run.id, keep.id);
    });
  },
);

const DAY_MS = 24 * 60 * 60 * 1000;

async function saveRunStartedAt(
  repo: YamlWorkflowRunRepository,
  workflowId: WorkflowId,
  workflow: Workflow,
  startedAt: Date,
): Promise<WorkflowRun> {
  const started = WorkflowRun.create(workflow);
  started.start();
  const run = WorkflowRun.fromData({
    ...started.toData(),
    startedAt: startedAt.toISOString(),
  });
  await repo.save(workflowId, run);
  return run;
}

async function trackScanOpens<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<{ result: T; reads: string[]; peak: number; open: number }> {
  const { readTextFile, readDir, stat } = Deno;
  const reads: string[] = [];
  let open = 0;
  let peak = 0;
  const under = (path: string | URL) => String(path).startsWith(dir);
  const opening = async <R>(run: () => Promise<R>): Promise<R> => {
    open++;
    peak = Math.max(peak, open);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await run();
    } finally {
      open--;
    }
  };
  Deno.readTextFile = ((path, options) => {
    if (!under(path)) return readTextFile(path, options);
    if (/workflow-run-[^/\\]*\.yaml$/.test(String(path))) {
      reads.push(String(path));
    }
    return opening(() => readTextFile(path, options));
  }) as typeof readTextFile;
  Deno.stat = ((path) => {
    if (!under(path)) return stat(path);
    return opening(() => stat(path));
  }) as typeof stat;
  Deno.readDir = ((path) => {
    if (!under(path)) return readDir(path);
    return (async function* () {
      open++;
      peak = Math.max(peak, open);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield* readDir(path);
      } finally {
        open--;
      }
    })();
  }) as typeof readDir;
  try {
    return { result: await fn(), reads, peak, open };
  } finally {
    Deno.readTextFile = readTextFile;
    Deno.stat = stat;
    Deno.readDir = readDir;
  }
}

Deno.test(
  "findAllGlobalSince: reads no run its index records as started before the cutoff (swamp-club#4076)",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();
      // Saved just now, so the mtime pre-filter alone would read it.
      const old = await saveRunStartedAt(
        repo,
        workflow.id,
        workflow,
        new Date(Date.now() - 2 * DAY_MS),
      );
      const fresh = WorkflowRun.create(workflow);
      fresh.start();
      await repo.save(workflow.id, fresh);

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const { result, reads } = await trackScanOpens(
        dir,
        () => repo.findAllGlobalSince(cutoff),
      );

      assertEquals(result.map((found) => found.run.id), [fresh.id]);
      assertEquals(reads, [repo.getPath(workflow.id, fresh.id)]);
      assert(!reads.includes(repo.getPath(workflow.id, old.id)));
    });
  },
);

Deno.test(
  "findAllGlobalSince: without an index in step with the records, filters by mtime and leaves the index as it was",
  async () => {
    for (const index of ["missing", "corrupt", "stale count"] as const) {
      await withTempDir(async (dir) => {
        const repo = new YamlWorkflowRunRepository(dir);
        const workflow = createTestWorkflow();
        const old = await saveRunStartedAt(
          repo,
          workflow.id,
          workflow,
          new Date(Date.now() - 2 * DAY_MS),
        );
        const oldPath = repo.getPath(workflow.id, old.id);
        const oldDate = new Date(Date.now() - 2 * DAY_MS);
        await Deno.utime(oldPath, oldDate, oldDate);
        const fresh = WorkflowRun.create(workflow);
        fresh.start();
        await repo.save(workflow.id, fresh);

        const indexPath = getIndexPath(runsDirOf(dir, workflow.id));
        if (index === "missing") await Deno.remove(indexPath);
        if (index === "corrupt") await Deno.writeTextFile(indexPath, "{");
        if (index === "stale count") {
          const other = WorkflowRun.create(workflow);
          await copyRecord(dir, workflow.id, fresh.id, other.id);
        }
        const before = await Deno.readTextFile(indexPath).catch(() => null);

        const cutoff = new Date(Date.now() - 60 * 60 * 1000);
        const { result, reads } = await trackScanOpens(
          dir,
          () => repo.findAllGlobalSince(cutoff),
        );

        const ids = result.map((found) => found.run.id);
        assert(ids.includes(fresh.id), index);
        assert(!ids.includes(old.id), index);
        assert(!reads.includes(oldPath), index);
        assertEquals(
          await Deno.readTextFile(indexPath).catch(() => null),
          before,
          index,
        );
      });
    }
  },
);

Deno.test(
  "findAllGlobalSince: finds a run file its index has no entry for, though the counts match (swamp-club#3452)",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();
      const kept = WorkflowRun.create(workflow);
      kept.start();
      await repo.save(workflow.id, kept);
      const removed = WorkflowRun.create(workflow);
      removed.start();
      await repo.save(workflow.id, removed);

      // Another process adds a run and removes one without this process's
      // index hearing of either: one entry per file still.
      const added = WorkflowRun.create(workflow);
      await copyRecord(dir, workflow.id, kept.id, added.id);
      await Deno.remove(repo.getPath(workflow.id, removed.id));
      const index = await readRunIndex(runsDirOf(dir, workflow.id));
      assertEquals(
        Object.keys(index?.entries ?? {}).sort(),
        [
          kept.id,
          removed.id,
        ].sort(),
      );

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(
        found.map((f) => f.run.id).sort(),
        [kept.id, added.id].sort(),
      );
    });
  },
);

Deno.test(
  "findAllGlobalSince: reads a run whose index entry has no startedAt, and checks its record",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();
      const run = WorkflowRun.create(workflow);
      await repo.save(workflow.id, run);
      const runsDir = runsDirOf(dir, workflow.id);
      assertEquals(
        (await readRunIndex(runsDir))?.entries[run.id].startedAt,
        undefined,
      );
      // Another process starts it; this process's index still has the
      // pending entry.
      const path = repo.getPath(workflow.id, run.id);
      const started = WorkflowRun.fromData(
        parseYaml(await Deno.readTextFile(path)) as Parameters<
          typeof WorkflowRun.fromData
        >[0],
      );
      started.start();
      await Deno.writeTextFile(
        path,
        stringifyYaml(JSON.parse(JSON.stringify(started.toData()))),
      );

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.map((f) => f.run.id), [run.id]);
    });
  },
);

Deno.test(
  "findAllGlobalSince: a run file whose name is not a UUID is filtered by mtime, never looked up in the index",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();
      const fresh = WorkflowRun.create(workflow);
      fresh.start();
      await repo.save(workflow.id, fresh);
      const runsDir = runsDirOf(dir, workflow.id);
      await Deno.copyFile(
        repo.getPath(workflow.id, fresh.id),
        join(runsDir, "workflow-run-not-a-uuid.yaml"),
      );
      const stored = (await readRunIndex(runsDir))!;
      stored.entries["not-a-uuid"] = {
        ...stored.entries[fresh.id],
        startedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
      };
      await writeRunIndex(runsDir, stored.entries);

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const { reads } = await trackScanOpens(
        dir,
        () => repo.findAllGlobalSince(cutoff),
      );

      assert(reads.includes(join(runsDir, "workflow-run-not-a-uuid.yaml")));
    });
  },
);

Deno.test(
  "findAllGlobalSince and findGlobalByStatus: return what a sequential walk returns, in its order (swamp-club#4076)",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();
      const base = Date.now();
      const tie = new Date(base - 10 * 60 * 1000);
      for (let w = 0; w < 6; w++) {
        const workflowId = createWorkflowId(crypto.randomUUID());
        for (let r = 0; r < 5; r++) {
          const startedAt = r === 0 && w < 2
            ? tie
            : new Date(base - (w * 5 + r) * 7 * 60 * 1000);
          const run = await saveRunStartedAt(
            repo,
            workflowId,
            workflow,
            startedAt,
          );
          if (r === 4) {
            run.complete();
            await repo.save(workflowId, run);
          }
        }
      }
      const cutoff = new Date(base - 90 * 60 * 1000);
      const all = await repo.findAllGlobal();
      const ids = (found: { run: WorkflowRun }[]) => found.map((f) => f.run.id);
      const startedSince = (f: { run: WorkflowRun }) =>
        (f.run.startedAt?.getTime() ?? -Infinity) >= cutoff.getTime();

      const since = all.filter(startedSince);
      assert(since.length > 0 && since.length < all.length);
      assertEquals(ids(await repo.findAllGlobalSince(cutoff)), ids(since));

      const running = all.filter((f) => f.run.status === "running");
      const runningSince = running.filter(startedSince);
      // A status scan lists each workflow's runs in its index's order, so
      // only startedAt fixes the order between runs: compare without ties.
      const untied = (found: { run: WorkflowRun }[]) =>
        found.filter((f) => f.run.startedAt?.getTime() !== tie.getTime());
      assertEquals(
        ids(untied(await repo.findGlobalByStatus("running"))),
        ids(untied(running)),
      );
      assertEquals(
        ids(untied(await repo.findGlobalByStatus("running", cutoff))),
        ids(untied(runningSince)),
      );
      assertEquals(
        (await repo.findGlobalByStatus(["running", "failed"])).length,
        all.length,
      );
    });
  },
);

Deno.test(
  "findAllGlobalSince and findGlobalByStatus: scans running at once keep at most 16 directories and files open between them (swamp-club#4076)",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();
      for (let w = 0; w < 12; w++) {
        const workflowId = createWorkflowId(crypto.randomUUID());
        for (let r = 0; r < 6; r++) {
          const run = WorkflowRun.create(workflow);
          run.start();
          await repo.save(workflowId, run);
        }
      }
      const cutoff = new Date(Date.now() - 60 * 60 * 1000);

      for (
        const scan of [
          () => repo.findAllGlobalSince(cutoff),
          () => repo.findGlobalByStatus("running"),
        ]
      ) {
        const alone = await trackScanOpens(dir, scan);
        assertEquals(alone.result.length, 72);
        assert(alone.peak > 1, `${alone.peak} open at once`);
      }

      const { result, peak, open } = await trackScanOpens(
        dir,
        () =>
          Promise.all([
            ...Array.from(
              { length: 12 },
              () => repo.findAllGlobalSince(cutoff),
            ),
            ...Array.from(
              { length: 12 },
              () => repo.findGlobalByStatus("running"),
            ),
          ]),
      );
      for (const found of result) assertEquals(found.length, 72);
      assertEquals(open, 0);
      // the bound is shared across the scans, not applied per scan
      assert(peak <= 16, `${peak} open at once`);
      assert(peak > 1, `${peak} open at once`);
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

// writes a raw run YAML directly, bypassing save, for records the summary read
// must tolerate that full-aggregate validation would reject
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

async function settleRunIndex(dir: string, workflowId: WorkflowId) {
  const runsDir = join(dir, ".swamp", "workflow-runs", workflowId);
  const when = new Date(Date.now() - 60_000);
  await Deno.utime(getIndexPath(runsDir), when, when);
  await Deno.utime(runsDir, when, when);
}

/**
 * a run index cache clock a minute ahead: utime sets mtime back but moves ctime
 * to now, and a recent ctime is not trusted, so snapshots a test expects kept
 * need this clock
 */
const aheadClock = () => Date.now() + 60_000;

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

    run.interruptOrphaned("test", []);
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

    const run = WorkflowRun.create(workflow, {}, undefined, "schedule");
    run.start();
    await repo.save(workflow.id, run);

    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const oldIndex: Record<string, unknown> = {
      [run.id]: {
        status: "running",
        workflowId: run.workflowId,
        workflowName: "test-workflow",
        startedAt: run.startedAt?.toISOString(),
        tags: {},
        inputs: {},
      },
    };
    await Deno.writeTextFile(
      getIndexPath(runsDir),
      JSON.stringify(oldIndex),
    );

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
    const stale = JSON.stringify({ version: 0, entries: {} });
    await Deno.writeTextFile(getIndexPath(indexDir), stale);

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
    assertEquals(recordReads, 1);
    assertEquals(await Deno.readTextFile(getIndexPath(indexDir)), stale);

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

    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.writeTextFile(getIndexPath(runsDir), "{{corrupt}}");

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

      const localIndexDir = join(dir, ".swamp", "workflow-runs", workflow.id);
      const localIndex = await readRunIndex(localIndexDir);
      assertNotEquals(localIndex, null, "index must exist under local .swamp/");
      assertEquals(localIndex!.entries[run.id]?.status, "running");

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

    // a decoy at the target's path in another workflow directory: findById
    // returns null for it, so the scan must go on to the directory that owns
    // the run, as for a run deleted between stat and read
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
    // each delete is followed by an attempt to remove the still non-empty runs
    // directory; on macOS a walk of that directory open at the time skipped
    // entries
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
      const path = repo.getPath(workflow.id, run.id);
      const content = await Deno.readTextFile(path);
      await Deno.writeTextFile(
        path,
        content.replace(`id: ${run.id}`, `id: ${JSON.stringify(badId)}`),
      );
    }
    await Deno.writeTextFile(join(runsDir, "workflow-run-..yaml"), "");
    await Deno.writeTextFile(join(runsDir, "workflow-run-...yaml"), "");

    const result = await repo.deleteOlderThan(new Date(Date.now() + 60_000));

    assertEquals(result.deleted, 5);
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
    const otherId = crypto.randomUUID();
    const otherDir = join(dir, ".swamp", "workflow-runs", otherId);
    await ensureDir(otherDir);
    await Deno.writeTextFile(
      join(otherDir, `workflow-run-${crypto.randomUUID()}.yaml`),
      "id: x\njobs: [\n",
    );
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

    assertEquals(uow.staged(), [{ kind: "write", path }, {
      kind: "write",
      path,
    }]);
    assertEquals(marks, [path, path]);
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

    assertEquals(uow.staged(), [{ kind: "remove", path: runsDir }, {
      kind: "remove",
      path: runsDir,
    }]);
    assertEquals(marks, [runsDir, runsDir]);
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
    assertEquals(uow.staged(), [{ kind: "remove", path }, {
      kind: "remove",
      path,
    }]);
    assertEquals(marks, [path, path]);
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
    assertEquals(uow.staged(), [{ kind: "remove", path }, {
      kind: "remove",
      path,
    }]);
    assertEquals(marks, [path, path]);
    assertEquals(await pathExists(path), false);
  });
});

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
      run.interruptOrphaned("test", []);
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
    run.interruptOrphaned("test", []);
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
    run.interruptOrphaned("test", []);
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
    run.interruptOrphaned("test", []);
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

    runs[0].interruptOrphaned("test", []);
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

      run.interruptOrphaned("test", []);
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
    run.interruptOrphaned("test", []);
    await repo.save(otherId, run);
    await replaceRecord(repo, otherId, run, runningRecord);

    await repo.verifyIndexes();

    const index = await readRunIndex(
      join(dir, ".swamp", "workflow-runs", otherId),
    );
    assertEquals(index?.entries[run.id]?.status, "running");
  });
});

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
    await writeRunIndex(indexDir, legacy?.entries ?? {});

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
    await writeRunIndex(indexDir, entries);

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

// run logs are written under the repo-local .swamp/workflow-runs whichever
// datastore holds the run records

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

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: makes no local index directory or lock file for records in another datastore with no local index", async () => {
  await withRepoAndStore(async (repoDir, storeDir, repo) => {
    const workflow = createTestWorkflow();
    const old = await saveFinishedRun(repo, workflow);
    await saveFinishedRun(repo, workflow);
    const path = join(storeDir, workflow.id, `workflow-run-${old.id}.yaml`);
    const data = parseYaml(await Deno.readTextFile(path)) as Record<
      string,
      unknown
    >;
    const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    data.startedAt = longAgo;
    data.completedAt = longAgo;
    await Deno.writeTextFile(path, stringifyYaml(data));
    await backdate(path, 400 * 86_400_000);
    await Deno.remove(localRunsDir(repoDir, workflow.id), { recursive: true });

    const result = await repo.deleteOlderThan(RETENTION_CUTOFF());

    assertEquals(result.deletedRunIds, [old.id]);
    assertEquals(await pathExists(localRunsDir(repoDir, workflow.id)), false);
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

for (const missing of [true, false]) {
  Deno.test(`repairIndex: queued readers share one ${missing ? "rebuild" : "validation"} across repository instances (swamp-club#3857)`, async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const other = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();
      const indexDir = localRunsDir(dir, workflow.id);
      const indexPath = getIndexPath(indexDir);
      const runs = await saveRunningRuns(repo, workflow, 3);
      if (missing) await Deno.remove(indexPath);
      else await dropIndexEntries(indexDir, [runs[0].id]);

      const release = Promise.withResolvers<void>();
      const held = withIndexQueue(indexDir, () => release.promise);
      const original = Deno.readFile;
      let observed = 0;
      Deno.readFile = async (...args: Parameters<typeof original>) => {
        try {
          return await original(...args);
        } finally {
          if (String(args[0]) === indexPath) observed++;
        }
      };
      const reading: Promise<unknown>[] = [];
      try {
        await withCapturedSpans(async (spans) => {
          const summaries = repo.findAllSummariesFromIndex(workflow.id);
          const status = other.findSummariesByStatus(workflow.id, "running");
          const latest = other.findLatestByWorkflowId(workflow.id);
          reading.push(summaries, status, latest);
          await waitFor(
            () => Promise.resolve(observed === 3),
            "all readers to observe the invalid index",
          );
          release.resolve();
          const [all, running, last] = await Promise.all([
            summaries,
            status,
            latest,
          ]);
          assertEquals(all.length, 3);
          assertEquals(running.length, 3);
          assert(last && runs.some((run) => run.id === last.id));
          const repairs = spans.filter((s) =>
            s.name === "swamp.workflow_runs.index.repair"
          );
          assertEquals(repairs.length, 1);
          assertEquals(
            repairs[0].attributes["workflow_runs.records_read"],
            missing ? 0 : 1,
          );
          assertEquals(
            spans.filter((s) => s.name === "swamp.workflow_runs.index.rebuild")
              .length,
            missing ? 1 : 0,
          );
        });
      } finally {
        release.resolve();
        await held;
        await Promise.allSettled(reading);
        Deno.readFile = original;
      }
    });
  });
}

Deno.test("repairIndex: cancelling the first queued reader does not cancel its peers (swamp-club#3857)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = localRunsDir(dir, workflow.id);
    const indexPath = getIndexPath(indexDir);
    await saveRunningRuns(repo, workflow, 2);
    await Deno.remove(indexPath);
    const release = Promise.withResolvers<void>();
    const held = withIndexQueue(indexDir, () => release.promise);
    const abort = new AbortController();
    const original = Deno.readFile;
    let observed = 0;
    Deno.readFile = async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } finally {
        if (String(args[0]) === indexPath) observed++;
      }
    };
    const first = repo.findSummariesByStatus(
      workflow.id,
      "running",
      abort.signal,
    );
    const rejected = assertRejects(() => first, DOMException, "stopped");
    const peer = repo.findAllSummariesFromIndex(workflow.id);
    try {
      await waitFor(
        () => Promise.resolve(observed === 2),
        "both reads to queue",
      );
      abort.abort(new DOMException("stopped", "AbortError"));
      await rejected;
      release.resolve();
      assertEquals((await peer).length, 2);
    } finally {
      abort.abort();
      release.resolve();
      await held;
      await Promise.allSettled([rejected, peer]);
      Deno.readFile = original;
    }
  });
});

async function dropIndexEntries(indexDir: string, runIds: string[]) {
  const result = await readRunIndex(indexDir);
  const entries = { ...result!.entries };
  for (const id of runIds) delete entries[id];
  await writeRunIndex(indexDir, entries);
}

Deno.test("repairIndex: cancelling a snapshot initiator preserves both snapshot and repair followers (swamp-club#3857)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      undefined,
      () => Date.now() + 60_000,
    );
    const workflow = createTestWorkflow();
    const indexDir = localRunsDir(dir, workflow.id);
    const indexPath = getIndexPath(indexDir);
    await saveRunningRuns(repo, workflow, 2);
    await Deno.remove(indexPath);
    const release = Promise.withResolvers<void>();
    const held = withIndexQueue(indexDir, () => release.promise);
    const abort = new AbortController();
    const original = Deno.readFile;
    let observed = 0;
    Deno.readFile = async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } finally {
        if (String(args[0]) === indexPath) observed++;
      }
    };
    const first = repo.runIndexSnapshot(workflow.id, abort.signal);
    const rejected = assertRejects(() => first, DOMException, "stopped");
    const reading: Promise<unknown>[] = [rejected];
    try {
      await waitFor(
        () => Promise.resolve(observed === 1),
        "snapshot loader to queue",
      );
      const snapshot = repo.runIndexSnapshot(workflow.id);
      const status = repo.findSummariesByStatus(workflow.id, "running");
      reading.push(snapshot, status);
      await waitFor(
        () => Promise.resolve(observed === 2),
        "status reader to join the repair",
      );
      abort.abort(new DOMException("stopped", "AbortError"));
      await rejected;
      release.resolve();
      assertEquals((await snapshot).size, 2);
      assertEquals((await status).length, 2);
    } finally {
      abort.abort();
      release.resolve();
      await held;
      await Promise.allSettled(reading);
      Deno.readFile = original;
    }
  });
});

Deno.test("repairIndex: different record directories never share a repair through the same local index (swamp-club#3857)", async () => {
  await withTempDir(async (dir) => {
    const firstRepo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      join(dir, "store-a"),
    );
    const secondRepo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      join(dir, "store-b"),
    );
    const workflow = createTestWorkflow();
    const [firstRun] = await saveRunningRuns(firstRepo, workflow, 1);
    const [secondRun] = await saveRunningRuns(secondRepo, workflow, 1);
    const indexDir = localRunsDir(dir, workflow.id);
    const indexPath = getIndexPath(indexDir);
    await Deno.remove(indexPath);
    const release = Promise.withResolvers<void>();
    const held = withIndexQueue(indexDir, () => release.promise);
    const original = Deno.readFile;
    let observed = 0;
    Deno.readFile = async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } finally {
        if (String(args[0]) === indexPath) observed++;
      }
    };
    const first = firstRepo.findAllSummariesFromIndex(workflow.id);
    const second = secondRepo.findAllSummariesFromIndex(workflow.id);
    try {
      await waitFor(
        () => Promise.resolve(observed === 2),
        "both repositories to observe the missing index",
      );
      release.resolve();
      assertEquals((await first).map((run) => run.id), [firstRun.id]);
      assertEquals((await second).map((run) => run.id), [secondRun.id]);
    } finally {
      release.resolve();
      await held;
      await Promise.allSettled([first, second]);
      Deno.readFile = original;
    }
  });
});

Deno.test("repairIndex: a writer queued between readers separates their validations (swamp-club#3857)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = localRunsDir(dir, workflow.id);
    const indexPath = getIndexPath(indexDir);
    const [finished, added] = await saveRunningRuns(repo, workflow, 2);
    const staleEntry = (await readRunIndex(indexDir))!.entries[finished.id];
    finished.interruptOrphaned("test", []);
    await repo.save(workflow.id, finished);
    await dropIndexEntries(indexDir, [added.id]);
    const release = Promise.withResolvers<void>();
    const held = withIndexQueue(indexDir, () => release.promise);
    const original = Deno.readFile;
    let observed = 0;
    Deno.readFile = async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } finally {
        if (String(args[0]) === indexPath) observed++;
      }
    };
    const reading: Promise<unknown>[] = [];
    try {
      await withCapturedSpans(async (spans) => {
        const first = repo.findAllSummariesFromIndex(workflow.id);
        reading.push(first);
        await waitFor(
          () => Promise.resolve(observed === 1),
          "first reader to queue",
        );
        const writer = withIndexQueue(indexDir, async () => {
          const current = (await readRunIndex(indexDir))!;
          current.entries[finished.id] = staleEntry;
          await writeRunIndex(indexDir, current.entries);
        });
        reading.push(writer);
        const second = repo.findAllSummariesFromIndex(workflow.id);
        reading.push(second);
        await waitFor(
          () => Promise.resolve(observed === 2),
          "later reader to observe its mismatch",
        );
        release.resolve();
        await Promise.all([first, writer]);
        assertEquals(
          (await second).find((run) => run.id === finished.id)?.status,
          "interrupted",
        );
        assertEquals(
          (await readRunIndex(indexDir))!.entries[finished.id].status,
          "interrupted",
        );
        assertEquals(
          spans.filter((s) => s.name === "swamp.workflow_runs.index.repair")
            .length,
          2,
        );
      });
    } finally {
      release.resolve();
      await held;
      await Promise.allSettled(reading);
      Deno.readFile = original;
    }
  });
});

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

Deno.test("repairIndex: cancelling every queued reader leaves the index untouched and permits a new cohort (swamp-club#3857)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = localRunsDir(dir, workflow.id);
    const indexPath = getIndexPath(indexDir);
    await saveRunningRuns(repo, workflow, 2);
    await Deno.remove(indexPath);
    const release = Promise.withResolvers<void>();
    const held = withIndexQueue(indexDir, () => release.promise);
    const controllers = [new AbortController(), new AbortController()];
    const original = Deno.readFile;
    let observed = 0;
    Deno.readFile = async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } finally {
        if (String(args[0]) === indexPath) observed++;
      }
    };
    const rejected = controllers.map((controller) => {
      const read = repo.findSummariesByStatus(
        workflow.id,
        "running",
        controller.signal,
      );
      return assertRejects(() => read, DOMException, "stopped");
    });
    const reading: Promise<unknown>[] = [...rejected];
    try {
      await waitFor(
        () => Promise.resolve(observed === 2),
        "both readers to queue",
      );
      for (const controller of controllers) {
        controller.abort(new DOMException("stopped", "AbortError"));
      }
      await Promise.all(rejected);
      assertEquals(await pathExists(indexPath), false);
      // The cancelled queue slot has not run yet. Its eventual cleanup must
      // not delete this replacement's registration.
      const next = repo.findAllSummariesFromIndex(workflow.id);
      const peer = repo.findSummariesByStatus(workflow.id, "running");
      reading.push(next, peer);
      await waitFor(
        () => Promise.resolve(observed === 4),
        "replacement readers to queue",
      );
      release.resolve();
      assertEquals((await next).length, 2);
      assertEquals((await peer).length, 2);
    } finally {
      for (const controller of controllers) controller.abort();
      release.resolve();
      await held;
      await Promise.allSettled(reading);
      Deno.readFile = original;
    }
  });
});

Deno.test("repairIndex: a shared parse failure reaches every reader and the next read retries (swamp-club#3857)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = localRunsDir(dir, workflow.id);
    const indexPath = getIndexPath(indexDir);
    const [run] = await saveRunningRuns(repo, workflow, 1);
    const path = repo.getPath(workflow.id, run.id);
    const record = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, "status: [");
    await Deno.remove(indexPath);
    const release = Promise.withResolvers<void>();
    const held = withIndexQueue(indexDir, () => release.promise);
    const original = Deno.readFile;
    let observed = 0;
    Deno.readFile = async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } finally {
        if (String(args[0]) === indexPath) observed++;
      }
    };
    const failed = [
      assertRejects(() => repo.findAllSummariesFromIndex(workflow.id)),
      assertRejects(() => repo.findSummariesByStatus(workflow.id, "running")),
    ];
    try {
      await waitFor(
        () => Promise.resolve(observed === 2),
        "both readers to queue",
      );
      release.resolve();
      await Promise.all(failed);
      assertEquals(await pathExists(indexPath), false);
      await Deno.writeTextFile(path, record);
      assertEquals(
        (await repo.findAllSummariesFromIndex(workflow.id)).length,
        1,
      );
    } finally {
      release.resolve();
      await held;
      await Promise.allSettled(failed);
      Deno.readFile = original;
    }
  });
});

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
    replaced.interruptOrphaned("test", []);
    await repo.save(workflow.id, replaced);
    const result = await readRunIndex(indexDir);
    await writeRunIndex(indexDir, {
      ...result!.entries,
      [replaced.id]: runningEntry,
    });
    assertEquals(
      (await repo.findAllSummariesFromIndex(workflow.id))[0].status,
      "running",
    );

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
      await writeRunIndex(indexDir, {
        ...result!.entries,
        [second.id]: secondEntry,
      });
      landed = await Deno.readTextFile(indexPath);
      await Deno.utime(indexPath, past, past);
    });

    const original = Deno.readTextFile;
    const originalReadFile = Deno.readFile;
    let indexReads = 0;
    let recordReads = 0;
    Deno.readFile = ((...args: Parameters<typeof originalReadFile>) => {
      if (String(args[0]) === indexPath) indexReads++;
      return originalReadFile(...args);
    }) as typeof originalReadFile;
    Deno.readTextFile = ((...args: Parameters<typeof original>) => {
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
      assertEquals(recordReads, 0);
    } finally {
      Deno.readTextFile = original;
      Deno.readFile = originalReadFile;
    }
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
    finished.interruptOrphaned("test", []);
    await repo.save(workflow.id, finished);
    const result = await readRunIndex(indexDir);
    await writeRunIndex(indexDir, {
      ...result!.entries,
      [finished.id]: runningEntry,
    });

    const [added] = await saveRunningRuns(repo, workflow, 1);
    const addedEntry = (await readRunIndex(indexDir))!.entries[added.id];
    await dropIndexEntries(indexDir, [added.id]);

    let release!: () => void;
    const held = withIndexQueue(indexDir, async () => {
      await new Promise<void>((resolve) => release = resolve);
      const current = await readRunIndex(indexDir);
      await writeRunIndex(indexDir, {
        ...current!.entries,
        [added.id]: addedEntry,
      });
    });

    const original = Deno.readFile;
    let indexReads = 0;
    Deno.readFile = ((...args: Parameters<typeof original>) => {
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
      Deno.readFile = original;
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
    const stale = JSON.stringify({ version: 0, entries: {} });
    await Deno.writeTextFile(getIndexPath(indexDir), stale);

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
    assertEquals(recordReads, 1);
    assertEquals(await Deno.readTextFile(getIndexPath(indexDir)), stale);

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
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], lostPath);
    assertEquals(stats.listings, 5);
  });
});

const RUN_READ_SPANS = [
  "swamp.workflow_runs.scan_all",
  "swamp.workflow_runs.read_summaries",
  "swamp.workflow_runs.index.repair",
  "swamp.workflow_runs.index.rebuild",
];

async function recordTextLength(
  dir: string,
  workflowIds: WorkflowId[],
): Promise<number> {
  let length = 0;
  for (const workflowId of workflowIds) {
    const runsDir = runsDirOf(dir, workflowId);
    for await (const entry of Deno.readDir(runsDir)) {
      if (!/^workflow-run-.*\.yaml$/.test(entry.name)) continue;
      length += (await Deno.readTextFile(join(runsDir, entry.name))).length;
    }
  }
  return length;
}

function runReadSpans(spans: readonly ReadableSpan[]): ReadableSpan[] {
  return spans.filter((s) => RUN_READ_SPANS.includes(s.name));
}

Deno.test("findAllGlobal: a scan_all span records every run record it reads", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const first = createWorkflowWithId(crypto.randomUUID(), "first");
    const second = createWorkflowWithId(crypto.randomUUID(), "second");
    await saveRunningRuns(repo, first, 2);
    await saveRunningRuns(repo, second, 3);
    const length = await recordTextLength(dir, [first.id, second.id]);

    await withCapturedSpans(async (spans) => {
      assertEquals((await repo.findAllGlobal()).length, 5);
      const scan = findSpan(spans, "swamp.workflow_runs.scan_all");
      assertEquals(scan.attributes["workflow_runs.records_read"], 5);
      assert(length > 0);
      assertEquals(scan.attributes["workflow_runs.bytes_read"], length);
    });
  });
});

Deno.test("findAllSummariesByWorkflowId: a read_summaries span records the records it reads", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "summaries");
    await saveRunningRuns(repo, workflow, 3);
    const length = await recordTextLength(dir, [workflow.id]);

    await withCapturedSpans(async (spans) => {
      assertEquals(
        (await repo.findAllSummariesByWorkflowId(workflow.id)).length,
        3,
      );
      const read = findSpan(spans, "swamp.workflow_runs.read_summaries");
      assertEquals(read.attributes["workflow.id"], workflow.id);
      assertEquals(read.attributes["workflow_runs.records_read"], 3);
      assertEquals(read.attributes["workflow_runs.bytes_read"], length);
    });
  });
});

Deno.test("getValidatedIndex: a repair span records the records it reads and its queue wait", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "repair");
    const indexDir = runsDirOf(dir, workflow.id);
    const runs = await saveRunningRuns(repo, workflow, 3);
    await dropIndexEntries(indexDir, [runs[1].id]);

    await withCapturedSpans(async (spans) => {
      await repo.findAllSummariesFromIndex(workflow.id);
      const repair = findSpan(spans, "swamp.workflow_runs.index.repair");
      assertEquals(repair.attributes["workflow.id"], workflow.id);
      assertEquals(repair.attributes["workflow_runs.records_read"], 1);
      assert(Number(repair.attributes["workflow_runs.bytes_read"]) > 0);
      const wait = repair.attributes["workflow_runs.index.queue_wait_ms"];
      assertEquals(typeof wait, "number");
      assert(Number(wait) >= 0);
      assertEquals(
        spans.filter((s) => s.name === "swamp.workflow_runs.index.rebuild")
          .length,
        0,
      );
    });
  });
});

Deno.test("getValidatedIndex: a repair that rebuilds has the reads on its child rebuild span only", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "rebuild");
    await saveRunningRuns(repo, workflow, 3);
    await Deno.remove(getIndexPath(runsDirOf(dir, workflow.id)));
    const length = await recordTextLength(dir, [workflow.id]);

    await withCapturedSpans(async (spans) => {
      assertEquals(
        (await repo.findAllSummariesFromIndex(workflow.id)).length,
        3,
      );
      const repair = findSpan(spans, "swamp.workflow_runs.index.repair");
      const rebuild = findSpan(spans, "swamp.workflow_runs.index.rebuild");
      assert(isChildOf(rebuild, repair));
      assertEquals(rebuild.attributes["workflow.id"], workflow.id);
      assertEquals(rebuild.attributes["workflow_runs.records_read"], 3);
      assertEquals(rebuild.attributes["workflow_runs.bytes_read"], length);
      assertEquals(repair.attributes["workflow_runs.records_read"], 0);
      assertEquals(
        typeof repair.attributes["workflow_runs.index.queue_wait_ms"],
        "number",
      );
      assertEquals(
        rebuild.attributes["workflow_runs.index.queue_wait_ms"],
        undefined,
      );
    });
  });
});

Deno.test("verifyIndexes: a rebuild span records the records it reads and its queue wait", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "verify");
    await saveRunningRuns(repo, workflow, 2);
    await Deno.remove(getIndexPath(runsDirOf(dir, workflow.id)));

    await withCapturedSpans(async (spans) => {
      await new YamlWorkflowRunRepository(dir).verifyIndexes();
      const rebuild = findSpan(spans, "swamp.workflow_runs.index.rebuild");
      assertEquals(rebuild.attributes["workflow.id"], workflow.id);
      assertEquals(rebuild.attributes["workflow_runs.records_read"], 2);
      assert(Number(rebuild.attributes["workflow_runs.bytes_read"]) > 0);
      const wait = rebuild.attributes["workflow_runs.index.queue_wait_ms"];
      assertEquals(typeof wait, "number");
      assert(Number(wait) >= 0);
    });
  });
});

Deno.test("findLatestByWorkflowId: a read the index answers opens no run read span", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "hit");
    const runs = await saveRunningRuns(repo, workflow, 2);

    await withCapturedSpans(async (spans) => {
      assertNotEquals(await repo.findLatestByWorkflowId(workflow.id), null);
      assertEquals(
        (await repo.findById(workflow.id, runs[0].id))?.id,
        runs[0].id,
      );
      const run = WorkflowRun.create(workflow);
      run.start();
      await repo.save(workflow.id, run);
      assertEquals(runReadSpans(spans).map((s) => s.name), []);
    });
  });
});

Deno.test("save: the run index holds a typed run's inputs and failure reason as reference text, never a sentinel or a value (typed-secrets 4.4)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    const values = new RunSensitiveValues(
      undefined,
      new SecretBagRegistry(),
    );
    const sentinel = new VaultSecretBag(values.sentinels).addSecret(
      { vaultName: "v", key: "k" },
      "inputs.token",
    );
    run.attachSensitiveValues(values);
    run.captureInputs({ token: `Bearer ${sentinel}` });
    run.start();
    const step = run.getJob("job1")!.getStep("step1")!;
    step.start();
    step.fail(`rejected ${sentinel}`);
    run.getJob("job1")!.fail();
    run.complete();
    await repo.save(workflow.id, run);

    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    const index = await readRunIndex(runsDir);
    const entry = index!.entries[run.id]!;
    const reference = "${{ vault.get('v', 'k') }}";
    assertEquals(entry.inputs, { token: `Bearer ${reference}` });
    assertEquals(entry.failureReason?.includes(reference), true);
    const text = JSON.stringify(index);
    assertEquals(text.includes("__SWAMP_VSEC_"), false);
  });
});

Deno.test("YamlWorkflowRunRepository.save: on v3, the staged record of a typed run is the persisted form, references in place and no sentinel or value (typed-secrets 4.4)", async () => {
  await withTempDir(async (dir) => {
    const { markDirty, uow, batches } = typedRecordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    const values = new RunSensitiveValues(
      undefined,
      new SecretBagRegistry(),
    );
    const sentinel = new VaultSecretBag(values.sentinels).addSecret(
      { vaultName: "v", key: "k" },
      "inputs.token",
    );
    run.attachSensitiveValues(values);
    run.captureInputs({ token: `Bearer ${sentinel}` });
    run.start();
    await runInUnitOfWork(uow, () => repo.save(workflow.id, run));
    assertEquals(batches.length, 1);
    const content = await contentOf(batches[0][0]);
    assertEquals(
      content,
      await Deno.readTextFile(repo.getPath(workflow.id, run.id)),
    );
    assertEquals(content.includes("__SWAMP_VSEC_"), false);
    const staged = parseYaml(content) as {
      inputs?: Record<string, unknown>;
      writtenReferences?: unknown[];
    };
    assertEquals(staged.inputs, { token: "Bearer ${{ vault.get('v', 'k') }}" });
    assertEquals(staged.writtenReferences?.length, 1);
  });
});

const RETENTION_CUTOFF = () => new Date(Date.now() - 86_400_000);

async function saveOldFinishedRun(
  dir: string,
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const run = await saveFinishedRun(repo, workflow);
  const path = join(
    runsDirOf(dir, workflow.id),
    `workflow-run-${run.id}.yaml`,
  );
  const data = parseYaml(await Deno.readTextFile(path)) as Record<
    string,
    unknown
  >;
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  data.startedAt = old;
  data.completedAt = old;
  await Deno.writeTextFile(path, stringifyYaml(data));
  await backdate(path, 400 * 86_400_000);
  return run;
}

async function saveRetentionHistory(
  dir: string,
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
  old: number,
  kept: number,
): Promise<{ old: WorkflowRun[]; kept: WorkflowRun[] }> {
  const oldRuns: WorkflowRun[] = [];
  for (let i = 0; i < old; i++) {
    oldRuns.push(await saveOldFinishedRun(dir, repo, workflow));
  }
  const keptRuns: WorkflowRun[] = [];
  for (let i = 0; i < kept; i++) {
    keptRuns.push(await saveFinishedRun(repo, workflow));
  }
  return { old: oldRuns, kept: keptRuns };
}

async function indexIds(indexDir: string): Promise<string[]> {
  return Object.keys((await readRunIndex(indexDir))!.entries).sort();
}

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: drops only the removed runs from the run index, so the next read parses no record (swamp-club#3856)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "retention");
    const indexDir = runsDirOf(dir, workflow.id);
    const { old, kept } = await saveRetentionHistory(
      dir,
      repo,
      workflow,
      3,
      27,
    );
    const [running] = await saveRunningRuns(repo, workflow, 1);

    const result = await repo.deleteOlderThan(RETENTION_CUTOFF());

    assertEquals(result.deletedRunIds.sort(), old.map((r) => r.id).sort());
    const survivors = [...kept, running].map((r) => r.id).sort();
    assertEquals(await indexIds(indexDir), survivors);
    await withCapturedSpans(async (spans) => {
      const [summaries, reads] = await countingRecordReads(() =>
        repo.findAllSummariesFromIndex(workflow.id)
      );
      assertEquals(reads, 0);
      assertEquals(summaries.map((s) => s.id).sort(), survivors);
      assertEquals(
        summaries.find((s) => s.id === running.id)?.status,
        "running",
      );
      const [snapshot, snapshotReads] = await countingRecordReads(() =>
        repo.runIndexSnapshot(workflow.id)
      );
      assertEquals(snapshotReads, 0);
      assertEquals(snapshot.size, survivors.length);
      assertEquals(
        spans.filter((s) => s.name === "swamp.workflow_runs.index.rebuild")
          .length,
        0,
      );
    });
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: keeps the index entry of a run saved while it collects (swamp-club#3856)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "concurrent");
    const indexDir = runsDirOf(dir, workflow.id);
    const { kept } = await saveRetentionHistory(dir, repo, workflow, 3, 5);
    const fresh = WorkflowRun.create(workflow);
    fresh.start();

    await Promise.all([
      repo.deleteOlderThan(RETENTION_CUTOFF()),
      repo.save(workflow.id, fresh),
    ]);

    const expected = [...kept, fresh].map((r) => r.id).sort();
    assertEquals(await indexIds(indexDir), expected);
    assertEquals([...await repo.listRunIds()].sort(), expected);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: keeps the index entry of a removed run whose record is put back before the index is updated (swamp-club#3856)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "put-back");
    const indexDir = runsDirOf(dir, workflow.id);
    const { old, kept } = await saveRetentionHistory(dir, repo, workflow, 3, 2);
    const putBack = old[0];
    const putBackPath = join(indexDir, `workflow-run-${putBack.id}.yaml`);
    const content = await Deno.readTextFile(putBackPath);

    // Hold the workflow's index queue so the index update waits until the
    // record is back.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const held = withIndexQueue(indexDir, () => gate);
    const collecting = repo.deleteOlderThan(RETENTION_CUTOFF());
    try {
      await waitFor(
        async () => !(await pathExists(putBackPath)),
        "the collected record to be removed",
      );
      await Deno.writeTextFile(putBackPath, content);
    } finally {
      release();
    }
    await held;
    const result = await collecting;

    assertEquals(result.deletedRunIds.sort(), old.map((r) => r.id).sort());
    assertEquals(
      await indexIds(indexDir),
      [...kept, putBack].map((r) => r.id).sort(),
    );
  });
});

Deno.test("YamlWorkflowRunRepository.findAllSummariesFromIndex: records removed by an interrupted cleanup are dropped from the index without reading a record (swamp-club#3856)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "interrupted");
    const indexDir = runsDirOf(dir, workflow.id);
    const { old, kept } = await saveRetentionHistory(dir, repo, workflow, 3, 5);
    for (const run of old) {
      await Deno.remove(join(indexDir, `workflow-run-${run.id}.yaml`));
    }

    await withCapturedSpans(async (spans) => {
      const [summaries, reads] = await countingRecordReads(() =>
        repo.findAllSummariesFromIndex(workflow.id)
      );
      assertEquals(reads, 0);
      assertEquals(
        summaries.map((s) => s.id).sort(),
        kept.map((r) => r.id).sort(),
      );
      const repair = findSpan(spans, "swamp.workflow_runs.index.repair");
      assertEquals(repair.attributes["workflow_runs.records_read"], 0);
      assertEquals(
        spans.filter((s) => s.name === "swamp.workflow_runs.index.rebuild")
          .length,
        0,
      );
    });
    assertEquals(await indexIds(indexDir), kept.map((r) => r.id).sort());
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: removes the run index with the last run, even one listing a record already gone (swamp-club#3856)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "emptied");
    const indexDir = runsDirOf(dir, workflow.id);
    const { old } = await saveRetentionHistory(dir, repo, workflow, 2, 0);
    const orphan = await saveFinishedRun(repo, workflow);
    await Deno.remove(join(indexDir, `workflow-run-${orphan.id}.yaml`));

    const result = await repo.deleteOlderThan(RETENTION_CUTOFF());

    assertEquals(result.deletedRunIds.sort(), old.map((r) => r.id).sort());
    assertEquals(await pathExists(getIndexPath(indexDir)), false);
    assertEquals(await pathExists(indexDir), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: deletes a run index of another schema version rather than updating it (swamp-club#3856)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "old-schema");
    const indexDir = runsDirOf(dir, workflow.id);
    await saveRetentionHistory(dir, repo, workflow, 2, 2);
    const index = await readRunIndex(indexDir);
    await Deno.writeTextFile(
      getIndexPath(indexDir),
      JSON.stringify({
        version: INDEX_SCHEMA_VERSION - 1,
        entries: index!.entries,
      }),
    );

    await repo.deleteOlderThan(RETENTION_CUTOFF());

    assertEquals(await pathExists(getIndexPath(indexDir)), false);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: a dry run leaves the run index as it was (swamp-club#3856)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createWorkflowWithId(crypto.randomUUID(), "dry-run");
    const indexDir = runsDirOf(dir, workflow.id);
    await saveRetentionHistory(dir, repo, workflow, 2, 2);
    const before = await Deno.readTextFile(getIndexPath(indexDir));

    const result = await repo.deleteOlderThan(RETENTION_CUTOFF(), {
      dryRun: true,
    });

    assertEquals(result.deleted, 2);
    assertEquals(await Deno.readTextFile(getIndexPath(indexDir)), before);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteOlderThan: with records in another datastore, removes a legacy index beside them and keeps the repo-local one (swamp-club#3856)", async () => {
  await withRepoAndStore(async (repoDir, storeDir, repo) => {
    const workflow = createWorkflowWithId(crypto.randomUUID(), "external");
    const indexDir = localRunsDir(repoDir, workflow.id);
    const recordsDir = join(storeDir, workflow.id);
    const kept = await saveFinishedRun(repo, workflow);
    const old = await saveFinishedRun(repo, workflow);
    const oldPath = join(recordsDir, `workflow-run-${old.id}.yaml`);
    await Deno.writeTextFile(oldPath, "");
    await backdate(oldPath, 400 * 86_400_000);
    const legacy = getIndexPath(recordsDir);
    await Deno.writeTextFile(legacy, "{}");

    const result = await repo.deleteOlderThan(RETENTION_CUTOFF());

    assertEquals(result.deletedRunIds, [old.id]);
    assertEquals(await pathExists(legacy), false);
    assertEquals(await indexIds(indexDir), [kept.id]);
  });
});

async function saveSuspendedRuns(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
  count: number,
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  for (let i = 0; i < count; i++) {
    const run = WorkflowRun.create(workflow);
    run.start();
    run.suspend();
    await repo.save(workflow.id, run);
    runs.push(run);
  }
  return runs;
}

Deno.test(
  "findByStatus: requests running at once keep at most the search share of directories and files open between them, with findGlobalByStatus (swamp-club#4077)",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlWorkflowRunRepository(dir);
      const workflow = createTestWorkflow();
      const runs = await saveSuspendedRuns(
        repo,
        workflow,
        SCAN_CONCURRENCY * 3,
      );

      const alone = await trackScanOpens(
        dir,
        () => repo.findByStatus(workflow.id, "suspended"),
      );
      assertEquals(alone.result.length, runs.length);
      assert(alone.peak > 1, `${alone.peak} open at once`);

      const { result, peak, open } = await trackScanOpens(
        dir,
        () =>
          Promise.all([
            ...Array.from(
              { length: 8 },
              () => repo.findByStatus(workflow.id, "suspended"),
            ),
            repo.findGlobalByStatus("suspended"),
          ]),
      );
      for (const found of result) assertEquals(found.length, runs.length);
      assertEquals(open, 0);
      // bounded across concurrent requests; unbounded, each request would open
      // its own reads
      assert(peak <= SEARCH_SCAN_SHARE, `${peak} open at once`);
      assert(peak > 1, `${peak} open at once`);
    });
  },
);

Deno.test("findByStatus: returns only runs with the status, in the order the index lists them", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    await saveSuspendedRuns(repo, workflow, 5);
    const running = WorkflowRun.create(workflow);
    running.start();
    await repo.save(workflow.id, running);

    const listed = await repo.findSummariesByStatus(workflow.id, "suspended");
    const { result } = await trackScanOpens(
      dir,
      () => repo.findByStatus(workflow.id, "suspended"),
    );

    assertEquals(result.map((r) => r.id), listed.map((s) => s.id));
    assert(result.every((r) => r.status === "suspended"));
  });
});

Deno.test("findByStatus: leaves out a run whose record is gone when it is read", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = await saveSuspendedRuns(repo, workflow, 3);
    const gone = repo.getPath(workflow.id, runs[1].id);

    const original = Deno.readTextFile;
    Deno.readTextFile = ((...args: Parameters<typeof original>) => {
      if (String(args[0]) === gone) {
        return Deno.remove(gone).then(() => original(...args));
      }
      return original(...args);
    }) as typeof original;
    let found: WorkflowRun[];
    try {
      found = await repo.findByStatus(workflow.id, "suspended");
    } finally {
      Deno.readTextFile = original;
    }

    assertEquals(
      found.map((r) => r.id).sort(),
      [runs[0].id, runs[2].id].sort(),
    );
  });
});

Deno.test("findByStatus: a record that cannot be read rejects with its error", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = await saveSuspendedRuns(repo, workflow, 3);
    const unreadable = repo.getPath(workflow.id, runs[0].id);

    const original = Deno.readTextFile;
    Deno.readTextFile = ((...args: Parameters<typeof original>) => {
      if (String(args[0]) === unreadable) {
        return Promise.reject(new Deno.errors.PermissionDenied("denied"));
      }
      return original(...args);
    }) as typeof original;
    try {
      await assertRejects(
        () => repo.findByStatus(workflow.id, "suspended"),
        Deno.errors.PermissionDenied,
        "denied",
      );
    } finally {
      Deno.readTextFile = original;
    }
  });
});

Deno.test("findByStatus: an aborted signal stops reading records and rejects with its reason", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = await saveSuspendedRuns(repo, workflow, SCAN_CONCURRENCY * 3);
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
        () => repo.findByStatus(workflow.id, "suspended", abort.signal),
        DOMException,
        "shutting down",
      );
    } finally {
      Deno.readTextFile = original;
    }

    assert(recordReads < runs.length, `${recordReads} records read`);
  });
});

// Run-record probe, fleet fan-out baseline (swamp-club#4271): a stored run
// whose job run carries a field this binary does not know is read from
// disk, and the next save writes it back without that field.
Deno.test("YamlWorkflowRunRepository: a stored job-run field it does not know is read, then dropped on the next save", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);

    const path = repo.getPath(workflow.id, run.id);
    const stored = parseYaml(await Deno.readTextFile(path)) as {
      jobs: Record<string, unknown>[];
    };
    stored.jobs[0].fanOut = {
      planned: [{ worker: "host-a", disposition: "dispatch" }],
    };
    await Deno.writeTextFile(path, stringifyYaml(stored));

    const loaded = await repo.findById(workflow.id, run.id);
    assertNotEquals(loaded, null);
    assertEquals(loaded!.status, "running");
    assertEquals(loaded!.jobs.map((job) => job.jobName), ["job1"]);

    await repo.save(workflow.id, loaded!);
    const rewritten = parseYaml(await Deno.readTextFile(path)) as {
      jobs: Record<string, unknown>[];
    };
    assertEquals("fanOut" in rewritten.jobs[0], false);
  });
});

Deno.test("YamlWorkflowRunRepository.save: a fence that closes during beforeSave leaves the record and the index as they were, and reports the refusal (swamp-club#4171)", async () => {
  await withTempDir(async (dir) => {
    const { markDirty, uow } = recordingUnitOfWork();
    const repo = new YamlWorkflowRunRepository(
      dir,
      undefined,
      undefined,
      markDirty,
    );
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await runInUnitOfWork(uow, () => repo.save(workflow.id, run));
    const path = repo.getPath(workflow.id, run.id);
    const before = await Deno.readTextFile(path);

    let closed = false;
    const waitsClosed: string[] = [];
    repo.beforeSave = (saving) => {
      waitsClosed.push(saving.status);
      closed = true;
      return Promise.resolve();
    };
    run.complete();
    let refusals = 0;
    await runInUnitOfWork(uow, () =>
      repo.save(workflow.id, run, {
        fence: { isClosed: () => closed, isTakenOver: () => false },
        onRefused: () => {
          refusals++;
        },
      }));
    assertEquals(refusals, 1);

    assertEquals(await Deno.readTextFile(path), before);
    assertEquals(waitsClosed, [run.status]);
    assertEquals(
      (await repo.findAllByWorkflowId(workflow.id)).map((r) => r.status),
      ["running"],
    );
  });
});

Deno.test("YamlWorkflowRunRepository.save: an open fence writes, as no fence does (swamp-club#4171)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    let refusals = 0;
    await repo.save(workflow.id, run, {
      fence: { isClosed: () => false, isTakenOver: () => false },
      onRefused: () => {
        refusals++;
      },
    });
    assertEquals(refusals, 0);
    assertEquals(
      (await repo.findById(workflow.id, run.id))?.status,
      "running",
    );
  });
});

Deno.test("save: appends the run's line to the index without rewriting it", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = localRunsDir(dir, workflow.id);
    const [run] = await saveRunningRuns(repo, workflow, 1);
    const indexPath = getIndexPath(indexDir);
    const before = await Deno.readTextFile(indexPath);
    const inode = (await Deno.stat(indexPath)).ino;

    run.interruptOrphaned("test", []);
    await repo.save(workflow.id, run);

    const after = await Deno.readTextFile(indexPath);
    assert(after.startsWith(before), "the earlier lines are kept as written");
    assertEquals(after.slice(before.length).trimEnd().split("\n").length, 1);
    assertEquals((await Deno.stat(indexPath)).ino, inode);
    assertEquals(
      (await readRunIndex(indexDir))!.entries[run.id].status,
      "interrupted",
    );
  });
});

Deno.test("save: the compaction bound is read from the index, so a fresh repository appends until the file doubles", async () => {
  await withTempDir(async (dir) => {
    const workflow = createTestWorkflow();
    const indexDir = localRunsDir(dir, workflow.id);
    const [run] = await saveRunningRuns(
      new YamlWorkflowRunRepository(dir),
      workflow,
      1,
    );
    const entry = (await readRunIndex(indexDir))!.entries[run.id];
    const entries: Record<string, typeof entry> = { [run.id]: entry };
    for (let i = 0; i < 2000; i++) {
      entries[`filler-${i}`] = { ...entry, inputs: { n: "f".repeat(200) } };
    }
    await writeRunIndex(indexDir, entries);
    const indexPath = getIndexPath(indexDir);
    const compacted = await Deno.readTextFile(indexPath);
    assert(compacted.length > INDEX_COMPACTION_FLOOR_BYTES);

    run.interruptOrphaned("test", []);
    await new YamlWorkflowRunRepository(dir).save(workflow.id, run);
    assert((await Deno.readTextFile(indexPath)).startsWith(compacted));

    const filler = `${
      JSON.stringify({ id: "filler-0", entry: entries["filler-0"] })
    }\n`;
    await Deno.writeTextFile(indexPath, filler.repeat(2500), { append: true });
    run.complete();
    await new YamlWorkflowRunRepository(dir).save(workflow.id, run);

    const rewritten = await Deno.readTextFile(indexPath);
    assertEquals(rewritten.trimEnd().split("\n").length, 2002);
    assertEquals(
      (await readRunIndex(indexDir))!.entries[run.id].status,
      run.status,
    );
  });
});

Deno.test("save: a large input stays in the record and the index lists its key as omitted", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const intent = "i".repeat(INDEXED_INPUT_MAX_BYTES * 4);
    const run = WorkflowRun.create(workflow);
    run.captureInputs({ region: "eu", intent });
    run.start();
    await repo.save(workflow.id, run);

    const entry = (await readRunIndex(localRunsDir(dir, workflow.id)))!
      .entries[run.id];
    assertEquals(entry.inputs, { region: "eu" });
    assertEquals(entry.inputsOmitted, ["intent"]);
    const [summary] = await repo.findAllSummariesFromIndex(workflow.id);
    assertEquals(summary.inputs, { region: "eu" });
    assertEquals(summary.inputsOmitted, ["intent"]);
    const snapshot = await repo.runIndexSnapshot(workflow.id);
    assertEquals(snapshot.size, 1);
    const stored = await repo.findById(workflow.id, run.id);
    assertEquals(stored?.toPersistedData().inputs, { region: "eu", intent });
  });
});

Deno.test("findAllSummariesByWorkflowId: a summary read from its record bounds its inputs as the index does", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.captureInputs({ body: "b".repeat(INDEXED_INPUT_MAX_BYTES * 2) });
    run.start();
    await repo.save(workflow.id, run);

    const [summary] = await repo.findAllSummariesByWorkflowId(workflow.id);

    assertEquals(summary.inputs, {});
    assertEquals(summary.inputsOmitted, ["body"]);
  });
});

Deno.test("getValidatedIndex: a legacy JSON index is rebuilt from the records in the new form", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = await saveRunningRuns(repo, workflow, 2);
    const indexDir = localRunsDir(dir, workflow.id);
    const entries = (await readRunIndex(indexDir))!.entries;
    await Deno.writeTextFile(
      getIndexPath(indexDir),
      JSON.stringify({ version: 4, entries }),
    );

    const summaries = await repo.findAllSummariesFromIndex(workflow.id);

    assertEquals(
      summaries.map((s) => s.id).sort(),
      runs.map((r) => r.id).sort(),
    );
    const rebuilt = await readRunIndex(indexDir);
    assertEquals(rebuilt?.version, INDEX_SCHEMA_VERSION);
    assertEquals(Object.keys(rebuilt!.entries).length, 2);
  });
});

Deno.test("getValidatedIndex: a torn line is repaired and dropped from the index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const [run] = await saveRunningRuns(repo, workflow, 1);
    const indexDir = localRunsDir(dir, workflow.id);
    await Deno.writeTextFile(getIndexPath(indexDir), '{"id":"x","en', {
      append: true,
    });

    const summaries = await repo.findAllSummariesFromIndex(workflow.id);

    assertEquals(summaries.map((s) => s.id), [run.id]);
    assertEquals((await readRunIndex(indexDir))?.damaged, undefined);
  });
});

Deno.test("findPersistedInputs: a record that does not parse reads as no inputs rather than failing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const [run] = await saveRunningRuns(repo, workflow, 1);
    await Deno.writeTextFile(repo.getPath(workflow.id, run.id), "status: [");

    assertEquals(
      await repo.findPersistedInputs(workflow.id, run.id),
      undefined,
    );
  });
});

Deno.test("save: compacting a damaged index past the bound repairs it, so later saves only append", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const indexDir = localRunsDir(dir, workflow.id);
    const [run] = await saveRunningRuns(repo, workflow, 1);
    const indexPath = getIndexPath(indexDir);
    await Deno.writeTextFile(indexPath, "torn\n", { append: true });
    const entry = (await readRunIndex(indexDir))!.entries[run.id];
    const filler = `${JSON.stringify({ id: run.id, entry })}\n`;
    await Deno.writeTextFile(
      indexPath,
      filler.repeat(Math.ceil(INDEX_COMPACTION_FLOOR_BYTES / filler.length)),
      { append: true },
    );

    run.interruptOrphaned("test", []);
    await repo.save(workflow.id, run);

    const repaired = await readRunIndex(indexDir);
    assertEquals(repaired?.damaged, undefined);
    assertEquals(repaired?.entries[run.id].status, "interrupted");
    assertEquals(
      (await Deno.readTextFile(indexPath)).trimEnd().split("\n").length,
      2,
    );
  });
});

function startFor(run: WorkflowRun, stepName: string, at = 1): StepStart {
  return StepStart.create({
    workflowId: run.workflowId,
    runId: run.id,
    jobName: run.jobs[0].jobName,
    stepName,
    startedAt: at,
  });
}

Deno.test("YamlWorkflowRunRepository.findStepStarts: reads the starts it wrote, under the run's own starts, outside the run records' listing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    const change = await repo.writeStepStart(startFor(run, "a"));
    await repo.writeStepStart(startFor(run, "b", 2));

    assert("put" in change);
    assertEquals(change.put.intent.kind, "run-start.save");
    assertEquals(
      change.put.key.toString(),
      `workflow-runs/${workflow.id}/starts/${run.id}/${
        startFor(run, "a").fileName
      }`,
    );
    const starts = await repo.findStepStarts(workflow.id, run.id);
    assertEquals(starts.map((start) => start.stepName).sort(), ["a", "b"]);
    assertEquals((await repo.findAllByWorkflowId(workflow.id)).length, 1);
  });
});

Deno.test("YamlWorkflowRunRepository.findStepStarts: skips a start filed under another run or another start's name", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    const other = WorkflowRun.create(workflow);
    await repo.writeStepStart(startFor(run, "a"));
    const startsDir = join(
      dirname(repo.getPath(workflow.id, run.id)),
      "starts",
      run.id,
    );
    const foreign = startFor(other, "q");
    await Deno.writeTextFile(
      join(startsDir, foreign.fileName),
      foreign.toYaml(),
    );
    await Deno.writeTextFile(
      join(startsDir, startFor(run, "z").fileName),
      startFor(run, "a", 5).toYaml(),
    );
    const starts = await repo.findStepStarts(workflow.id, run.id);
    assertEquals(starts.map((start) => start.stepName), ["a"]);
  });
});

Deno.test("YamlWorkflowRunRepository.deleteAllByWorkflowId: removes a run's starts with its record", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    await repo.save(workflow.id, run);
    await repo.writeStepStart(startFor(run, "a"));
    assertEquals(await repo.deleteAllByWorkflowId(workflow.id), 1);
    assertEquals(await repo.findStepStarts(workflow.id, run.id), []);
  });
});

/**
 * a repository staging typed changes whose engine answers the record's
 * committed version with `stored`, given the checkout's record bytes
 */
function withdrawalRepo(
  dir: string,
  stored: (bytes: Uint8Array) => PutExpect,
  forwards = false,
) {
  const { markDirty, uow, batches } = typedRecordingUnitOfWork();
  const repo = new YamlWorkflowRunRepository(
    dir,
    undefined,
    undefined,
    markDirty,
  );
  // the runs directory: a run's path is <runs>/<workflowId>/<record>
  const runsDir = dirname(dirname(repo.getPath(
    createWorkflowId(crypto.randomUUID()),
    createWorkflowRunId(crypto.randomUUID()),
  )));
  bindCommitLogEngine(markDirty, {
    forwardsToServe: forwards,
    storedVersion: async (_partition: unknown, key: string) =>
      stored(await Deno.readFile(join(runsDir, ...key.split("/").slice(1)))),
  } as unknown as CommitLogEngine);
  const withdrawn = () =>
    batches.flat().filter((change) =>
      "op" in change && change.op.kind === "tombstone" &&
      change.op.intent.kind === "run-start.delete"
    ).length;
  return { repo, uow, withdrawn };
}

async function settledRunWithStart(
  repo: YamlWorkflowRunRepository,
  uow: UnitOfWork,
  status: "unknown" | "succeeded" | "running" | "pending",
) {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  const step = run.jobs[0].steps[0];
  if (status !== "pending") step.start();
  if (status === "succeeded") step.succeed();
  if (status === "unknown") step.markUnknown("interrupted");
  await runInUnitOfWork(uow, () => repo.save(workflow.id, run));
  await repo.writeStepStart(startFor(run, step.stepName));
  return { workflow, run, stepName: step.stepName };
}

const digestOf = (bytes: Uint8Array) => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

for (const status of ["unknown", "succeeded"] as const) {
  Deno.test(`YamlWorkflowRunRepository.withdrawSettledStepStarts: withdraws the start of a step the committed record shows ${status}`, async () => {
    await withTempDir(async (dir) => {
      const { repo, uow, withdrawn } = withdrawalRepo(dir, digestOf);
      const { workflow, run, stepName } = await settledRunWithStart(
        repo,
        uow,
        status,
      );
      await runInUnitOfWork(
        uow,
        () => repo.withdrawSettledStepStarts(workflow.id, run.id, [stepName]),
      );
      assertEquals(withdrawn(), 1);
      assertEquals(await repo.findStepStarts(workflow.id, run.id), []);
    });
  });
}

for (const status of ["running", "pending"] as const) {
  Deno.test(`YamlWorkflowRunRepository.withdrawSettledStepStarts: keeps the start of a step the committed record shows ${status}`, async () => {
    await withTempDir(async (dir) => {
      const { repo, uow, withdrawn } = withdrawalRepo(dir, digestOf);
      const { workflow, run, stepName } = await settledRunWithStart(
        repo,
        uow,
        status,
      );
      await runInUnitOfWork(
        uow,
        () => repo.withdrawSettledStepStarts(workflow.id, run.id, [stepName]),
      );
      assertEquals(withdrawn(), 0);
      assertEquals(
        (await repo.findStepStarts(workflow.id, run.id)).length,
        1,
      );
    });
  });
}

Deno.test("YamlWorkflowRunRepository.withdrawSettledStepStarts: keeps the start when the record is not committed, or the committed record is not the checkout's", async () => {
  for (
    const stored of [
      (): PutExpect => "absent",
      (): PutExpect => ({ sha256: "0".repeat(64) }),
    ]
  ) {
    await withTempDir(async (dir) => {
      const { repo, uow, withdrawn } = withdrawalRepo(dir, stored);
      const { workflow, run, stepName } = await settledRunWithStart(
        repo,
        uow,
        "unknown",
      );
      await runInUnitOfWork(
        uow,
        () => repo.withdrawSettledStepStarts(workflow.id, run.id, [stepName]),
      );
      assertEquals(withdrawn(), 0);
      assertEquals(
        (await repo.findStepStarts(workflow.id, run.id)).length,
        1,
      );
    });
  }
});

Deno.test("YamlWorkflowRunRepository.withdrawSettledStepStarts: off v3 it withdraws nothing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    run.jobs[0].steps[0].start();
    run.jobs[0].steps[0].markUnknown("interrupted");
    await repo.save(workflow.id, run);
    await repo.writeStepStart(startFor(run, run.jobs[0].steps[0].stepName));
    await repo.withdrawSettledStepStarts(workflow.id, run.id, [
      run.jobs[0].steps[0].stepName,
    ]);
    assertEquals((await repo.findStepStarts(workflow.id, run.id)).length, 1);
  });
});

Deno.test("YamlWorkflowRunRepository.withdrawSettledStepStarts: through serve it withdraws nothing, so a member who may recover with run alone is not refused", async () => {
  await withTempDir(async (dir) => {
    const { repo, uow, withdrawn } = withdrawalRepo(dir, digestOf, true);
    const { workflow, run, stepName } = await settledRunWithStart(
      repo,
      uow,
      "unknown",
    );
    await runInUnitOfWork(
      uow,
      () => repo.withdrawSettledStepStarts(workflow.id, run.id, [stepName]),
    );
    assertEquals(withdrawn(), 0);
    assertEquals((await repo.findStepStarts(workflow.id, run.id)).length, 1);
  });
});

async function saveSlotRuns(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
  slots: (string | null)[],
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  for (const slot of slots) {
    const run = WorkflowRun.create(
      workflow,
      slot === null ? {} : { [SCHEDULED_FOR_TAG]: slot },
    );
    run.start();
    await repo.save(workflow.id, run);
    runs.push(run);
  }
  return runs;
}

async function collect<T>(runs: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const run of runs) out.push(run);
  return out;
}

const SLOTS = [
  "2026-10-01T09:00:00.000Z",
  "2026-12-01T09:00:00.000Z",
  null,
  "2026-11-01T09:00:00.000Z",
];

Deno.test("findByTimeTagLatestFirst: lists only tagged runs, latest tag first", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = await saveSlotRuns(repo, workflow, SLOTS);

    const found = await collect(
      repo.findByTimeTagLatestFirst(
        workflow.id,
        SCHEDULED_FOR_TAG,
        new AbortController().signal,
      ),
    );

    assertEquals(found.map((r) => r.id), [runs[1].id, runs[3].id, runs[0].id]);
  });
});

Deno.test("findByTimeTagLatestFirst: a caller that stops at the first run reads one record", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = await saveSlotRuns(repo, workflow, SLOTS);

    const [first, reads] = await countingRecordReads(async () => {
      for await (
        const run of repo.findByTimeTagLatestFirst(
          workflow.id,
          SCHEDULED_FOR_TAG,
          new AbortController().signal,
        )
      ) {
        return run;
      }
      return null;
    });

    assertEquals(first?.id, runs[1].id);
    assertEquals(reads, 1);
  });
});

Deno.test("findByTimeTagLatestFirst: without an index lists the same runs in the same order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const runs = await saveSlotRuns(repo, workflow, SLOTS);
    await Deno.remove(getIndexPath(localRunsDir(dir, workflow.id)));

    const found = await collect(
      repo.findByTimeTagLatestFirst(
        workflow.id,
        SCHEDULED_FOR_TAG,
        new AbortController().signal,
      ),
    );

    assertEquals(found.map((r) => r.id), [runs[1].id, runs[3].id, runs[0].id]);
  });
});

Deno.test("findByTimeTagLatestFirst: an aborted signal rejects with its reason", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    await saveSlotRuns(repo, workflow, SLOTS);
    const abort = new AbortController();
    abort.abort(new Error("out of time"));

    await assertRejects(
      () =>
        collect(
          repo.findByTimeTagLatestFirst(
            workflow.id,
            SCHEDULED_FOR_TAG,
            abort.signal,
          ),
        ),
      Error,
      "out of time",
    );
  });
});

Deno.test("YamlWorkflowRunRepository: a job run's fan-out plan round-trips through save and load (swamp-club#4379)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    run.start();
    const job = run.jobs[0];
    job.recordFanOutPlan(
      {
        kind: "planned",
        members: [
          { worker: "host-a", instanceUuid: "uuid-a", disposition: "dispatch" },
          {
            worker: "host-b",
            instanceUuid: "uuid-b",
            disposition: "failed",
            reason: "unverified",
          },
        ],
        plannedLanes: 1,
        maxFailures: null,
      },
      [["host-a"]],
    );
    await repo.save(workflow.id, run);

    const loaded = await repo.findById(workflow.id, run.id);
    assertNotEquals(loaded, null);
    const plan = loaded!.jobs[0].fanOutPlan;
    assertEquals(plan?.maxFailures, null);
    assertEquals(plan?.members[1].reason, "unverified");
    assertEquals(
      plan?.lanes.map((lane) => lane.name),
      [`${job.jobName}[host-a]`],
    );
    assertEquals(
      JSON.parse(JSON.stringify(loaded!.jobs[0].toData())),
      JSON.parse(JSON.stringify(job.toData())),
    );
  });
});

async function truncateRecord(
  repo: YamlWorkflowRunRepository,
  run: WorkflowRun,
): Promise<string> {
  const path = repo.getPath(createWorkflowId(run.workflowId), run.id);
  const content = await Deno.readTextFile(path);
  const cut = content.indexOf("workflowName:") + "workflowName: 'te".length;
  await Deno.writeTextFile(path, `${content.slice(0, cut)}'unterminated`);
  return path;
}

async function saveStarted(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const run = WorkflowRun.create(workflow);
  run.start();
  await repo.save(workflow.id, run);
  return run;
}

Deno.test("YamlWorkflowRunRepository.findById: a truncated record throws UnreadableRunRecordError naming the run and path, without quoting the record", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    const path = await truncateRecord(repo, run);

    const error = await assertRejects(
      () => repo.findById(workflow.id, run.id),
      UnreadableRunRecordError,
    );
    assertEquals(error.runId, run.id);
    assertEquals(error.path, path);
    assertEquals(error.code, "run_record_unreadable");
    assertEquals(error.message.includes("unterminated"), false);
  });
});

Deno.test("YamlWorkflowRunRepository.findById: a record that fails the schema is unreadable, without quoting it; an empty one still reads as no run", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    const path = repo.getPath(workflow.id, run.id);

    await Deno.writeTextFile(path, `id: ${run.id}\nsecret: hunter2\n`);
    const error = await assertRejects(
      () => repo.findById(workflow.id, run.id),
      UnreadableRunRecordError,
    );
    assertEquals(error.message.includes("hunter2"), false);

    await Deno.writeTextFile(path, "");
    assertEquals(await repo.findById(workflow.id, run.id), null);
  });
});

Deno.test("YamlWorkflowRunRepository.save: repairs an unreadable record, sends no second start event, and still sends the terminal event", async () => {
  await withTempDir(async (dir) => {
    const eventBus = new EventBus();
    const events: string[] = [];
    for (const type of ["WorkflowRunStarted", "WorkflowRunFailed"] as const) {
      eventBus.subscribe(type, (event) => {
        events.push(event.type);
        return Promise.resolve();
      });
    }
    const repo = new YamlWorkflowRunRepository(dir, eventBus);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    assertEquals(events, ["WorkflowRunStarted"]);

    await truncateRecord(repo, run);
    await repo.save(workflow.id, run);
    assertEquals(events, ["WorkflowRunStarted"]);
    assertEquals((await repo.findById(workflow.id, run.id))?.status, "running");

    await truncateRecord(repo, run);
    run.complete();
    await repo.save(workflow.id, run);
    assertEquals(events, ["WorkflowRunStarted", "WorkflowRunFailed"]);
    assertEquals((await repo.findById(workflow.id, run.id))?.status, "failed");
  });
});

function collectRunEvents(eventBus: EventBus): string[] {
  const events: string[] = [];
  for (
    const type of [
      "WorkflowRunStarted",
      "WorkflowRunCompleted",
      "WorkflowRunFailed",
    ] as const
  ) {
    eventBus.subscribe(type, (event) => {
      events.push(event.type);
      return Promise.resolve();
    });
  }
  return events;
}

Deno.test("YamlWorkflowRunRepository.save: a later save of the same run takes its previous status from the last save, not from the record on disk", async () => {
  await withTempDir(async (dir) => {
    const eventBus = new EventBus();
    const events = collectRunEvents(eventBus);
    const repo = new YamlWorkflowRunRepository(dir, eventBus);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    const path = repo.getPath(workflow.id, run.id);
    const content = await Deno.readTextFile(path);
    await Deno.writeTextFile(
      path,
      content.replace(/^status: running$/m, "status: pending"),
    );
    assertEquals((await repo.findById(workflow.id, run.id))?.status, "pending");

    await repo.save(workflow.id, run);

    assertEquals(events, ["WorkflowRunStarted"]);
    assertEquals((await repo.findById(workflow.id, run.id))?.status, "running");
  });
});

Deno.test("YamlWorkflowRunRepository.save: a run object new to the repository takes its previous status from the record, so a copy sends no second start event", async () => {
  await withTempDir(async (dir) => {
    const eventBus = new EventBus();
    const events = collectRunEvents(eventBus);
    const repo = new YamlWorkflowRunRepository(dir, eventBus);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);

    const copy = WorkflowRun.fromData(run.toPersistedData());
    await repo.save(workflow.id, copy);
    assertEquals(events, ["WorkflowRunStarted"]);

    copy.complete();
    await repo.save(workflow.id, copy);
    assertEquals(events, ["WorkflowRunStarted", "WorkflowRunFailed"]);
  });
});

Deno.test("YamlWorkflowRunRepository.save: a run object new to the repository repairs an unreadable record and sends no second start event", async () => {
  await withTempDir(async (dir) => {
    const eventBus = new EventBus();
    const events = collectRunEvents(eventBus);
    const repo = new YamlWorkflowRunRepository(dir, eventBus);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    await truncateRecord(repo, run);

    const copy = WorkflowRun.fromData(run.toPersistedData());
    await repo.save(workflow.id, copy);
    assertEquals(events, ["WorkflowRunStarted"]);
    assertEquals((await repo.findById(workflow.id, run.id))?.status, "running");

    copy.complete();
    await repo.save(workflow.id, copy);
    assertEquals(events, ["WorkflowRunStarted", "WorkflowRunFailed"]);
  });
});

Deno.test("YamlWorkflowRunRepository.save: a save the fence refuses records no status, so the next save still sends the terminal event", async () => {
  await withTempDir(async (dir) => {
    const eventBus = new EventBus();
    const events = collectRunEvents(eventBus);
    const repo = new YamlWorkflowRunRepository(dir, eventBus);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);

    run.complete();
    let refusals = 0;
    await repo.save(workflow.id, run, {
      fence: { isClosed: () => true, isTakenOver: () => false },
      onRefused: () => {
        refusals++;
      },
    });
    assertEquals(refusals, 1);
    assertEquals(events, ["WorkflowRunStarted"]);

    await repo.save(workflow.id, run);
    assertEquals(events, ["WorkflowRunStarted", "WorkflowRunFailed"]);
    assertEquals((await repo.findById(workflow.id, run.id))?.status, "failed");
  });
});

Deno.test("YamlWorkflowRunRepository.save: without an event bus every save still writes the run", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    assertEquals((await repo.findById(workflow.id, run.id))?.status, "running");

    run.complete();
    await repo.save(workflow.id, run);
    assertEquals((await repo.findById(workflow.id, run.id))?.status, "failed");
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalByStatus: leaves out an unreadable record and returns the others", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const damaged = await saveStarted(repo, workflow);
    const healthy = await saveStarted(repo, workflow);
    await truncateRecord(repo, damaged);

    const running = await repo.findGlobalByStatus("running");
    assertEquals(running.map(({ run }) => run.id), [healthy.id]);
  });
});

Deno.test("YamlWorkflowRunRepository.findGlobalByStatus: when an index rebuild hits an unreadable record, the workflow's other runs and other workflows are still found", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const other = createTestWorkflow2();
    const damaged = await saveStarted(repo, workflow);
    const sibling = await saveStarted(repo, workflow);
    const finished = await saveStarted(repo, workflow);
    finished.complete();
    await repo.save(workflow.id, finished);
    const elsewhere = await saveStarted(repo, other);
    const path = await truncateRecord(repo, damaged);
    await Deno.remove(join(dirname(path), ".runs-index.json"));

    const running = await repo.findGlobalByStatus("running");
    assertEquals(
      running.map(({ run }) => run.id as string).sort(),
      [sibling.id as string, elsewhere.id as string].sort(),
    );
  });
});

Deno.test("YamlWorkflowRunRepository.findById: a logFile that is not a string is unreadable, not a raw path error", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    const path = repo.getPath(workflow.id, run.id);
    await Deno.writeTextFile(
      path,
      `${await Deno.readTextFile(path)}logFile: 5\n`,
    );

    await assertRejects(
      () => repo.findById(workflow.id, run.id),
      UnreadableRunRecordError,
    );
  });
});

Deno.test("YamlWorkflowRunRepository: the other scans throw on an unreadable record, so a guard or a caller that decides for itself still sees it", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const damaged = await saveStarted(repo, workflow);
    const path = await truncateRecord(repo, damaged);
    await Deno.remove(join(dirname(path), ".runs-index.json"));

    for (
      const scan of [
        () => repo.findAllByWorkflowId(workflow.id),
        () => repo.findAllGlobalSince(new Date(0)),
        () => repo.findAllSummariesFromIndex(workflow.id),
      ]
    ) {
      await assertRejects(scan, UnreadableRunRecordError);
    }
  });
});

Deno.test("YamlWorkflowRunRepository.findUnreadableRuns: finds a running run with or without an index, and an empty record too", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const damaged = await saveStarted(repo, workflow);
    const path = await truncateRecord(repo, damaged);

    const indexed = await repo.findUnreadableRuns();
    assertEquals(indexed.map((run) => run.runId), [damaged.id]);
    assertEquals(indexed[0].workflowName, workflow.name);
    assertEquals(indexed[0].path, path);

    await Deno.remove(join(dirname(path), ".runs-index.json"));
    const rebuilt = await repo.findUnreadableRuns();
    assertEquals(rebuilt.map((run) => run.runId), [damaged.id]);

    await Deno.writeTextFile(path, "");
    const empty = await repo.findUnreadableRuns();
    assertEquals(empty.map((run) => run.reason), ["it is empty"]);
  });
});

Deno.test("YamlWorkflowRunRepository.findUnreadableRuns: finds a damaged interrupted run, and tells a cut-short record from one that fails the schema", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    run.interrupt("test");
    await repo.save(workflow.id, run);
    const path = await truncateRecord(repo, run);

    assertEquals((await repo.findUnreadableRuns())[0].damaged, true);

    await Deno.writeTextFile(path, `id: ${run.id}\nstatus: new\n`);
    assertEquals((await repo.findUnreadableRuns())[0].damaged, false);
  });
});

Deno.test("YamlWorkflowRunRepository.findUnreadableRuns: does not read a record the index lists as finished", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    run.complete();
    await repo.save(workflow.id, run);
    await truncateRecord(repo, run);

    assertEquals(await repo.findUnreadableRuns(), []);
  });
});

Deno.test("YamlWorkflowRunRepository.isRunDamaged: follows the record as it is now, and a whole record that fails the schema is not damaged", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = await saveStarted(repo, workflow);
    const check = () => repo.isRunDamaged(workflow.id, run.id);
    assertEquals(await check(), false);

    const path = await truncateRecord(repo, run);
    assertEquals(await check(), true);

    await Deno.writeTextFile(path, "id: 'unterminated");
    assertEquals(await check(), true);

    await Deno.writeTextFile(path, "");
    assertEquals(await check(), true);

    for (
      const whole of [
        `id: ${run.id}\nstatus: new\n`,
        `id: ${run.id}\nlogFile: 5\n`,
        `id: ${run.id}\nlogFile: {path: x}\n`,
        "just-a-scalar\n",
        "id: 'unterminated\n",
        "0\n",
      ]
    ) {
      await Deno.writeTextFile(path, whole);
      assertEquals(await check(), false, whole);
    }

    await Deno.remove(path);
    assertEquals(await check(), false);
  });
});

const START_KEY = { lookup: "lookup-1", salt: "salt", fingerprint: "print" };

async function savedRunWithStartKey(
  repo: YamlWorkflowRunRepository,
): Promise<
  { workflow: ReturnType<typeof createTestWorkflow>; run: WorkflowRun }
> {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.recordStartKey(START_KEY);
  run.start();
  await repo.save(workflow.id, run);
  return { workflow, run };
}

Deno.test("runIndexSnapshot: finds a run by its start key, and the record holds the whole key", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const { workflow, run } = await savedRunWithStartKey(repo);

    const snapshot = await repo.runIndexSnapshot(workflow.id);
    assertEquals(snapshot.withStartKey("lookup-1")?.summary.id, run.id);
    assertEquals(snapshot.withStartKey("other"), undefined);
    assertEquals(
      (await repo.findById(workflow.id, run.id))!.startKey,
      START_KEY,
    );
  });
});

Deno.test("runIndexSnapshot: a start key survives a later save of the run", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const { workflow, run } = await savedRunWithStartKey(repo);
    run.suspend();
    await repo.save(workflow.id, run);

    const fresh = new YamlWorkflowRunRepository(dir);
    const snapshot = await fresh.runIndexSnapshot(workflow.id);
    assertEquals(snapshot.withStartKey("lookup-1")?.summary.id, run.id);
    assertEquals(
      snapshot.withStartKey("lookup-1")?.summary.status,
      "suspended",
    );
  });
});

Deno.test("runIndexSnapshot: a start key survives rebuilding a deleted index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const { workflow, run } = await savedRunWithStartKey(repo);
    await Deno.remove(getIndexPath(runsDirOf(dir, workflow.id)));

    const fresh = new YamlWorkflowRunRepository(dir);
    const snapshot = await fresh.runIndexSnapshot(workflow.id);
    assertEquals(snapshot.withStartKey("lookup-1")?.summary.id, run.id);
  });
});

Deno.test("runIndexSnapshot: a start key survives repairing a torn index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const { workflow, run } = await savedRunWithStartKey(repo);
    const indexPath = getIndexPath(runsDirOf(dir, workflow.id));
    await Deno.writeTextFile(
      indexPath,
      (await Deno.readTextFile(indexPath)) + "{not json\n",
    );

    const fresh = new YamlWorkflowRunRepository(dir);
    const snapshot = await fresh.runIndexSnapshot(workflow.id);
    assertEquals(snapshot.withStartKey("lookup-1")?.summary.id, run.id);
  });
});

Deno.test("runIndexSnapshot: a malformed start key in the index is dropped, not fatal", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const { workflow, run } = await savedRunWithStartKey(repo);
    const indexPath = getIndexPath(runsDirOf(dir, workflow.id));
    const text = await Deno.readTextFile(indexPath);
    await Deno.writeTextFile(
      indexPath,
      text.replaceAll('"startKeyLookup":"lookup-1"', '"startKeyLookup":7'),
    );

    const fresh = new YamlWorkflowRunRepository(dir);
    const snapshot = await fresh.runIndexSnapshot(workflow.id);
    assertEquals(snapshot.get(run.id)?.summary.id, run.id);
  });
});

Deno.test("findById: a run without a start key still reads, and its summary has none", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = createTestWorkflow();
    const run = WorkflowRun.create(workflow);
    await repo.save(workflow.id, run);
    assertEquals(
      (await repo.findById(workflow.id, run.id))!.startKey,
      undefined,
    );
    const snapshot = await repo.runIndexSnapshot(workflow.id);
    assertEquals(snapshot.get(run.id)?.summary.startKeyLookup, undefined);
  });
});

Deno.test("runIndexSnapshot: a start key survives compacting the index", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const { workflow, run } = await savedRunWithStartKey(repo);
    await compactRunIndex(runsDirOf(dir, workflow.id));

    const fresh = new YamlWorkflowRunRepository(dir);
    const snapshot = await fresh.runIndexSnapshot(workflow.id);
    assertEquals(snapshot.withStartKey("lookup-1")?.summary.id, run.id);
  });
});
