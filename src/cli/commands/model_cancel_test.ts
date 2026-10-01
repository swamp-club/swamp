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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { ActiveRun } from "../../domain/models/active_run.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import { KILL_GRACE_MS } from "../../infrastructure/process/process_executor.ts";
import {
  cancelModelMethodRuns,
  METHOD_OWNER_STOP_GRACE_MS,
  modelCancelCommand,
  type OwnerStop,
  selectMethodRunToCancel,
  splitServeOwnedRuns,
} from "./model_cancel.ts";
import { OWNER_STOP_GRACE_MS } from "./workflow_cancel.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

// A PID that is not this process, so cancel asks to stop it.
const OWNER_PID = Deno.pid + 1;

async function withTracker(
  fn: (tracker: RunTrackerStore, dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-model-cancel-" });
  const dbPath = join(dir, "run_tracker.db");
  const tracker = new RunTrackerStore(dbPath);
  try {
    await fn(tracker, dbPath);
  } finally {
    tracker.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function methodRun(pid: number): ActiveRun {
  return ActiveRun.createModelMethodRun({
    id: crypto.randomUUID(),
    modelType: "command/shell",
    methodName: "execute",
    pid,
    hostname: "test-host",
  });
}

function readCancelReason(dbPath: string, runId: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(
      "SELECT cancel_reason FROM active_runs WHERE id = ?",
    ).get(runId) as { cancel_reason: string | null };
    return row.cancel_reason;
  } finally {
    db.close();
  }
}

/** A killProcess that records each call and reports the owner stopped. */
function recordingKill(calls: OwnerStop[]) {
  return (pid: number, { maxWaitMs }: { maxWaitMs: number }) => {
    calls.push({ pid, maxWaitMs });
    return Promise.resolve(true);
  };
}

Deno.test("modelCancelCommand module loads", () => {
  assertEquals(modelCancelCommand.getName(), "cancel");
});

Deno.test("METHOD_OWNER_STOP_GRACE_MS: outlasts the shell step's kill grace", () => {
  assert(METHOD_OWNER_STOP_GRACE_MS > KILL_GRACE_MS);
});

Deno.test("cancelModelMethodRuns: gives a method run's owner the method stop grace", async () => {
  await withTracker(async (tracker) => {
    const run = methodRun(OWNER_PID);
    tracker.register(run);

    const calls: OwnerStop[] = [];
    await cancelModelMethodRuns([run], undefined, {
      tracker,
      killProcess: recordingKill(calls),
    });

    assertEquals(calls, [{
      pid: OWNER_PID,
      maxWaitMs: METHOD_OWNER_STOP_GRACE_MS,
    }]);
    assertEquals(tracker.findById(run.id)?.status, "cancelled");
  });
});

Deno.test("cancelModelMethodRuns: gives a workflow's process the workflow cancel grace", async () => {
  await withTracker(async (tracker) => {
    const run = methodRun(OWNER_PID);
    tracker.register(run);
    tracker.register(ActiveRun.createWorkflowRun({
      id: crypto.randomUUID(),
      workflowName: "deploy",
      pid: OWNER_PID,
      hostname: "test-host",
    }));

    const calls: OwnerStop[] = [];
    await cancelModelMethodRuns([run], undefined, {
      tracker,
      killProcess: recordingKill(calls),
    });

    assertEquals(calls, [{ pid: OWNER_PID, maxWaitMs: OWNER_STOP_GRACE_MS }]);
  });
});

Deno.test("cancelModelMethodRuns: stops a process that owns several runs once", async () => {
  await withTracker(async (tracker, dbPath) => {
    // The steps of one workflow share its process.
    const runs = [methodRun(OWNER_PID), methodRun(OWNER_PID)];
    for (const run of runs) tracker.register(run);

    const calls: OwnerStop[] = [];
    const announced: OwnerStop[][] = [];
    await cancelModelMethodRuns(runs, "No longer needed", {
      tracker,
      killProcess: recordingKill(calls),
      onStopping: (stops) => announced.push([...stops]),
    });

    assertEquals(calls.map((c) => c.pid), [OWNER_PID]);
    assertEquals(announced, [calls]);
    for (const run of runs) {
      assertEquals(tracker.findById(run.id)?.status, "cancelled");
      assertEquals(readCancelReason(dbPath, run.id), "No longer needed");
    }
  });
});

Deno.test("cancelModelMethodRuns: stops different owners together", async () => {
  await withTracker(async (tracker) => {
    const runs = [methodRun(OWNER_PID), methodRun(OWNER_PID + 1)];
    for (const run of runs) tracker.register(run);

    // Each kill waits until both have started, so stopping the owners one
    // after another would never finish.
    const started: number[] = [];
    let bothStarted: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => bothStarted = resolve);
    await cancelModelMethodRuns(runs, undefined, {
      tracker,
      killProcess: async (pid) => {
        started.push(pid);
        if (started.length === 2) bothStarted();
        await allStarted;
        return true;
      },
    });

    assertEquals(started.toSorted(), [OWNER_PID, OWNER_PID + 1]);
    for (const run of runs) {
      assertEquals(tracker.findById(run.id)?.status, "cancelled");
    }
  });
});

Deno.test("cancelModelMethodRuns: completes a run this process owns without a kill", async () => {
  await withTracker(async (tracker) => {
    const run = methodRun(Deno.pid);
    tracker.register(run);

    const calls: OwnerStop[] = [];
    let announced = false;
    await cancelModelMethodRuns([run], undefined, {
      tracker,
      killProcess: recordingKill(calls),
      onStopping: () => announced = true,
    });

    assertEquals(calls, []);
    assertEquals(announced, false);
    assertEquals(tracker.findById(run.id)?.status, "cancelled");
  });
});

Deno.test("cancelModelMethodRuns: records the reason on a run its owner cancelled while stopping", async () => {
  await withTracker(async (tracker, dbPath) => {
    const run = methodRun(OWNER_PID);
    tracker.register(run);

    const outcomes = await cancelModelMethodRuns([run], "No longer needed", {
      tracker,
      // The owner handles SIGTERM by completing its own row, without a reason.
      killProcess: () => {
        tracker.complete(run.id, "cancelled");
        return Promise.resolve(true);
      },
    });

    assertEquals(outcomes.map((o) => o.status), ["cancelled"]);
    assertEquals(tracker.findById(run.id)?.status, "cancelled");
    assertEquals(readCancelReason(dbPath, run.id), "No longer needed");
  });
});

Deno.test("cancelModelMethodRuns: reports and keeps the status of a run its owner finished otherwise", async () => {
  await withTracker(async (tracker, dbPath) => {
    const run = methodRun(OWNER_PID);
    tracker.register(run);

    const outcomes = await cancelModelMethodRuns([run], "No longer needed", {
      tracker,
      killProcess: () => {
        tracker.complete(run.id, "completed");
        return Promise.resolve(true);
      },
    });

    assertEquals(outcomes.map((o) => o.status), ["completed"]);
    assertEquals(tracker.findById(run.id)?.status, "completed");
    assertEquals(readCancelReason(dbPath, run.id), null);
  });
});

Deno.test("cancelModelMethodRuns: reports each run's own outcome when only some finished first", async () => {
  await withTracker(async (tracker) => {
    const finishing = methodRun(OWNER_PID);
    const stuck = methodRun(OWNER_PID + 1);
    tracker.register(finishing);
    tracker.register(stuck);

    const outcomes = await cancelModelMethodRuns(
      [finishing, stuck],
      undefined,
      {
        tracker,
        killProcess: (pid) => {
          if (pid === OWNER_PID) tracker.complete(finishing.id, "failed");
          return Promise.resolve(true);
        },
      },
    );

    assertEquals(
      outcomes.map((o) => [o.run.id, o.status]),
      [[finishing.id, "failed"], [stuck.id, "cancelled"]],
    );
  });
});

Deno.test("cancelModelMethodRuns: still stops the other owners and completes their runs when one stop fails", async () => {
  await withTracker(async (tracker) => {
    const failing = methodRun(OWNER_PID);
    const stopped = methodRun(OWNER_PID + 1);
    tracker.register(failing);
    tracker.register(stopped);

    let otherFinished = false;
    await assertRejects(
      () =>
        cancelModelMethodRuns([failing, stopped], undefined, {
          tracker,
          killProcess: async (pid) => {
            if (pid === OWNER_PID) throw new Error("ps failed");
            await Promise.resolve();
            otherFinished = true;
            return true;
          },
        }),
      Error,
      "ps failed",
    );

    assertEquals(otherFinished, true);
    assertEquals(tracker.findById(stopped.id)?.status, "cancelled");
    assertEquals(tracker.findById(failing.id)?.status, "running");
  });
});

// A pid standing in for a running swamp serve process.
const SERVE_PID = Deno.pid + 2;

/** A running tracker row, as findAllRunning returns it. */
function trackerRow(opts: {
  runKind?: "model_method" | "workflow";
  pid: number;
  instanceId?: string;
  startedAt?: string;
}): ActiveRun {
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const workflow = opts.runKind === "workflow";
  return ActiveRun.fromData({
    id: crypto.randomUUID(),
    runKind: opts.runKind ?? "model_method",
    modelType: workflow ? null : "command/shell",
    methodName: workflow ? null : "execute",
    workflowName: workflow ? "wf" : null,
    pid: opts.pid,
    hostname: "test-host",
    startedAt,
    heartbeatAt: startedAt,
    status: "running",
    instanceId: opts.instanceId,
  });
}

const alive = () => true;

Deno.test("splitServeOwnedRuns: a method run a live serve instance owns is skipped (swamp-club#2914)", () => {
  const serveRun = trackerRow({ pid: SERVE_PID, instanceId: "serve-a" });
  const localRun = trackerRow({ pid: OWNER_PID });

  const { cancellable, serveOwned } = splitServeOwnedRuns(
    [serveRun, localRun],
    [serveRun, localRun],
    alive,
  );

  assertEquals(cancellable, [localRun]);
  assertEquals(serveOwned, [{ run: serveRun, instanceId: "serve-a" }]);
});

Deno.test("splitServeOwnedRuns: a step row sharing its pid with a serve-owned workflow row is skipped", () => {
  // A step row written by a serve binary that predates instance ids on
  // method rows: only the workflow row names the serve instance.
  const workflowRow = trackerRow({
    runKind: "workflow",
    pid: SERVE_PID,
    instanceId: "serve-a",
  });
  const stepRow = trackerRow({ pid: SERVE_PID });

  const { cancellable, serveOwned } = splitServeOwnedRuns(
    [stepRow],
    [workflowRow, stepRow],
    alive,
  );

  assertEquals(cancellable, []);
  assertEquals(serveOwned, [{ run: stepRow, instanceId: "serve-a" }]);
});

Deno.test("splitServeOwnedRuns: a step of a CLI workflow run stays cancellable", () => {
  const workflowRow = trackerRow({ runKind: "workflow", pid: OWNER_PID });
  const stepRow = trackerRow({ pid: OWNER_PID });

  const { cancellable, serveOwned } = splitServeOwnedRuns(
    [stepRow],
    [workflowRow, stepRow],
    alive,
  );

  assertEquals(cancellable, [stepRow]);
  assertEquals(serveOwned, []);
});

Deno.test("splitServeOwnedRuns: a serve-owned run whose serve is dead stays cancellable", () => {
  const serveRun = trackerRow({ pid: SERVE_PID, instanceId: "serve-a" });

  const { cancellable, serveOwned } = splitServeOwnedRuns(
    [serveRun],
    [serveRun],
    (pid) => pid !== SERVE_PID,
  );

  assertEquals(cancellable, [serveRun]);
  assertEquals(serveOwned, []);
});

Deno.test("splitServeOwnedRuns: cancelling the cancellable runs never signals the serve process", async () => {
  await withTracker(async (tracker) => {
    const serveRun = trackerRow({ pid: SERVE_PID, instanceId: "serve-a" });
    const localRun = trackerRow({ pid: OWNER_PID });
    tracker.register(serveRun);
    tracker.register(localRun);
    const calls: OwnerStop[] = [];

    const { cancellable } = splitServeOwnedRuns(
      tracker.findAllRunning(),
      tracker.findAllRunning(),
      alive,
    );
    await cancelModelMethodRuns(cancellable, undefined, {
      tracker,
      killProcess: recordingKill(calls),
    });

    assertEquals(calls.map((c) => c.pid), [OWNER_PID]);
    assertEquals(tracker.findById(serveRun.id)?.status, "running");
    assertEquals(tracker.findById(localRun.id)?.status, "cancelled");
  });
});

Deno.test("selectMethodRunToCancel: picks the latest cancellable run over a newer serve-owned one", () => {
  const olderLocal = trackerRow({
    pid: OWNER_PID,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const newerLocal = trackerRow({
    pid: OWNER_PID,
    startedAt: "2026-01-01T00:01:00.000Z",
  });
  const newestServe = trackerRow({
    pid: SERVE_PID,
    instanceId: "serve-a",
    startedAt: "2026-01-01T00:02:00.000Z",
  });
  const runs = [olderLocal, newestServe, newerLocal];

  const { run, skipped } = selectMethodRunToCancel(runs, runs, alive);

  assertEquals(run, newerLocal);
  assertEquals(skipped, [{ run: newestServe, instanceId: "serve-a" }]);
});

Deno.test("selectMethodRunToCancel: selects nothing when serve owns every run, newest first", () => {
  const older = trackerRow({
    pid: SERVE_PID,
    instanceId: "serve-a",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const newer = trackerRow({
    pid: SERVE_PID,
    instanceId: "serve-a",
    startedAt: "2026-01-01T00:01:00.000Z",
  });

  const { run, skipped } = selectMethodRunToCancel(
    [older, newer],
    [older, newer],
    alive,
  );

  assertEquals(run, undefined);
  assertEquals(skipped.map((s) => s.run), [newer, older]);
});
