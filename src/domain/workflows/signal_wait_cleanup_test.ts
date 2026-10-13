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
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { CANCELLED_STEP_ERROR, WorkflowRun } from "./workflow_run.ts";
import {
  SignalWait,
  WAIT_TIMEOUT_STEP_ERROR,
  WAIT_UNREADABLE_STEP_ERROR,
} from "./signal_wait.ts";
import { cancelledOutcome, registrationOf } from "./signal_wait_records.ts";
import {
  acceptedOutcomeFor,
  InMemorySignalWaitStore,
  unsignalledOutcomeFor,
} from "./signal_wait_store_test_helpers.ts";
import {
  applyAcceptedSignals,
  closeRunWaits,
  closeStepWait,
  closeWaitsOfEndedRun,
  ensureRegistered,
  findRegistrationOfStep,
  findUnsettledWait,
  isEndedRunStatus,
  ORPHAN_WAIT_RECORD_GRACE_MS,
  outcomeAt,
  removeWaitRecordsOfRuns,
  settleExpiredWaits,
  settleReenteredWait,
  sweepPendingSignals,
  sweepWaitRecords,
  takePendingSignalsOfRun,
  waitIdsOf,
  waitRefOf,
} from "./signal_wait_cleanup.ts";
import {
  PENDING_SIGNAL_LAPSE_GRACE_MS,
  type PendingSignal,
} from "./pending_signal.ts";
import { holdEarlySignal } from "./early_signal.ts";
import {
  claimWaitKey,
  type WaitKeyClaim,
  waitKeyRecordKey,
} from "./wait_key_claim.ts";

const OPENED = new Date("2026-01-01T00:00:00.000Z");
const IN_TIME = new Date("2026-01-01T00:00:30.000Z");
const DEADLINE = new Date("2026-01-01T00:01:00.000Z");
const TOO_LATE = new Date("2026-01-01T00:01:00.001Z");
const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

/** A run suspended with each named step waiting, and its store as the executor leaves it. */
async function waitingRun(
  steps: string[] = ["a"],
  store = new InMemorySignalWaitStore(),
): Promise<{ run: WorkflowRun; store: InMemorySignalWaitStore }> {
  const run = WorkflowRun.create(
    Workflow.create({
      name: "release",
      jobs: [
        Job.create({
          name: "main",
          steps: steps.map((name) =>
            Step.create({ name, task: StepTask.waitForSignal(60, SCHEMA) })
          ),
        }),
      ],
    }),
  );
  run.start();
  const job = run.getJob("main")!;
  job.start();
  for (const name of steps) {
    const step = job.getStep(name)!;
    step.start();
    const wait = SignalWait.open(SCHEMA, 60, OPENED);
    step.waitForSignal(wait);
    await store.register(
      registrationOf(
        {
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          runId: run.id,
          jobName: "main",
          stepName: name,
        },
        wait,
        OPENED,
      ),
    );
  }
  run.suspend();
  return { run, store };
}

function stepOf(run: WorkflowRun, name: string) {
  return run.getJob("main")!.getStep(name)!;
}

function accept(run: WorkflowRun, name: string, payload = { verdict: "ship" }) {
  return acceptedOutcomeFor(stepOf(run, name).signalWait!, payload, {
    runId: run.id,
  });
}

Deno.test("isEndedRunStatus: only a run nothing continues from", () => {
  for (const status of ["succeeded", "failed", "cancelled"]) {
    assertEquals(isEndedRunStatus(status), true, status);
  }
  for (const status of ["pending", "running", "suspended", "interrupted"]) {
    assertEquals(isEndedRunStatus(status), false, status);
  }
});

Deno.test("outcomeAt: reads the outcome, and settles an open wait as timed out only once its deadline has passed", async () => {
  const { run, store } = await waitingRun();
  const ref = waitRefOf(run, stepOf(run, "a"))!;

  assertEquals(await outcomeAt(store, ref, IN_TIME), { kind: "absent" });
  assertEquals(await outcomeAt(store, ref, DEADLINE), { kind: "absent" });
  assertEquals(store.outcomes.size, 0);

  const settled = await outcomeAt(store, ref, TOO_LATE);
  assert(settled.kind === "found");
  assertEquals(settled.record.kind, "timed_out");
  assertEquals(settled.record.runId, run.id);
  // Decided once: an earlier clock reads the same outcome afterwards.
  assertEquals(await outcomeAt(store, ref, IN_TIME), settled);
});

Deno.test("outcomeAt: a signal stored before the deadline stays the outcome after it", async () => {
  const { run, store } = await waitingRun();
  const accepted = accept(run, "a");
  await store.settle(accepted);

  assertEquals(
    await outcomeAt(store, waitRefOf(run, stepOf(run, "a"))!, TOO_LATE),
    { kind: "found", record: accepted },
  );
});

Deno.test("findUnsettledWait: the first wait with no outcome and time left, without settling anything", async () => {
  const { run, store } = await waitingRun(["a", "b"]);
  await store.settle(accept(run, "a"));

  const open = await findUnsettledWait(store, run, IN_TIME);
  assertEquals(open?.stepName, "b");
  assertEquals(open?.wait.id, stepOf(run, "b").signalWait!.id);

  // Past the deadline nothing is open, and nothing was written to say so.
  assertEquals(await findUnsettledWait(store, run, TOO_LATE), undefined);
  assertEquals(store.outcomes.size, 1);
});

Deno.test("applyAcceptedSignals: applies each accepted signal and reports the first wait still open", async () => {
  const { run, store } = await waitingRun(["a", "b", "c"]);
  const accepted = accept(run, "b", { verdict: "fix" });
  await store.settle(accepted);

  const open = await applyAcceptedSignals(store, run, IN_TIME);

  assertEquals(open, {
    jobName: "main",
    stepName: "a",
    wait: {
      id: stepOf(run, "a").signalWait!.id,
      deadline: stepOf(run, "a").signalWait!.deadline.toISOString(),
    },
  });
  assertEquals(stepOf(run, "a").status, "waiting_signal");
  assertEquals(stepOf(run, "b").status, "succeeded");
  assertEquals(stepOf(run, "b").output, {
    type: "wait_for_signal",
    payload: { verdict: "fix" },
    signal: accepted.receipt,
  });
  assertEquals(stepOf(run, "c").status, "waiting_signal");
});

