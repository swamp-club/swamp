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
import { assertEquals, assertRejects } from "@std/assert";
import {
  cancelOrphanedMethodRuns,
  findDeadOwnerMethodRuns,
  matchMethodRunOutputs,
  type MethodRunOutputs,
  ownerExitedReason,
  type OwnerLiveness,
  reapOrphanedWorkflowRuns,
  runHasDeadOwner,
  runRecordFinder,
  settleDeadOwnerMethodRuns,
  settleDeadOwnerRun,
  settleInterruptedWorkflowRows,
  suspendedRunHasDeadOwner,
  suspendedRunOwnerIsRunning,
  trackerShowsDeadOwner,
} from "./orphaned_run_reaper.ts";
import { WorkflowRun } from "./workflow_run.ts";
import type { WorkflowRunRepository } from "./repositories.ts";
import type { Workflow } from "./workflow.ts";
import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import { ActiveRun, type ActiveRunStatus } from "../models/active_run.ts";
import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";
import { ModelOutput } from "../models/model_output.ts";
import type { ModelType } from "../models/model_type.ts";
import { createDefinitionId } from "../definitions/definition.ts";

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

// Helper: an output repository holding no method-run records
const noOutputs: MethodRunOutputs = {
  findByIds: () => Promise.resolve(new Map()),
  save: () => Promise.reject(new Error("unexpected output save")),
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

Deno.test("reapOrphanedWorkflowRuns: a step whose start was never saved becomes unknown", async () => {
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status: "running",
    startedAt: "2026-07-20T20:00:00.000Z",
    pid: 99999,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt: "2026-07-20T20:00:00.000Z",
      steps: [{ stepName: "step1", status: "pending" }],
    }],
    tags: {},
  });
  await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    () => Promise.resolve(),
    trackerReaped,
    unexpectedPidCheck,
  );
  assertEquals(run.tags["interrupt_reason"], "server_crash");
  assertEquals(run.unknownSteps(), ["step1"]);
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
  /** Every repository and tracker write, in order. */
  writes: string[];
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
  const recorded: Recorded = { saved: [], completed: [], writes: [] };
  return {
    runRepo: {
      findById: (_wfId: WorkflowId, runId: WorkflowRunId) =>
        Promise.resolve(
          stored.find((r) => r.id === (runId as string)) ?? null,
        ),
      save: (_wfId: WorkflowId, run: WorkflowRun) => {
        recorded.saved.push({ runId: run.id, status: run.status });
        recorded.writes.push(`save:${run.status}`);
        return Promise.resolve();
      },
    } as unknown as WorkflowRunRepository,
    runTracker: {
      findById: (runId: string) => rows.find((r) => r.id === runId) ?? null,
      findAll: () => rows,
      complete: (runId: string, status: ActiveRunStatus) => {
        recorded.completed.push({ runId, status });
        recorded.writes.push(`complete:${status}`);
      },
      markSettled: (_runId: string, reason: string) => {
        recorded.writes.push(`settled:${reason}`);
      },
    } as unknown as RunTrackerRepository,
    recorded,
  };
}

Deno.test("trackerShowsDeadOwner: only a local running or interrupted row with a dead pid counts", () => {
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
  // Reaped on heartbeat age by another serve instance on this host, while
  // its owner is still alive: the pid decides, not the status.
  assertEquals(
    trackerShowsDeadOwner(
      trackerRow(id, { pid: 7, status: "interrupted" }),
      check,
    ),
    false,
  );
  assertEquals(
    trackerShowsDeadOwner(trackerRow(id, { hostname: "other-host" }), check),
    false,
  );
  // Another host's row is reaped on heartbeat age alone, never a pid check.
  assertEquals(
    trackerShowsDeadOwner(
      trackerRow(id, { hostname: "other-host", status: "interrupted" }),
      check,
    ),
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
    noOutputs,
  );

  assertEquals(settled, true);
  assertEquals(run.status, "interrupted");
  assertEquals(run.tags["interrupt_reason"], "owner_process_dead");
  assertEquals(run.jobs[0].status, "unknown");
  assertEquals(run.jobs[0].steps[0].status, "unknown");
  assertEquals(recorded.saved, [{ runId: run.id, status: "interrupted" }]);
  assertEquals(recorded.completed, [{ runId: run.id, status: "interrupted" }]);
  // The row is marked settled only once the record is saved.
  assertEquals(recorded.writes, [
    "complete:interrupted",
    "save:interrupted",
    "settled:owner_process_dead",
  ]);
});

