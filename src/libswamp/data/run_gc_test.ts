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
  runGc,
  type RunGcDeps,
  runGcInputFromPolicy,
  runGcPreview,
  runGcRetentionFromPolicy,
} from "./run_gc.ts";
import { createLibSwampContext } from "../context.ts";
import { getLogger } from "@logtape/logtape";
import { join } from "@std/path";
import { createRunGcDeps } from "./run_gc.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";

function createMockCtx() {
  return createLibSwampContext({ logger: getLogger(["test"]) });
}

function createMockDeps(result: {
  workflowRunsDeleted: number;
  workflowRunBytesReclaimed: number;
  outputsDeleted: number;
  outputBytesReclaimed: number;
  snapshotsDeleted?: number;
  snapshotBytesReclaimed?: number;
  dryRun: boolean;
}): RunGcDeps {
  return {
    gcAll: () =>
      Promise.resolve({
        snapshotsDeleted: 0,
        snapshotBytesReclaimed: 0,
        more: false,
        ...result,
      }),
  };
}

Deno.test("runGcPreview: returns preview with dryRun=true", async () => {
  const deps = createMockDeps({
    workflowRunsDeleted: 10,
    workflowRunBytesReclaimed: 5000,
    outputsDeleted: 5,
    outputBytesReclaimed: 2000,
    snapshotsDeleted: 4,
    snapshotBytesReclaimed: 400,
    dryRun: true,
  });

  const preview = await runGcPreview(createMockCtx(), deps, {
    dryRun: false,
    workflowRunRetentionDays: 7,
    outputRetentionDays: 7,
  });

  assertEquals(preview.workflowRunsToDelete, 10);
  assertEquals(preview.workflowRunBytesReclaimable, 5000);
  assertEquals(preview.outputsToDelete, 5);
  assertEquals(preview.outputBytesReclaimable, 2000);
  assertEquals(preview.evaluatedSnapshotsToDelete, 4);
  assertEquals(preview.evaluatedSnapshotBytesReclaimable, 400);
  assertEquals(preview.totalBytesReclaimable, 7400);
});

Deno.test("runGc: yields collecting then completed events", async () => {
  const deps = createMockDeps({
    workflowRunsDeleted: 3,
    workflowRunBytesReclaimed: 1500,
    outputsDeleted: 2,
    outputBytesReclaimed: 800,
    snapshotsDeleted: 6,
    snapshotBytesReclaimed: 600,
    dryRun: false,
  });

  const events = [];
  for await (
    const event of runGc(createMockCtx(), deps, {
      dryRun: false,
      workflowRunRetentionDays: 30,
      outputRetentionDays: 30,
    })
  ) {
    events.push(event);
  }

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "collecting");
  assertEquals(events[1].kind, "completed");
  if (events[1].kind === "completed") {
    assertEquals(events[1].data.workflowRunsDeleted, 3);
    assertEquals(events[1].data.outputsDeleted, 2);
    assertEquals(events[1].data.evaluatedSnapshotsDeleted, 6);
    assertEquals(events[1].data.evaluatedSnapshotBytesReclaimed, 600);
    assertEquals(events[1].data.totalBytesReclaimed, 2900);
    assertEquals(events[1].data.dryRun, false);
  }
});

Deno.test("runGc: uses default retention when not specified", async () => {
  let capturedOptions: Record<string, unknown> | undefined;
  const deps: RunGcDeps = {
    gcAll: (options) => {
      capturedOptions = options;
      return Promise.resolve({
        workflowRunsDeleted: 0,
        workflowRunBytesReclaimed: 0,
        outputsDeleted: 0,
        outputBytesReclaimed: 0,
        snapshotsDeleted: 0,
        snapshotBytesReclaimed: 0,
        dryRun: true,
        more: false,
      });
    },
  };

  for await (
    const _event of runGc(createMockCtx(), deps, { dryRun: true })
  ) {
    // consume
  }

  assertEquals(capturedOptions?.workflowRunRetentionDays, 30);
  assertEquals(capturedOptions?.outputRetentionDays, 30);
  assertEquals(capturedOptions?.dryRun, true);
});

Deno.test("runGcRetentionFromPolicy: maps independent retention durations", () => {
  assertEquals(
    runGcRetentionFromPolicy({ workflowRuns: "2w", outputs: "1d" }),
    { workflowRunRetentionDays: 14, outputRetentionDays: 1 },
  );
});

Deno.test("runGcInputFromPolicy: uses configured retention unless overridden", () => {
  assertEquals(
    runGcInputFromPolicy(false, { workflowRuns: "2w", outputs: "1d" }),
    { dryRun: false, workflowRunRetentionDays: 14, outputRetentionDays: 1 },
  );
  assertEquals(
    runGcInputFromPolicy(false, { workflowRuns: "2w", outputs: "1d" }, 3),
    { dryRun: false, workflowRunRetentionDays: 3, outputRetentionDays: 3 },
  );
});