Deno.test("applyAcceptedSignals: a wait that timed out, was cancelled or cannot be read is not open, and is left for the walk to fail", async () => {
  const { run, store } = await waitingRun(["late", "gone", "bad", "forged"]);
  await store.settle(
    unsignalledOutcomeFor(stepOf(run, "gone").signalWait!, "cancelled", {
      runId: run.id,
    }),
  );
  store.outcomes.set(
    stepOf(run, "bad").signalWait!.id,
    new TextEncoder().encode("{"),
  );
  await store.settle(accept(run, "forged", { verdict: "nope" }));
  const before = run.toData();

  // `late` has no outcome yet: looking after its deadline creates one.
  const open = await applyAcceptedSignals(store, run, TOO_LATE);

  assertEquals(open, undefined);
  assertEquals(run.toData(), before);
  const late = await store.findOutcome(stepOf(run, "late").signalWait!.id);
  assert(late.kind === "found");
  assertEquals(late.record.kind, "timed_out");
});

Deno.test("settleReenteredWait: fails the step by what settled its wait, and leaves an open or signalled one waiting", async () => {
  const names = ["open", "signalled", "late", "gone", "bad", "forged"];
  const { run, store } = await waitingRun(names);
  await store.settle(accept(run, "signalled"));
  await store.settle(
    unsignalledOutcomeFor(stepOf(run, "late").signalWait!, "timed_out", {
      runId: run.id,
    }),
  );
  await store.settle(
    unsignalledOutcomeFor(stepOf(run, "gone").signalWait!, "cancelled", {
      runId: run.id,
    }),
  );
  store.outcomes.set(
    stepOf(run, "bad").signalWait!.id,
    new TextEncoder().encode("{"),
  );
  await store.settle(accept(run, "forged", { verdict: "nope" }));

  const settle = (name: string) =>
    settleReenteredWait(store, run, stepOf(run, name), IN_TIME);

  assertEquals(await settle("open"), "open");
  assertEquals(stepOf(run, "open").status, "waiting_signal");
  // A signal is applied by the resume's takeover, not here.
  assertEquals(await settle("signalled"), "open");
  assertEquals(stepOf(run, "signalled").status, "waiting_signal");

  assertEquals(await settle("late"), "failed");
  assertEquals(stepOf(run, "late").error, WAIT_TIMEOUT_STEP_ERROR);
  assertEquals(await settle("gone"), "failed");
  assertEquals(stepOf(run, "gone").error, CANCELLED_STEP_ERROR);
  assertEquals(await settle("bad"), "failed");
  assertEquals(stepOf(run, "bad").error, WAIT_UNREADABLE_STEP_ERROR);
  // An outcome that can never be applied does not leave the step waiting.
  assertEquals(await settle("forged"), "failed");
  assertEquals(stepOf(run, "forged").error, WAIT_UNREADABLE_STEP_ERROR);
  assertEquals(stepOf(run, "forged").output, undefined);
});

Deno.test("settleReenteredWait: a step whose stored wait cannot be read fails as unreadable without asking the store", async () => {
  const { run } = await waitingRun();
  const data = run.toData();
  data.jobs[0].steps[0].wait = { kind: "?" };
  const broken = WorkflowRun.fromData(data);
  const store = new InMemorySignalWaitStore();

  assertEquals(
    await settleReenteredWait(store, broken, stepOf(broken, "a"), IN_TIME),
    "failed",
  );
  assertEquals(stepOf(broken, "a").error, WAIT_UNREADABLE_STEP_ERROR);
});

Deno.test("closeStepWait: settles an open wait as cancelled, removes its registration, and keeps a signal that got there first", async () => {
  const { run, store } = await waitingRun(["open", "signalled"]);
  const accepted = accept(run, "signalled");
  await store.settle(accepted);

  await closeStepWait(store, run, stepOf(run, "open"), IN_TIME);
  await closeStepWait(store, run, stepOf(run, "signalled"), IN_TIME);

  assertEquals(await store.listRegistrations(), []);
  const open = await store.findOutcome(stepOf(run, "open").signalWait!.id);
  assert(open.kind === "found");
  assertEquals(open.record.kind, "cancelled");
  assertEquals(
    await store.findOutcome(stepOf(run, "signalled").signalWait!.id),
    { kind: "found", record: accepted },
  );
});

Deno.test("closeRunWaits: closes every wait the run holds or held, and is safe to repeat", async () => {
  const { run, store } = await waitingRun(["a", "b"]);
  const accepted = accept(run, "a");
  await store.settle(accepted);
  stepOf(run, "a").applyWaitOutcome(accepted);

  await closeRunWaits(store, run, IN_TIME);
  const once = new Map(store.outcomes);
  await closeRunWaits(store, run, TOO_LATE);

  assertEquals(await store.listRegistrations(), []);
  assertEquals(store.outcomes, once);
  assertEquals(
    (await store.listOutcomes()).map((o) => o.kind).sort(),
    ["accepted", "cancelled"],
  );
});

Deno.test("closeWaitsOfEndedRun: closes the waits of a run about to be saved as ended, and of no other", async () => {
  const { run, store } = await waitingRun();
  const hook = closeWaitsOfEndedRun(store, () => IN_TIME);

  await hook(run);
  assertEquals((await store.listRegistrations()).length, 1);
  assertEquals(store.outcomes.size, 0);

  run.endAsCancelled("operator");
  await hook(run);
  assertEquals(await store.listRegistrations(), []);
  assertEquals((await store.listOutcomes()).map((o) => o.kind), ["cancelled"]);
});