Deno.test("settleDeadOwnerRun: a step whose start was never saved becomes unknown, not pending", async () => {
  // As a pre-#2896 swamp left it: the job is running, its in-flight step
  // still reads pending.
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status: "running",
    startedAt: "2026-07-20T20:00:00.000Z",
    pid: 4242,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt: "2026-07-20T20:00:00.000Z",
      steps: [
        {
          stepName: "fast",
          status: "succeeded",
          startedAt: "2026-07-20T20:00:00.000Z",
        },
        { stepName: "slow", status: "pending" },
      ],
    }],
    tags: {},
  });
  const { runRepo, runTracker } = stubs(
    [run],
    [trackerRow(run.id, { pid: 4242 })],
  );

  await settleDeadOwnerRun(
    runRepo,
    runTracker,
    WORKFLOW_ID,
    run.id,
    liveness([4242]),
    noOutputs,
  );

  assertEquals(run.unknownSteps(), ["slow"]);
});

Deno.test("settleDeadOwnerRun: leaves the row unsettled when saving the record fails", async () => {
  const run = makeRun({ pid: 4242 });
  const { runRepo, runTracker, recorded } = stubs(
    [run],
    [trackerRow(run.id, { pid: 4242 })],
  );
  runRepo.save = () => Promise.reject(new Error("disk full"));

  await assertRejects(
    () =>
      settleDeadOwnerRun(
        runRepo,
        runTracker,
        WORKFLOW_ID,
        run.id,
        liveness([4242]),
        noOutputs,
      ),
    Error,
    "disk full",
  );
  assertEquals(recorded.writes, ["complete:interrupted"]);
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
    liveness([4242]),
    noOutputs,
  );

  assertEquals(settled, true);
  assertEquals(run.status, "interrupted");
  assertEquals(recorded.saved.length, 1);
});

Deno.test("settleDeadOwnerRun: leaves a running run whose interrupted row's owner is still alive", async () => {
  // Another serve instance on this host reaped the row on heartbeat age
  // alone (a stalled event loop), while its owner is still executing.
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
    noOutputs,
  );

  assertEquals(settled, false);
  assertEquals(run.status, "running");
  assertEquals(recorded.saved, []);
  assertEquals(recorded.completed, []);
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
      noOutputs,
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
    noOutputs,
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
    noOutputs,
  );

  assertEquals(settled, false);
  assertEquals(taken.status, "running");
  assertEquals(recorded.saved, []);
});

// --- method runs a dead owner left running ---

const MODEL_TYPE = "command/shell";

function methodRow(
  overrides: {
    id?: string;
    status?: ActiveRunStatus;
    pid?: number;
    hostname?: string;
    methodName?: string;
    settled?: boolean;
  } = {},
): ActiveRun {
  const now = new Date().toISOString();
  return ActiveRun.fromData({
    id: overrides.id ?? crypto.randomUUID(),
    runKind: "model_method",
    modelType: MODEL_TYPE,
    methodName: overrides.methodName ?? "execute",
    workflowName: null,
    pid: overrides.pid ?? 4242,
    hostname: overrides.hostname ?? HOST,
    startedAt: now,
    heartbeatAt: now,
    status: overrides.status ?? "running",
    initiatedBy: null,
    settled: overrides.settled,
  });
}

/** An output saved running by process `pid`, with the row's id. */
function runningOutput(row: ActiveRun, pid = row.pid): ModelOutput {
  const output = ModelOutput.fromData({
    id: row.id,
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: row.methodName!,
    status: "pending",
    startedAt: new Date().toISOString(),
    retryCount: 0,
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "workflow",
    },
    artifacts: { dataArtifacts: [] },
  });
  output.markRunning(pid);
  return output;
}

/** An output repository over `outputs`, recording reads and saves. */
function outputStub(outputs: ModelOutput[], writes: string[] = []): {
  outputRepo: MethodRunOutputs;
  reads: string[];
} {
  const reads: string[] = [];
  return {
    outputRepo: {
      findByIds: (type: ModelType, method: string, ids) => {
        reads.push(`${type.normalized}:${method}`);
        return Promise.resolve(
          new Map(
            outputs.filter((o) => ids.has(o.id)).map((o) => [o.id, o]),
          ),
        );
      },
      save: (_type: ModelType, _method: string, output: ModelOutput) => {
        writes.push(`save-output:${output.status}`);
        return Promise.resolve();
      },
    },
    reads,
  };
}

