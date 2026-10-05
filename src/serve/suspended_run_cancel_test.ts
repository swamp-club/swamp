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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { hostname } from "node:os";
import { ActiveRun as TrackedRun } from "../domain/models/active_run.ts";
import { RunTrackerStore } from "../infrastructure/persistence/run_tracker_store.ts";
import {
  awaitAbortedRun,
  cancelSuspendedRunAndPush,
  ownerGoneDecider,
  SUSPENDED_RUN_BUSY_MESSAGE,
} from "./suspended_run_cancel.ts";
import { type ActiveRun, ActiveRunRegistry } from "./active_run_registry.ts";
import { RunEventBuffer } from "./run_event_buffer.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import type { CancelTargetWorkflow } from "../libswamp/mod.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";

function makeWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
}

function suspendedRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start(Deno.pid, crypto.randomUUID());
  const step = run.getJob("main")!.getStep("gate")!;
  run.getJob("main")!.start();
  step.start();
  step.waitForApproval();
  run.suspend();
  return run;
}

interface Harness {
  ctx: ConnectionContext;
  registry: ActiveRunRegistry;
  saved: WorkflowRun[];
  pushes: number;
  /** Run and workflow repository calls. */
  repoCalls: number;
}

/**
 * A serve context over in-memory repositories holding `runs`, with a real
 * active-run registry and a sync service that counts pushes. `failLoad`
 * makes every run lookup throw; `failReread` only the gated re-read of a
 * located run, which loads it by id from its workflow.
 */
function harness(
  workflows: Workflow[],
  runs: WorkflowRun[],
  options: { registry?: boolean; failLoad?: boolean; failReread?: boolean } =
    {},
): Harness {
  const registry = new ActiveRunRegistry();
  const h: Harness = {
    ctx: undefined as unknown as ConnectionContext,
    registry,
    saved: [],
    pushes: 0,
    repoCalls: 0,
  };
  const load = <T>(value: T): Promise<T> => {
    h.repoCalls++;
    return options.failLoad
      ? Promise.reject(new Error("repository unavailable"))
      : Promise.resolve(value);
  };
  h.ctx = {
    activeRunRegistry: options.registry === false ? undefined : registry,
    datastoreConfig: { type: "filesystem" },
    syncService: {
      pushChanged: () => {
        h.pushes++;
        return Promise.resolve();
      },
    },
    repoContext: {
      workflowRepo: {
        findByName: (name: string) => {
          h.repoCalls++;
          return Promise.resolve(
            workflows.find((w) => w.name === name) ?? null,
          );
        },
        findById: (id: string) => {
          h.repoCalls++;
          return Promise.resolve(workflows.find((w) => w.id === id) ?? null);
        },
      },
      workflowRunRepo: {
        findById: (workflowId: string, runId: string) =>
          options.failReread
            ? Promise.reject(new Error("repository unavailable"))
            : load(
              runs.find((r) => r.workflowId === workflowId && r.id === runId) ??
                null,
            ),
        findGlobalById: (runId: string) => {
          const run = runs.find((r) => r.id === runId);
          return load(run ? { run, workflowId: run.workflowId } : null);
        },
        save: (_workflowId: string, run: WorkflowRun) => {
          h.saved.push(run);
          return Promise.resolve();
        },
      },
    },
  } as unknown as ConnectionContext;
  return h;
}

function fakeActiveRun(runId: string, completion: Promise<void>): ActiveRun {
  return {
    runId,
    kind: "workflow-resume",
    resourceName: "deploy",
    buffer: new RunEventBuffer(10),
    controller: new AbortController(),
    startedAt: new Date(),
    completion,
    principalId: null,
  };
}

const allow = () => true;

Deno.test("cancelSuspendedRunAndPush: without a registry reports not found and authorizes nothing", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run], { registry: false });
  const asked: CancelTargetWorkflow[] = [];

  const result = await cancelSuspendedRunAndPush(
    h.ctx,
    { runId: run.id, reason: "r" },
    (workflow) => {
      asked.push(workflow);
      return true;
    },
  );

  assertEquals(result, {
    status: "not_found",
    message: `No cancellable run with id ${run.id}`,
  });
  assertEquals(asked, []);
  assertEquals(h.saved.length, 0);
});