Deno.test("removeWaitRecordsOfRuns: removes every record of the named runs and none of another's", async () => {
  const store = new InMemorySignalWaitStore();
  const { run: gone } = await waitingRun(["a", "b"], store);
  const { run: kept } = await waitingRun(["a"], store);
  await store.settle(accept(gone, "a"));
  await store.removeRegistration(stepOf(gone, "a").signalWait!.id);
  await store.settle(accept(kept, "a"));

  assertEquals(await removeWaitRecordsOfRuns(store, new Set()), 0);
  assertEquals(await removeWaitRecordsOfRuns(store, new Set([gone.id])), 2);

  assertEquals(waitIdsOf([gone]).length, 2);
  assertEquals(
    (await store.listRegistrations()).map((r) => r.runId),
    [kept.id],
  );
  assertEquals((await store.listOutcomes()).map((o) => o.runId), [kept.id]);
});

Deno.test("sweepWaitRecords: closes the registration of an ended run, keeps its outcome, and leaves a live run alone", async () => {
  const store = new InMemorySignalWaitStore();
  const { run: ended } = await waitingRun(["a"], store);
  const { run: live } = await waitingRun(["a"], store);
  await store.settle(accept(live, "a"));
  ended.endAsCancelled("operator");
  const runs = new Map<string, WorkflowRun>([
    [ended.id, ended],
    [live.id, live],
  ]);
  const findRun = (_workflowId: string, runId: string) =>
    Promise.resolve(runs.get(runId) ?? null);
  const farFuture = new Date(
    TOO_LATE.getTime() + 10 * ORPHAN_WAIT_RECORD_GRACE_MS,
  );

  const swept = await sweepWaitRecords(store, findRun, farFuture, {
    localRunAbsenceIsAuthoritative: true,
  });

  assertEquals(swept, {
    registrations: 1,
    outcomes: 0,
    keyRecords: 0,
    pendingSignals: 0,
  });
  assertEquals(
    (await store.listRegistrations()).map((r) => r.runId),
    [live.id],
  );
  // Both outcomes live as long as their runs, however old.
  assertEquals(
    (await store.listOutcomes()).map((o) => [o.runId, o.kind]).sort(),
    [[ended.id, "cancelled"], [live.id, "accepted"]].sort(),
  );
});

Deno.test("sweepWaitRecords: records of a run that cannot be found go only once the deadline plus the grace period has passed", async () => {
  const { run, store } = await waitingRun(["a", "b"]);
  await store.settle(
    cancelledOutcome(waitRefOf(run, stepOf(run, "a"))!, IN_TIME),
  );
  const nowhere = () => Promise.resolve(null);
  const justInside = new Date(DEADLINE.getTime() + ORPHAN_WAIT_RECORD_GRACE_MS);
  const justPast = new Date(justInside.getTime() + 1);

  assertEquals(
    await sweepWaitRecords(store, nowhere, justInside, {
      localRunAbsenceIsAuthoritative: true,
    }),
    {
      registrations: 0,
      outcomes: 0,
      keyRecords: 0,
      pendingSignals: 0,
    },
  );
  assertEquals((await store.listRegistrations()).length, 2);

  assertEquals(
    await sweepWaitRecords(store, nowhere, justPast, {
      localRunAbsenceIsAuthoritative: true,
    }),
    {
      registrations: 2,
      outcomes: 1,
      keyRecords: 0,
      pendingSignals: 0,
    },
  );
  assertEquals(store.registrations.size, 0);
  assertEquals(store.outcomes.size, 0);
});

Deno.test("sweepWaitRecords: uncertain run absence retains records regardless of age", async () => {
  for (const authority of [undefined, false]) {
    const { run, store } = await waitingRun();
    const accepted = accept(run, "a");
    await store.settle(accepted);
    const farFuture = new Date(
      DEADLINE.getTime() + 100 * ORPHAN_WAIT_RECORD_GRACE_MS,
    );
    assertEquals(
      await sweepWaitRecords(store, () => Promise.resolve(null), farFuture, {
        localRunAbsenceIsAuthoritative: authority,
      }),
      { registrations: 0, outcomes: 0, keyRecords: 0, pendingSignals: 0 },
    );
    assertEquals((await store.listRegistrations()).length, 1);
    assertEquals(await store.listOutcomes(), [accepted]);
    assertEquals(await applyAcceptedSignals(store, run, farFuture), undefined);
    assertEquals(stepOf(run, "a").output, {
      type: "wait_for_signal",
      payload: accepted.payload,
      signal: accepted.receipt,
    });
  }
});

Deno.test("settleReenteredWait: an accepted outcome with another wait's identity fails without replacing the outcome", async () => {
  for (const mismatch of ["outcome", "receipt"]) {
    const { run, store } = await waitingRun();
    const step = stepOf(run, "a");
    const outcome = accept(run, "a");
    if (mismatch === "outcome") outcome.waitId = crypto.randomUUID();
    else outcome.receipt.waitId = crypto.randomUUID();
    // Also exercise stores that return a parsed outcome without checking its key.
    store.findOutcome = () =>
      Promise.resolve({ kind: "found", record: outcome });
    const before = structuredClone(outcome);
    assertEquals(await applyAcceptedSignals(store, run, IN_TIME), undefined);
    assertEquals(step.status, "waiting_signal");
    assertEquals(
      await settleReenteredWait(store, run, step, IN_TIME),
      "failed",
    );
    assertEquals(step.error, WAIT_UNREADABLE_STEP_ERROR);
    assertEquals(step.output, undefined);
    assertEquals(outcome, before);
    assertEquals(store.outcomes.size, 0);
  }
});

Deno.test("outcomeAt: an outcome that names another run is not this wait's outcome", async () => {
  const { run, store } = await waitingRun();
  const step = stepOf(run, "a");
  await store.settle(
    acceptedOutcomeFor(step.signalWait!, { verdict: "ship" }, {
      runId: crypto.randomUUID(),
    }),
  );

  assertEquals(await outcomeAt(store, waitRefOf(run, step)!, IN_TIME), {
    kind: "unreadable",
  });
  // The resume fails the step instead of applying another run's signal.
  assertEquals(await applyAcceptedSignals(store, run, IN_TIME), undefined);
  assertEquals(step.status, "waiting_signal");
  assertEquals(await settleReenteredWait(store, run, step, IN_TIME), "failed");
  assertEquals(step.error, WAIT_UNREADABLE_STEP_ERROR);
});