Deno.test("runGcRetentionFromPolicy: falls back to retention for kinds without their own key", () => {
  assertEquals(
    runGcRetentionFromPolicy({ retention: "1w", outputs: "1d" }),
    {
      workflowRunRetentionDays: 7,
      outputRetentionDays: 1,
      evaluatedSnapshotRetentionDays: 7,
    },
  );
});

Deno.test("runGcRetentionFromPolicy: maps evaluatedSnapshots to the snapshot retention", () => {
  assertEquals(
    runGcRetentionFromPolicy({ workflowRuns: "2w", evaluatedSnapshots: "3d" }),
    {
      workflowRunRetentionDays: 14,
      outputRetentionDays: undefined,
      evaluatedSnapshotRetentionDays: 3,
    },
  );
});

Deno.test("runGcInputFromPolicy: the override wins over kind keys and retention, and drops the snapshot retention", () => {
  assertEquals(
    runGcInputFromPolicy(
      true,
      { retention: "1w", workflowRuns: "2w", evaluatedSnapshots: "3d" },
      5,
    ),
    { dryRun: true, workflowRunRetentionDays: 5, outputRetentionDays: 5 },
  );
  assertEquals(
    runGcInputFromPolicy(false, {
      workflowRuns: "2w",
      evaluatedSnapshots: "3d",
    }),
    {
      dryRun: false,
      workflowRunRetentionDays: 14,
      outputRetentionDays: undefined,
      evaluatedSnapshotRetentionDays: 3,
    },
  );
});

Deno.test("runGc: passes the snapshot retention to gcAll only when set", async () => {
  const captured: Record<string, unknown>[] = [];
  const deps: RunGcDeps = {
    gcAll: (options) => {
      captured.push(options);
      return Promise.resolve({
        workflowRunsDeleted: 0,
        workflowRunBytesReclaimed: 0,
        outputsDeleted: 0,
        outputBytesReclaimed: 0,
        snapshotsDeleted: 0,
        snapshotBytesReclaimed: 0,
        dryRun: false,
        more: false,
      });
    },
  };

  for await (
    const _event of runGc(createMockCtx(), deps, {
      dryRun: false,
      evaluatedSnapshotRetentionDays: 3,
    })
  ) {
    // consume
  }
  for await (const _event of runGc(createMockCtx(), deps, { dryRun: false })) {
    // consume
  }

  assertEquals(captured[0].snapshotRetentionDays, 3);
  assertEquals("snapshotRetentionDays" in captured[1], false);
});

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

Deno.test("createRunGcDeps: a snapshot retention removes a finished run's old snapshot and keeps a running run's", async () => {
  await withTempDir(async (dir) => {
    const workflow = Workflow.create({
      id: crypto.randomUUID(),
      name: "snapshot-retention",
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
    const runRepo = new YamlWorkflowRunRepository(dir);
    const snapshotRepo = new YamlEvaluatedWorkflowRepository(dir);
    // Finished ten days ago, as old as its snapshot: a run that finished
    // recently keeps its snapshot however old (see run_lifecycle_service).
    const base = WorkflowRun.create(workflow);
    base.start();
    const tenDaysAgoIso = new Date(Date.now() - 10 * 86_400_000)
      .toISOString();
    const finished = WorkflowRun.fromData({
      ...base.toData(),
      status: "cancelled",
      startedAt: tenDaysAgoIso,
      completedAt: tenDaysAgoIso,
    });
    await runRepo.save(workflow.id, finished);
    const running = WorkflowRun.create(workflow);
    running.start();
    await runRepo.save(workflow.id, running);
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    for (const run of [finished, running]) {
      await snapshotRepo.saveForRun(run.id, workflow);
    }
    for (const snapshot of await snapshotRepo.listRunSnapshots()) {
      await Deno.utime(
        join(
          dir,
          ".swamp",
          "workflows-evaluated",
          "runs",
          snapshot.runId,
          "evaluated-workflow.yaml",
        ),
        tenDaysAgo,
        tenDaysAgo,
      );
    }

    const deps = createRunGcDeps(dir);
    const keptByDefault = await deps.gcAll({
      workflowRunRetentionDays: 30,
      outputRetentionDays: 30,
      dryRun: false,
    });
    assertEquals(keptByDefault.snapshotsDeleted, 0);

    const result = await deps.gcAll({
      workflowRunRetentionDays: 30,
      outputRetentionDays: 30,
      dryRun: false,
      snapshotRetentionDays: 7,
    });

    assertEquals(result.workflowRunsDeleted, 0);
    assertEquals(result.snapshotsDeleted, 1);
    assertEquals(
      (await snapshotRepo.listRunSnapshots()).map((s) => s.runId),
      [running.id],
    );
  });
});
