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
  type OwnerLiveness,
  reapOrphanedWorkflowRuns,
  runHasDeadOwner,
  settleDeadOwnerRun,
  trackerShowsDeadOwner,
} from "./orphaned_run_reaper.ts";
import { WorkflowRun } from "./workflow_run.ts";
import type { WorkflowRunRepository } from "./repositories.ts";
import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import { ActiveRun, type ActiveRunStatus } from "../models/active_run.ts";
import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";

const WORKFLOW_ID = "96968218-50aa-4b91-8161-a6995ce96cae" as WorkflowId;

type RunStatus =
  | "pending"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

function makeRun(
  overrides: {
    status?: RunStatus;
    pid?: number;
    id?: string;
    instanceId?: string;
  } = {},
): WorkflowRun {
  return WorkflowRun.fromData({
    id: overrides.id ?? crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status: overrides.status ?? "running",
    startedAt: "2026-07-20T20:00:00.000Z",
    pid: overrides.pid,
    instanceId: overrides.instanceId,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt: "2026-07-20T20:00:00.000Z",
      steps: [{
        stepName: "step1",
        status: "running",
        startedAt: "2026-07-20T20:00:00.000Z",
      }],
    }],
    tags: {},
  });
}

// Helper: no tracker record for any run (legacy fallback path)
const noTracker = () => null;

// Helper: tracker says run is still running
const trackerRunning = () => ({ status: "running" });

// Helper: tracker says run was reaped (stale)
const trackerReaped = () => ({ status: "failed" });

// Helper: for cases decided before any pid check
const unexpectedPidCheck = (pid: number): boolean => {
  throw new Error(`unexpected pid check for ${pid}`);
};

Deno.test("reapOrphanedWorkflowRuns: skips run when tracker reports still running", async () => {
  const run = makeRun({ pid: 42 });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    trackerRunning,
    unexpectedPidCheck,
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 1);
  assertEquals(run.status, "running");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: interrupts run when tracker confirmed stale", async () => {
  const run = makeRun({ pid: 99999 });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    trackerReaped,
    unexpectedPidCheck,
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "interrupted");
  assertEquals(saved.length, 1);
});

Deno.test("reapOrphanedWorkflowRuns: legacy run with live PID is skipped", async () => {
  const run = makeRun({ pid: 42 });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    (_pid) => false, // PID is alive
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 1);
  assertEquals(run.status, "running");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: legacy run with dead PID is interrupted", async () => {
  const run = makeRun({ pid: 99999 });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    (_pid) => true, // PID is dead
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "interrupted");
  assertEquals(saved.length, 1);
});

Deno.test("reapOrphanedWorkflowRuns: legacy run with no PID is interrupted", async () => {
  const run = makeRun(); // no pid
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    () => {
      throw new Error("should not be called for undefined pid");
    },
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "interrupted");
});

Deno.test("reapOrphanedWorkflowRuns: skips run in terminal state", async () => {
  const run = makeRun({ status: "succeeded" });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    () => true,
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "succeeded");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: mixed scenario with tracker and legacy runs", async () => {
  const trackedLive = makeRun({ pid: 100 });
  const trackedStale = makeRun({ pid: 200 });
  const legacyDeadPid = makeRun({ pid: 300 });
  const legacyNoPid = makeRun();
  const succeededRun = makeRun({ status: "succeeded" });
  const saved: string[] = [];

  const trackerMap = new Map<string, { status: string }>([
    [trackedLive.id, { status: "running" }],
    [trackedStale.id, { status: "failed" }],
  ]);

  const result = await reapOrphanedWorkflowRuns(
    [
      { run: trackedLive, workflowId: WORKFLOW_ID },
      { run: trackedStale, workflowId: WORKFLOW_ID },
      { run: legacyDeadPid, workflowId: WORKFLOW_ID },
      { run: legacyNoPid, workflowId: WORKFLOW_ID },
      { run: succeededRun, workflowId: WORKFLOW_ID },
    ],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    (runId) => trackerMap.get(runId) ?? null,
    (pid) => pid === 300, // only PID 300 is dead
  );
  assertEquals(result.reaped, 3); // tracker-stale + legacy dead PID + legacy no PID
  assertEquals(result.skipped, 1); // tracker-live
  assertEquals(trackedLive.status, "running");
  assertEquals(trackedStale.status, "interrupted");
  assertEquals(legacyDeadPid.status, "interrupted");
  assertEquals(legacyNoPid.status, "interrupted");
  assertEquals(succeededRun.status, "succeeded");
  assertEquals(saved.length, 3);
});