Deno.test("ensureRegistered: keeps a readable registration, and replaces one that cannot be read", async () => {
  const { run, store } = await waitingRun();
  const [original] = await store.listRegistrations();
  const rebuilt = { ...original, stepName: "renamed" };

  // A readable registration holds, whatever is offered.
  assertEquals(await ensureRegistered(store, rebuilt), original);

  store.registrations.set(original.waitId, new Uint8Array());
  assertEquals(await store.listRegistrations(), []);
  assertEquals(await ensureRegistered(store, rebuilt), rebuilt);
  assertEquals(await store.listRegistrations(), [rebuilt]);

  await store.removeRegistration(original.waitId);
  assertEquals(await ensureRegistered(store, original), original);
  assertEquals(run.id, original.runId);
});

Deno.test("findRegistrationOfStep: finds the wait a step of a run registered, and no other step's or run's", async () => {
  const store = new InMemorySignalWaitStore();
  const { run } = await waitingRun(["a", "b"], store);
  await waitingRun(["a"], store);

  const found = await findRegistrationOfStep(store, {
    runId: run.id,
    jobName: "main",
    stepName: "b",
  });

  assertEquals(found?.waitId, stepOf(run, "b").signalWait!.id);
  assertEquals(
    await findRegistrationOfStep(store, {
      runId: run.id,
      jobName: "main",
      stepName: "c",
    }),
    undefined,
  );
  assertEquals(
    await findRegistrationOfStep(store, {
      runId: crypto.randomUUID(),
      jobName: "main",
      stepName: "a",
    }),
    undefined,
  );
});

Deno.test("sweepWaitRecords: a wait registered after the run record here says the run ended is live, and is left alone", async () => {
  // A failed run is retried under the same id on another host. Its new
  // wait is registered at once; the run record here still says failed.
  const { run, store } = await waitingRun();
  const [registration] = await store.listRegistrations();
  run.endAsCancelled("operator");
  const stale = run.completedAt!;
  await store.removeRegistration(registration.waitId);
  await store.register({
    ...registration,
    registeredAt: new Date(stale.getTime() + 1000).toISOString(),
  });
  const findRun = () => Promise.resolve(run);
  const later = new Date(stale.getTime() + 60_000);

  assertEquals(await sweepWaitRecords(store, findRun, later, AUTHORITATIVE), {
    registrations: 0,
    outcomes: 0,
    keyRecords: 0,
    pendingSignals: 0,
  });
  assertEquals((await store.listRegistrations()).length, 1);
  assertEquals(store.outcomes.size, 0);

  // One registered before the run ended is closed as before.
  await store.removeRegistration(registration.waitId);
  await store.register({
    ...registration,
    registeredAt: new Date(stale.getTime() - 1000).toISOString(),
  });
  assertEquals(await sweepWaitRecords(store, findRun, later, AUTHORITATIVE), {
    registrations: 1,
    outcomes: 0,
    keyRecords: 0,
    pendingSignals: 0,
  });
  assertEquals((await store.listOutcomes()).map((o) => o.kind), ["cancelled"]);
});

const AUTHORITATIVE = { localRunAbsenceIsAuthoritative: true };

Deno.test("sweepWaitRecords: where run records are not the datastore's own it changes nothing, whatever they say", async () => {
  // A stale copy that says the run ended, and a run kept in another
  // repository that looks deleted: neither is evidence about the wait.
  const store = new InMemorySignalWaitStore();
  const { run: stale } = await waitingRun(["a"], store);
  const { run: elsewhere } = await waitingRun(["a"], store);
  await store.settle(accept(elsewhere, "a"));
  stale.endAsCancelled("operator");
  const before = {
    registrations: new Map(store.registrations),
    outcomes: new Map(store.outcomes),
  };
  const findRun = (_workflowId: string, runId: string) =>
    Promise.resolve(runId === stale.id ? stale : null);
  const farFuture = new Date(
    TOO_LATE.getTime() + 10 * ORPHAN_WAIT_RECORD_GRACE_MS,
  );

  for (
    const options of [undefined, { localRunAbsenceIsAuthoritative: false }]
  ) {
    assertEquals(await sweepWaitRecords(store, findRun, farFuture, options), {
      registrations: 0,
      outcomes: 0,
      keyRecords: 0,
      pendingSignals: 0,
    });
    assertEquals(store.registrations, before.registrations);
    assertEquals(store.outcomes, before.outcomes);
  }
});

Deno.test("sweepWaitRecords: a run that cannot be read is skipped, and the rest are still swept", async () => {
  const store = new InMemorySignalWaitStore();
  const { run: damaged } = await waitingRun(["a"], store);
  await store.settle(accept(damaged, "a"));
  const { run: ended } = await waitingRun(["a"], store);
  ended.endAsCancelled("operator");
  const findRun = (_workflowId: string, runId: string) =>
    runId === damaged.id
      ? Promise.reject(new Error("run file does not parse"))
      : Promise.resolve(runId === ended.id ? ended : null);
  const farFuture = new Date(
    TOO_LATE.getTime() + 10 * ORPHAN_WAIT_RECORD_GRACE_MS,
  );

  const swept = await sweepWaitRecords(
    store,
    findRun,
    farFuture,
    AUTHORITATIVE,
  );

  assertEquals(swept, {
    registrations: 1,
    outcomes: 0,
    keyRecords: 0,
    pendingSignals: 0,
  });
  // Nothing is known about the damaged run, so its records stay.
  assertEquals(
    (await store.listRegistrations()).map((r) => r.runId),
    [damaged.id],
  );
  assertEquals(
    (await store.listOutcomes()).map((o) => o.runId).sort(),
    [damaged.id, ended.id].sort(),
  );
});

