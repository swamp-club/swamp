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

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { hostname } from "node:os";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../src/domain/workflows/workflow_id.ts";
import {
  OWNER_STOPPED_STEP_ERROR,
  WorkflowRun,
} from "../src/domain/workflows/workflow_run.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  plantV3WriterLease,
  type V3WriterLeaseHolder,
} from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import {
  createWorkflowRunClaims,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import {
  cancelAllLocalRuns,
  cancelLocalRun,
  openCancelWriter,
  ownerHoldsWriter,
  stopLocalRunOwners,
  stopOwnersBeforeWriter,
} from "../src/cli/commands/workflow_cancel.ts";
import { createContext } from "../src/cli/context.ts";
import { UserError } from "../src/domain/errors.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const WORKFLOW_ID = createWorkflowId("b0000000-0000-4000-8000-000000000042");
const OWNER_PID = 99_999_998;
const GONE_PID = 99_999_999;

function runningRun(): WorkflowRun {
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "deploy",
    status: "running",
    startedAt: "2026-11-02T10:00:00.000Z",
    pid: OWNER_PID,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt: "2026-11-02T10:00:00.000Z",
      steps: [{
        stepName: "apply",
        status: "running",
        startedAt: "2026-11-02T10:00:01.000Z",
      }],
    }],
    tags: {},
  });
}

/** The run as its owner left it: committed, with a tracker row on this host. */
async function startedRun(repoDir: string): Promise<WorkflowRun> {
  const run = runningRun();
  const writer = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  await runCommandInRootUnit(
    writer.repoContext,
    { push: undefined },
    async () => {
      await writer.repoContext.workflowRepo.save(Workflow.create({
        id: WORKFLOW_ID,
        name: "deploy",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "apply",
            task: StepTask.model("writer", "write", {}),
          })],
        })],
      }));
      await writer.repoContext.workflowRunRepo.save(WORKFLOW_ID, run);
    },
  );
  await closeV3Datastores();
  const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
  try {
    tracker.register(ActiveRun.createWorkflowRun({
      id: run.id,
      workflowName: run.workflowName,
      pid: OWNER_PID,
      hostname: hostname(),
    }));
  } finally {
    tracker.close();
  }
  return run;
}

async function cancelUnderWriter(
  repoDir: string,
  run: WorkflowRun,
  preStopped: ReadonlySet<number>,
): Promise<WorkflowRun | null> {
  const writer = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
  try {
    return await runCommandInRootUnit(
      writer.repoContext,
      { push: undefined },
      () =>
        cancelLocalRun(run, undefined, "No longer needed", {
          runRepo: writer.repoContext.workflowRunRepo,
          findEvaluatedWorkflow: () => Promise.resolve(null),
          runTracker: tracker,
          runClaims: createWorkflowRunClaims(writer.datastoreConfig),
          outputRepo: writer.repoContext.outputRepo,
          preStopped,
          killProcess: () => Promise.reject(new Error("stopped twice")),
        }),
    );
  } finally {
    tracker.close();
    await closeV3Datastores();
  }
}

async function committedRun(
  repoDir: string,
  workflowId: WorkflowId,
  run: WorkflowRun,
): Promise<WorkflowRun | null> {
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir,
    outputMode: "json",
  });
  try {
    return await repoContext.workflowRunRepo.findById(workflowId, run.id);
  } finally {
    await closeV3Datastores();
  }
}

Deno.test("v3 cancel: the owner holding the writer is found through a read-only open and stopped before the cancel takes the writer, which then settles the run (swamp-club#4295)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    const run = await startedRun(repos.repoA);
    let lease: V3WriterLeaseHolder | undefined = await plantV3WriterLease(
      datastorePath,
      { pid: Deno.pid, ttlMs: 10 * 60_000 },
    );
    try {
      assertEquals(await ownerHoldsWriter(repos.repoA), true);
      const seen = await committedRun(repos.repoA, WORKFLOW_ID, run);
      assertEquals(seen?.status, "running");

      const tracker = RunTrackerStore.fromSwampDir(swampPath(repos.repoA));
      let stopped: Set<number>;
      try {
        stopped = await stopLocalRunOwners([seen!], {
          runTracker: tracker,
          killProcess: async (pid) => {
            assertEquals(pid, OWNER_PID);
            await lease!.release();
            lease = undefined;
            return true;
          },
        });
      } finally {
        tracker.close();
      }
      assertEquals([...stopped], [OWNER_PID]);

      const settled = await cancelUnderWriter(repos.repoA, seen!, stopped);
      assertEquals(settled?.status, "cancelled");
      assertEquals(settled?.tags.cancel_reason, "No longer needed");
      assertEquals(
        settled?.jobs[0].steps[0].error,
        OWNER_STOPPED_STEP_ERROR,
      );
      assertEquals(
        (await committedRun(repos.repoA, WORKFLOW_ID, run))?.status,
        "cancelled",
      );
    } finally {
      await lease?.release();
    }
  });
});