Deno.test("reapOrphanedWorkflowRuns: skips run with foreign instanceId when tracker miss", async () => {
  const run = makeRun({ pid: 42, instanceId: "remote-1" });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    () => {
      throw new Error("should not check PID for foreign instance");
    },
    "local-1",
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 1);
  assertEquals(run.status, "running");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: reaps run with matching instanceId when tracker miss and PID dead", async () => {
  const run = makeRun({ pid: 42, instanceId: "local-1" });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    (_pid) => true, // PID is dead
    "local-1",
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "interrupted");
  assertEquals(saved.length, 1);
});

Deno.test("reapOrphanedWorkflowRuns: reaps run with no instanceId when tracker miss and PID dead", async () => {
  const run = makeRun({ pid: 42 }); // no instanceId — legacy run
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    (_pid) => true, // PID is dead
    "local-1",
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "interrupted");
  assertEquals(saved.length, 1);
});

Deno.test("reapOrphanedWorkflowRuns: reaps foreign run when heartbeat lookup reports no heartbeat", async () => {
  const run = makeRun({ pid: 42, instanceId: "remote-1" });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    () => {
      throw new Error("should not check PID for foreign instance");
    },
    "local-1",
    (_instanceId) => Promise.resolve(false), // no heartbeat
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "interrupted");
  assertEquals(saved.length, 1);
});

Deno.test("reapOrphanedWorkflowRuns: skips foreign run when heartbeat lookup reports live heartbeat", async () => {
  const run = makeRun({ pid: 42, instanceId: "remote-1" });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    () => {
      throw new Error("should not check PID for foreign instance");
    },
    "local-1",
    (_instanceId) => Promise.resolve(true), // heartbeat exists
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 1);
  assertEquals(run.status, "running");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: skips foreign run when no heartbeat lookup provided", async () => {
  const run = makeRun({ pid: 42, instanceId: "remote-1" });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    () => {
      throw new Error("should not check PID for foreign instance");
    },
    "local-1",
    undefined, // no heartbeat lookup — preserves old behavior
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 1);
  assertEquals(run.status, "running");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: reaps run with foreign instanceId when tracker reports stale", async () => {
  const run = makeRun({ pid: 42, instanceId: "remote-1" });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    trackerReaped, // tracker says stale — overrides instanceId check
    () => {
      throw new Error("should not check PID when tracker confirms stale");
    },
    "local-1",
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "interrupted");
  assertEquals(saved.length, 1);
});

// --- settleDeadOwnerRun and its checks ---

const HOST = "this-host";

function liveness(deadPids: number[] = []): OwnerLiveness {
  return { hostname: HOST, isDead: (pid) => deadPids.includes(pid) };
}

function trackerRow(
  runId: string,
  overrides: {
    status?: ActiveRunStatus;
    pid?: number;
    hostname?: string;
    instanceId?: string;
  } = {},
): ActiveRun {
  const now = new Date().toISOString();
  return ActiveRun.fromData({
    id: runId,
    runKind: "workflow",
    modelType: null,
    methodName: null,
    workflowName: "test-workflow",
    pid: overrides.pid ?? 4242,
    hostname: overrides.hostname ?? HOST,
    startedAt: now,
    heartbeatAt: now,
    status: overrides.status ?? "running",
    initiatedBy: null,
    instanceId: overrides.instanceId,
  });
}

