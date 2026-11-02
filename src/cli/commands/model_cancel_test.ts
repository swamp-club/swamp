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
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { getLogger } from "@logtape/logtape";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { LockInfo } from "../../domain/datastore/distributed_lock.ts";
import { ActiveRun } from "../../domain/models/active_run.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import { KILL_GRACE_MS } from "../../infrastructure/process/process_executor.ts";
import {
  abandonedMethodRuns,
  cancelModelMethodRuns,
  findMethodRunsOfModel,
  METHOD_OWNER_STOP_GRACE_MS,
  methodRunsOfModel,
  modelCancelCommand,
  type OwnerStop,
  selectMethodRunToCancel,
  settleStoppedMethodRuns,
  splitServeOwnedRuns,
  stopMethodRunOwners,
} from "./model_cancel.ts";
import { OWNER_STOP_GRACE_MS } from "./workflow_cancel.ts";
import type { MethodRunOutputs } from "../../domain/workflows/orphaned_run_reaper.ts";
import {
  createModelOutputId,
  ModelOutput,
} from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { OWNER_STOPPED_STEP_ERROR } from "../../domain/workflows/workflow_run.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

// A PID that is not this process, so cancel asks to stop it.
const OWNER_PID = Deno.pid + 1;

const noOutputs: MethodRunOutputs = {
  findByIds: () => Promise.resolve(new Map()),
  save: () => Promise.reject(new Error("unexpected output save")),
};

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
    definitionId: "def-1",
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
      outputRepo: noOutputs,
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
      outputRepo: noOutputs,
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
      outputRepo: noOutputs,
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
      outputRepo: noOutputs,
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
      outputRepo: noOutputs,
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
      outputRepo: noOutputs,
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
      outputRepo: noOutputs,
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
        outputRepo: noOutputs,
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
          outputRepo: noOutputs,
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

const SERVE_PID = Deno.pid + 2;