Deno.test("v3 cancel: an owner that died holding the writer leaves a lease the settle takes over, and its in-flight step fails as owner-stopped (swamp-club#4295)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    const run = await startedRun(repos.repoA);
    await plantV3WriterLease(datastorePath, {
      pid: GONE_PID,
      ttlMs: 10 * 60_000,
    });

    const settled = await cancelUnderWriter(
      repos.repoA,
      run,
      new Set([OWNER_PID]),
    );
    assertEquals(settled?.status, "cancelled");
    assertEquals(settled?.jobs[0].steps[0].error, OWNER_STOPPED_STEP_ERROR);
    assertEquals(
      (await committedRun(repos.repoA, WORKFLOW_ID, run))?.status,
      "cancelled",
    );
  });
});

for (const all of [true, false]) {
  Deno.test(
    `v3 cancel: ${
      all ? "--all" : "a cancel by workflow name"
    } stops a live owner holding the writer before it opens the writer, which it then takes without waiting and settles the run cancelled (swamp-club#4295)`,
    async () => {
      await withV3RowRepos({}, async (repos, datastorePath) => {
        await closeV3Datastores();
        const run = await startedRun(repos.repoA);
        let lease: V3WriterLeaseHolder | undefined = await plantV3WriterLease(
          datastorePath,
          { pid: Deno.pid, ttlMs: 10 * 60_000 },
        );
        try {
          const killed: number[] = [];
          const preStop = await stopOwnersBeforeWriter(
            createContext({ json: true }, ["workflow", "cancel"]),
            all ? { repoDir: repos.repoA, all: true } : {
              repoDir: repos.repoA,
              all: false,
              workflowIdOrName: "deploy",
            },
            {
              killProcess: async (pid) => {
                killed.push(pid);
                await lease!.release();
                lease = undefined;
                return true;
              },
            },
          );
          await closeV3Datastores();
          assertEquals(killed, [OWNER_PID]);
          assertEquals([...preStop.stopped], [OWNER_PID]);
          const targets = preStop.kind === "all"
            ? preStop.active
            : [{ run: preStop.run, workflow: preStop.workflow }];
          assertEquals(targets.map((target) => target.run.id), [run.id]);

          const writer = await openCancelWriter(
            () =>
              requireInitializedRepoUnlocked({
                repoDir: repos.repoA,
                outputMode: "json",
              }),
            () => new UserError("the cancel was answered with writer busy"),
          );
          const tracker = RunTrackerStore.fromSwampDir(swampPath(repos.repoA));
          try {
            const result = await runCommandInRootUnit(
              writer.repoContext,
              { push: undefined },
              () =>
                cancelAllLocalRuns(targets, "No longer needed", {
                  runRepo: writer.repoContext.workflowRunRepo,
                  findEvaluatedWorkflow: () => Promise.resolve(null),
                  runTracker: tracker,
                  runClaims: createWorkflowRunClaims(writer.datastoreConfig),
                  outputRepo: writer.repoContext.outputRepo,
                  preStopped: preStop.stopped,
                  killProcess: () => Promise.reject(new Error("stopped twice")),
                }),
            );
            assertEquals(result.cancelled, [{
              runId: run.id,
              workflowName: "deploy",
              previousStatus: "running",
            }]);
          } finally {
            tracker.close();
            await closeV3Datastores();
          }
          assertEquals(
            (await committedRun(repos.repoA, WORKFLOW_ID, run))?.status,
            "cancelled",
          );
        } finally {
          await lease?.release();
        }
      });
    },
  );
}