interface Recorded {
  saved: { runId: string; status: string }[];
  completed: { runId: string; status: ActiveRunStatus }[];
}

/**
 * A run repository that returns `stored` on read, so a test can stand in a
 * fresher record than the one the caller listed.
 */
function stubs(stored: WorkflowRun[], rows: ActiveRun[]): {
  runRepo: WorkflowRunRepository;
  runTracker: RunTrackerRepository;
  recorded: Recorded;
} {
  const recorded: Recorded = { saved: [], completed: [] };
  return {
    runRepo: {
      findById: (_wfId: WorkflowId, runId: WorkflowRunId) =>
        Promise.resolve(
          stored.find((r) => r.id === (runId as string)) ?? null,
        ),
      save: (_wfId: WorkflowId, run: WorkflowRun) => {
        recorded.saved.push({ runId: run.id, status: run.status });
        return Promise.resolve();
      },
    } as unknown as WorkflowRunRepository,
    runTracker: {
      findById: (runId: string) => rows.find((r) => r.id === runId) ?? null,
      complete: (runId: string, status: ActiveRunStatus) => {
        recorded.completed.push({ runId, status });
      },
    } as unknown as RunTrackerRepository,
    recorded,
  };
}

Deno.test("trackerShowsDeadOwner: only an interrupted row or a local running row with a dead pid counts", () => {
  const id = crypto.randomUUID();
  const check = liveness([4242]);
  assertEquals(trackerShowsDeadOwner(null, check), false);
  assertEquals(
    trackerShowsDeadOwner(trackerRow(id, { status: "interrupted" }), check),
    true,
  );
  assertEquals(trackerShowsDeadOwner(trackerRow(id), check), true);
  assertEquals(
    trackerShowsDeadOwner(trackerRow(id, { pid: 7 }), check),
    false,
  );
  assertEquals(
    trackerShowsDeadOwner(trackerRow(id, { hostname: "other-host" }), check),
    false,
  );
  for (
    const status of [
      "completed",
      "failed",
      "cancelled",
      "suspended",
    ] as ActiveRunStatus[]
  ) {
    assertEquals(
      trackerShowsDeadOwner(trackerRow(id, { status }), check),
      false,
      `${status} row is settled by its owner`,
    );
  }
});

Deno.test("trackerShowsDeadOwner: a serve instance id decides locality when both sides have one", () => {
  const id = crypto.randomUUID();
  const own = { ...liveness([4242]), instanceId: "inst-a" };
  assertEquals(
    trackerShowsDeadOwner(
      trackerRow(id, { hostname: "other-host", instanceId: "inst-a" }),
      own,
    ),
    true,
  );
  assertEquals(
    trackerShowsDeadOwner(trackerRow(id, { instanceId: "inst-b" }), own),
    false,
  );
});

Deno.test("runHasDeadOwner: needs a tracker row and the same owner pid", () => {
  const run = makeRun({ pid: 4242 });
  const check = liveness([4242]);
  const none = stubs([], []);
  assertEquals(runHasDeadOwner(run, none.runTracker, check), false);

  const same = stubs([], [trackerRow(run.id, { pid: 4242 })]);
  assertEquals(runHasDeadOwner(run, same.runTracker, check), true);

  const reaped = stubs([], [
    trackerRow(run.id, { pid: 999, status: "interrupted" }),
  ]);
  assertEquals(runHasDeadOwner(run, reaped.runTracker, check), false);

  const done = makeRun({ pid: 4242, status: "succeeded" });
  const doneRows = stubs([], [trackerRow(done.id, { pid: 4242 })]);
  assertEquals(runHasDeadOwner(done, doneRows.runTracker, check), false);
});

