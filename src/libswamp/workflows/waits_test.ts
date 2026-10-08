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
import { assert, assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowWaits,
  type WorkflowWaitsDeps,
  type WorkflowWaitsEvent,
} from "./waits.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { SignalWait } from "../../domain/workflows/signal_wait.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { registrationOf } from "../../domain/workflows/signal_wait_records.ts";
import {
  acceptedOutcomeFor,
  InMemorySignalWaitStore,
} from "../../domain/workflows/signal_wait_store_test_helpers.ts";
import {
  ORPHAN_WAIT_RECORD_GRACE_MS,
  waitRefOf,
} from "../../domain/workflows/signal_wait_cleanup.ts";

const SCHEMA = {
  type: "object" as const,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

function workflowNamed(name: string, steps: string[] = ["review"]): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          ...steps.map((step) =>
            Step.create({
              name: step,
              task: StepTask.waitForSignal(60, SCHEMA),
            })
          ),
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
}

/** A run suspended with each named step waiting on a wait opened at `at`. */
function waitingRun(
  workflow: Workflow,
  opened: Record<string, Date>,
): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  for (const [step, at] of Object.entries(opened)) {
    job.getStep(step)!.start();
    job.getStep(step)!.waitForSignal(SignalWait.open(SCHEMA, 60, at));
  }
  job.getStep("gate")!.waitForApproval("Approve");
  run.suspend();
  return run;
}

function depsOf(
  runs: WorkflowRun[],
  now: Date,
  ...store: [InMemorySignalWaitStore | undefined] | []
): WorkflowWaitsDeps {
  const waits = store.length === 0 ? new InMemorySignalWaitStore() : store[0];
  return {
    now: () => now,
    signalWaits: waits
      ? { supported: true, store: waits }
      : { supported: false, reason: "no shared store" },
    runRepo: {
      findById: (_workflowId, runId) =>
        Promise.resolve(runs.find((run) => run.id === runId) ?? null),
      findGlobalByStatus: (status: string | string[]) => {
        const wanted = Array.isArray(status) ? status : [status];
        return Promise.resolve(
          runs.filter((run) => wanted.includes(run.status)).map((run) => ({
            run,
            workflowId: createWorkflowId(run.workflowId),
          })),
        );
      },
    },
  };
}

async function list(deps: WorkflowWaitsDeps) {
  const events = await collect<WorkflowWaitsEvent>(
    workflowWaits(createLibSwampContext(), deps),
  );
  assertEquals(events[0], { kind: "resolving" });
  const last = events.at(-1)!;
  if (last.kind !== "completed") throw new Error(`got ${last.kind}`);
  return last.data.waits;
}

async function listUnreadable(deps: WorkflowWaitsDeps) {
  const events = await collect<WorkflowWaitsEvent>(
    workflowWaits(createLibSwampContext(), deps),
  );
  const last = events.at(-1)!;
  if (last.kind !== "completed") throw new Error(`got ${last.kind}`);
  return last.data.unreadableWaits;
}

const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:00:10.000Z");

Deno.test("workflowWaits: lists each open wait with what a signal needs", async () => {
  const workflow = workflowNamed("release");
  const run = waitingRun(workflow, { review: T0 });
  const wait = run.getJob("main")!.getStep("review")!.signalWait!;

  const waits = await list(depsOf([run], T1));

  assertEquals(waits, [{
    waitId: wait.id,
    workflowId: workflow.id,
    workflowName: "release",
    runId: run.id,
    jobName: "main",
    stepName: "review",
    waitingSince: run.getJob("main")!.getStep("review")!.startedAt!
      .toISOString(),
    deadline: "2026-01-01T00:01:00.000Z",
    expired: false,
    schema: wait.schema,
    nextCommand: `swamp workflow signal ${wait.id} --payload '<json>'`,
  }]);
});

Deno.test("workflowWaits: a wait past its deadline is listed as expired with the resume command", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });

  const [wait] = await list(
    depsOf([run], new Date("2026-01-01T00:01:00.001Z")),
  );

  assertEquals(wait.expired, true);
  assertEquals(
    wait.nextCommand,
    `swamp workflow resume release --run ${run.id}`,
  );
});

