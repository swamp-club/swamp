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
import { join } from "@std/path";
import { hostname } from "node:os";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import "../../domain/models/models.ts";
import { diagnoseLocalRuns } from "./run.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { ActiveRun } from "../../domain/models/active_run.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type {
  WorkflowId,
  WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";

await initializeLogging({});

const WORKFLOW_ID = "5b0e6c3c-2b7e-4c55-9d43-3c1f2f0e9a11" as WorkflowId;
// Far above any real pid_max, so never a live process.
const DEAD_PID = 2147483647;

function withTracker(fn: (tracker: RunTrackerStore) => Promise<void>) {
  return async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-run-doctor-test-" });
    const tracker = new RunTrackerStore(join(dir, "run_tracker.db"));
    try {
      await fn(tracker);
    } finally {
      tracker.close();
      await Deno.remove(dir, { recursive: true }).catch(
        Deno.build.os === "windows" ? () => {} : (e) => {
          throw e;
        },
      );
    }
  };
}

/** A run left `running` by a force exit: one step done, one in flight. */
function strandedRun(pid: number): WorkflowRun {
  const startedAt = new Date().toISOString();
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "wf",
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

function trackerRow(
  id: string,
  pid: number,
  runKind: "workflow" | "model_method" = "workflow",
  host = hostname(),
): ActiveRun {
  const now = new Date().toISOString();
  return ActiveRun.fromData({
    id,
    runKind,
    modelType: runKind === "model_method" ? "command/shell" : null,
    methodName: runKind === "model_method" ? "execute" : null,
    workflowName: runKind === "workflow" ? "wf" : null,
    pid,
    hostname: host,
    startedAt: now,
    heartbeatAt: now,
    status: "running",
  });
}

/**
 * A run repository over `runs`. `scanned` limits what the recent-record scan
 * returns, as its window does for a run started long ago.
 */
function runRepoOf(runs: WorkflowRun[], scanned = runs): {
  runRepo: WorkflowRunRepository;
  saved: string[];
} {
  const saved: string[] = [];
  const runRepo = {
    findGlobalByStatus: (status: string) =>
      Promise.resolve(
        scanned.filter((r) => r.status === status).map((run) => ({
          run,
          workflowId: WORKFLOW_ID,
        })),
      ),
    findById: (_wfId: WorkflowId, runId: WorkflowRunId) =>
      Promise.resolve(runs.find((r) => r.id === (runId as string)) ?? null),
    save: (_wfId: WorkflowId, run: WorkflowRun) => {
      saved.push(run.id);
      return Promise.resolve();
    },
  } as unknown as WorkflowRunRepository;
  return { runRepo, saved };
}

/** Workflow lookup that knows only workflow "wf". */
const workflowRepo = {
  findByName: (name: string) =>
    Promise.resolve(
      name === "wf" ? { id: WORKFLOW_ID, name } as unknown as Workflow : null,
    ),
} as Pick<WorkflowRepository, "findByName">;

Deno.test(
  "diagnoseLocalRuns: lists a dead local owner as stale before its heartbeat expires, and writes nothing without fix",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    const { runRepo, saved } = runRepoOf([run]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      localOwnerLiveness(),
      false,
    );

    assertEquals(result.stale.map((r) => r.id), [run.id]);
    assertEquals(result.active, []);
    assertEquals(result.reaped, 0);
    assertEquals(result.orphanedWorkflowRuns, 1);
    assertEquals(result.orphanedReaped, 0);
    assertEquals(tracker.findById(run.id)?.status, "running");
    assertEquals(run.status, "running");
    assertEquals(saved, []);
  }),
);