Deno.test("settleDeadOwnerRun: interrupts a running run whose local owner is dead", async () => {
  const run = makeRun({ pid: 4242 });
  const { runRepo, runTracker, recorded } = stubs(
    [run],
    [trackerRow(run.id, { pid: 4242 })],
  );

  const settled = await settleDeadOwnerRun(
    runRepo,
    runTracker,
    WORKFLOW_ID,
    run.id,
    liveness([4242]),
  );

  assertEquals(settled, true);
  assertEquals(run.status, "interrupted");
  assertEquals(run.tags["interrupt_reason"], "owner_process_dead");
  assertEquals(run.jobs[0].status, "unknown");
  assertEquals(run.jobs[0].steps[0].status, "unknown");
  assertEquals(recorded.saved, [{ runId: run.id, status: "interrupted" }]);
  assertEquals(recorded.completed, [{ runId: run.id, status: "interrupted" }]);
});

Deno.test("settleDeadOwnerRun: interrupts a running run whose tracker row was already reaped", async () => {
  const run = makeRun({ pid: 4242 });
  const { runRepo, runTracker, recorded } = stubs(
    [run],
    [trackerRow(run.id, { pid: 4242, status: "interrupted" })],
  );

  const settled = await settleDeadOwnerRun(
    runRepo,
    runTracker,
    WORKFLOW_ID,
    run.id,
    liveness(),
  );

  assertEquals(settled, true);
  assertEquals(run.status, "interrupted");
  assertEquals(recorded.saved.length, 1);
});

Deno.test("settleDeadOwnerRun: leaves a run whose owner is alive, remote or untracked", async () => {
  const alive = makeRun({ pid: 4242 });
  const remote = makeRun({ pid: 4242 });
  const untracked = makeRun({ pid: 4242 });
  const { runRepo, runTracker, recorded } = stubs(
    [alive, remote, untracked],
    [
      trackerRow(alive.id, { pid: 4242 }),
      trackerRow(remote.id, { pid: 4242, hostname: "other-host" }),
    ],
  );

  for (
    const [run, dead] of [[alive, []], [remote, [4242]], [untracked, [
      4242,
    ]]] as [WorkflowRun, number[]][]
  ) {
    const settled = await settleDeadOwnerRun(
      runRepo,
      runTracker,
      WORKFLOW_ID,
      run.id,
      liveness(dead),
    );
    assertEquals(settled, false);
    assertEquals(run.status, "running");
  }
  assertEquals(recorded.saved, []);
  assertEquals(recorded.completed, []);
});

Deno.test("settleDeadOwnerRun: never overwrites a run its owner finished after the tracker row was read", async () => {
  // The listed copy is stale; the stored record is what the owner saved
  // last. The tracker row says completed, so it is not trusted either.
  const finished = makeRun({ pid: 4242, status: "succeeded" });
  const { runRepo, runTracker, recorded } = stubs(
    [finished],
    [trackerRow(finished.id, { pid: 4242, status: "completed" })],
  );

  const settled = await settleDeadOwnerRun(
    runRepo,
    runTracker,
    WORKFLOW_ID,
    finished.id,
    liveness([4242]),
  );

  assertEquals(settled, false);
  assertEquals(finished.status, "succeeded");
  assertEquals(recorded.saved, []);
  assertEquals(recorded.completed, []);
});

Deno.test("settleDeadOwnerRun: leaves a run another process took over", async () => {
  // The tracker row still names the dead pid, but the stored record now
  // belongs to a newer owner.
  const taken = makeRun({ pid: 5151 });
  const { runRepo, runTracker, recorded } = stubs(
    [taken],
    [trackerRow(taken.id, { pid: 4242 })],
  );

  const settled = await settleDeadOwnerRun(
    runRepo,
    runTracker,
    WORKFLOW_ID,
    taken.id,
    liveness([4242]),
  );

  assertEquals(settled, false);
  assertEquals(taken.status, "running");
  assertEquals(recorded.saved, []);
});