Deno.test("settleExpiredWaits: settles a registered wait as timed out only once its deadline has passed, and only once", async () => {
  const { run, store } = await waitingRun(["a", "b"]);

  assertEquals(await settleExpiredWaits(store, run, DEADLINE), 0);
  assertEquals(store.outcomes.size, 0);

  assertEquals(await settleExpiredWaits(store, run, TOO_LATE), 2);
  for (const name of ["a", "b"]) {
    const stored = await store.findOutcome(stepOf(run, name).signalWait!.id);
    assert(stored.kind === "found");
    assertEquals(stored.record.kind, "timed_out");
    assertEquals(stored.record.runId, run.id);
  }
  // The run record is the resume's to change.
  assertEquals(stepOf(run, "a").status, "waiting_signal");
  assertEquals(await settleExpiredWaits(store, run, TOO_LATE), 0);
});

Deno.test("settleExpiredWaits: a signal accepted before the deadline stays the outcome", async () => {
  const { run, store } = await waitingRun();
  const accepted = accept(run, "a");
  await store.settle(accepted);

  assertEquals(await settleExpiredWaits(store, run, TOO_LATE), 0);
  assertEquals(
    await store.findOutcome(stepOf(run, "a").signalWait!.id),
    { kind: "found", record: accepted },
  );
});

Deno.test("settleExpiredWaits: a wait whose registration is gone or cannot be read is left with no outcome", async () => {
  const { run, store } = await waitingRun(["a", "b"]);
  await store.removeRegistration(stepOf(run, "a").signalWait!.id);
  store.registrations.set(
    stepOf(run, "b").signalWait!.id,
    new TextEncoder().encode("{"),
  );

  assertEquals(await settleExpiredWaits(store, run, TOO_LATE), 0);
  assertEquals(store.outcomes.size, 0);
});

// Key claims go with the records of their runs (swamp-club#3209).

/** Claims `key` for the wait step `name` of `run` holds, as the executor does. */
async function claimFor(
  store: InMemorySignalWaitStore,
  run: WorkflowRun,
  name: string,
  key = "verdict",
): Promise<WaitKeyClaim> {
  const wait = stepOf(run, name).signalWait!;
  const result = await claimWaitKey(store, {
    workflowId: run.workflowId,
    key,
    waitId: wait.id,
    runId: run.id,
    jobName: "main",
    stepName: name,
    deadline: wait.deadline.toISOString(),
  }, OPENED);
  assert(result.kind === "acquired", `got ${result.kind}`);
  return result.claim;
}

Deno.test("removeWaitRecordsOfRuns: a deleted run's claim is released before its outcome goes, so the key reads free and its number is not used again", async () => {
  const store = new InMemorySignalWaitStore();
  const { run: gone } = await waitingRun(["a"], store);
  const claim = await claimFor(store, gone, "a");
  await store.settle(accept(gone, "a"));

  await removeWaitRecordsOfRuns(store, new Set([gone.id]), IN_TIME);

  assertEquals(store.outcomes.size, 0);
  const records = await store.listKeyRecords();
  assertEquals(records.map((r) => [r.kind, r.generation]), [
    ["release", claim.generation + 1],
  ]);
  const next = await claimWaitKey(store, {
    workflowId: gone.workflowId,
    key: "verdict",
    waitId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    jobName: "main",
    stepName: "a",
    deadline: DEADLINE.toISOString(),
  }, IN_TIME);
  assert(next.kind === "acquired");
  assertEquals(next.claim.generation, 3);
});

Deno.test("removeWaitRecordsOfRuns: the claim of a run that stays is kept, and still holds its key", async () => {
  const store = new InMemorySignalWaitStore();
  const { run: gone } = await waitingRun(["a"], store);
  await claimFor(store, gone, "a", "old");
  await store.settle(accept(gone, "a"));
  const { run: kept } = await waitingRun(["a"], store);
  const holder = await claimFor(store, kept, "a");

  await removeWaitRecordsOfRuns(store, new Set([gone.id]), IN_TIME);

  const highest = await store.highestKeyRecord(kept.workflowId, "verdict");
  assertEquals(highest, { kind: "found", record: holder });
});

Deno.test("sweepWaitRecords: the claim of a run that cannot be found is released once the deadline plus the grace period has passed, and only where run absence is authoritative", async () => {
  const { run, store } = await waitingRun(["a"]);
  await claimFor(store, run, "a");
  const nowhere = () => Promise.resolve(null);
  const justInside = new Date(DEADLINE.getTime() + ORPHAN_WAIT_RECORD_GRACE_MS);
  const justPast = new Date(justInside.getTime() + 1);
  const kinds = async () => (await store.listKeyRecords()).map((r) => r.kind);

  await sweepWaitRecords(store, nowhere, justPast);
  assertEquals(await kinds(), ["claim"]);
  await sweepWaitRecords(store, nowhere, justInside, {
    localRunAbsenceIsAuthoritative: true,
  });
  assertEquals(await kinds(), ["claim"]);

  const swept = await sweepWaitRecords(store, nowhere, justPast, {
    localRunAbsenceIsAuthoritative: true,
  });
  assertEquals(swept.keyRecords, 1);
  assertEquals(await kinds(), ["release"]);
});

Deno.test("sweepWaitRecords: the claim of a run that exists, or that cannot be read, is left alone", async () => {
  const { run, store } = await waitingRun(["a"]);
  const claim = await claimFor(store, run, "a");
  const farFuture = new Date(
    DEADLINE.getTime() + ORPHAN_WAIT_RECORD_GRACE_MS * 10,
  );
  for (
    const findRun of [
      () => Promise.resolve(run),
      () => Promise.reject(new Error("damaged run file")),
    ]
  ) {
    const swept = await sweepWaitRecords(store, findRun, farFuture, {
      localRunAbsenceIsAuthoritative: true,
    });
    assertEquals(swept.keyRecords, 0);
    assertEquals(await store.listKeyRecords(), [claim]);
  }
});

// Pending signals (swamp-club#3212).

const EARLY_KEY = "kitchen-verdict";
const EARLY_SCHEMA = { type: "object" as const };