Deno.test("matchMethodRunOutputs: only an output still running under the row's pid needs settling", async () => {
  const same = methodRow();
  const other = methodRow();
  const finished = methodRow();
  const missing = methodRow();
  const noPid = methodRow();
  const done = runningOutput(finished);
  done.markSucceeded();
  const { outputRepo, reads } = outputStub([
    runningOutput(same),
    runningOutput(other, 5151),
    done,
    runningOutput(noPid, undefined as unknown as number),
  ]);

  const { running, done: settled } = await matchMethodRunOutputs(
    outputRepo,
    [same, other, finished, missing, noPid],
  );

  assertEquals(running.map((r) => r.row.id).sort(), [same.id, noPid.id].sort());
  assertEquals(
    settled.map((r) => r.id).sort(),
    [other.id, finished.id, missing.id].sort(),
  );
  // One read for the model type and method all five rows share.
  assertEquals(reads, [`${MODEL_TYPE}:execute`]);
});

Deno.test("matchMethodRunOutputs: a row that cannot name an output is never looked up", async () => {
  const escaping = methodRow({ methodName: "../../etc" });
  const nested = methodRow({ methodName: "a/b" });
  const workflow = trackerRow(crypto.randomUUID());
  const { outputRepo, reads } = outputStub([]);

  const { running, done } = await matchMethodRunOutputs(outputRepo, [
    escaping,
    nested,
    workflow,
  ]);

  assertEquals(running, []);
  assertEquals(done.length, 3);
  assertEquals(reads, []);
});

Deno.test("settleDeadOwnerMethodRuns: cancels a dead owner's running output, then settles its row", async () => {
  const row = methodRow();
  const output = runningOutput(row);
  const { runTracker, recorded } = stubs([], [row]);
  const { outputRepo } = outputStub([output], recorded.writes);

  const settled = await settleDeadOwnerMethodRuns(
    outputRepo,
    runTracker,
    liveness([4242]),
  );

  assertEquals(settled.map((s) => s.row.id), [row.id]);
  assertEquals(output.status, "cancelled");
  assertEquals(output.completedAt !== undefined, true);
  assertEquals(output.error?.message, ownerExitedReason(4242));
  // The row is marked settled only once the output is saved.
  assertEquals(recorded.writes, [
    "complete:interrupted",
    "save-output:cancelled",
    "settled:owner_process_dead",
  ]);
});

Deno.test("settleDeadOwnerMethodRuns: leaves rows whose owner is alive, remote, or another pid", async () => {
  const alive = methodRow({ pid: 7 });
  const remote = methodRow({ hostname: "other-host" });
  const otherPid = methodRow({ pid: 5151 });
  const outputs = [
    runningOutput(alive),
    runningOutput(remote),
    runningOutput(otherPid),
  ];
  const { runTracker, recorded } = stubs([], [alive, remote, otherPid]);
  const { outputRepo } = outputStub(outputs, recorded.writes);

  const settled = await settleDeadOwnerMethodRuns(
    outputRepo,
    runTracker,
    liveness([4242, 5151]),
    4242,
  );

  assertEquals(settled, []);
  assertEquals(outputs.map((o) => o.status), ["running", "running", "running"]);
  assertEquals(recorded.writes, []);
});

Deno.test("settleDeadOwnerMethodRuns: settles a dead owner's row with no output left to settle", async () => {
  const missing = methodRow({ status: "interrupted" });
  const finished = methodRow();
  const done = runningOutput(finished);
  done.markFailed({ message: "boom" });
  const { runTracker, recorded } = stubs([], [missing, finished]);
  const { outputRepo } = outputStub([done], recorded.writes);

  const settled = await settleDeadOwnerMethodRuns(
    outputRepo,
    runTracker,
    liveness([4242]),
  );

  assertEquals(settled, []);
  assertEquals(done.status, "failed");
  assertEquals(recorded.writes, [
    "complete:interrupted",
    "settled:record_settled",
    "complete:interrupted",
    "settled:record_settled",
  ]);
});

