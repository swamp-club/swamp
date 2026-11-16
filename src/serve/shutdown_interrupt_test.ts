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
import { Workflow } from "../domain/workflows/workflow.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import type { WorkflowId } from "../domain/workflows/workflow_id.ts";
import type { ActiveRun } from "./active_run_registry.ts";
import { createSyncGate } from "./sync_gate.ts";
import {
  interruptShutdownRuns,
  type ShutdownInterruptDeps,
  stopHeartbeatAtShutdown,
} from "./shutdown_interrupt.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import {
  readUnpushedInterrupts,
  UNPUSHED_INTERRUPTS_FILE,
} from "./unpushed_interrupts.ts";
import type { ActiveRunStatus } from "../domain/models/active_run.ts";
import { RUN_WRITE_FENCE_WAIT_MS } from "./run_write_fence.ts";
import type { CommitLogEngine } from "../infrastructure/persistence/repo_unit_of_work.ts";

await initializeLogging({});

function workflow(): Workflow {
  return Workflow.create({
    name: `wf-${crypto.randomUUID()}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "sleep",
            task: StepTask.manualApproval("ok?"),
          }),
        ],
      }),
    ],
  });
}

function runningRun(wf: Workflow): WorkflowRun {
  const run = WorkflowRun.create(wf);
  run.start();
  return run;
}

function active(
  run: WorkflowRun,
  kind: ActiveRun["kind"] = "workflow-run",
): Pick<ActiveRun, "runId" | "kind" | "startedAt"> {
  return { runId: run.id, kind, startedAt: new Date() };
}

function harness(runs: WorkflowRun[], workflowId: WorkflowId) {
  const events: string[] = [];
  const repoContext: ShutdownInterruptDeps["repoContext"] = {
    markDirty: () => Promise.resolve(),
    workflowRunRepo: {
      findById: (_wid, runId) =>
        Promise.resolve(runs.find((run) => run.id === runId) ?? null),
      findGlobalByStatus: (status) => {
        events.push("load");
        const wanted = Array.isArray(status) ? status : [status];
        return Promise.resolve(
          runs
            .filter((run) => wanted.includes(run.status))
            .map((run) => ({ run, workflowId })),
        );
      },
      save: (_wid, run) => {
        events.push(`save ${run.id} ${run.status}`);
        return Promise.resolve();
      },
    },
  };
  return { events, repoContext };
}

Deno.test("interruptShutdownRuns: saves a running run interrupted, then pushes it (swamp-club#3252)", async () => {
  const wf = workflow();
  const run = WorkflowRun.create(wf);
  run.start(1, "serve-a");
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    syncService: {
      pushChanged: (options) => {
        events.push(`push ${options?.namespace}`);
        return Promise.resolve(1);
      },
    },
    namespace: "ns",
    syncGate: createSyncGate(),
  });

  assertEquals(result, { interrupted: [run.id] });
  assertEquals(events, ["load", `save ${run.id} interrupted`, "push ns"]);
  assertEquals(run.tags["interrupt_reason"], "server_shutdown");
  assertEquals(run.continuableSince !== undefined, true);
});

Deno.test("interruptShutdownRuns: a run that ended cancelled is interrupted and pushed", async () => {
  // the run's own unit of work pushed cancelled before the interrupt ran
  const wf = workflow();
  const run = runningRun(wf);
  run.endAsCancelled("server shutdown");
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns([active(run, "workflow-resume")], {
    repoContext,
    syncService: {
      pushChanged: () => {
        events.push("push");
        return Promise.resolve(1);
      },
    },
  });

  assertEquals(result, { interrupted: [run.id] });
  assertEquals(events, ["load", `save ${run.id} interrupted`, "push"]);
});

Deno.test("interruptShutdownRuns: a run that completed during the drain is left alone", async () => {
  const wf = workflow();
  const done = runningRun(wf);
  done.complete();
  const status = done.status;
  const { events, repoContext } = harness([done], wf.id);

  const result = await interruptShutdownRuns([active(done)], {
    repoContext,
    syncService: {
      pushChanged: () => {
        events.push("push");
        return Promise.resolve(0);
      },
    },
  });

  assertEquals(result, { interrupted: [] });
  assertEquals(events, ["load"]);
  assertEquals(done.status, status);
});

Deno.test("interruptShutdownRuns: a failed push is reported, not thrown", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    syncService: {
      pushChanged: () => Promise.reject(new Error("S3 unreachable")),
    },
  });

  assertEquals(result, {
    interrupted: [run.id],
    pushError: "S3 unreachable",
    unpushed: [run.id],
  });
  assertEquals(events, ["load", `save ${run.id} interrupted`]);
});

Deno.test("interruptShutdownRuns: a push that never settles is cut off at the deadline and aborted", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { repoContext } = harness([run], wf.id);
  let signal: AbortSignal | undefined;

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    syncService: {
      pushChanged: (options) => {
        signal = options?.signal;
        return new Promise((_, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal!.reason),
          )
        );
      },
    },
    pushTimeoutMs: 10,
  });

  assertEquals(result, {
    interrupted: [run.id],
    pushError: "timed out after 10ms",
    unpushed: [run.id],
  });
  assertEquals(signal?.aborted, true);
});

Deno.test("interruptShutdownRuns: a gate held by a pull is cut off at the deadline", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);
  const gate = createSyncGate();
  await gate.acquire();
  try {
    const result = await interruptShutdownRuns([active(run)], {
      repoContext,
      syncService: {
        pushChanged: () => {
          events.push("push");
          return Promise.resolve(1);
        },
      },
      syncGate: gate,
      pushTimeoutMs: 10,
    });

    assertEquals(result, {
      interrupted: [run.id],
      pushError: "timed out after 10ms",
      unpushed: [run.id],
    });
    assertEquals(events, ["load", `save ${run.id} interrupted`]);
  } finally {
    gate.release();
  }
  // The abandoned push queued for the gate ahead of this acquire, so once it
  // is granted the push has had its turn, and skipped it past the deadline.
  await gate.acquire();
  gate.release();
  assertEquals(events, ["load", `save ${run.id} interrupted`]);
});

Deno.test("interruptShutdownRuns: with no sync service the run is saved and nothing pushes", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);
  const reported: string[] = [];

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    onInterrupted: (runId) => reported.push(runId),
  });

  assertEquals(result, { interrupted: [run.id] });
  assertEquals(events, ["load", `save ${run.id} interrupted`]);
  assertEquals(reported, [run.id]);
});

Deno.test("interruptShutdownRuns: no aborted workflow run loads nothing and pushes nothing", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns(
    [{ runId: "m-1", kind: "method-run", startedAt: new Date() }],
    {
      repoContext,
      syncService: {
        pushChanged: () => {
          events.push("push");
          return Promise.resolve(0);
        },
      },
    },
  );

  assertEquals(result, { interrupted: [] });
  assertEquals(events, []);
});

function tracker(
  rows: Map<string, ActiveRunStatus> = new Map(),
): ShutdownInterruptDeps["runTracker"] & { completed: string[] } {
  const completed: string[] = [];
  return {
    completed,
    complete: (runId, status, reason) => {
      const current = rows.get(runId) ?? "running";
      if (current !== "running" && current !== "suspended") return;
      rows.set(runId, status);
      completed.push(`${runId} ${status} ${reason}`);
    },
    interruptCancelled: (runId, reason) => {
      if (rows.get(runId) !== "cancelled") return;
      rows.set(runId, "interrupted");
      completed.push(`${runId} interrupted ${reason} (was cancelled)`);
    },
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("interruptShutdownRuns: settles the tracker row of each interrupted run (swamp-club#3958)", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { repoContext } = harness([run], wf.id);
  const runTracker = tracker();

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    syncService: { pushChanged: () => Promise.resolve(1) },
    runTracker,
  });

  assertEquals(result, { interrupted: [run.id] });
  assertEquals(runTracker.completed, [`${run.id} interrupted server_shutdown`]);
});

Deno.test("interruptShutdownRuns: a row the run settled as cancelled before its record was interrupted becomes interrupted, so a resume can reactivate it", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  run.endAsCancelled("server shutdown");
  const { repoContext } = harness([run], wf.id);
  const rows = new Map<string, ActiveRunStatus>([[run.id, "cancelled"]]);
  const runTracker = tracker(rows);

  await interruptShutdownRuns([active(run)], { repoContext, runTracker });

  assertEquals(runTracker.completed, [
    `${run.id} interrupted server_shutdown (was cancelled)`,
  ]);
  assertEquals(rows.get(run.id), "interrupted");
});

Deno.test("interruptShutdownRuns: a cancelled row whose record could not be interrupted is left cancelled", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  run.endAsCancelled("server shutdown");
  const { repoContext } = harness([run], wf.id);
  repoContext.workflowRunRepo.save = () =>
    Promise.reject(new Error("disk full"));
  const rows = new Map<string, ActiveRunStatus>([[run.id, "cancelled"]]);
  const runTracker = tracker(rows);

  await interruptShutdownRuns([active(run)], { repoContext, runTracker });

  assertEquals(rows.get(run.id), "cancelled");
});

Deno.test("interruptShutdownRuns: a run that completed during the drain keeps its tracker row", async () => {
  const wf = workflow();
  const done = runningRun(wf);
  done.complete();
  const { repoContext } = harness([done], wf.id);
  const runTracker = tracker();

  await interruptShutdownRuns([active(done)], { repoContext, runTracker });

  assertEquals(runTracker.completed, []);
});

Deno.test("interruptShutdownRuns: a run whose save failed still settles its row and is reported unpushed", async () => {
  const wf = workflow();
  const saved = runningRun(wf);
  const failing = runningRun(wf);
  const { repoContext } = harness([saved, failing], wf.id);
  const save = repoContext.workflowRunRepo.save;
  const runTracker = tracker();

  const result = await interruptShutdownRuns(
    [active(saved), active(failing)],
    {
      repoContext: {
        ...repoContext,
        workflowRunRepo: {
          ...repoContext.workflowRunRepo,
          save: (wid, run) =>
            run.id === failing.id
              ? Promise.reject(new Error("disk full"))
              : save(wid, run),
        },
      },
      syncService: { pushChanged: () => Promise.resolve(1) },
      runTracker,
    },
  );

  assertEquals(result, { interrupted: [saved.id], unpushed: [failing.id] });
  assertEquals(runTracker.completed, [
    `${saved.id} interrupted server_shutdown`,
    `${failing.id} interrupted server_shutdown`,
  ]);
});

Deno.test("interruptShutdownRuns: a failed load settles every aborted run's row and reports them unpushed", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { repoContext } = harness([run], wf.id);
  const runTracker = tracker();

  const result = await interruptShutdownRuns([active(run)], {
    repoContext: {
      ...repoContext,
      workflowRunRepo: {
        ...repoContext.workflowRunRepo,
        findGlobalByStatus: () => Promise.reject(new Error("unreadable")),
      },
    },
    syncService: { pushChanged: () => Promise.resolve(1) },
    runTracker,
  });

  assertEquals(result, { interrupted: [], unpushed: [run.id] });
  assertEquals(runTracker.completed, [`${run.id} interrupted server_shutdown`]);
});

Deno.test("interruptShutdownRuns: records the runs a failed push left for the next start", async () => {
  await withTempDir(async (dir) => {
    const wf = workflow();
    const run = runningRun(wf);
    const { repoContext } = harness([run], wf.id);
    const marker = join(dir, UNPUSHED_INTERRUPTS_FILE);

    await interruptShutdownRuns([active(run)], {
      repoContext,
      syncService: {
        pushChanged: () => Promise.reject(new Error("S3 unreachable")),
      },
      unpushedMarkerPath: marker,
    });

    assertEquals(await readUnpushedInterrupts(marker), {
      present: true,
      runs: [{ runId: run.id, workflowId: wf.id }],
    });
  });
});

Deno.test("interruptShutdownRuns: a pushed run records nothing for the next start", async () => {
  await withTempDir(async (dir) => {
    const wf = workflow();
    const run = runningRun(wf);
    const { repoContext } = harness([run], wf.id);
    const marker = join(dir, UNPUSHED_INTERRUPTS_FILE);

    await interruptShutdownRuns([active(run)], {
      repoContext,
      syncService: { pushChanged: () => Promise.resolve(1) },
      unpushedMarkerPath: marker,
    });

    assertEquals(await readUnpushedInterrupts(marker), { present: false });
  });
});

Deno.test("interruptShutdownRuns: a push that sent no files is taken as pushed, since the record may have gone already or run records may not sync", async () => {
  await withTempDir(async (dir) => {
    const wf = workflow();
    const run = runningRun(wf);
    const { repoContext } = harness([run], wf.id);
    const marker = join(dir, UNPUSHED_INTERRUPTS_FILE);

    const result = await interruptShutdownRuns([active(run)], {
      repoContext,
      syncService: { pushChanged: () => Promise.resolve(0) },
      unpushedMarkerPath: marker,
    });

    assertEquals(result, { interrupted: [run.id] });
    assertEquals(await readUnpushedInterrupts(marker), { present: false });
  });
});

Deno.test("interruptShutdownRuns: closes the aborted workflow runs' write fence before it loads them (swamp-club#4101)", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);
  const methodRun = {
    runId: crypto.randomUUID(),
    kind: "method-run" as const,
    startedAt: new Date(),
  };

  await interruptShutdownRuns([active(run), methodRun], {
    repoContext,
    runWriteFence: {
      close: (runIds) => {
        events.push(`close ${runIds.join(",")}`);
        return Promise.resolve();
      },
      takeOver: () => {},
    },
    syncService: {
      pushChanged: () => {
        events.push("push");
        return Promise.resolve(1);
      },
    },
  });

  assertEquals(events, [
    `close ${run.id}`,
    "load",
    `save ${run.id} interrupted`,
    "push",
  ]);
});

Deno.test("interruptShutdownRuns: closes the write fence on a filesystem datastore too", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);

  await interruptShutdownRuns([active(run)], {
    repoContext,
    runWriteFence: {
      close: (runIds) => {
        events.push(`close ${runIds.join(",")}`);
        return Promise.resolve();
      },
      takeOver: () => {},
    },
  });

  assertEquals(events, [
    `close ${run.id}`,
    "load",
    `save ${run.id} interrupted`,
  ]);
});

Deno.test("interruptShutdownRuns: with no aborted workflow run the write fence is not closed", async () => {
  let closed = false;
  await interruptShutdownRuns(
    [{ runId: crypto.randomUUID(), kind: "method-run", startedAt: new Date() }],
    {
      repoContext: harness([], workflow().id).repoContext,
      runWriteFence: {
        close: () => {
          closed = true;
          return Promise.resolve();
        },
        takeOver: () => {},
      },
    },
  );
  assertEquals(closed, false);
});

Deno.test("interruptShutdownRuns: a marker that cannot be written is logged, not thrown", async () => {
  await withTempDir(async (dir) => {
    const wf = workflow();
    const run = runningRun(wf);
    const { repoContext } = harness([run], wf.id);

    const result = await interruptShutdownRuns([active(run)], {
      repoContext,
      syncService: {
        pushChanged: () => Promise.reject(new Error("S3 unreachable")),
      },
      unpushedMarkerPath: join(dir, "missing-dir", UNPUSHED_INTERRUPTS_FILE),
    });

    assertEquals(result.unpushed, [run.id]);
  });
});

Deno.test("interruptShutdownRuns: on a filesystem datastore nothing is reported unpushed", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns([active(run)], {
    repoContext: {
      ...repoContext,
      workflowRunRepo: {
        ...repoContext.workflowRunRepo,
        save: () => Promise.reject(new Error("disk full")),
      },
    },
  });

  assertEquals(result, { interrupted: [] });
});

function v3Engine(commit: () => Promise<void>): CommitLogEngine {
  const view = { stage: () => {}, staged: () => [] } as unknown as Parameters<
    Parameters<CommitLogEngine["runRoot"]>[1]
  >[0];
  return {
    openUnit: () => {
      throw new Error("not used");
    },
    hasOpenUnit: () => false,
    checkpointOpenUnit: () => Promise.resolve("no-unit"),
    committedBeforeThrowing: () => false,
    runRoot: async (_options, fn) => {
      const value = await fn(view);
      await commit();
      return value;
    },
  };
}

Deno.test("interruptShutdownRuns: a v3 commit held past its bound is cut off and recorded for the next start (swamp-club#3961)", async () => {
  await withTempDir(async (dir) => {
    const wf = workflow();
    const run = runningRun(wf);
    const { events, repoContext } = harness([run], wf.id);
    const marker = join(dir, UNPUSHED_INTERRUPTS_FILE);
    let failLateCommit: (error: Error) => void = () => {};
    const held = new Promise<void>((_, reject) => {
      failLateCommit = reject;
    });

    const result = await interruptShutdownRuns([active(run)], {
      repoContext: { ...repoContext, commitLog: v3Engine(() => held) },
      pushTimeoutMs: 20,
      unpushedMarkerPath: marker,
    });

    assertEquals(events, ["load", `save ${run.id} interrupted`]);
    assertEquals(result.interrupted, [run.id]);
    assertEquals(result.unpushed, [run.id]);
    assertEquals(result.pushError, "timed out after 20ms");
    assertEquals(await readUnpushedInterrupts(marker), {
      present: true,
      runs: [{ runId: run.id, workflowId: wf.id }],
    });
    // The datastore's close aborts the upload: handled, never unhandled.
    failLateCommit(new Error("Request aborted"));
    await held.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

Deno.test("interruptShutdownRuns: a v3 commit that lands in time records nothing", async () => {
  await withTempDir(async (dir) => {
    const wf = workflow();
    const run = runningRun(wf);
    const { repoContext } = harness([run], wf.id);
    const marker = join(dir, UNPUSHED_INTERRUPTS_FILE);

    const result = await interruptShutdownRuns([active(run)], {
      repoContext: {
        ...repoContext,
        commitLog: v3Engine(() => Promise.resolve()),
      },
      pushTimeoutMs: 5_000,
      unpushedMarkerPath: marker,
    });

    assertEquals(result, { interrupted: [run.id] });
    assertEquals(await readUnpushedInterrupts(marker), { present: false });
  });
});

Deno.test("interruptShutdownRuns: a v3 commit that fails is reported unpushed, not thrown", async () => {
  await withTempDir(async (dir) => {
    const wf = workflow();
    const run = runningRun(wf);
    const { repoContext } = harness([run], wf.id);
    const marker = join(dir, UNPUSHED_INTERRUPTS_FILE);

    const result = await interruptShutdownRuns([active(run)], {
      repoContext: {
        ...repoContext,
        commitLog: v3Engine(() => Promise.reject(new Error("bucket gone"))),
      },
      pushTimeoutMs: 5_000,
      unpushedMarkerPath: marker,
    });

    assertEquals(result.pushError, "bucket gone");
    assertEquals(result.unpushed, [run.id]);
    assertEquals((await readUnpushedInterrupts(marker)).present, true);
  });
});

function recordingStore(events: string[]): ControlPlaneStore {
  return {
    put: (key) => {
      events.push(`put ${key}`);
      return Promise.resolve();
    },
    get: () => Promise.resolve(null),
    delete: (key) => {
      events.push(`delete ${key}`);
      return Promise.resolve();
    },
    list: () => Promise.resolve([]),
  };
}

const ABORTED = {
  runId: "run-1",
  kind: "workflow-run" as const,
  resourceName: "slow",
  resourceId: "00000000-0000-4000-8000-000000000001",
  startedAt: new Date(),
};

Deno.test("stopHeartbeatAtShutdown: with nothing unpushed the heartbeat is deleted and no record is written", async () => {
  const events: string[] = [];
  await stopHeartbeatAtShutdown(
    {
      stop: (options) => {
        events.push(
          `stop ${
            options?.leaveStoppedRecord ?? false
          } ${options?.writeTimeoutMs}`,
        );
        return Promise.resolve();
      },
    },
    {
      store: recordingStore(events),
      instanceId: "inst",
      aborted: [ABORTED],
      unpushed: [],
      writeTimeoutMs: 1_234,
    },
  );
  assertEquals(events, ["stop false 1234"]);
});

Deno.test("stopHeartbeatAtShutdown: writes the unpushed runs' active-run records back before leaving a stopped heartbeat (swamp-club#3958)", async () => {
  const events: string[] = [];
  await stopHeartbeatAtShutdown(
    {
      stop: (options) => {
        events.push(`stop ${options?.leaveStoppedRecord ?? false}`);
        return Promise.resolve();
      },
    },
    {
      store: recordingStore(events),
      instanceId: "inst",
      aborted: [ABORTED, { ...ABORTED, runId: "run-pushed" }],
      unpushed: ["run-1"],
    },
  );
  assertEquals(events, ["put active-runs/inst/run-1", "stop true"]);
});

function takeOverFence(events: string[]) {
  return {
    close: () => Promise.resolve(),
    takeOver: (runId: string) => {
      events.push(`take over ${runId}`);
    },
  };
}

Deno.test("interruptShutdownRuns: takes a run over once its interrupted record is saved, before that record is pushed (swamp-club#4171)", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);

  await interruptShutdownRuns([active(run)], {
    repoContext,
    runWriteFence: takeOverFence(events),
    syncService: {
      pushChanged: () => {
        events.push("push");
        return Promise.resolve(1);
      },
    },
  });

  assertEquals(events, [
    "load",
    `save ${run.id} interrupted`,
    `take over ${run.id}`,
    "push",
  ]);
});

Deno.test("interruptShutdownRuns: a run whose record it leaves alone, or could not save, is not taken over, so its executor's commit still lands (swamp-club#4171)", async () => {
  const wf = workflow();
  const notLoaded = runningRun(wf);
  const unsaved = runningRun(wf);
  const { events, repoContext } = harness([unsaved], wf.id);

  await interruptShutdownRuns([active(notLoaded), active(unsaved)], {
    repoContext: {
      ...repoContext,
      workflowRunRepo: {
        ...repoContext.workflowRunRepo,
        save: () => Promise.reject(new Error("disk full")),
      },
    },
    runWriteFence: takeOverFence(events),
  });

  assertEquals(events.filter((event) => event.startsWith("take over")), []);
});

Deno.test("interruptShutdownRuns: only a run the shutdown itself cut off is stamped for automatic continuation", async () => {
  const wf = workflow();
  const served = () => {
    const run = WorkflowRun.create(wf);
    run.start(1, "serve-a");
    return run;
  };
  const byShutdown = served();
  byShutdown.endAsCancelled("server shutdown");
  const byUser = served();
  byUser.endAsCancelled("cancelled by user");
  // a user cancel the executor had not saved yet: the record still reads running
  const unsaved = served();
  const userAbort = new AbortController();
  userAbort.abort(new Error("cancelled by user"));
  const { repoContext } = harness([byShutdown, byUser, unsaved], wf.id);

  const result = await interruptShutdownRuns([
    active(byShutdown),
    active(byUser),
    { ...active(unsaved), controller: userAbort },
  ], { repoContext });

  assertEquals(result.interrupted.length, 3);
  assertEquals(byShutdown.continuableSince !== undefined, true);
  assertEquals(byUser.continuableSince, undefined);
  assertEquals(unsaved.continuableSince, undefined);
});

Deno.test("interruptShutdownRuns: a run a user cancelled first that the cut-off left running is saved cancelled, never interrupted", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);
  const rows: string[] = [];

  const result = await interruptShutdownRuns([{
    ...active(run),
    cancelledBeforeShutdown: { reason: "cancelled by user:alice" },
  }], {
    repoContext,
    runTracker: {
      complete: (runId: string, status: ActiveRunStatus, reason?: string) => {
        rows.push(`${runId} ${status} ${reason}`);
      },
      interruptCancelled: () => {
        rows.push("interruptCancelled");
      },
    },
  });

  assertEquals(result, { interrupted: [], cancelled: [run.id] });
  assertEquals(events, ["load", `save ${run.id} cancelled`]);
  assertEquals(run.tags["cancel_reason"], "cancelled by user:alice");
  assertEquals(rows, [`${run.id} cancelled cancelled by user:alice`]);
});

Deno.test("interruptShutdownRuns: a run a user cancelled first whose cleanup finished stays cancelled and is not saved again", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  run.endAsCancelled("cancelled by user");
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns([{
    ...active(run),
    cancelledBeforeShutdown: {},
  }], { repoContext });

  assertEquals(result, { interrupted: [] });
  assertEquals(events, ["load"]);
  assertEquals(run.status, "cancelled");
});

Deno.test("interruptShutdownRuns: a failed push reports a run the cut-off saved cancelled as unpushed, beside the interrupted ones", async () => {
  const wf = workflow();
  const interruptedRun = runningRun(wf);
  const cancelledRun = runningRun(wf);
  const { repoContext } = harness([interruptedRun, cancelledRun], wf.id);

  const result = await interruptShutdownRuns([
    active(interruptedRun),
    { ...active(cancelledRun), cancelledBeforeShutdown: {} },
  ], {
    repoContext,
    syncService: {
      pushChanged: () => Promise.reject(new Error("S3 unreachable")),
    },
  });

  assertEquals(result, {
    interrupted: [interruptedRun.id],
    cancelled: [cancelledRun.id],
    pushError: "S3 unreachable",
    unpushed: [interruptedRun.id, cancelledRun.id],
  });
});

Deno.test("interruptShutdownRuns: a failed load leaves a cancelled run's row for the boot reaper, since its record is still running", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { repoContext } = harness([run], wf.id);
  const runTracker = tracker();

  await interruptShutdownRuns(
    [{ ...active(run), cancelledBeforeShutdown: {} }],
    {
      repoContext: {
        ...repoContext,
        workflowRunRepo: {
          ...repoContext.workflowRunRepo,
          findGlobalByStatus: () => Promise.reject(new Error("unreadable")),
        },
      },
      runTracker,
    },
  );

  assertEquals(runTracker.completed, []);
});

function callingWorkflow(): Workflow {
  return Workflow.create({
    name: `wf-${crypto.randomUUID()}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call-child",
            task: StepTask.workflow("child"),
          }),
        ],
      }),
    ],
  });
}