Deno.test(
  "diagnoseLocalRuns: fix reaps the dead owner's tracker rows and interrupts its run record",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    const stepRowId = crypto.randomUUID();
    tracker.register(trackerRow(run.id, DEAD_PID));
    tracker.register(trackerRow(stepRowId, DEAD_PID, "model_method"));
    const { runRepo, saved } = runRepoOf([run]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      localOwnerLiveness(),
      true,
    );

    assertEquals(result.reaped, 2);
    assertEquals(result.orphanedWorkflowRuns, 1);
    assertEquals(result.orphanedReaped, 1);
    assertEquals(tracker.findById(run.id)?.status, "interrupted");
    assertEquals(tracker.findById(stepRowId)?.status, "interrupted");
    assertEquals(run.status, "interrupted");
    assertEquals(run.tags["interrupt_reason"], "owner_process_dead");
    assertEquals(
      run.jobs[0].steps.map((s) => s.status),
      ["succeeded", "unknown"],
    );
    assertEquals(saved, [run.id]);
  }),
);

Deno.test(
  "diagnoseLocalRuns: fix leaves a live owner, a remote owner and an untracked run alone",
  withTracker(async (tracker) => {
    const live = strandedRun(Deno.pid);
    const remote = strandedRun(DEAD_PID);
    const untracked = strandedRun(DEAD_PID);
    tracker.register(trackerRow(live.id, Deno.pid));
    tracker.register(
      trackerRow(remote.id, DEAD_PID, "workflow", "some-other-host"),
    );
    const { runRepo, saved } = runRepoOf([live, remote, untracked]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      localOwnerLiveness(),
      true,
    );

    assertEquals(
      result.active.map((r) => r.id).sort(),
      [live.id, remote.id].sort(),
    );
    assertEquals(result.stale, []);
    assertEquals(result.orphanedWorkflowRuns, 0);
    assertEquals(live.status, "running");
    assertEquals(remote.status, "running");
    assertEquals(untracked.status, "running");
    assertEquals(saved, []);
  }),
);

Deno.test(
  "diagnoseLocalRuns: fix settles a run older than the scan window through its tracker row",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    const { runRepo, saved } = runRepoOf([run], []);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      localOwnerLiveness(),
      true,
    );

    assertEquals(result.orphanedWorkflowRuns, 1);
    assertEquals(result.orphanedReaped, 1);
    assertEquals(run.status, "interrupted");
    assertEquals(saved, [run.id]);
  }),
);

Deno.test(
  "diagnoseLocalRuns: without fix, an old run is counted through its tracker row but not written",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    tracker.complete(run.id, "interrupted");
    const { runRepo, saved } = runRepoOf([run], []);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      localOwnerLiveness(),
      false,
    );

    assertEquals(result.orphanedWorkflowRuns, 1);
    assertEquals(run.status, "running");
    assertEquals(saved, []);
  }),
);

Deno.test(
  "diagnoseLocalRuns: fix marks an interrupted row settled only once its record is no longer running",
  withTracker(async (tracker) => {
    const settled = strandedRun(DEAD_PID);
    settled.interrupt("server_crash");
    const remote = strandedRun(DEAD_PID);
    const renamed = strandedRun(DEAD_PID);
    for (
      const [run, host] of [
        [settled, hostname()],
        [remote, "some-other-host"],
        [renamed, hostname()],
      ] as const
    ) {
      tracker.register(trackerRow(run.id, DEAD_PID, "workflow", host));
      tracker.complete(run.id, "interrupted");
    }
    // The renamed run's record is not found under its row's workflow name.
    const { runRepo, saved } = runRepoOf([settled, remote], []);
    const marked: string[] = [];
    const markSettled = tracker.markSettled.bind(tracker);
    tracker.markSettled = (id: string, reason: string) => {
      marked.push(id);
      markSettled(id, reason);
    };

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      localOwnerLiveness(),
      true,
    );

    // The settled record's row is marked; the remote row's record is still
    // running on another host, and the renamed run's record is not found.
    assertEquals(marked, [settled.id]);
    assertEquals(result.orphanedWorkflowRuns, 0);
    assertEquals(remote.status, "running");
    assertEquals(saved, []);
  }),
);