function earlyWorkflow(): Workflow {
  return Workflow.create({
    name: "kitchen",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "identify",
            task: StepTask.waitForSignal(60, EARLY_SCHEMA, EARLY_KEY, 10),
          }),
        ],
      }),
    ],
  });
}

/** A run suspended at a keyed wait a step with acceptEarly opened at `at`. */
async function suspendedAtEarlyWait(
  store: InMemorySignalWaitStore,
  workflow: Workflow,
  at: Date,
): Promise<{ run: WorkflowRun; waitId: string; claim: WaitKeyClaim }> {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("identify")!;
  step.start();
  let wait = SignalWait.open(EARLY_SCHEMA, 60, at, undefined, EARLY_KEY);
  const claimed = await claimWaitKey(store, {
    workflowId: workflow.id,
    key: EARLY_KEY,
    waitId: wait.id,
    runId: run.id,
    jobName: "main",
    stepName: "identify",
    deadline: wait.deadline.toISOString(),
    acceptEarly: 10,
  }, at);
  assert(claimed.kind === "acquired", `got ${claimed.kind}`);
  wait = wait.withEarly(claimed.claim.early!);
  await store.register(registrationOf(
    {
      workflowId: workflow.id,
      workflowName: workflow.name,
      runId: run.id,
      jobName: "main",
      stepName: "identify",
    },
    wait,
    at,
  ));
  step.waitForSignal(wait);
  run.suspend();
  return { run, waitId: wait.id, claim: claimed.claim };
}

function pendingFor(
  workflow: Workflow,
  overrides: Partial<PendingSignal> = {},
): PendingSignal {
  return {
    kind: "pending",
    workflowId: workflow.id,
    key: EARLY_KEY,
    slot: 1,
    number: 1,
    receiptId: crypto.randomUUID(),
    receivedAt: IN_TIME.toISOString(),
    submittedBy: "camera",
    payload: { verdict: "known" },
    acceptEarly: 10,
    ...overrides,
  };
}

Deno.test("outcomeAt: a wait at its deadline with a pending signal received before it succeeds, and does not time out", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const { run } = await suspendedAtEarlyWait(store, workflow, OPENED);
  const pending = pendingFor(workflow);
  await store.createPendingRecord(pending);
  const step = run.getJob("main")!.getStep("identify")!;
  const ref = waitRefOf(run, step)!;

  const stored = await outcomeAt(store, ref, TOO_LATE);
  assert(stored.kind === "found" && stored.record.kind === "accepted");
  assertEquals(stored.record.receipt.id, pending.receiptId);

  // The resume that follows succeeds the step with the payload.
  assertEquals(await applyAcceptedSignals(store, run, TOO_LATE), undefined);
  assertEquals(step.status, "succeeded");
});

Deno.test("outcomeAt: a pending signal received after the deadline does not stop the timeout", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const { run } = await suspendedAtEarlyWait(store, workflow, OPENED);
  await store.createPendingRecord(
    pendingFor(workflow, { receivedAt: TOO_LATE.toISOString() }),
  );
  const ref = waitRefOf(run, run.getJob("main")!.getStep("identify")!)!;
  const stored = await outcomeAt(store, ref, TOO_LATE);
  assertEquals(stored.kind === "found" && stored.record.kind, "timed_out");
});

Deno.test("outcomeAt: an open wait takes a pending signal a signaller left unapplied, whoever looks", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const { run } = await suspendedAtEarlyWait(store, workflow, OPENED);
  const ref = waitRefOf(run, run.getJob("main")!.getStep("identify")!)!;
  assertEquals(await outcomeAt(store, ref, IN_TIME), { kind: "absent" });
  await store.createPendingRecord(pendingFor(workflow));
  const stored = await outcomeAt(store, ref, IN_TIME);
  assertEquals(stored.kind === "found" && stored.record.kind, "accepted");
});

Deno.test("claimWaitKey: an overdue holder with a pending signal received before its deadline is settled as signalled, not timed out", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const holder = await suspendedAtEarlyWait(store, workflow, OPENED);
  await store.createPendingRecord(pendingFor(workflow));
  // A second run claims the key after the holder's deadline.
  const next = await claimWaitKey(store, {
    workflowId: workflow.id,
    key: EARLY_KEY,
    waitId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    jobName: "main",
    stepName: "identify",
    deadline: new Date(TOO_LATE.getTime() + 60_000).toISOString(),
    acceptEarly: 10,
  }, TOO_LATE);
  assertEquals(next.kind, "acquired");
  const outcome = await store.findOutcome(holder.waitId);
  assertEquals(outcome.kind === "found" && outcome.record.kind, "accepted");
});

Deno.test("settleExpiredWaits: an expired wait with an applicable pending signal is not counted as timed out", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const { run, waitId } = await suspendedAtEarlyWait(store, workflow, OPENED);
  await store.createPendingRecord(pendingFor(workflow));
  assertEquals(await settleExpiredWaits(store, run, TOO_LATE), 0);
  const outcome = await store.findOutcome(waitId);
  assertEquals(outcome.kind === "found" && outcome.record.kind, "accepted");
});

Deno.test("findUnsettledWait: a wait whose key holds an applicable pending signal is not waiting, and nothing is settled for it (swamp-club#3309)", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const { run, waitId } = await suspendedAtEarlyWait(store, workflow, OPENED);
  assertEquals(
    (await findUnsettledWait(store, run, IN_TIME))?.stepName,
    "identify",
  );
  const pending = pendingFor(workflow);
  await store.createPendingRecord(pending);

  assertEquals(await findUnsettledWait(store, run, IN_TIME), undefined);
  assertEquals((await store.findOutcome(waitId)).kind, "absent");

  // The resume that follows takes the signal and succeeds the step.
  assertEquals(await applyAcceptedSignals(store, run, IN_TIME), undefined);
  const step = run.getJob("main")!.getStep("identify")!;
  assertEquals(step.status, "succeeded");
  assertEquals(
    (step.output as { signal: { id: string } }).signal.id,
    pending.receiptId,
  );
});