Deno.test("cancelSuspendedRunAndPush: reports a run registered under the id as active", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run]);
  h.registry.register(fakeActiveRun(run.id, Promise.resolve()));

  const result = await cancelSuspendedRunAndPush(
    h.ctx,
    { runId: run.id, reason: "r" },
    allow,
  );

  assertEquals(result, { status: "active" });
  assertEquals(h.saved.length, 0);
});

Deno.test("cancelSuspendedRunAndPush: reports busy while another operation holds the id", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run]);
  const release = h.registry.reserve(run.id)!;

  try {
    const result = await cancelSuspendedRunAndPush(
      h.ctx,
      { runId: run.id, reason: "r" },
      allow,
    );

    assertEquals(result, {
      status: "busy",
      message: SUSPENDED_RUN_BUSY_MESSAGE,
    });
    assertEquals(h.saved.length, 0);
  } finally {
    release();
  }
});

Deno.test("cancelSuspendedRunAndPush: cancels a suspended run and releases the id", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run]);

  const result = await cancelSuspendedRunAndPush(
    h.ctx,
    { runId: run.id, reason: "stuck gate" },
    allow,
  );

  assertEquals(result, {
    status: "cancelled",
    runId: run.id,
    workflowName: "deploy",
  });
  assertEquals(h.saved.length, 1);
  assertEquals(h.saved[0].status, "cancelled");
  const release = h.registry.reserve(run.id);
  assert(release, "the cancel released its reservation");
  release();
});

Deno.test("cancelSuspendedRunAndPush: maps an authorized run that is not suspended to not_suspended", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  run.endAsCancelled("earlier");
  const h = harness([wf], [run]);

  const result = await cancelSuspendedRunAndPush(
    h.ctx,
    { runId: run.id, workflowIdOrName: "deploy", reason: "r" },
    allow,
  );

  assertEquals(result, {
    status: "not_suspended",
    message: `Run ${run.id} is not suspended (status: cancelled)`,
  });
  assertEquals(h.saved.length, 0);
});

Deno.test("cancelSuspendedRunAndPush: reports a refused caller as not found without reserving the id or pushing", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run]);
  let reservations = 0;
  const reserve = h.registry.reserve.bind(h.registry);
  h.registry.reserve = (runId: string) => {
    reservations++;
    return reserve(runId);
  };

  const result = await cancelSuspendedRunAndPush(
    h.ctx,
    { runId: run.id, reason: "r" },
    () => false,
  );

  assertEquals(result.status, "not_found");
  assertEquals(h.saved.length, 0);
  assertEquals(reservations, 0);
  assertEquals(h.pushes, 0);
});

Deno.test("cancelSuspendedRunAndPush: a run id that is not a UUID is not found before any lookup", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);

  for (const runId of ["-", "../x"]) {
    for (const workflowIdOrName of [undefined, "deploy"]) {
      const h = harness([wf], [run]);
      let reservations = 0;
      const reserve = h.registry.reserve.bind(h.registry);
      h.registry.reserve = (id: string) => {
        reservations++;
        return reserve(id);
      };
      const asked: CancelTargetWorkflow[] = [];

      const result = await cancelSuspendedRunAndPush(
        h.ctx,
        { runId, workflowIdOrName, reason: "r" },
        (workflow) => {
          asked.push(workflow);
          return true;
        },
      );

      assertEquals(result, {
        status: "not_found",
        message: `No cancellable run with id ${runId}`,
      });
      assertEquals(h.repoCalls, 0);
      assertEquals(asked, []);
      assertEquals(reservations, 0);
      assertEquals(h.pushes, 0);
    }
  }
  assertEquals(run.status, "suspended");
});

Deno.test("cancelSuspendedRunAndPush: a lookup that throws takes no reservation and pushes nothing", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run], { failLoad: true });

  await assertRejects(
    () =>
      cancelSuspendedRunAndPush(h.ctx, { runId: run.id, reason: "r" }, allow),
    Error,
    "repository unavailable",
  );

  assertEquals(h.pushes, 0);
  const release = h.registry.reserve(run.id);
  assert(release, "the failed lookup took no reservation");
  release();
});

Deno.test("cancelSuspendedRunAndPush: releases the id when re-reading the run throws", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run], { failReread: true });

  await assertRejects(
    () =>
      cancelSuspendedRunAndPush(h.ctx, { runId: run.id, reason: "r" }, allow),
    Error,
    "repository unavailable",
  );

  const release = h.registry.reserve(run.id);
  assert(release, "the failed cancel released its reservation");
  release();
});

