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

// A run left `running` by a serve process that died is cleared by a cancel
// through its run id, and the status index follows the record
// (swamp-club#2518). Wires the real run repository, run tracker and cancel
// use case on a temp filesystem.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { hostname } from "node:os";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowCancelSuspendedDeps,
  workflowCancelSuspended,
} from "../src/libswamp/mod.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../src/infrastructure/persistence/run_tracker_store.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import { runHasDeadOwner } from "../src/domain/workflows/orphaned_run_reaper.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  OWNER_STOPPED_STEP_ERROR,
  WorkflowRun,
} from "../src/domain/workflows/workflow_run.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";

/** A pid no process has: the largest a 32-bit pid_t holds. */
const DEAD_PID = 2147483647;

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

function makeWorkflow(): Workflow {
  return Workflow.create({
    name: `deploy-${crypto.randomUUID()}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "work", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
}

function trackerRow(run: WorkflowRun, pid: number): ActiveRun {
  const now = new Date().toISOString();
  return ActiveRun.fromData({
    id: run.id,
    runKind: "workflow",
    modelType: null,
    methodName: null,
    workflowName: run.workflowName,
    pid,
    hostname: hostname(),
    instanceId: "previous-serve-instance",
    startedAt: now,
    heartbeatAt: now,
    status: "running",
  });
}

for (
  const { name, pid, cancelled } of [
    { name: "a dead owner", pid: DEAD_PID, cancelled: true },
    { name: "a live owner", pid: Deno.pid, cancelled: false },
  ]
) {
  Deno.test(
    `dead-owner cancel: a running run with ${name} is ${
      cancelled ? "cancelled and leaves the running index" : "left running"
    }`,
    async () => {
      await withTempDir(async (dir) => {
        const workflowRepo = new YamlWorkflowRepository(dir);
        const runRepo = new YamlWorkflowRunRepository(dir);
        const tracker = new RunTrackerStore(join(dir, "run_tracker.db"));
        try {
          const workflow = makeWorkflow();
          await workflowRepo.save(workflow);
          const run = WorkflowRun.create(workflow);
          run.start(pid, "previous-serve-instance");
          run.getJob("main")!.start();
          run.getJob("main")!.getStep("work")!.start();
          await runRepo.save(workflow.id, run);
          tracker.register(trackerRow(run, pid));

          const deps = createWorkflowCancelSuspendedDeps(
            workflowRepo,
            runRepo,
            () => true,
            () => Promise.resolve(null),
            tracker,
            (r) => runHasDeadOwner(r, tracker, localOwnerLiveness()),
          );
          const events = await collect(
            workflowCancelSuspended(createLibSwampContext(), deps, {
              runId: run.id,
              reason: "cancelled by test",
            }),
          );

          const stored = await runRepo.findById(workflow.id, run.id);
          const running = await runRepo.findGlobalByStatus("running");
          if (cancelled) {
            assertEquals(events.at(-1)?.kind, "completed");
            assertEquals(stored?.status, "cancelled");
            assertEquals(
              stored?.getJob("main")?.getStep("work")?.error,
              OWNER_STOPPED_STEP_ERROR,
            );
            assertEquals(running, []);
            assertEquals(tracker.findById(run.id)?.status, "cancelled");
          } else {
            assertEquals(events.at(-1)?.kind, "error");
            assertEquals(stored?.status, "running");
            assertEquals(running.map((r) => r.run.id), [run.id]);
            assertEquals(tracker.findById(run.id)?.status, "running");
          }
        } finally {
          tracker.close();
        }
      });
    },
  );
}