type CutOffShape = "running" | "shutdown" | "user";

const STEP_STARTED_AT = () => new Date(Date.now() - 60_000);

/** as the engine leaves a run a shutdown aborted: its call-child step in flight */
function serveRun(
  wf: Workflow,
  shape: CutOffShape,
  parent?: WorkflowRun,
  stepStartedAt: Date = STEP_STARTED_AT(),
): WorkflowRun {
  const run = WorkflowRun.create(wf);
  if (parent) {
    run.recordParentRun({
      workflowId: parent.workflowId,
      workflowName: parent.workflowName,
      runId: parent.id,
      jobName: "main",
      stepName: "call-child",
      nestingDepth: 1,
      ancestorWorkflowNames: [parent.workflowName],
    });
  }
  run.start(1, "instance-1");
  run.getJob("main")!.start();
  const step = run.getJob("main")!.getStep("call-child")!;
  step.start(stepStartedAt);
  if (shape !== "running") {
    step.failStoppedByAbort("Nested workflow was cancelled.");
    run.endAsCancelled(shape === "shutdown" ? "server shutdown" : "user asked");
  }
  return run;
}

function callStep(run: WorkflowRun) {
  return run.getJob("main")!.getStep("call-child")!;
}

function savesOf(events: string[]): string[] {
  return events.filter((event) => event.startsWith("save "));
}