function trackerRow(opts: {
  runKind?: "model_method" | "workflow";
  pid: number;
  instanceId?: string;
  startedAt?: string;
  modelType?: string;
  definitionId?: string | null;
  hostname?: string;
}): ActiveRun {
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const workflow = opts.runKind === "workflow";
  return ActiveRun.fromData({
    id: crypto.randomUUID(),
    runKind: opts.runKind ?? "model_method",
    modelType: workflow ? null : opts.modelType ?? "command/shell",
    definitionId: opts.definitionId,
    methodName: workflow ? null : "execute",
    workflowName: workflow ? "wf" : null,
    pid: opts.pid,
    hostname: opts.hostname ?? "test-host",
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

Deno.test("splitServeOwnedRuns: a serve-owned run whose serve is dead on this host stays cancellable", () => {
  const serveRun = trackerRow({ pid: SERVE_PID, instanceId: "serve-a" });

  const { cancellable, serveOwned } = splitServeOwnedRuns(
    [serveRun],
    [serveRun],
    (pid) => pid !== SERVE_PID,
    "test-host",
  );

  assertEquals(cancellable, [serveRun]);
  assertEquals(serveOwned, []);
});

Deno.test("splitServeOwnedRuns: a serve-owned run from another host is skipped even when its pid is dead here", () => {
  // The local process table says nothing about another host's serve.
  const serveRun = trackerRow({ pid: SERVE_PID, instanceId: "serve-b" });

  const { cancellable, serveOwned } = splitServeOwnedRuns(
    [serveRun],
    [serveRun],
    () => false,
    "other-host",
  );

  assertEquals(cancellable, []);
  assertEquals(serveOwned, [{ run: serveRun, instanceId: "serve-b" }]);
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
      outputRepo: noOutputs,
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

async function saveStepOutput(
  outputRepo: YamlOutputRepository,
  run: ActiveRun,
): Promise<ModelOutput> {
  const output = ModelOutput.fromData({
    id: run.id,
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "execute",
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
  output.markRunning(run.pid);
  await outputRepo.save(ModelType.create("command/shell"), "execute", output);
  return output;
}

Deno.test("cancelModelMethodRuns: cancels the method-run record an owner killed after its grace left running", async () => {
  await withTracker(async (tracker, dbPath) => {
    const outputRepo = new YamlOutputRepository(dirname(dbPath));
    const type = ModelType.create("command/shell");
    const run = methodRun(OWNER_PID);
    tracker.register(run);
    await saveStepOutput(outputRepo, run);

    const [outcome] = await cancelModelMethodRuns([run], "Stop it", {
      tracker,
      outputRepo,
      liveness: { hostname: "test-host", isDead: () => true },
      killProcess: () => Promise.resolve(true),
    });

    assertEquals(outcome.status, "cancelled");
    const stored = await outputRepo.findById(
      type,
      "execute",
      createModelOutputId(run.id),
    );
    assertEquals(stored?.status, "cancelled");
    assertEquals(stored?.error?.message, OWNER_STOPPED_STEP_ERROR);
    assertEquals(readCancelReason(dbPath, run.id), "Stop it");
  });
});

Deno.test("cancelModelMethodRuns: leaves the record of an owner that saved its own outcome or is still alive", async () => {
  await withTracker(async (tracker, dbPath) => {
    const outputRepo = new YamlOutputRepository(dirname(dbPath));
    const type = ModelType.create("command/shell");
    const finished = methodRun(OWNER_PID);
    const alive = methodRun(OWNER_PID + 1);
    tracker.register(finished);
    tracker.register(alive);
    const finishedOutput = await saveStepOutput(outputRepo, finished);
    await saveStepOutput(outputRepo, alive);

    await cancelModelMethodRuns([finished, alive], undefined, {
      tracker,
      outputRepo,
      liveness: {
        hostname: "test-host",
        isDead: (pid) => pid === OWNER_PID,
      },
      killProcess: async (pid) => {
        if (pid === OWNER_PID) {
          finishedOutput.markCancelled("The signal has been aborted");
          await outputRepo.save(type, "execute", finishedOutput);
          tracker.complete(finished.id, "cancelled");
        }
        return true;
      },
    });

    assertEquals(
      (await outputRepo.findById(
        type,
        "execute",
        createModelOutputId(finished.id),
      ))?.error
        ?.message,
      "The signal has been aborted",
    );
    assertEquals(
      (await outputRepo.findById(
        type,
        "execute",
        createModelOutputId(alive.id),
      ))?.status,
      "running",
    );
  });
});

Deno.test("cancelModelMethodRuns: an unwritable method-run record leaves its row interrupted for run doctor", async () => {
  await withTracker(async (tracker, dbPath) => {
    const outputRepo = new YamlOutputRepository(dirname(dbPath));
    const stuck = methodRun(OWNER_PID);
    const other = methodRun(OWNER_PID + 1);
    tracker.register(stuck);
    tracker.register(other);
    await saveStepOutput(outputRepo, stuck);

    const outcomes = await cancelModelMethodRuns([stuck, other], "Stop it", {
      tracker,
      outputRepo: {
        findByIds: (type, method, ids) =>
          outputRepo.findByIds(type, method, ids),
        save: () => Promise.reject(new Error("disk full")),
      },
      liveness: { hostname: "test-host", isDead: () => true },
      killProcess: () => Promise.resolve(true),
    });

    assertEquals(
      outcomes.map((o) => [o.run.id, o.status]),
      [[stuck.id, "interrupted"], [other.id, "cancelled"]],
    );
    assertEquals(
      (await outputRepo.findById(
        ModelType.create("command/shell"),
        "execute",
        createModelOutputId(stuck.id),
      ))?.status,
      "running",
    );
    assertEquals(readCancelReason(dbPath, other.id), "Stop it");
  });
});

const idleModel = { definitionId: "def-idle", modelType: "command/shell" };

Deno.test("methodRunsOfModel: leaves another model's run of the same type unselected (swamp-club#3244)", () => {
  const sleeperRun = trackerRow({
    pid: OWNER_PID,
    definitionId: "def-sleeper",
  });

  assertEquals(methodRunsOfModel([sleeperRun], idleModel), {
    runs: [],
    unattributed: [],
  });
  assertEquals(
    methodRunsOfModel([sleeperRun], {
      ...idleModel,
      definitionId: "def-sleeper",
    }).runs,
    [sleeperRun],
  );
});

Deno.test("methodRunsOfModel: ignores workflow rows and a same-id row of another type", () => {
  const workflowRow = trackerRow({ runKind: "workflow", pid: OWNER_PID });
  const otherType = trackerRow({
    pid: OWNER_PID,
    modelType: "@test/other",
    definitionId: "def-idle",
  });
  const own = trackerRow({ pid: OWNER_PID, definitionId: "def-idle" });

  assertEquals(
    methodRunsOfModel([workflowRow, otherType, own], idleModel).runs,
    [own],
  );
});

Deno.test("methodRunsOfModel: a row with no definition id is unattributed until something places it", () => {
  const mine = trackerRow({ pid: OWNER_PID });
  const theirs = trackerRow({ pid: OWNER_PID });
  const unknown = trackerRow({ pid: OWNER_PID });
  const otherType = trackerRow({ pid: OWNER_PID, modelType: "@test/other" });
  const rows = [mine, theirs, unknown, otherType];

  assertEquals(methodRunsOfModel(rows, idleModel), {
    runs: [],
    unattributed: [mine, theirs, unknown],
  });
  assertEquals(
    methodRunsOfModel(rows, idleModel, {
      own: new Set([mine.id]),
      others: new Set([theirs.id]),
    }),
    { runs: [mine], unattributed: [unknown] },
  );
});

// Method-run records only accept a UUID for the definition id.
const IDLE_ID = crypto.randomUUID();
const SLEEPER_ID = crypto.randomUUID();

const idle = {
  definitionId: IDLE_ID,
  type: ModelType.create("command/shell"),
};

function recordFor(row: ActiveRun, definitionId: string): ModelOutput {
  return ModelOutput.fromData({
    ...ModelOutput.create({
      definitionId: createDefinitionId(definitionId),
      methodName: "execute",
      provenance: {
        definitionHash: "abc",
        modelVersion: "1",
        triggeredBy: "workflow",
      },
    }).toData(),
    id: row.id,
  });
}

function evidenceOf(
  records: ModelOutput[] | Error,
  lock: Partial<LockInfo> | null | Error,
) {
  const reads = { outputs: 0, lock: 0 };
  const evidence = {
    outputs: {
      findByIds: (
        _type: ModelType,
        _method: string,
        ids: ReadonlySet<string>,
      ) => {
        reads.outputs++;
        if (records instanceof Error) return Promise.reject(records);
        return Promise.resolve(
          new Map(records.filter((r) => ids.has(r.id)).map((r) => [r.id, r])),
        );
      },
    },
    inspectModelLock: () => {
      reads.lock++;
      if (lock instanceof Error) return Promise.reject(lock);
      return Promise.resolve(
        lock && {
          holder: "user@test-host",
          hostname: "test-host",
          pid: OWNER_PID,
          acquiredAt: "2026-01-01T00:00:00.000Z",
          ttlMs: 30_000,
          ...lock,
        },
      );
    },
    logger: getLogger(["test"]),
  };
  return { evidence, reads };
}

Deno.test("findMethodRunsOfModel: reads no record and no lock when every row names its definition", async () => {
  const { evidence, reads } = evidenceOf([], {});
  const sleeperRun = trackerRow({
    pid: OWNER_PID,
    definitionId: SLEEPER_ID,
  });

  assertEquals(await findMethodRunsOfModel([sleeperRun], idle, evidence), {
    runs: [],
    unattributed: [],
  });
  assertEquals(reads, { outputs: 0, lock: 0 });
});

Deno.test("findMethodRunsOfModel: a row's method-run record decides whose run it is, without reading the lock", async () => {
  const mine = trackerRow({ pid: OWNER_PID });
  const theirs = trackerRow({ pid: OWNER_PID });
  const { evidence, reads } = evidenceOf([
    recordFor(mine, IDLE_ID),
    recordFor(theirs, SLEEPER_ID),
  ], {});

  assertEquals(await findMethodRunsOfModel([mine, theirs], idle, evidence), {
    runs: [mine],
    unattributed: [],
  });
  assertEquals(reads.lock, 0);
});

Deno.test("findMethodRunsOfModel: a row with no record is the model's when its process holds the model's lock", async () => {
  const legacy = trackerRow({ pid: OWNER_PID });
  const { evidence } = evidenceOf([], {});

  assertEquals(await findMethodRunsOfModel([legacy], idle, evidence), {
    runs: [legacy],
    unattributed: [],
  });
});

Deno.test("findMethodRunsOfModel: a row with no record stays unattributed unless its own process is known to hold the lock", async () => {
  const legacy = trackerRow({ pid: OWNER_PID });
  const locks: (Partial<LockInfo> | null)[] = [
    null,
    { pid: OWNER_PID + 1 },
    { hostname: "other-host" },
    { holderUnknown: true },
  ];

  for (const lock of locks) {
    const { evidence } = evidenceOf([], lock);
    assertEquals(await findMethodRunsOfModel([legacy], idle, evidence), {
      runs: [],
      unattributed: [legacy],
    }, JSON.stringify(lock));
  }
});

Deno.test("findMethodRunsOfModel: a lock does not attribute a row whose process runs another method too", async () => {
  const legacy = trackerRow({ pid: OWNER_PID });
  const sibling = trackerRow({
    pid: OWNER_PID,
    modelType: "@test/other",
    definitionId: "def-other",
  });
  const { evidence } = evidenceOf([], {});

  assertEquals(
    await findMethodRunsOfModel([legacy, sibling], idle, evidence),
    { runs: [], unattributed: [legacy] },
  );
});

Deno.test("findMethodRunsOfModel: a lock that cannot be read leaves the row unattributed and the model's own run selected", async () => {
  const legacy = trackerRow({ pid: OWNER_PID });
  const own = trackerRow({ pid: OWNER_PID + 2, definitionId: IDLE_ID });
  const { evidence } = evidenceOf([], new Error("datastore unreachable"));

  assertEquals(await findMethodRunsOfModel([legacy, own], idle, evidence), {
    runs: [own],
    unattributed: [legacy],
  });
});

Deno.test("findMethodRunsOfModel: records that cannot be read leave the row to the lock and the model's own run selected", async () => {
  const legacy = trackerRow({ pid: OWNER_PID });
  const own = trackerRow({ pid: OWNER_PID + 2, definitionId: IDLE_ID });
  const unreadable = new Error("EACCES");

  const held = evidenceOf(unreadable, {});
  assertEquals(
    await findMethodRunsOfModel([legacy, own], idle, held.evidence),
    {
      runs: [legacy, own],
      unattributed: [],
    },
  );

  const free = evidenceOf(unreadable, null);
  assertEquals(
    await findMethodRunsOfModel([legacy, own], idle, free.evidence),
    {
      runs: [own],
      unattributed: [legacy],
    },
  );
});

Deno.test("findMethodRunsOfModel: a synced method-run record only attributes a tracker row; the pid cancel stops is always the row's (swamp-club#4274)", async () => {
  // A method-run record is data a v2 datastore syncs between members, so
  // the pid it names is whatever its writer chose. A record with no tracker
  // row selects nothing, and one that matches a row stops the row's pid.
  const FORGED_PID = OWNER_PID + 41;
  const legacy = trackerRow({ pid: OWNER_PID });
  const forgedForRow = recordFor(legacy, IDLE_ID);
  forgedForRow.markRunning(FORGED_PID);
  const rowless = ModelOutput.fromData({
    ...recordFor(trackerRow({ pid: FORGED_PID }), IDLE_ID).toData(),
    id: createModelOutputId(crypto.randomUUID()),
  });
  rowless.markRunning(FORGED_PID);
  const { evidence } = evidenceOf([forgedForRow, rowless], null);

  const { runs } = await findMethodRunsOfModel([legacy], idle, evidence);
  assertEquals(runs.map((r) => r.pid), [OWNER_PID]);

  await withTracker(async (tracker) => {
    tracker.register(legacy);
    const calls: { pid: number; maxWaitMs: number }[] = [];
    await cancelModelMethodRuns(runs, undefined, {
      tracker,
      outputRepo: noOutputs,
      liveness: { hostname: "test-host", isDead: () => false },
      killProcess: recordingKill(calls),
    });
    assertEquals(calls.map((c) => c.pid), [OWNER_PID]);
  });
});

Deno.test("stopMethodRunOwners: stops the owners with the tracker alone, before any record is read or saved (swamp-club#4295)", async () => {
  await withTracker(async (tracker) => {
    const run = methodRun(OWNER_PID);
    tracker.register(run);
    const calls: OwnerStop[] = [];
    const stopped = await stopMethodRunOwners([run], {
      tracker,
      killProcess: recordingKill(calls),
    });
    assertEquals(calls.map((c) => c.pid), [OWNER_PID]);
    assertEquals(stopped.stopped.map((r) => r.id), [run.id]);
    assertEquals(stopped.errors, []);
    assertEquals(tracker.findById(run.id)?.status, "running");
  });
});

Deno.test("abandonedMethodRuns: only a stopped run whose owner died with its row still running needs its record settled (swamp-club#4295)", async () => {
  await withTracker(async (tracker) => {
    const saved = methodRun(OWNER_PID);
    const abandoned = methodRun(OWNER_PID + 1);
    const alive = methodRun(OWNER_PID + 2);
    for (const run of [saved, abandoned, alive]) tracker.register(run);
    tracker.complete(saved.id, "cancelled");
    const liveness = {
      hostname: "test-host",
      isDead: (pid: number) => pid !== OWNER_PID + 2,
    };
    assertEquals(
      abandonedMethodRuns([saved, abandoned, alive], { tracker, liveness })
        .map((r) => r.id),
      [abandoned.id],
    );
    const outcomes = await settleStoppedMethodRuns(
      { stopped: [saved, alive], errors: [] },
      "Stop it",
      { tracker, outputRepo: noOutputs, liveness },
    );
    assertEquals(outcomes.map((o) => o.status), ["cancelled", "cancelled"]);
  });
});
