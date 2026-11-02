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

// A run record is data. On a v2 S3/GCS datastore it syncs between members'
// checkouts, so a member who writes one chooses its pid. Another member's
// `workflow cancel` must never stop the process that pid names on their own
// machine (swamp-club#4274). These tests carry a forged record from one
// repo to another through the in-memory remote that stands in for S3 and
// GCS (the use-case sync fixture's two repos), then cancel it from the
// second repo with the kill injected.

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import {
  createWorkflowRunClaims,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import {
  cancelAllLocalRuns,
  cancelLocalRun,
  findAllActiveRuns,
  splitForeignRuns,
} from "../src/cli/commands/workflow_cancel.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../src/infrastructure/persistence/run_tracker_store.ts";
import { settle, withRowRepos } from "./usecase_sync_fixtures.ts";

await initializeLogging({});

/** A pid the forger picked: any process on the canceller's machine. */
const FORGED_PID = Deno.pid + 1;

type UnlockedRepo = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

/**
 * Member A writes a workflow and a `running` record of it naming
 * `FORGED_PID`; the remote carries both to member B, as two members on one
 * S3 or GCS bucket share them. Runs `fn` with B's checkout.
 */
async function withForgedRunOnB(
  fn: (synced: {
    repoB: string;
    b: UnlockedRepo;
    workflow: Workflow;
    runId: string;
  }) => Promise<void>,
): Promise<void> {
  await withRowRepos({}, async (repos) => {
    const workflow = Workflow.create({ name: "deploy" });
    const runId = crypto.randomUUID();
    await repos.a.repoContext.workflowRepo.save(workflow);
    await repos.a.repoContext.workflowRunRepo.save(
      workflow.id,
      WorkflowRun.fromData({
        id: runId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        status: "running",
        startedAt: new Date().toISOString(),
        pid: FORGED_PID,
        jobs: [],
        tags: {},
      }),
    );
    await settle(repos);
    const b = await requireInitializedRepoUnlocked({
      repoDir: repos.repoB,
      outputMode: "json",
    });
    await fn({ repoB: repos.repoB, b, workflow, runId });
  });
}

function cancelDeps(
  b: UnlockedRepo,
  runTracker: RunTrackerStore,
  killed: number[],
) {
  return {
    runRepo: b.repoContext.workflowRunRepo,
    findEvaluatedWorkflow: () => Promise.resolve(null),
    runTracker,
    runClaims: createWorkflowRunClaims(b.datastoreConfig),
    outputRepo: b.repoContext.outputRepo,
    // The forged pid reads as alive, as a real process on this machine would.
    liveness: { ...localOwnerLiveness(), isDead: () => false },
    killProcess: (pid: number) => {
      killed.push(pid);
      return Promise.resolve(true);
    },
  };
}

function activeRunsOf(b: UnlockedRepo) {
  return findAllActiveRuns({
    workflowRepo: b.repoContext.workflowRepo,
    runRepo: b.repoContext.workflowRunRepo,
    listBrokenWorkflows: () => Promise.resolve([]),
  });
}

Deno.test("workflow cancel: a synced run record's forged pid is never killed, by name or --all, and the run is settled (swamp-club#4274)", async () => {
  for (const mode of ["single", "all"] as const) {
    await withForgedRunOnB(async ({ repoB, b, workflow, runId }) => {
      const { active } = await activeRunsOf(b);
      const target = active.find(({ run }) => run.id === runId);
      assertEquals(target?.run.pid, FORGED_PID, "the record synced to B");

      const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoB));
      const killed: number[] = [];
      try {
        const deps = cancelDeps(b, runTracker, killed);
        await runCommandInRootUnit(
          b.repoContext,
          { push: undefined },
          async () => {
            if (mode === "single") {
              const result = await cancelLocalRun(
                target!.run,
                workflow,
                "Cancelled by user",
                deps,
              );
              assertEquals(result?.status, "cancelled");
            } else {
              // Outside serve mode every run is the checkout's to settle.
              const { own, foreign } = splitForeignRuns(
                active,
                runTracker,
                false,
              );
              assertEquals(foreign, []);
              const result = await cancelAllLocalRuns(
                own,
                "Cancelled by user",
                deps,
              );
              assertEquals(result.cancelled.map((c) => c.runId), [runId]);
            }
          },
        );
      } finally {
        runTracker.close();
      }
      assertEquals(killed, [], `${mode}: no kill`);
      const stored = await b.repoContext.workflowRunRepo.findById(
        workflow.id,
        createWorkflowRunId(runId),
      );
      assertEquals(stored?.status, "cancelled");
    });
  }
});

Deno.test("workflow cancel: a run this checkout's tracker holds is still stopped by its pid on a synced datastore (swamp-club#4274)", async () => {
  await withForgedRunOnB(async ({ repoB, b, workflow, runId }) => {
    const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoB));
    const killed: number[] = [];
    try {
      // B started the run itself under this pid: its row says so.
      runTracker.register(ActiveRun.createWorkflowRun({
        id: runId,
        workflowName: workflow.name,
        pid: FORGED_PID,
        hostname: localOwnerLiveness().hostname,
      }));
      const run = await b.repoContext.workflowRunRepo.findById(
        workflow.id,
        createWorkflowRunId(runId),
      );
      await runCommandInRootUnit(
        b.repoContext,
        { push: undefined },
        () =>
          cancelLocalRun(run!, workflow, "Cancelled by user", {
            ...cancelDeps(b, runTracker, killed),
            liveness: {
              ...localOwnerLiveness(),
              isDead: (pid: number) => killed.includes(pid),
            },
          }),
      );
    } finally {
      runTracker.close();
    }
    assertEquals(killed, [FORGED_PID]);
  });
});

Deno.test("workflow cancel --all: in a serve-mode checkout a run this checkout did not start is left for serve, never settled or killed here (swamp-club#4274)", async () => {
  await withForgedRunOnB(async ({ repoB, b, runId }) => {
    const { active } = await activeRunsOf(b);
    const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoB));
    try {
      const { own, foreign } = splitForeignRuns(active, runTracker, true);
      assertEquals(own, []);
      assertEquals(foreign.map(({ run }) => run.id), [runId]);
    } finally {
      runTracker.close();
    }
  });
});