function linkedTo(run: WorkflowRun, child: WorkflowRun): boolean {
  const link = callStep(run).nestedRun;
  return callStep(run).isNestedWait && link?.kind === "valid" &&
    link.ref.runId === child.id;
}

function recordingFence(events: string[]) {
  return {
    close: (runIds: readonly string[]) => {
      events.push(`close ${runIds.join(",")}`);
      return Promise.resolve();
    },
    takeOver: (runId: string) => {
      events.push(`take over ${runId}`);
    },
  };
}

Deno.test("interruptShutdownRuns: a nested run the shutdown cancelled is interrupted, and its parent's step waits on it, each saved once", async () => {
  const wf = callingWorkflow();
  const parent = serveRun(wf, "shutdown");
  const child = serveRun(wf, "shutdown", parent);
  const { events, repoContext } = harness([parent, child], wf.id);
  const rows = new Map<string, ActiveRunStatus>([
    [parent.id, "cancelled"],
    [child.id, "cancelled"],
  ]);
  const runTracker = tracker(rows);
  const reported: string[] = [];

  const result = await interruptShutdownRuns([active(parent)], {
    repoContext,
    runWriteFence: recordingFence(events),
    runTracker,
    onInterrupted: (runId) => reported.push(runId),
  });

  assertEquals(result, { interrupted: [parent.id, child.id] });
  assertEquals(events, [
    `close ${parent.id}`,
    "load",
    `close ${child.id}`,
    `save ${parent.id} interrupted`,
    `take over ${parent.id}`,
    `save ${child.id} interrupted`,
    `take over ${child.id}`,
  ]);
  assertEquals(linkedTo(parent, child), true);
  assertEquals(child.status, "interrupted");
  assertEquals(child.continuableSince !== undefined, true);
  assertEquals(callStep(child).status, "unknown");
  assertEquals(reported, [parent.id, child.id]);
  assertEquals(rows.get(child.id), "interrupted");
});