Deno.test("settleDeadOwnerMethodRuns: leaves the row unsettled when saving the output fails", async () => {
  const row = methodRow();
  const { runTracker, recorded } = stubs([], [row]);
  const outputRepo: MethodRunOutputs = {
    findByIds: () => Promise.resolve(new Map([[row.id, runningOutput(row)]])),
    save: () => Promise.reject(new Error("disk full")),
  };

  await assertRejects(
    () => settleDeadOwnerMethodRuns(outputRepo, runTracker, liveness([4242])),
    Error,
    "disk full",
  );
  assertEquals(recorded.writes, ["complete:interrupted"]);
});

Deno.test("findDeadOwnerMethodRuns: reports without writing", async () => {
  const row = methodRow();
  const output = runningOutput(row);
  const { runTracker, recorded } = stubs([], [row]);
  const { outputRepo } = outputStub([output], recorded.writes);

  const { running } = await findDeadOwnerMethodRuns(
    outputRepo,
    runTracker,
    liveness([4242]),
  );

  assertEquals(running.map((r) => r.row.id), [row.id]);
  assertEquals(output.status, "running");
  assertEquals(recorded.writes, []);
});

Deno.test("settleDeadOwnerRun: settles the method runs its dead owner left running", async () => {
  const run = makeRun({ pid: 4242 });
  const step = methodRow();
  const stranger = methodRow({ pid: 5151 });
  const stepOutput = runningOutput(step);
  const strangerOutput = runningOutput(stranger);
  const { runRepo, runTracker, recorded } = stubs(
    [run],
    [trackerRow(run.id, { pid: 4242 }), step, stranger],
  );
  const { outputRepo } = outputStub(
    [stepOutput, strangerOutput],
    recorded.writes,
  );

  const settled = await settleDeadOwnerRun(
    runRepo,
    runTracker,
    WORKFLOW_ID,
    run.id,
    liveness([4242, 5151]),
    outputRepo,
  );

  assertEquals(settled, true);
  assertEquals(stepOutput.status, "cancelled");
  // Only the dead owner's own method runs; another dead pid waits for doctor.
  assertEquals(strangerOutput.status, "running");
  assertEquals(recorded.writes, [
    "complete:interrupted",
    "save:interrupted",
    "settled:owner_process_dead",
    "complete:interrupted",
    "save-output:cancelled",
    "settled:owner_process_dead",
  ]);
});

Deno.test("findDeadOwnerMethodRuns: a row already settled is not read again", async () => {
  const settled = methodRow({ status: "interrupted", settled: true });
  const { runTracker } = stubs([], [settled]);
  const { outputRepo, reads } = outputStub([runningOutput(settled)]);

  const { running, done } = await findDeadOwnerMethodRuns(
    outputRepo,
    runTracker,
    liveness([4242]),
  );

  assertEquals(running, []);
  assertEquals(done, []);
  assertEquals(reads, []);
});

Deno.test("settleDeadOwnerRun: a method-run settlement failure does not fail the settled run", async () => {
  const run = makeRun({ pid: 4242 });
  const step = methodRow();
  const { runRepo, runTracker, recorded } = stubs(
    [run],
    [trackerRow(run.id, { pid: 4242 }), step],
  );
  const outputRepo: MethodRunOutputs = {
    findByIds: () => Promise.reject(new Error("permission denied")),
    save: () => Promise.reject(new Error("unexpected output save")),
  };

  const settled = await settleDeadOwnerRun(
    runRepo,
    runTracker,
    WORKFLOW_ID,
    run.id,
    liveness([4242]),
    outputRepo,
  );

  assertEquals(settled, true);
  assertEquals(run.status, "interrupted");
  // The step's row is left unsettled for run doctor.
  assertEquals(recorded.writes, [
    "complete:interrupted",
    "save:interrupted",
    "settled:owner_process_dead",
  ]);
});

Deno.test("cancelOrphanedMethodRuns: collects a failed save instead of throwing", async () => {
  const ok = methodRow();
  const bad = methodRow();
  const finished = methodRow();
  const done = runningOutput(finished);
  done.markSucceeded();
  const outputs = [runningOutput(ok), runningOutput(bad), done];
  const outputRepo: MethodRunOutputs = {
    findByIds: (_type, _method, ids) =>
      Promise.resolve(
        new Map(outputs.filter((o) => ids.has(o.id)).map((o) => [o.id, o])),
      ),
    save: (_type, _method, output) =>
      output.id === bad.id
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve(),
  };

  const { closed, failed, errors } = await cancelOrphanedMethodRuns(
    outputRepo,
    [ok, bad, finished],
    "stopped",
  );

  assertEquals(closed.map((r) => r.id).sort(), [ok.id, finished.id].sort());
  assertEquals(failed.map((r) => r.id), [bad.id]);
  assertEquals(errors.length, 1);
});