Deno.test("workflowWaits: lists every wait of every suspended run, soonest deadline first", async () => {
  const a = waitingRun(workflowNamed("a", ["late", "early"]), {
    late: T1,
    early: T0,
  });
  const b = waitingRun(workflowNamed("b"), {
    review: new Date("2026-01-01T00:00:05.000Z"),
  });

  const waits = await list(depsOf([a, b], T1));

  assertEquals(
    waits.map((w) => `${w.workflowName}/${w.stepName}`),
    ["a/early", "b/review", "a/late"],
  );
});

Deno.test("workflowWaits: leaves out gates, settled waits and runs that are not suspended, and lists an unreadable wait apart", async () => {
  const gateOnly = waitingRun(workflowNamed("gate-only"), {});
  const settled = waitingRun(workflowNamed("settled"), { review: T0 });
  const settledStep = settled.getJob("main")!.getStep("review")!;
  settledStep.applyWaitOutcome(
    acceptedOutcomeFor(settledStep.signalWait!, { verdict: "ship" }),
  );
  const cancelled = waitingRun(workflowNamed("cancelled"), { review: T0 });
  cancelled.endAsCancelled("operator");
  const brokenData = waitingRun(workflowNamed("broken"), { review: T0 })
    .toData();
  brokenData.jobs[0].steps[0].wait = { kind: "?" };
  const broken = WorkflowRun.fromData(brokenData);

  const deps = depsOf([gateOnly, settled, cancelled, broken], T1);
  assertEquals(await list(deps), []);
  assertEquals(await listUnreadable(deps), [{
    workflowId: broken.workflowId,
    workflowName: "broken",
    runId: broken.id,
    jobName: "main",
    stepName: "review",
    nextCommand: `swamp workflow resume broken --run ${broken.id}`,
  }]);
});

Deno.test("workflowWaits: a wait a signal settled is not listed, though its step still waits in the run record", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });
  const step = run.getJob("main")!.getStep("review")!;
  const waits = new InMemorySignalWaitStore();
  await waits.settle(
    acceptedOutcomeFor(step.signalWait!, { verdict: "ship" }, {
      runId: run.id,
    }),
  );

  assertEquals(await list(depsOf([run], T1, waits)), []);
  assertEquals(step.status, "waiting_signal");
});

Deno.test("workflowWaits: registers a wait a run holds without a registration, and settles an expired one as timed out", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });
  const wait = run.getJob("main")!.getStep("review")!.signalWait!;
  const waits = new InMemorySignalWaitStore();

  await list(depsOf([run], T1, waits));

  const registration = await waits.findRegistration(wait.id);
  assert(registration.kind === "found");
  assertEquals(registration.record.runId, run.id);
  assertEquals(registration.record.stepName, "review");
  assertEquals(waits.outcomes.size, 0);

  const [expired] = await list(
    depsOf([run], new Date("2026-01-01T00:01:00.001Z"), waits),
  );
  assertEquals(expired.expired, true);
  const outcome = await waits.findOutcome(wait.id);
  assert(outcome.kind === "found");
  assertEquals(outcome.record.kind, "timed_out");
});

Deno.test("workflowWaits: lists a registered wait whose run record is not on this host", async () => {
  const workflow = workflowNamed("release");
  const run = waitingRun(workflow, { review: T0 });
  const step = run.getJob("main")!.getStep("review")!;
  const waits = new InMemorySignalWaitStore();
  await waits.register(
    registrationOf(
      {
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        runId: run.id,
        jobName: "main",
        stepName: "review",
      },
      step.signalWait!,
      T0,
    ),
  );

  const listed = await list(depsOf([], T1, waits));

  assertEquals(listed.map((w) => [w.waitId, w.runId, w.stepName]), [
    [step.signalWait!.id, run.id, "review"],
  ]);
  assertEquals(listed[0].waitingSince, T0.toISOString());
});