Deno.test("interruptShutdownRuns: a nested run still running at the cut-off is interrupted with its in-flight step unknown", async () => {
  const wf = callingWorkflow();
  const parent = serveRun(wf, "running");
  const child = serveRun(wf, "running", parent);
  const { events, repoContext } = harness([parent, child], wf.id);

  const result = await interruptShutdownRuns([active(parent)], {
    repoContext,
  });

  assertEquals(result, { interrupted: [parent.id, child.id] });
  assertEquals(savesOf(events), [
    `save ${parent.id} interrupted`,
    `save ${child.id} interrupted`,
  ]);
  assertEquals(linkedTo(parent, child), true);
  assertEquals(callStep(child).status, "unknown");
});

Deno.test("interruptShutdownRuns: a nested run a user cancelled stays cancelled, and its parent's step is left for the resume to run again", async () => {
  const wf = callingWorkflow();
  const parent = serveRun(wf, "shutdown");
  const child = serveRun(wf, "user", parent);
  const { events, repoContext } = harness([parent, child], wf.id);

  const result = await interruptShutdownRuns([active(parent)], {
    repoContext,
    runWriteFence: recordingFence(events),
  });

  assertEquals(result, { interrupted: [parent.id] });
  assertEquals(savesOf(events), [`save ${parent.id} interrupted`]);
  assertEquals(events.includes(`close ${child.id}`), false);
  assertEquals(child.status, "cancelled");
  assertEquals(callStep(parent).status, "unknown");
});

