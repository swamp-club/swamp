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
// A workflow step saves its method-run record `running` before it finishes,
// so an owner that dies mid-step leaves that record `running` under a dead
// pid (swamp-club#2930). These tests wire the real output repository and
// SQLite run tracker together, with the row and record written as a step
// writes them, and check that run doctor --fix and workflow recover settle
// the record without touching ones they cannot vouch for.

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import {
  createModelOutputId,
  ModelOutput,
} from "../src/domain/models/model_output.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import type { OutputRepository } from "../src/domain/models/repositories.ts";
import {
  ownerExitedReason,
  settleDeadOwnerRun,
} from "../src/domain/workflows/orphaned_run_reaper.ts";
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

// A raw type whose normalized form differs, as an extension type's can: the
// row stores the normalized form, the step saves under the raw one.
const RAW_TYPE = "Test::Orphan::Shell";

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-orphaned-method-" });
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

/**
 * A step's method run as the execution service starts it: the record saved
 * `running` under `pid`, then a model_method row with the record's id and
 * the normalized model type.
 */
async function startStepMethodRun(
  outputRepo: OutputRepository,
  tracker: RunTrackerStore,
  pid: number,
  host = hostname(),
): Promise<ModelOutput> {
  const modelType = ModelType.create(RAW_TYPE);
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "execute",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "workflow",
    },
  });
  output.markRunning(pid);
  await outputRepo.save(modelType, "execute", output);
  tracker.register(ActiveRun.createModelMethodRun({
    id: output.id,
    modelType: modelType.normalized,
    methodName: "execute",
    pid,
    hostname: host,
  }));
  return output;
}

async function statusOf(
  outputRepo: OutputRepository,
  output: ModelOutput,
): Promise<ModelOutput | null> {
  return await outputRepo.findById(
    ModelType.create(RAW_TYPE),
    "execute",
    createModelOutputId(output.id),
  );
}

function settledReason(repoDir: string, id: string): string | null {
  const db = new DatabaseSync(join(swampPath(repoDir), "run_tracker.db"));
  try {
    return (db.prepare("SELECT cancel_reason FROM active_runs WHERE id = ?")
      .get(id) as { cancel_reason: string | null }).cancel_reason;
  } finally {
    db.close();
  }
}

Deno.test("run doctor --fix: cancels the method run a dead owner left running, and only that one", async () => {
  await withRepo(async (repoDir) => {
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    const outputRepo = repoContext.outputRepo;
    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    try {
      const orphan = await startStepMethodRun(outputRepo, tracker, DEAD_PID);
      const live = await startStepMethodRun(outputRepo, tracker, Deno.pid);
      const remote = await startStepMethodRun(
        outputRepo,
        tracker,
        DEAD_PID,
        "other-host",
      );

      const result = await diagnoseLocalRuns(
        tracker,
        repoContext.workflowRunRepo,
        repoContext.workflowRepo,
        outputRepo,
        localOwnerLiveness(),
        true,
      );

      assertEquals(result.orphanedMethodRuns, 1);
      assertEquals(result.orphanedMethodReaped, 1);
      const settled = await statusOf(outputRepo, orphan);
      assertEquals(settled?.status, "cancelled");
      assertEquals(settled?.error?.message, ownerExitedReason(DEAD_PID));
      assertEquals(tracker.findById(orphan.id)?.status, "interrupted");
      assertEquals(settledReason(repoDir, orphan.id), "owner_process_dead");

      assertEquals((await statusOf(outputRepo, live))?.status, "running");
      assertEquals((await statusOf(outputRepo, remote))?.status, "running");
      assertEquals(tracker.findById(live.id)?.status, "running");
      assertEquals(tracker.findById(remote.id)?.status, "running");
    } finally {
      tracker.close();
    }
  });
});

Deno.test("workflow recover: settling a dead owner's run cancels its step's method run", async () => {
  await withRepo(async (repoDir) => {
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    const workflow = Workflow.create({
      name: "wf",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({ name: "s", task: StepTask.model("m", "run") })],
      })],
    });
    await repoContext.workflowRepo.save(workflow);
    const startedAt = new Date().toISOString();
    const run = WorkflowRun.fromData({
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: "running",
      startedAt,
      pid: DEAD_PID,
      jobs: [{
        jobName: "main",
        status: "running",
        startedAt,
        steps: [{ stepName: "s", status: "running", startedAt }],
      }],
      tags: {},
    });
    await repoContext.workflowRunRepo.save(workflow.id, run);

    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    try {
      tracker.register(ActiveRun.createWorkflowRun({
        id: run.id,
        workflowName: run.workflowName,
        pid: DEAD_PID,
        hostname: hostname(),
      }));
      const step = await startStepMethodRun(
        repoContext.outputRepo,
        tracker,
        DEAD_PID,
      );

      const interrupted = await settleDeadOwnerRun(
        repoContext.workflowRunRepo,
        tracker,
        workflow.id,
        run.id,
        localOwnerLiveness(),
        repoContext.outputRepo,
      );

      assertEquals(interrupted, true);
      assertEquals(
        (await statusOf(repoContext.outputRepo, step))?.status,
        "cancelled",
      );
      assertEquals(settledReason(repoDir, step.id), "owner_process_dead");
    } finally {
      tracker.close();
    }
  });
});