Deno.test("cancelOrphanedMethodRuns: a failed read leaves every row failed", async () => {
  const row = methodRow();
  const { failed, closed } = await cancelOrphanedMethodRuns(
    {
      findByIds: () => Promise.reject(new Error("permission denied")),
      save: () => Promise.resolve(),
    },
    [row],
    "stopped",
  );
  assertEquals(closed, []);
  assertEquals(failed.map((r) => r.id), [row.id]);
});

// --- runRecordFinder and settleInterruptedWorkflowRows (swamp-club#2917) ---

const NAMED_WORKFLOW = "11111111-1111-4111-8111-111111111111" as WorkflowId;
const OTHER_WORKFLOW = "22222222-2222-4222-8222-222222222222" as WorkflowId;

/**
 * A record store holding `byWorkflow`, and a workflow lookup that knows only
 * "test-workflow", as NAMED_WORKFLOW. `failing` run ids throw on read.
 */
function recordFinder(
  byWorkflow: Map<WorkflowId, WorkflowRun[]>,
  failing: string[] = [],
) {
  const reads: string[] = [];
  const find = runRecordFinder(
    {
      findById: (workflowId, runId) => {
        reads.push(`${workflowId}:${runId}`);
        if (failing.includes(runId)) {
          return Promise.reject(new Error("permission denied"));
        }
        return Promise.resolve(
          byWorkflow.get(workflowId)?.find((r) => r.id === runId) ?? null,
        );
      },
      listWorkflowIds: () => Promise.resolve([...byWorkflow.keys()]),
    },
    {
      findByName: (name: string) =>
        Promise.resolve(
          name === "test-workflow"
            ? { id: NAMED_WORKFLOW } as unknown as Workflow
            : null,
        ),
    },
  );
  return { find, reads };
}

Deno.test("runRecordFinder: finds a record under the row's workflow without listing others", async () => {
  const run = makeRun();
  const { find, reads } = recordFinder(
    new Map([[NAMED_WORKFLOW, [run]], [OTHER_WORKFLOW, []]]),
  );

  const found = await find(trackerRow(run.id));

  assertEquals(found?.workflowId, NAMED_WORKFLOW);
  assertEquals(reads, [`${NAMED_WORKFLOW}:${run.id}`]);
});

Deno.test("runRecordFinder: finds a renamed workflow's record by run id", async () => {
  const run = makeRun();
  const { find } = recordFinder(
    new Map([[NAMED_WORKFLOW, []], [OTHER_WORKFLOW, [run]]]),
  );

  const found = await find(trackerRow(run.id));

  assertEquals(found?.workflowId, OTHER_WORKFLOW);
  assertEquals(found?.run.id, run.id);
});

Deno.test("runRecordFinder: null when no workflow stores the record", async () => {
  const { find } = recordFinder(
    new Map([[NAMED_WORKFLOW, []], [OTHER_WORKFLOW, []]]),
  );

  assertEquals(await find(trackerRow(crypto.randomUUID())), null);
});

Deno.test("settleInterruptedWorkflowRows: settles rows whose record finished or is gone, and nothing else", async () => {
  const finished = makeRun();
  finished.interrupt("server_crash");
  const renamed = makeRun();
  renamed.interrupt("server_shutdown");
  const running = makeRun();
  const goneId = crypto.randomUUID();
  const unreadableId = crypto.randomUUID();
  const alreadySettled = ActiveRun.fromData({
    ...trackerRow(crypto.randomUUID(), { status: "interrupted" }).toData(),
    settled: true,
  });
  const rows = [
    trackerRow(finished.id, { status: "interrupted" }),
    trackerRow(renamed.id, { status: "interrupted" }),
    trackerRow(running.id, { status: "interrupted" }),
    trackerRow(goneId, { status: "interrupted" }),
    trackerRow(unreadableId, { status: "interrupted" }),
    trackerRow(crypto.randomUUID(), { status: "running" }),
    trackerRow(crypto.randomUUID(), { status: "completed" }),
    alreadySettled,
  ];
  const marked: [string, string][] = [];
  const runTracker = {
    findAll: () => rows,
    markSettled: (runId: string, reason: string) => {
      marked.push([runId, reason]);
    },
  } as unknown as RunTrackerRepository;
  const { find } = recordFinder(
    new Map([
      [NAMED_WORKFLOW, [finished, running]],
      [OTHER_WORKFLOW, [renamed]],
    ]),
    [unreadableId],
  );

  const settled = await settleInterruptedWorkflowRows(runTracker, find);

  assertEquals(settled, 3);
  assertEquals(marked, [
    [finished.id, "record_settled"],
    [renamed.id, "record_settled"],
    [goneId, "record_missing"],
  ]);
});

