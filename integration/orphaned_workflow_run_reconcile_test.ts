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

// A `workflow run` or `resume` force-exited by a second Ctrl-C leaves its
// run record `running` under a dead pid, with its tracker row `running`
// too (swamp-club#2896). These tests wire the real YAML run repository and
// SQLite run tracker together and check that `run doctor --fix` settles such
// a run so `workflow recover` accepts it, without touching runs it cannot
// vouch for.

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { hostname } from "node:os";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import {
  assessRecoveryForRun,
  findInterruptedRun,
} from "../src/domain/workflows/recovery_assessment.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { diagnoseLocalRuns } from "../src/cli/commands/run.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../src/infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

// Far above any real pid_max, so never a live process.
const DEAD_PID = 2147483647;

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-orphaned-run-" });
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

function oneStepWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "gate", task: StepTask.manualApproval("Go?") }),
          Step.create({ name: "s", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
}

/** The record a force exit leaves: gate done, step `s` in flight. */
function strandedRun(workflow: Workflow, pid: number): WorkflowRun {
  const startedAt = new Date().toISOString();
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "running",
    startedAt,
    pid,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt,
      steps: [
        { stepName: "gate", status: "succeeded", startedAt },
        { stepName: "s", status: "running", startedAt },
      ],
    }],
    tags: {},
  });
}

function register(
  tracker: RunTrackerStore,
  run: WorkflowRun,
  pid: number,
  host = hostname(),
): void {
  tracker.register(ActiveRun.createWorkflowRun({
    id: run.id,
    workflowName: run.workflowName,
    pid,
    hostname: host,
  }));
}

Deno.test("run doctor --fix: settles a force-exited parent run and its nested child so recover accepts them", async () => {
  await withRepo(async (repoDir) => {
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    const parentWf = oneStepWorkflow("parent");
    const childWf = oneStepWorkflow("child");
    await repoContext.workflowRepo.save(parentWf);
    await repoContext.workflowRepo.save(childWf);

    // A nested workflow step runs its child in the same process.
    const parent = strandedRun(parentWf, DEAD_PID);
    const child = strandedRun(childWf, DEAD_PID);
    // A run another host owns through a shared datastore: same dead-looking
    // pid, but no row in this host's tracker.
    const foreign = strandedRun(parentWf, DEAD_PID);
    await repoContext.workflowRunRepo.save(parentWf.id, parent);
    await repoContext.workflowRunRepo.save(childWf.id, child);
    await repoContext.workflowRunRepo.save(parentWf.id, foreign);

    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    try {
      register(tracker, parent, DEAD_PID);
      register(tracker, child, DEAD_PID);

      const result = await diagnoseLocalRuns(
        tracker,
        repoContext.workflowRunRepo,
        repoContext.workflowRepo,
        repoContext.outputRepo,
        localOwnerLiveness(),
        true,
      );

      assertEquals(result.reaped, 2);
      assertEquals(result.orphanedWorkflowRuns, 2);
      assertEquals(result.orphanedReaped, 2);
      assertEquals(tracker.findById(parent.id)?.status, "interrupted");
      assertEquals(tracker.findById(child.id)?.status, "interrupted");
    } finally {
      tracker.close();
    }

    // Read back through a fresh context, as the next command would.
    const { repoContext: fresh } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    for (const [wf, run] of [[parentWf, parent], [childWf, child]] as const) {
      const stored = await fresh.workflowRunRepo.findById(
        wf.id,
        createWorkflowRunId(run.id),
      );
      assertEquals(stored?.status, "interrupted");
      assertEquals(stored?.tags["interrupt_reason"], "owner_process_dead");
      assertEquals(
        stored?.jobs[0].steps.map((s) => s.status),
        ["succeeded", "unknown"],
      );
    }

    const recoverable = await findInterruptedRun(
      parentWf,
      fresh.workflowRunRepo,
      parent.id,
    );
    assertEquals(recoverable?.id, parent.id);
    const assessment = await assessRecoveryForRun(parentWf, recoverable!);
    assertEquals(assessment.unguardedSteps, ["s"]);

    const untouched = await fresh.workflowRunRepo.findById(
      parentWf.id,
      createWorkflowRunId(foreign.id),
    );
    assertEquals(untouched?.status, "running");
  });
});

Deno.test("run doctor --fix: leaves a run alone while its owner is alive", async () => {
  await withRepo(async (repoDir) => {
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    const wf = oneStepWorkflow("live");
    await repoContext.workflowRepo.save(wf);
    const run = strandedRun(wf, Deno.pid);
    await repoContext.workflowRunRepo.save(wf.id, run);

    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    try {
      register(tracker, run, Deno.pid);

      const result = await diagnoseLocalRuns(
        tracker,
        repoContext.workflowRunRepo,
        repoContext.workflowRepo,
        repoContext.outputRepo,
        localOwnerLiveness(),
        true,
      );

      assertEquals(result.orphanedWorkflowRuns, 0);
      assertEquals(tracker.findById(run.id)?.status, "running");
    } finally {
      tracker.close();
    }

    const stored = await repoContext.workflowRunRepo.findById(
      wf.id,
      createWorkflowRunId(run.id),
    );
    assertEquals(stored?.status, "running");
  });
});