Deno.test("findUnsettledWait: a pending signal that does not apply leaves the wait waiting", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const { run } = await suspendedAtEarlyWait(store, workflow, OPENED);
  // Received before the wait's limit allows.
  await store.createPendingRecord(
    pendingFor(workflow, { receivedAt: "2025-12-31T23:00:00.000Z" }),
  );

  const open = await findUnsettledWait(store, run, IN_TIME);
  assertEquals(open?.stepName, "identify");
  assertEquals(store.outcomes.size, 0);
});

Deno.test("takePendingSignalsOfRun: gives each open wait of the run its pending signal and counts them", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const { run, waitId } = await suspendedAtEarlyWait(store, workflow, OPENED);
  assertEquals(await takePendingSignalsOfRun(store, run), 0);
  await store.createPendingRecord(pendingFor(workflow));
  assertEquals(await takePendingSignalsOfRun(store, run), 1);
  // Settled now, so a second pass takes nothing.
  assertEquals(await takePendingSignalsOfRun(store, run), 0);
  // A wait whose registration is gone belongs to a run that ended.
  const other = new InMemorySignalWaitStore();
  const gone = await suspendedAtEarlyWait(other, workflow, OPENED);
  await other.createPendingRecord(pendingFor(workflow));
  await other.removeRegistration(gone.waitId);
  assertEquals(await takePendingSignalsOfRun(other, gone.run), 0);
  assertEquals((await store.findOutcome(waitId)).kind, "found");
});

Deno.test("removeWaitRecordsOfRuns: the pending signals of a deleted run's slot go with its claim", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const { run } = await suspendedAtEarlyWait(store, workflow, OPENED);
  await store.createPendingRecord(pendingFor(workflow));
  // A signal for the next claim is not this run's.
  await store.createPendingRecord(pendingFor(workflow, { slot: 2 }));
  await outcomeAt(
    store,
    waitRefOf(run, run.getJob("main")!.getStep("identify")!)!,
    IN_TIME,
  );
  await removeWaitRecordsOfRuns(store, new Set([run.id]), TOO_LATE);
  assertEquals(
    (await store.listPendingAddresses()).map((at) => at.slot),
    [2],
  );
  assertEquals(store.outcomes.size, 0);
});

const LONG_AFTER = new Date(
  IN_TIME.getTime() + 10_000 + PENDING_SIGNAL_LAPSE_GRACE_MS + 1,
);

Deno.test("sweepPendingSignals: a pending signal no wait took is superseded by a lapse once past its age limit and the grace period, and no number is reused", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  const pending = pendingFor(workflow);
  await store.createPendingRecord(pending);

  // Within the grace period it is kept.
  assertEquals(
    await sweepPendingSignals(store, new Date(LONG_AFTER.getTime() - 2)),
    0,
  );
  assertEquals(await sweepPendingSignals(store, LONG_AFTER), 1);
  const left = await store.listPendingAddresses();
  assertEquals(left.map((at) => at.number), [2]);
  const head = await store.findPendingRecord(left[0]);
  assertEquals(head.kind === "found" && head.record.kind, "lapse");
  // The lapse holds no payload.
  assertEquals("payload" in (head.kind === "found" ? head.record : {}), false);
  // It stays as the highest of its slot: a later sweep leaves it.
  assertEquals(await sweepPendingSignals(store, LONG_AFTER), 0);
  // The next signal is stored above it.
  const next = await holdEarlySignal(store, {
    workflowId: workflow.id,
    key: EARLY_KEY,
    payload: {},
    submittedBy: "camera",
    acceptEarly: 10,
  }, LONG_AFTER);
  assert(next.kind === "pending");
  assertEquals([next.record.slot, next.record.number], [1, 3]);
});

Deno.test("sweepPendingSignals: the signals a newer one superseded are removed, and the newest is kept", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  await store.createPendingRecord(pendingFor(workflow));
  const newest = pendingFor(workflow, {
    number: 2,
    receivedAt: new Date(IN_TIME.getTime() + 20_000).toISOString(),
  });
  await store.createPendingRecord(newest);
  assertEquals(
    await sweepPendingSignals(store, new Date(IN_TIME.getTime() + 21_000)),
    1,
  );
  assertEquals(await store.listPendingAddresses(), [{
    workflowId: workflow.id,
    key: EARLY_KEY,
    slot: 1,
    number: 2,
  }]);
});

Deno.test("sweepPendingSignals: the records of a slot whose claim still exists are left for the run that took them", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  await suspendedAtEarlyWait(store, workflow, OPENED);
  await store.createPendingRecord(pendingFor(workflow));
  assertEquals(await sweepPendingSignals(store, LONG_AFTER), 0);
  assertEquals((await store.listPendingAddresses()).length, 1);
});

Deno.test("sweepPendingSignals: a signal whose slot is claimed after the sweep listed the pending signals is left for that step to take", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  await store.createPendingRecord(pendingFor(workflow));
  // The step claims the key between the sweep's listing and its read of
  // the slot's key.
  const racing = new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "listPendingAddresses") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        const listed = await target.listPendingAddresses();
        await suspendedAtEarlyWait(target, workflow, OPENED);
        return listed;
      };
    },
  });
  assertEquals(await sweepPendingSignals(racing, LONG_AFTER), 0);
  assertEquals(
    await store.listPendingAddresses(),
    [{ workflowId: workflow.id, key: EARLY_KEY, slot: 1, number: 1 }],
  );
});

Deno.test("sweepPendingSignals: a slot the key has passed, with no claim left to read it, is removed whole", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  // Three claims, each settled; the first two are then removed by a build
  // that does not know pending signals, which leaves their slots behind.
  const claims: WaitKeyClaim[] = [];
  for (let generation = 1; generation <= 3; generation++) {
    const held = await suspendedAtEarlyWait(store, workflow, OPENED);
    await store.settle(
      cancelledOutcome(
        waitRefOf(held.run, held.run.getJob("main")!.getStep("identify")!)!,
        OPENED,
      ),
    );
    claims.push(held.claim);
  }
  await store.removeKeyRecord(claims[0]);
  await store.removeKeyRecord(claims[1]);
  await store.createPendingRecord(pendingFor(workflow, { slot: 1 }));
  await store.createPendingRecord(pendingFor(workflow, { slot: 3 }));
  assertEquals(await sweepPendingSignals(store, IN_TIME), 1);
  assertEquals(
    (await store.listPendingAddresses()).map((at) => at.slot),
    [3],
  );
});