Deno.test("suspendedRunHasDeadOwner: a suspended run whose tracker row still runs under a dead pid was abandoned", () => {
  const run = makeRun({ pid: 4242, status: "suspended" });
  const dead = liveness([4242]);

  const abandoned = stubs([], [trackerRow(run.id, { pid: 4242 })]);
  assertEquals(suspendedRunHasDeadOwner(run, abandoned.runTracker, dead), true);

  // The owner is still alive: the level has not drained yet.
  assertEquals(
    suspendedRunHasDeadOwner(run, abandoned.runTracker, liveness()),
    false,
  );
});

Deno.test("suspendedRunHasDeadOwner: never judges a run it cannot tie to a dead local owner", () => {
  const run = makeRun({ pid: 4242, status: "suspended" });
  const dead = liveness([4242, 999]);

  // No tracker row.
  assertEquals(
    suspendedRunHasDeadOwner(run, stubs([], []).runTracker, dead),
    false,
  );
  // The owner drained the level and marked its row suspended itself.
  const settled = stubs([], [
    trackerRow(run.id, { pid: 4242, status: "suspended" }),
  ]);
  assertEquals(suspendedRunHasDeadOwner(run, settled.runTracker, dead), false);
  // The row belongs to another process than the record names.
  const otherPid = stubs([], [trackerRow(run.id, { pid: 999 })]);
  assertEquals(suspendedRunHasDeadOwner(run, otherPid.runTracker, dead), false);
  // Owned on another host.
  const elsewhere = stubs([], [
    trackerRow(run.id, { pid: 4242, hostname: "other-host" }),
  ]);
  assertEquals(
    suspendedRunHasDeadOwner(run, elsewhere.runTracker, dead),
    false,
  );
  // A run that is not suspended is the reaper's to judge.
  const running = makeRun({ pid: 4242 });
  const runningRows = stubs([], [trackerRow(running.id, { pid: 4242 })]);
  assertEquals(
    suspendedRunHasDeadOwner(running, runningRows.runTracker, dead),
    false,
  );
});

Deno.test("suspendedRunOwnerIsRunning: true only while the tracker row still runs under an owner not shown gone", () => {
  const run = makeRun({ pid: 4242, status: "suspended" });
  const alive = liveness();
  const dead = liveness([4242]);

  // Mid-level: the record says suspended, the row still says running.
  const midLevel = stubs([], [trackerRow(run.id, { pid: 4242 })]);
  assertEquals(
    suspendedRunOwnerIsRunning(run, midLevel.runTracker, alive),
    true,
  );
  // The same row under a dead owner: nothing will save the record again.
  assertEquals(
    suspendedRunOwnerIsRunning(run, midLevel.runTracker, dead),
    false,
  );

  // The owner drained the level and marked its row suspended.
  const drained = stubs([], [
    trackerRow(run.id, { pid: 4242, status: "suspended" }),
  ]);
  assertEquals(
    suspendedRunOwnerIsRunning(run, drained.runTracker, alive),
    false,
  );
  // No tracker row to judge by.
  assertEquals(
    suspendedRunOwnerIsRunning(run, stubs([], []).runTracker, alive),
    false,
  );
  // An owner on another host cannot be checked, so it counts as running.
  const elsewhere = stubs([], [
    trackerRow(run.id, { pid: 4242, hostname: "other-host" }),
  ]);
  assertEquals(
    suspendedRunOwnerIsRunning(run, elsewhere.runTracker, dead),
    true,
  );
  // A run that is not suspended is not this predicate's to judge.
  const running = makeRun({ pid: 4242 });
  const runningRows = stubs([], [trackerRow(running.id, { pid: 4242 })]);
  assertEquals(
    suspendedRunOwnerIsRunning(running, runningRows.runTracker, alive),
    false,
  );
});