Deno.test("cancelSuspendedRunAndPush: pushes once after the cancel", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run]);

  const result = await cancelSuspendedRunAndPush(
    h.ctx,
    { runId: run.id, reason: "r" },
    allow,
  );

  assertEquals(result.status, "cancelled");
  assertEquals(h.pushes, 1);
});

Deno.test("cancelSuspendedRunAndPush: pushes once and re-throws when the cancel throws", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedRun(wf);
  const h = harness([wf], [run], { failReread: true });

  await assertRejects(
    () =>
      cancelSuspendedRunAndPush(h.ctx, { runId: run.id, reason: "r" }, allow),
    Error,
    "repository unavailable",
  );
  assertEquals(h.pushes, 1);
});

Deno.test("awaitAbortedRun: returns true at once for a run that is not registered", async () => {
  const registry = new ActiveRunRegistry();

  assertEquals(await awaitAbortedRun(registry, crypto.randomUUID()), true);
});

Deno.test("awaitAbortedRun: returns true once the run completes and leaves", async () => {
  const registry = new ActiveRunRegistry();
  const runId = crypto.randomUUID();
  const completion = Promise.withResolvers<void>();
  registry.register(fakeActiveRun(runId, completion.promise));

  const left = awaitAbortedRun(registry, runId);
  registry.deregister(runId);
  completion.resolve();

  assertEquals(await left, true);
});

Deno.test("awaitAbortedRun: returns false when the run does not finish within the grace period", async () => {
  const registry = new ActiveRunRegistry();
  const runId = crypto.randomUUID();
  registry.register(fakeActiveRun(runId, new Promise<void>(() => {})));

  assertEquals(await awaitAbortedRun(registry, runId, 1), false);
  registry.deregister(runId);
});

Deno.test("awaitAbortedRun: returns false when the run completes but is still registered", async () => {
  const registry = new ActiveRunRegistry();
  const runId = crypto.randomUUID();
  registry.register(fakeActiveRun(runId, Promise.resolve()));

  assertEquals(await awaitAbortedRun(registry, runId), false);
  registry.deregister(runId);
});

/** A pid no process has: the largest a 32-bit pid_t holds. */
const DEAD_PID = 2147483647;

/** A run left `running` under `pid` by serve instance `instanceId`. */
function runningRun(
  workflow: Workflow,
  pid: number,
  instanceId: string,
): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start(pid, instanceId);
  run.getJob("main")!.start();
  run.getJob("main")!.getStep("gate")!.start();
  return run;
}

/** The tracker row serve instance `instanceId` registered for `run`. */
function trackerRow(
  run: WorkflowRun,
  pid: number,
  instanceId: string,
): TrackedRun {
  const now = new Date().toISOString();
  return TrackedRun.fromData({
    id: run.id,
    runKind: "workflow",
    modelType: null,
    methodName: null,
    workflowName: run.workflowName,
    pid,
    hostname: hostname(),
    instanceId,
    startedAt: now,
    heartbeatAt: now,
    status: "running",
  });
}

async function withTracker(
  fn: (tracker: RunTrackerStore) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-cancel-test-" });
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
}

/**
 * A control plane holding a heartbeat for each of `alive`, and for
 * `new-instance`, the instance the deciders under test run as: heartbeats
 * are being written. See {@link controlPlaneWithoutHeartbeats}.
 */
function controlPlaneWith(
  alive: string[],
): ConnectionContext["controlPlaneStore"] {
  return controlPlaneWithoutHeartbeats([...alive, "new-instance"]);
}

/** A control plane holding a heartbeat only for each of `alive`. */
function controlPlaneWithoutHeartbeats(
  alive: string[] = [],
): ConnectionContext["controlPlaneStore"] {
  return {
    get: (key: string) =>
      Promise.resolve(
        alive.some((id) => key === `heartbeats/${id}`)
          ? new Uint8Array([1])
          : null,
      ),
  } as unknown as ConnectionContext["controlPlaneStore"];
}

