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

// a serve killed with -9 and started again gets a new instance id; its boot
// must still settle the run it left running, but not a live peer serve's run

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { hostname } from "node:os";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import { reapOrphanedWorkflowRuns } from "../src/domain/workflows/orphaned_run_reaper.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { isProcessGone } from "../src/infrastructure/runtime/process.ts";
import { DEFAULT_STALE_TTL_MS } from "../src/serve/instance_heartbeat.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

// Far above any real pid_max, so never a live process.
const DEAD_PID = 2147483647;

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-serve-restart-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function sleepWorkflow(): Workflow {
  return Workflow.create({
    name: "sleepwf",
    jobs: [
      Job.create({
        name: "main",
        steps: [Step.create({ name: "s", task: StepTask.model("m", "run") })],
      }),
    ],
  });
}

function runOf(
  workflow: Workflow,
  pid: number,
  instanceId: string,
): WorkflowRun {
  const startedAt = new Date().toISOString();
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "running",
    startedAt,
    pid,
    instanceId,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt,
      steps: [{ stepName: "s", status: "running", startedAt }],
    }],
    tags: {},
  });
}

Deno.test("serve boot: a restarted serve settles the run its killed instance left running, and leaves a live peer's run", async () => {
  await withRepo(async (repoDir) => {
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    const workflow = sleepWorkflow();
    await repoContext.workflowRepo.save(workflow);
    const runRepo = repoContext.workflowRunRepo;

    const killed = runOf(workflow, DEAD_PID, "killed-instance");
    const peer = runOf(workflow, Deno.pid, "peer-instance");
    await runRepo.save(workflow.id, killed);
    await runRepo.save(workflow.id, peer);

    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    try {
      for (
        const [run, instanceId] of [[killed, "killed-instance"], [
          peer,
          "peer-instance",
        ]] as const
      ) {
        tracker.register(ActiveRun.createWorkflowRun({
          id: run.id,
          workflowName: workflow.name,
          pid: run.pid!,
          hostname: hostname(),
          instanceId,
        }));
      }

      // serve's boot order, run by the new instance well inside the stale TTL
      const restarted = "restarted-instance";
      tracker.reapStaleRuns(DEFAULT_STALE_TTL_MS, restarted);
      tracker.reapDeadProcessRuns(restarted);
      const result = await reapOrphanedWorkflowRuns(
        await runRepo.findGlobalByStatus("running"),
        async (wid, r) => {
          await runRepo.save(wid, r);
          tracker.markSettled(r.id, "server_crash");
        },
        (wid, r) => runRepo.findStepStarts(wid, r.id),
        (runId) => {
          const tracked = tracker.findById(runId);
          return tracked
            ? { status: tracked.status, instanceId: tracked.instanceId }
            : null;
        },
        isProcessGone,
        restarted,
      );

      assertEquals(result, { reaped: 1, skipped: 1 });
      const settled = await runRepo.findById(workflow.id, killed.id);
      assertEquals(settled?.status, "interrupted");
      assertEquals(settled?.tags["interrupt_reason"], "server_crash");
      assertEquals(
        (await runRepo.findById(workflow.id, peer.id))?.status,
        "running",
      );
      assertEquals(tracker.findById(peer.id)?.status, "running");
    } finally {
      tracker.close();
    }
  });
});