Deno.test("interruptShutdownRuns: a nested run that finished while its fence waited keeps its outcome, which its parent's step waits to adopt", async () => {
  const wf = callingWorkflow();
  const parent = serveRun(wf, "shutdown");
  const child = serveRun(wf, "shutdown", parent);
  const finished = WorkflowRun.fromData({
    ...child.toData(),
    status: "succeeded",
  });
  const { events, repoContext } = harness([parent, child], wf.id);

  const result = await interruptShutdownRuns([active(parent)], {
    repoContext: {
      ...repoContext,
      workflowRunRepo: {
        ...repoContext.workflowRunRepo,
        findById: () => Promise.resolve(finished),
      },
    },
  });

  assertEquals(result, { interrupted: [parent.id] });
  assertEquals(savesOf(events), [`save ${parent.id} interrupted`]);
  assertEquals(linkedTo(parent, child), true);
});

Deno.test("interruptShutdownRuns: a grandchild the shutdown cut off is linked and interrupted below its parent", async () => {
  const wf = callingWorkflow();
  const parent = serveRun(wf, "shutdown");
  const child = serveRun(wf, "shutdown", parent);
  const grandchild = serveRun(wf, "shutdown", child);
  const { events, repoContext } = harness([parent, child, grandchild], wf.id);

  const result = await interruptShutdownRuns([active(parent)], {
    repoContext,
  });

  assertEquals(result, { interrupted: [parent.id, child.id, grandchild.id] });
  assertEquals(savesOf(events), [
    `save ${parent.id} interrupted`,
    `save ${child.id} interrupted`,
    `save ${grandchild.id} interrupted`,
  ]);
  assertEquals(linkedTo(parent, child), true);
  assertEquals(linkedTo(child, grandchild), true);
});