Deno.test("ownerGoneDecider: a dead pid in the tracker row of a previous serve instance shows the owner gone (swamp-club#2518)", async () => {
  await withTracker(async (tracker) => {
    const run = runningRun(makeWorkflow("deploy"), DEAD_PID, "old-instance");
    tracker.register(trackerRow(run, DEAD_PID, "old-instance"));
    const pids: number[] = [];

    const gone = await ownerGoneDecider(
      {
        activeRunRegistry: new ActiveRunRegistry(),
        runTracker: tracker,
        instanceId: "new-instance",
      },
      (pid) => pids.push(pid),
    )(run);

    assertEquals(gone, { gone: true });
    assertEquals(pids, [DEAD_PID]);
  });
});

Deno.test("ownerGoneDecider: a live pid in the tracker row keeps the owner, whatever the control plane says", async () => {
  await withTracker(async (tracker) => {
    const run = runningRun(makeWorkflow("deploy"), Deno.pid, "old-instance");
    tracker.register(trackerRow(run, Deno.pid, "old-instance"));

    const gone = await ownerGoneDecider({
      activeRunRegistry: new ActiveRunRegistry(),
      runTracker: tracker,
      instanceId: "new-instance",
      controlPlaneStore: controlPlaneWith([]),
    })(run);

    assertEquals(gone.gone, false);
    if (!gone.gone) assertStringIncludes(gone.why, "is still alive");
  });
});

Deno.test("ownerGoneDecider: a run this instance drives is never gone", async () => {
  await withTracker(async (tracker) => {
    const run = runningRun(makeWorkflow("deploy"), DEAD_PID, "old-instance");
    tracker.register(trackerRow(run, DEAD_PID, "old-instance"));
    const registry = new ActiveRunRegistry();
    registry.register(fakeActiveRun(run.id, new Promise<void>(() => {})));

    const gone = await ownerGoneDecider({
      activeRunRegistry: registry,
      runTracker: tracker,
      instanceId: "new-instance",
    })(run);

    assertEquals(gone.gone, false);
    if (!gone.gone) assertStringIncludes(gone.why, "this serve instance");
  });
});

Deno.test("ownerGoneDecider: without a tracker row, another instance's run is gone only when the control plane has no heartbeat for it", async () => {
  await withTracker(async (tracker) => {
    const run = runningRun(makeWorkflow("deploy"), DEAD_PID, "peer");
    const decide = (
      extra: Partial<Pick<ConnectionContext, "controlPlaneStore">>,
      instanceId = "new-instance",
    ) =>
      ownerGoneDecider({
        activeRunRegistry: new ActiveRunRegistry(),
        runTracker: tracker,
        instanceId,
        ...extra,
      })(run);
    const why = async (verdict: ReturnType<typeof decide>) => {
      const v = await verdict;
      return v.gone ? "gone" : v.why;
    };

    assertStringIncludes(await why(decide({})), "no instance heartbeats");
    assertStringIncludes(
      await why(decide({ controlPlaneStore: controlPlaneWith(["peer"]) })),
      "still reports a heartbeat",
    );
    assertEquals(
      await decide({ controlPlaneStore: controlPlaneWith([]) }),
      { gone: true },
    );
    // Its own run with no row: nothing shows the owner gone.
    assertStringIncludes(
      await why(
        decide({ controlPlaneStore: controlPlaneWith([]) }, "peer"),
      ),
      "no run tracker record",
    );
  });
});

Deno.test("cancelSuspendedRunAndPush: cancels a running run whose serve process is gone, by run id alone", async () => {
  await withTracker(async (tracker) => {
    const wf = makeWorkflow("deploy");
    const run = runningRun(wf, DEAD_PID, "old-instance");
    tracker.register(trackerRow(run, DEAD_PID, "old-instance"));
    const h = harness([wf], [run]);
    Object.assign(h.ctx, { runTracker: tracker, instanceId: "new-instance" });
    Object.assign(h.ctx.repoContext, {
      outputRepo: { findByIds: () => Promise.resolve(new Map()) },
    });

    const result = await cancelSuspendedRunAndPush(
      h.ctx,
      { runId: run.id, reason: "stuck" },
      allow,
    );

    assertEquals(result.status, "cancelled");
    assertEquals(h.saved.map((r) => r.status), ["cancelled"]);
    assertEquals(tracker.findById(run.id)?.status, "cancelled");
    assertEquals(h.pushes, 1);
    assertEquals(h.registry.reserve(run.id) !== null, true);
  });
});