Deno.test("workflowWaits: sweeps ended runs and authoritative orphans after the grace period", async () => {
  const waits = new InMemorySignalWaitStore();
  const register = async (run: WorkflowRun) => {
    const step = run.getJob("main")!.getStep("review")!;
    await waits.register(
      registrationOf(
        {
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          runId: run.id,
          jobName: "main",
          stepName: "review",
        },
        step.signalWait!,
        T0,
      ),
    );
    return waitRefOf(run, step)!.waitId;
  };
  const ended = waitingRun(workflowNamed("ended"), { review: T0 });
  const endedWait = await register(ended);
  ended.endAsCancelled("operator");
  const unsynced = waitingRun(workflowNamed("unsynced"), { review: T0 });
  const unsyncedWait = await register(unsynced);

  // Just past the deadline: the missing run is still inside the grace period.
  const soon = new Date("2026-01-01T00:02:00.000Z");
  const sure = depsOf([ended], soon, waits);
  sure.signalWaits = {
    supported: true,
    store: waits,
    localRunAbsenceIsAuthoritative: true,
  };
  const listed = await list(sure);
  assertEquals(listed.map((w) => w.waitId), [unsyncedWait]);
  assertEquals((await waits.findRegistration(endedWait)).kind, "absent");
  // The ended run's wait was closed, so a late signal is answered closed.
  const closed = await waits.findOutcome(endedWait);
  assert(closed.kind === "found");
  assertEquals(closed.record.kind, "cancelled");

  // Only an authoritative lookup permits removal after the grace period.
  const later = new Date(
    new Date("2026-01-01T00:01:00.000Z").getTime() +
      ORPHAN_WAIT_RECORD_GRACE_MS + 1,
  );
  const authoritative = depsOf([ended], later, waits);
  authoritative.signalWaits = {
    supported: true,
    store: waits,
    localRunAbsenceIsAuthoritative: true,
  };
  assertEquals(await list(authoritative), []);
  assertEquals((await waits.findRegistration(unsyncedWait)).kind, "absent");
  assertEquals((await waits.findOutcome(unsyncedWait)).kind, "absent");
  // The outcome of the run that exists lives as long as the run.
  assertEquals((await waits.findOutcome(endedWait)).kind, "found");
});

Deno.test("workflowWaits: an outcome that cannot be read is listed apart, with the resume that fails its step", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });
  const wait = run.getJob("main")!.getStep("review")!.signalWait!;
  const waits = new InMemorySignalWaitStore();
  waits.outcomes.set(wait.id, new TextEncoder().encode("{"));

  const deps = depsOf([run], T1, waits);

  assertEquals(await list(deps), []);
  assertEquals((await listUnreadable(deps)).map((w) => w.nextCommand), [
    `swamp workflow resume release --run ${run.id}`,
  ]);
});

Deno.test("workflowWaits: without a wait store it lists what run records hold and writes nothing", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });

  const open = await list(depsOf([run], T1, undefined));
  assertEquals(open.map((w) => w.expired), [false]);

  const expired = await list(
    depsOf([run], new Date("2026-01-01T00:01:00.001Z"), undefined),
  );
  assertEquals(expired.map((w) => w.expired), [true]);
});

Deno.test("workflowWaits: no suspended runs lists nothing", async () => {
  assertEquals(await list(depsOf([], T1)), []);
});

Deno.test("workflowWaits: a registration that cannot be read is rebuilt from the run record and listed as the open wait it is", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });
  const wait = run.getJob("main")!.getStep("review")!.signalWait!;
  const waits = new InMemorySignalWaitStore();
  waits.registrations.set(wait.id, new Uint8Array());

  const deps = depsOf([run], T1, waits);

  assertEquals((await list(deps)).map((w) => [w.waitId, w.expired]), [
    [wait.id, false],
  ]);
  assertEquals((await waits.findRegistration(wait.id)).kind, "found");
  assertEquals(await listUnreadable(deps), []);
});