/** `store`, and the names of the methods called on it, in order. */
function recordingCalls(
  store: InMemorySignalWaitStore,
): { store: InMemorySignalWaitStore; calls: string[] } {
  const calls: string[] = [];
  const recording = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return value.apply(target, args);
      };
    },
  });
  return { store: recording, calls };
}

/** A claim of the early key stored at `generation`, as `claimWaitKey` writes one. */
async function storeClaimAt(
  store: InMemorySignalWaitStore,
  workflow: Workflow,
  generation: number,
  early?: { overRelease: boolean },
): Promise<void> {
  const stored = await store.createKeyRecord({
    kind: "claim",
    workflowId: workflow.id,
    key: EARLY_KEY,
    generation,
    recordedAt: OPENED.toISOString(),
    waitId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    jobName: "main",
    stepName: "identify",
    deadline: TOO_LATE.toISOString(),
    ...(early
      ? {
        early: {
          generation,
          overRelease: early.overRelease,
          from: OPENED.toISOString(),
        },
      }
      : {}),
  });
  assertEquals(stored.kind, "found");
}

Deno.test("sweepPendingSignals: slots that hold only a lapse are swept without listing key records, however many keys are claimed", async () => {
  const store = new InMemorySignalWaitStore();
  const retired = earlyWorkflow();
  await store.createPendingRecord(pendingFor(retired));
  assertEquals(await sweepPendingSignals(store, LONG_AFTER), 1);
  // Other workflows hold their keys; none of them has a pending signal.
  for (let other = 0; other < 5; other++) {
    await suspendedAtEarlyWait(store, earlyWorkflow(), OPENED);
  }

  const { store: recording, calls } = recordingCalls(store);
  assertEquals(await sweepPendingSignals(recording, LONG_AFTER), 0);
  assertEquals(await sweepPendingSignals(recording, LONG_AFTER), 0);
  // One listing of the pending signals, then the lapsed slot's own key and
  // its own highest record, on each pass. No other key is read.
  assertEquals(calls, [
    "listPendingAddresses",
    "highestKeyRecord",
    "highestPendingRecord",
    "listPendingAddresses",
    "highestKeyRecord",
    "highestPendingRecord",
  ]);
  assertEquals(
    await store.listPendingAddresses(),
    [{ workflowId: retired.id, key: EARLY_KEY, slot: 1, number: 2 }],
  );
});

Deno.test("sweepPendingSignals: a slot the key has passed is kept for its claim without listing key records", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  // The slot's own claim has no early block: any claim keeps its slot.
  await storeClaimAt(store, workflow, 1);
  await storeClaimAt(store, workflow, 2, { overRelease: false });
  await storeClaimAt(store, workflow, 3, { overRelease: false });
  await store.createPendingRecord(pendingFor(workflow, { slot: 1 }));

  const { store: recording, calls } = recordingCalls(store);
  assertEquals(await sweepPendingSignals(recording, LONG_AFTER), 0);
  assertEquals(calls.includes("listKeyRecords"), false);
  assertEquals((await store.listPendingAddresses()).length, 1);
});

Deno.test("sweepPendingSignals: the claim one generation up keeps a slot only when it was created over a release", async () => {
  for (const overRelease of [true, false]) {
    const store = new InMemorySignalWaitStore();
    const workflow = earlyWorkflow();
    // Generation 1 is gone; 2 is the release a signal wrote its slot under.
    assertEquals(
      (await store.createKeyRecord({
        kind: "release",
        workflowId: workflow.id,
        key: EARLY_KEY,
        generation: 2,
        recordedAt: OPENED.toISOString(),
      })).kind,
      "found",
    );
    await storeClaimAt(store, workflow, 3, { overRelease });
    await storeClaimAt(store, workflow, 4, { overRelease: false });
    await store.createPendingRecord(pendingFor(workflow, { slot: 2 }));

    assertEquals(
      await sweepPendingSignals(store, LONG_AFTER),
      overRelease ? 0 : 1,
    );
    assertEquals(
      (await store.listPendingAddresses()).length,
      overRelease ? 1 : 0,
    );
  }
});

Deno.test("sweepPendingSignals: a slot whose claim cannot be read is left as it is", async () => {
  for (const damaged of [1, 2]) {
    const store = new InMemorySignalWaitStore();
    const workflow = earlyWorkflow();
    for (let generation = 1; generation <= 3; generation++) {
      await storeClaimAt(store, workflow, generation, { overRelease: false });
    }
    // Without the damage neither generation 1 nor 2 would keep slot 1 once
    // generation 1 is gone.
    await store.removeKeyRecord({
      workflowId: workflow.id,
      key: EARLY_KEY,
      generation: 1,
    });
    store.keyRecords.set(
      waitKeyRecordKey({
        workflowId: workflow.id,
        key: EARLY_KEY,
        generation: damaged,
      }),
      new TextEncoder().encode("{"),
    );
    await store.createPendingRecord(pendingFor(workflow, { slot: 1 }));

    assertEquals(await sweepPendingSignals(store, LONG_AFTER), 0);
    assertEquals((await store.listPendingAddresses()).length, 1);
  }
});

Deno.test("sweepWaitRecords: pending signals are swept where run records say nothing about a wait", async () => {
  const store = new InMemorySignalWaitStore();
  const workflow = earlyWorkflow();
  await store.createPendingRecord(pendingFor(workflow));
  const swept = await sweepWaitRecords(
    store,
    () => Promise.resolve(null),
    LONG_AFTER,
  );
  assertEquals(swept, {
    registrations: 0,
    outcomes: 0,
    keyRecords: 0,
    pendingSignals: 1,
  });
});