Deno.test("cancelSuspendedRunAndPush: refuses a running run whose owner is alive with a conflict saying so", async () => {
  await withTracker(async (tracker) => {
    const wf = makeWorkflow("deploy");
    const run = runningRun(wf, Deno.pid, "old-instance");
    tracker.register(trackerRow(run, Deno.pid, "old-instance"));
    const h = harness([wf], [run]);
    Object.assign(h.ctx, { runTracker: tracker, instanceId: "new-instance" });

    const result = await cancelSuspendedRunAndPush(
      h.ctx,
      { runId: run.id, reason: "r" },
      allow,
    );

    assertEquals(result.status, "not_suspended");
    if (result.status === "not_suspended") {
      assertStringIncludes(
        result.message,
        "was not cancelled: the process running it on the serve host is still alive",
      );
    }
    assertEquals(h.saved, []);
    assertEquals(tracker.findById(run.id)?.status, "running");
  });
});

Deno.test("cancelSuspendedRunAndPush: a refused caller gets not found for a running run with a dead owner", async () => {
  await withTracker(async (tracker) => {
    const wf = makeWorkflow("deploy");
    const run = runningRun(wf, DEAD_PID, "old-instance");
    tracker.register(trackerRow(run, DEAD_PID, "old-instance"));
    const h = harness([wf], [run]);
    Object.assign(h.ctx, { runTracker: tracker, instanceId: "new-instance" });

    const result = await cancelSuspendedRunAndPush(
      h.ctx,
      { runId: run.id, reason: "r" },
      () => false,
    );

    assertEquals(result, {
      status: "not_found",
      message: `No cancellable run with id ${run.id}`,
    });
    assertEquals(h.saved, []);
    assertEquals(h.pushes, 0);
  });
});

Deno.test("ownerGoneDecider: a tracker row written under another hostname is not judged by pid, so the control plane decides", async () => {
  await withTracker(async (tracker) => {
    const run = runningRun(makeWorkflow("deploy"), Deno.pid, "peer");
    // This process's pid is alive here, but the row is another host's.
    tracker.register(TrackedRun.fromData({
      ...trackerRow(run, Deno.pid, "peer").toData(),
      hostname: `other-${crypto.randomUUID()}`,
    }));
    const decide = (
      controlPlaneStore?: ConnectionContext["controlPlaneStore"],
    ) =>
      ownerGoneDecider({
        activeRunRegistry: new ActiveRunRegistry(),
        runTracker: tracker,
        instanceId: "new-instance",
        controlPlaneStore,
      })(run);

    assertEquals((await decide()).gone, false);
    assertEquals((await decide(controlPlaneWith(["peer"]))).gone, false);
    assertEquals(await decide(controlPlaneWith([])), { gone: true });
  });
});

Deno.test("ownerGoneDecider: a control plane that records no heartbeats, as without a remote one, never shows another instance gone", async () => {
  await withTracker(async (tracker) => {
    const run = runningRun(makeWorkflow("deploy"), DEAD_PID, "peer");

    const verdict = await ownerGoneDecider({
      activeRunRegistry: new ActiveRunRegistry(),
      runTracker: tracker,
      instanceId: "new-instance",
      controlPlaneStore: controlPlaneWithoutHeartbeats(),
    })(run);

    assertEquals(verdict.gone, false);
    if (!verdict.gone) {
      assertStringIncludes(verdict.why, "no instance heartbeats");
    }
  });
});

Deno.test("cancelSuspendedRunAndPush: without recorded heartbeats, a running run under another host's tracker row is refused, not cancelled", async () => {
  await withTracker(async (tracker) => {
    const wf = makeWorkflow("deploy");
    const run = runningRun(wf, DEAD_PID, "peer");
    tracker.register(TrackedRun.fromData({
      ...trackerRow(run, DEAD_PID, "peer").toData(),
      hostname: `other-${crypto.randomUUID()}`,
    }));
    const h = harness([wf], [run]);
    Object.assign(h.ctx, {
      runTracker: tracker,
      instanceId: "new-instance",
      controlPlaneStore: controlPlaneWithoutHeartbeats(),
    });

    const result = await cancelSuspendedRunAndPush(
      h.ctx,
      { runId: run.id, reason: "r" },
      allow,
    );

    assertEquals(result.status, "not_suspended");
    assertEquals(h.saved, []);
    assertEquals(run.status, "running");
  });
});
