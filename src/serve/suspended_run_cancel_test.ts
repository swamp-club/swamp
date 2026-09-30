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
import {
  awaitAbortedRun,
  cancelSuspendedRunAndPush,
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
  run.cancel("earlier");
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