Deno.test("workflowWaits: a sweep that fails does not hide the waits", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });
  const wait = run.getJob("main")!.getStep("review")!.signalWait!;
  class FailingSweep extends InMemorySignalWaitStore {
    private lists = 0;
    override listRegistrations() {
      // The sweep lists first; the listing itself lists after.
      return this.lists++ === 0
        ? Promise.reject(new Error("bucket unreachable"))
        : super.listRegistrations();
    }
  }
  const store = new FailingSweep();
  const deps = depsOf([run], T1, store);
  deps.signalWaits = {
    supported: true,
    store,
    localRunAbsenceIsAuthoritative: true,
  };

  assertEquals((await list(deps)).map((w) => w.waitId), [wait.id]);
});

async function listAll(deps: WorkflowWaitsDeps, includeSignalled?: boolean) {
  const events = await collect<WorkflowWaitsEvent>(
    workflowWaits(createLibSwampContext(), deps, { includeSignalled }),
  );
  const last = events.at(-1)!;
  if (last.kind !== "completed") throw new Error(`got ${last.kind}`);
  return last.data;
}

/** A run suspended only on one wait for a signal, with no gate. */
function runWaitingOnlyForSignal(name: string, at: Date): WorkflowRun {
  const workflow = Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(60, SCHEMA),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  job.getStep("review")!.start();
  job.getStep("review")!.waitForSignal(SignalWait.open(SCHEMA, 60, at));
  run.suspend();
  return run;
}

Deno.test("workflowWaits: without includeSignalled the result carries no signalled list", async () => {
  const run = runWaitingOnlyForSignal("release", T0);
  const data = await listAll(depsOf([run], T1));
  assertEquals("signalled" in data, false);
  assertEquals(data.waits.length, 1);
});

Deno.test("workflowWaits: includeSignalled lists a signalled wait with its receipt and that the run can resume", async () => {
  const run = runWaitingOnlyForSignal("release", T0);
  const step = run.getJob("main")!.getStep("review")!;
  const waits = new InMemorySignalWaitStore();
  const outcome = acceptedOutcomeFor(step.signalWait!, { verdict: "ship" }, {
    runId: run.id,
    at: T1,
  });
  await waits.settle(outcome);

  const data = await listAll(depsOf([run], T1, waits), true);

  assertEquals(data.waits, []);
  assertEquals(data.signalled, [{
    waitId: step.signalWait!.id,
    workflowId: run.workflowId,
    workflowName: "release",
    runId: run.id,
    jobName: "main",
    stepName: "review",
    waitingSince: data.signalled![0].waitingSince,
    deadline: step.signalWait!.deadline.toISOString(),
    signal: outcome.receipt,
    awaitingResume: true,
    nextCommand: `swamp workflow resume release --run ${run.id}`,
  }]);
  // The listing never writes the run.
  assertEquals(step.status, "waiting_signal");
});

Deno.test("workflowWaits: a signalled wait of a run a gate still holds is not awaiting resume", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });
  const step = run.getJob("main")!.getStep("review")!;
  const waits = new InMemorySignalWaitStore();
  await waits.settle(
    acceptedOutcomeFor(step.signalWait!, { verdict: "ship" }, {
      runId: run.id,
    }),
  );

  const data = await listAll(depsOf([run], T1, waits), true);

  assertEquals(data.signalled?.map((w) => w.awaitingResume), [false]);
});

Deno.test("workflowWaits: includeSignalled lists open and signalled waits apart, and an empty list when none is signalled", async () => {
  const open = runWaitingOnlyForSignal("open", T0);
  const done = runWaitingOnlyForSignal("done", T0);
  const waits = new InMemorySignalWaitStore();
  await waits.settle(
    acceptedOutcomeFor(
      done.getJob("main")!.getStep("review")!.signalWait!,
      { verdict: "ship" },
      { runId: done.id },
    ),
  );

  const data = await listAll(depsOf([open, done], T1, waits), true);
  assertEquals(data.waits.map((w) => w.workflowName), ["open"]);
  assertEquals(data.signalled?.map((w) => w.workflowName), ["done"]);

  assertEquals(
    (await listAll(depsOf([open], T1), true)).signalled,
    [],
  );
});
