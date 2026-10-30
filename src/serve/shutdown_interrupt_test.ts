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

/**
 * A run repository and sync service that record, in order, each save (with
 * the status it saved) and each push.
 */
function harness(runs: WorkflowRun[], workflowId: WorkflowId) {
  const events: string[] = [];
  const repoContext: ShutdownInterruptDeps["repoContext"] = {
    markDirty: () => Promise.resolve(),
    workflowRunRepo: {
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
  const run = runningRun(wf);
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
});

Deno.test("interruptShutdownRuns: a run that ended cancelled is interrupted and pushed", async () => {
  // The run's own unit of work pushed `cancelled` before the interrupt ran,
  // as in the live reproduction.
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
        // Settles only when aborted, as a push honouring the signal does.
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
  // A pull holds the gate exclusively for the whole shutdown.
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

/** A run tracker that records each row completion. */
function tracker(
  rows: Map<string, ActiveRunStatus> = new Map(),
): ShutdownInterruptDeps["runTracker"] & { completed: string[] } {
  const completed: string[] = [];
  return {
    completed,
    complete: (runId, status, reason) => {
      // As the store does: only a running or suspended row is completed.
      const current = rows.get(runId) ?? "running";
      if (current !== "running" && current !== "suspended") return;
      rows.set(runId, status);
      completed.push(`${runId} ${status} ${reason}`);
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

Deno.test("interruptShutdownRuns: a row the run already settled as cancelled is left alone", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  run.endAsCancelled("server shutdown");
  const { repoContext } = harness([run], wf.id);
  const runTracker = tracker(new Map([[run.id, "cancelled"]]));

  await interruptShutdownRuns([active(run)], { repoContext, runTracker });

  assertEquals(runTracker.completed, []);
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

/**
 * A v3 commit-log engine whose root runs `fn` and then waits on `commit`,
 * as a v3 root waits on its chunk uploads before it commits locally.
 */
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
  // The delete is bounded as the stopped record is (swamp-club#3961).
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