Deno.test("interruptShutdownRuns: the nested runs of a run a user cancelled before the shutdown are left alone", async () => {
  const wf = callingWorkflow();
  const parent = serveRun(wf, "running");
  const child = serveRun(wf, "shutdown", parent);
  const { events, repoContext } = harness([parent, child], wf.id);

  await interruptShutdownRuns(
    [{ ...active(parent), cancelledBeforeShutdown: { reason: "user asked" } }],
    { repoContext },
  );

  assertEquals(savesOf(events), [`save ${parent.id} cancelled`]);
  assertEquals(child.status, "cancelled");
});

Deno.test("interruptShutdownRuns: a nested run an earlier attempt started is not linked or interrupted", async () => {
  const wf = callingWorkflow();
  const parent = serveRun(
    wf,
    "shutdown",
    undefined,
    new Date(Date.now() + 60_000),
  );
  const child = serveRun(wf, "shutdown", parent);
  const { events, repoContext } = harness([parent, child], wf.id);

  const result = await interruptShutdownRuns([active(parent)], {
    repoContext,
  });

  assertEquals(result, { interrupted: [parent.id] });
  assertEquals(savesOf(events), [`save ${parent.id} interrupted`]);
  assertEquals(callStep(parent).status, "unknown");
  assertEquals(child.status, "cancelled");
});

Deno.test("interruptShutdownRuns: a failed push records the interrupted nested run for the next start", async () => {
  await withTempDir(async (dir) => {
    const wf = callingWorkflow();
    const parent = serveRun(wf, "shutdown");
    const child = serveRun(wf, "shutdown", parent);
    const { repoContext } = harness([parent, child], wf.id);
    const marker = join(dir, UNPUSHED_INTERRUPTS_FILE);

    const result = await interruptShutdownRuns([active(parent)], {
      repoContext,
      syncService: {
        pushChanged: () => Promise.reject(new Error("S3 unreachable")),
      },
      unpushedMarkerPath: marker,
    });

    assertEquals(result.unpushed, [parent.id, child.id]);
    assertEquals(await readUnpushedInterrupts(marker), {
      present: true,
      runs: [
        { runId: parent.id, workflowId: wf.id },
        { runId: child.id, workflowId: wf.id },
      ],
    });
  });
});

Deno.test("interruptShutdownRuns: a nested run whose save fails is reported unpushed and settles its row, and its parent is still saved waiting on it", async () => {
  const wf = callingWorkflow();
  const parent = serveRun(wf, "shutdown");
  const child = serveRun(wf, "shutdown", parent);
  const { events, repoContext } = harness([parent, child], wf.id);
  const runTracker = tracker();

  const result = await interruptShutdownRuns([active(parent)], {
    repoContext: {
      ...repoContext,
      workflowRunRepo: {
        ...repoContext.workflowRunRepo,
        save: (wid, run) =>
          run.id === child.id
            ? Promise.reject(new Error("disk full"))
            : repoContext.workflowRunRepo.save(wid, run),
      },
    },
    syncService: { pushChanged: () => Promise.resolve(1) },
    runTracker,
  });

  assertEquals(result, { interrupted: [parent.id], unpushed: [child.id] });
  assertEquals(savesOf(events), [`save ${parent.id} interrupted`]);
  assertEquals(linkedTo(parent, child), true);
  assertEquals(
    runTracker.completed.includes(
      `${child.id} interrupted server_shutdown`,
    ),
    true,
  );
});

Deno.test("interruptShutdownRuns: the child fence waits of several parents and levels share one deadline", async () => {
  const wf = callingWorkflow();
  const first = serveRun(wf, "shutdown");
  const firstChild = serveRun(wf, "shutdown", first);
  const grandchild = serveRun(wf, "shutdown", firstChild);
  const second = serveRun(wf, "shutdown");
  const secondChild = serveRun(wf, "shutdown", second);
  const { repoContext } = harness(
    [first, firstChild, grandchild, second, secondChild],
    wf.id,
  );
  const waits: Array<{ runIds: readonly string[]; waitMs?: number }> = [];

  const result = await interruptShutdownRuns([active(first), active(second)], {
    repoContext,
    runWriteFence: {
      close: (runIds, waitMs) => {
        waits.push({ runIds, waitMs });
        return Promise.resolve();
      },
      takeOver: () => {},
    },
  });

  assertEquals(result.interrupted.length, 5);
  const childWaits = waits.slice(1);
  assertEquals(childWaits.map((w) => w.runIds), [
    [firstChild.id],
    [grandchild.id],
    [secondChild.id],
  ]);
  for (const [i, wait] of childWaits.entries()) {
    assertEquals(wait.waitMs !== undefined, true);
    assertEquals(wait.waitMs! <= RUN_WRITE_FENCE_WAIT_MS, true);
    if (i > 0) assertEquals(wait.waitMs! <= childWaits[i - 1].waitMs!, true);
  }
});
