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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowSignal,
  type WorkflowSignalDeps,
  type WorkflowSignalEvent,
} from "./signal.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import {
  WorkflowRun,
  type WorkflowRunData,
} from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { SignalWait } from "../../domain/workflows/signal_wait.ts";
import {
  cancelledOutcome,
  registrationOf,
  type StoredWaitRecord,
  type WaitOutcome,
} from "../../domain/workflows/signal_wait_records.ts";
import {
  acceptedOutcomeFor,
  InMemorySignalWaitStore,
} from "../../domain/workflows/signal_wait_store_test_helpers.ts";
import {
  closeRunWaits,
  waitRefOf,
} from "../../domain/workflows/signal_wait_cleanup.ts";
import { cancelAndSettle } from "../../domain/workflows/abort_settlement.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";

const OPENED = new Date("2026-01-01T00:00:00.000Z");
const IN_TIME = new Date("2026-01-01T00:00:30.000Z");
const TOO_LATE = new Date("2026-01-01T00:02:00.000Z");

const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

function makeWorkflow(name = "release"): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(60, SCHEMA),
          }),
          Step.create({
            name: "sibling",
            task: StepTask.model("worker", "run"),
          }),
        ],
      }),
    ],
  });
}

/** A run suspended with `review` waiting for a signal and `sibling` done. */
function suspendedAtWait(workflow: Workflow): {
  run: WorkflowRun;
  waitId: string;
} {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const review = job.getStep("review")!;
  review.start();
  const wait = SignalWait.open(SCHEMA, 60, OPENED);
  review.waitForSignal(wait);
  job.getStep("sibling")!.succeed();
  run.suspend();
  return { run, waitId: wait.id };
}

interface Fixture {
  deps: WorkflowSignalDeps;
  waits: InMemorySignalWaitStore;
  /** The run records as stored. A signal has no way to change them. */
  stored: Map<string, WorkflowRunData>;
  /** Reads made of the run repository, in order. */
  calls: string[];
}

/**
 * A repository holding `runs` as stored records, with no way to save, and a
 * wait store holding the registration of every wait those runs hold, as
 * the executor leaves it. `registered: false` leaves the store empty, as a
 * run suspended before waits were registered.
 */
async function fixtureOf(
  runs: WorkflowRun[],
  options: {
    now?: Date;
    registered?: boolean;
    waits?: InMemorySignalWaitStore;
  } = {},
): Promise<Fixture> {
  const stored = new Map<string, WorkflowRunData>(
    runs.map((run) => [run.id, run.toData()]),
  );
  const waits = options.waits ?? new InMemorySignalWaitStore();
  if (options.registered !== false) {
    for (const run of runs) {
      for (const ref of run.findSignalWaits()) {
        if (!ref.wait) continue;
        await waits.register(
          registrationOf(
            {
              workflowId: run.workflowId,
              workflowName: run.workflowName,
              runId: run.id,
              jobName: ref.jobName,
              stepName: ref.stepName,
            },
            ref.wait,
            OPENED,
          ),
        );
      }
    }
  }
  const calls: string[] = [];
  const all = () =>
    [...stored.values()].map((data) => ({
      run: WorkflowRun.fromData(data),
      workflowId: createWorkflowId(data.workflowId),
    }));
  return {
    waits,
    stored,
    calls,
    deps: {
      now: () => options.now ?? IN_TIME,
      signalWaits: { supported: true, store: waits },
      runRepo: {
        findById: (_workflowId: WorkflowId, runId: string) => {
          calls.push(`findById:${runId}`);
          const data = stored.get(runId);
          return Promise.resolve(data ? WorkflowRun.fromData(data) : null);
        },
        findGlobalByStatus: (status: string | string[]) => {
          calls.push("findGlobalByStatus");
          const wanted = Array.isArray(status) ? status : [status];
          return Promise.resolve(
            all().filter(({ run }) => wanted.includes(run.status)),
          );
        },
        findAllGlobal: () => {
          calls.push("findAllGlobal");
          return Promise.resolve(all());
        },
      } as unknown as WorkflowSignalDeps["runRepo"],
    },
  };
}

async function send(
  fixture: Pick<Fixture, "deps">,
  waitId: string,
  payload: unknown,
): Promise<WorkflowSignalEvent> {
  const events = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), fixture.deps, {
      waitId,
      payload,
      // No letter of it is a hex digit, so no UUID in a message holds it.
      submittedBy: "tux",
    }),
  );
  assertEquals(events[0], { kind: "resolving" });
  return events.at(-1)!;
}

function errorOf(
  event: WorkflowSignalEvent,
): { code: string; message: string } {
  assert(event.kind === "error", `expected a refusal, got ${event.kind}`);
  return event.error;
}

async function outcomeOf(
  fixture: Fixture,
  waitId: string,
): Promise<WaitOutcome | undefined> {
  const stored = await fixture.waits.findOutcome(waitId);
  return stored.kind === "found" ? stored.record : undefined;
}

Deno.test("workflowSignal: a valid payload creates the wait's outcome, reports the receipt and leaves the run record alone", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);
  const before = structuredClone(fixture.stored.get(run.id));

  const event = await send(fixture, waitId, { verdict: "ship" });

  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.waitId, waitId);
  assertEquals(event.data.workflowId, workflow.id);
  assertEquals(event.data.workflowName, "release");
  assertEquals(event.data.runId, run.id);
  assertEquals(event.data.jobName, "main");
  assertEquals(event.data.stepName, "review");
  assertEquals(event.data.signal.waitId, waitId);
  assertEquals(event.data.signal.submittedBy, "tux");
  assertEquals(event.data.signal.receivedAt, IN_TIME.toISOString());
  assertEquals(event.data.awaitingResume, true);
  assertEquals(
    event.data.resumeCommand,
    `swamp workflow resume release --run ${run.id}`,
  );

  const outcome = await outcomeOf(fixture, waitId);
  assert(outcome?.kind === "accepted");
  assertEquals(outcome.receipt, event.data.signal);
  assertEquals(outcome.payload, { verdict: "ship" });
  assertEquals(outcome.runId, run.id);
  // The step still waits in the record: only a resume applies the outcome.
  assertEquals(fixture.stored.get(run.id), before);
});

Deno.test("workflowSignal: a registered wait is delivered without reading a run record for the decision", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run]);
  // The run is not on this host at all, as on a second host of a shared
  // datastore that has not synced it yet.
  fixture.stored.clear();

  const event = await send(fixture, waitId, { verdict: "ship" });

  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.workflowName, "release");
  assertEquals(event.data.stepName, "review");
  // Whether the run can resume is not known here.
  assertEquals(event.data.awaitingResume, false);
  assertEquals((await outcomeOf(fixture, waitId))?.kind, "accepted");
  assertEquals(fixture.calls.includes("findAllGlobal"), false);
  assertEquals(fixture.calls.includes("findGlobalByStatus"), false);
});

Deno.test("workflowSignal: a signal is accepted while the owner still runs the level, whatever the run record says", async () => {
  for (const status of ["running", "suspended"] as const) {
    const { run, waitId } = suspendedAtWait(makeWorkflow());
    const data = run.toData();
    data.status = status;
    const sibling = data.jobs[0].steps.find((s) => s.stepName === "sibling")!;
    sibling.status = "running";
    sibling.completedAt = undefined;
    const fixture = await fixtureOf([WorkflowRun.fromData(data)]);

    const event = await send(fixture, waitId, { verdict: "ship" });

    assert(event.kind === "completed", JSON.stringify(event));
    assertEquals((await outcomeOf(fixture, waitId))?.kind, "accepted");
  }
});

Deno.test("workflowSignal: an id nothing issued is not found, and one that is not a UUID never reaches a store", async () => {
  const { run } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run]);

  const unknown = errorOf(
    await send(fixture, crypto.randomUUID(), { verdict: "ship" }),
  );
  assertEquals(unknown.code, "not_found");

  fixture.calls.length = 0;
  for (
    const typed of ["", "   ", "../../etc/passwd", "waits/x", "not-a-uuid"]
  ) {
    assertEquals(
      errorOf(await send(fixture, typed, { verdict: "ship" })).code,
      "not_found",
    );
  }
  assertEquals(fixture.calls, []);
  assertEquals(fixture.waits.outcomes.size, 0);
});

Deno.test("workflowSignal: the wait id matches whatever its letter case", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run]);

  const event = await send(fixture, ` ${waitId.toUpperCase()} `, {
    verdict: "ship",
  });

  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.waitId, waitId);
});

Deno.test("workflowSignal: an invalid payload is refused with its errors and the wait stays open", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run]);

  const refused = await send(fixture, waitId, { verdict: "maybe" });

  const error = errorOf(refused);
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "the wait stays open");
  assertStringIncludes(error.message, "verdict");
  assertEquals(await outcomeOf(fixture, waitId), undefined);
  // The same wait still takes a valid payload.
  assertEquals(
    (await send(fixture, waitId, { verdict: "fix" })).kind,
    "completed",
  );
});

Deno.test("workflowSignal: a wait past its deadline is refused, settled as timed out and names the resume", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run], { now: TOO_LATE });

  const error = errorOf(await send(fixture, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "expired at");
  assertStringIncludes(error.message, "wait_timeout");
  assertStringIncludes(
    error.message,
    `swamp workflow resume release --run ${run.id}`,
  );
  // The deadline is decided by the create, so every later reader agrees.
  assertEquals((await outcomeOf(fixture, waitId))?.kind, "timed_out");
});

Deno.test("workflowSignal: a settled wait refuses a second signal with the stored receipt", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run]);
  const first = await send(fixture, waitId, { verdict: "ship" });
  assert(first.kind === "completed");

  const again = await send(fixture, waitId, { verdict: "fix" });

  const error = errorOf(again);
  assertStringIncludes(error.message, "already settled");
  assertStringIncludes(error.message, first.data.signal.id);
  const stored = await outcomeOf(fixture, waitId);
  assert(stored?.kind === "accepted");
  assertEquals(stored.payload, { verdict: "ship" });
});

Deno.test("workflowSignal: after the run ended the kept outcome still answers, with or without the run record", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);
  const first = await send(fixture, waitId, { verdict: "ship" });
  assert(first.kind === "completed");
  // The run ends: its registration is removed and its outcome kept.
  await closeRunWaits(fixture.waits, run, IN_TIME);
  assertEquals(fixture.waits.registrations.size, 0);

  const withRun = errorOf(await send(fixture, waitId, { verdict: "fix" }));
  assertStringIncludes(withRun.message, "already settled");
  assertStringIncludes(withRun.message, 'step "review"');

  fixture.stored.clear();
  const withoutRun = errorOf(await send(fixture, waitId, { verdict: "fix" }));
  assertStringIncludes(withoutRun.message, "already settled");
  assertStringIncludes(withoutRun.message, first.data.signal.id);
});

Deno.test("workflowSignal: the wait of a cancelled run is closed", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);
  // A cancel closes the run's waits before it saves the run.
  await closeRunWaits(fixture.waits, run, IN_TIME);
  cancelAndSettle(run, workflow, "operator");
  fixture.stored.set(run.id, run.toData());

  const error = errorOf(await send(fixture, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "is closed");
  assertEquals((await outcomeOf(fixture, waitId))?.kind, "cancelled");
});

/** A store in which something else settles the wait just before a signal. */
class RacedStore extends InMemorySignalWaitStore {
  constructor(private readonly winner: (outcome: WaitOutcome) => WaitOutcome) {
    super();
  }

  override async settle(
    outcome: WaitOutcome,
  ): Promise<StoredWaitRecord<WaitOutcome>> {
    await super.settle(this.winner(outcome));
    return await super.settle(outcome);
  }
}

Deno.test("workflowSignal: a signal that loses the create to a cancel, a timeout or another signal is answered from what is stored", async () => {
  const cases: Array<[(outcome: WaitOutcome) => WaitOutcome, string]> = [
    [(o) => cancelledOutcome(o, IN_TIME), "is closed"],
    [
      (o) => ({ ...cancelledOutcome(o, IN_TIME), kind: "timed_out" }),
      "expired",
    ],
    [
      (o) =>
        acceptedOutcomeFor(
          { id: o.waitId, deadline: new Date(o.deadline) },
          { verdict: "fix" },
          { runId: o.runId, submittedBy: "zzz" },
        ),
      "already settled",
    ],
  ];
  for (const [winner, expected] of cases) {
    const { run, waitId } = suspendedAtWait(makeWorkflow());
    const waits = new RacedStore(winner);
    const fixture = await fixtureOf([run], { waits });

    const error = errorOf(await send(fixture, waitId, { verdict: "ship" }));

    assertStringIncludes(error.message, expected);
    // Exactly one outcome, and it is the winner's.
    assertEquals(waits.outcomes.size, 1);
    const stored = await outcomeOf(fixture, waitId);
    assert(stored);
    if (stored.kind === "accepted") {
      assertEquals(stored.payload, { verdict: "fix" });
    }
  }
});

Deno.test("workflowSignal: a wait of a run suspended before waits were registered is registered from its record and takes the signal", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  // As swamp-club#3068 stored it: status `waiting`, no registration.
  const data = run.toData();
  data.jobs[0].steps.find((s) => s.stepName === "review")!.status = "waiting";
  const fixture = await fixtureOf([WorkflowRun.fromData(data)], {
    registered: false,
  });
  const before = structuredClone(fixture.stored.get(run.id));

  const event = await send(fixture, waitId, { verdict: "ship" });

  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.stepName, "review");
  const registration = await fixture.waits.findRegistration(waitId);
  assert(registration.kind === "found");
  assertEquals(registration.record.runId, run.id);
  assertEquals(registration.record.schema, SCHEMA);
  assertEquals((await outcomeOf(fixture, waitId))?.kind, "accepted");
  assertEquals(fixture.stored.get(run.id), before);

  assertStringIncludes(
    errorOf(await send(fixture, waitId, { verdict: "fix" })).message,
    "already settled",
  );
});

Deno.test("workflowSignal: a wait an earlier build settled in the run record is answered from that record", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const review = run.getJob("main")!.getStep("review")!;
  const settled = acceptedOutcomeFor(review.signalWait!, { verdict: "ship" });
  review.applyWaitOutcome(settled);
  const fixture = await fixtureOf([run], { registered: false });

  const again = await send(fixture, waitId, { verdict: "fix" });

  assert(again.kind === "error");
  assertStringIncludes(again.error.message, "already settled");
  assertEquals(
    (again.error.details as { receipt: unknown }).receipt,
    settled.receipt,
  );
  // Nothing was registered or settled for a wait that is over.
  assertEquals(fixture.waits.registrations.size, 0);
  assertEquals(fixture.waits.outcomes.size, 0);
});

Deno.test("workflowSignal: a step that no longer waits, with no outcome, is closed", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  cancelAndSettle(run, workflow, "operator");
  const fixture = await fixtureOf([run], { registered: false });

  const error = errorOf(await send(fixture, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "is closed");
  assertStringIncludes(error.message, "cancelled");
  assertEquals(fixture.waits.registrations.size, 0);
});

Deno.test("workflowSignal: a registration that cannot be read is rebuilt from the run record, and the signal is delivered", async () => {
  for (const damaged of [new Uint8Array(), new TextEncoder().encode("{no")]) {
    const { run, waitId } = suspendedAtWait(makeWorkflow());
    const fixture = await fixtureOf([run]);
    fixture.waits.registrations.set(waitId, damaged);

    const event = await send(fixture, waitId, { verdict: "ship" });

    assert(event.kind === "completed", JSON.stringify(event));
    const registration = await fixture.waits.findRegistration(waitId);
    assert(registration.kind === "found");
    assertEquals(registration.record.stepName, "review");
    assertEquals((await outcomeOf(fixture, waitId))?.kind, "accepted");
  }
});

Deno.test("workflowSignal: a record that cannot be read, with nothing to rebuild it from, is refused and never treated as an open wait", async () => {
  const garbage = new TextEncoder().encode("{not json");

  // The run record is not on this host, so the wait cannot be rebuilt.
  const first = suspendedAtWait(makeWorkflow());
  const badRegistration = await fixtureOf([first.run]);
  badRegistration.waits.registrations.set(first.waitId, garbage);
  badRegistration.stored.clear();
  assertStringIncludes(
    errorOf(await send(badRegistration, first.waitId, { verdict: "ship" }))
      .message,
    "cannot be read",
  );
  assertEquals(badRegistration.waits.outcomes.size, 0);
  assertEquals(badRegistration.waits.registrations.get(first.waitId), garbage);

  const second = suspendedAtWait(makeWorkflow());
  const badOutcome = await fixtureOf([second.run]);
  badOutcome.waits.outcomes.set(second.waitId, garbage);
  assertStringIncludes(
    errorOf(await send(badOutcome, second.waitId, { verdict: "ship" })).message,
    "cannot be read",
  );
  assertEquals(badOutcome.waits.outcomes.get(second.waitId), garbage);
});

Deno.test("workflowSignal: a registered wait whose step the run record shows already past it is answered from the record, not accepted", async () => {
  const workflow = makeWorkflow();

  // Settled in the run record by a build that writes it directly.
  const settled = suspendedAtWait(workflow);
  const settledFixture = await fixtureOf([settled.run]);
  const review = settled.run.getJob("main")!.getStep("review")!;
  const earlier = acceptedOutcomeFor(review.signalWait!, { verdict: "ship" });
  review.applyWaitOutcome(earlier);
  settledFixture.stored.set(settled.run.id, settled.run.toData());

  const again = await send(settledFixture, settled.waitId, { verdict: "fix" });
  assert(again.kind === "error");
  assertStringIncludes(again.error.message, "already settled");
  assertEquals(
    (again.error.details as { receipt: unknown }).receipt,
    earlier.receipt,
  );
  assertEquals(settledFixture.waits.outcomes.size, 0);

  // Cancelled by a writer that did not close the wait.
  const cancelled = suspendedAtWait(workflow);
  const cancelledFixture = await fixtureOf([cancelled.run]);
  cancelAndSettle(cancelled.run, workflow, "operator");
  cancelledFixture.stored.set(cancelled.run.id, cancelled.run.toData());

  const closed = errorOf(
    await send(cancelledFixture, cancelled.waitId, { verdict: "ship" }),
  );
  assertStringIncludes(closed.message, "is closed");
  assertEquals(cancelledFixture.waits.outcomes.size, 0);
});

Deno.test("workflowSignal: a datastore that cannot hold wait records refuses with the reason", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run]);
  fixture.deps.signalWaits = {
    supported: false,
    reason: "the store is local to this machine",
  };

  const error = errorOf(await send(fixture, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "the store is local to this machine");
  assertEquals(fixture.waits.outcomes.size, 0);
});

Deno.test("workflowSignal: the refusals are distinct messages", async () => {
  const workflow = makeWorkflow();
  const messages: string[] = [];

  const open = suspendedAtWait(workflow);
  messages.push(
    errorOf(await send(await fixtureOf([open.run]), open.waitId, {})).message
      .split("\n")[0],
  );
  const late = suspendedAtWait(workflow);
  messages.push(
    errorOf(
      await send(
        await fixtureOf([late.run], { now: TOO_LATE }),
        late.waitId,
        { verdict: "ship" },
      ),
    ).message,
  );
  const twice = suspendedAtWait(workflow);
  const twiceFixture = await fixtureOf([twice.run]);
  await send(twiceFixture, twice.waitId, { verdict: "ship" });
  messages.push(
    errorOf(await send(twiceFixture, twice.waitId, { verdict: "ship" }))
      .message,
  );
  const closed = suspendedAtWait(workflow);
  const closedFixture = await fixtureOf([closed.run]);
  await closeRunWaits(closedFixture.waits, closed.run, IN_TIME);
  messages.push(
    errorOf(await send(closedFixture, closed.waitId, { verdict: "ship" }))
      .message,
  );
  messages.push(
    errorOf(
      await send(await fixtureOf([]), crypto.randomUUID(), { verdict: "ship" }),
    ).message,
  );

  const kinds = messages.map((message) =>
    message.replace(/[0-9a-f-]{36}/g, "<id>").split(":")[0]
  );
  assertEquals(new Set(kinds).size, kinds.length, kinds.join(" | "));
});

/** A workflow with two waits in one job, and a run suspended on both. */
function suspendedAtTwoWaits(): {
  run: WorkflowRun;
  first: string;
  second: string;
} {
  const workflow = Workflow.create({
    name: "two",
    jobs: [
      Job.create({
        name: "main",
        steps: ["a", "b"].map((name) =>
          Step.create({ name, task: StepTask.waitForSignal(60, SCHEMA) })
        ),
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const ids = ["a", "b"].map((name) => {
    const step = job.getStep(name)!;
    step.start();
    const wait = SignalWait.open(SCHEMA, 60, OPENED);
    step.waitForSignal(wait);
    return wait.id;
  });
  run.suspend();
  return { run, first: ids[0], second: ids[1] };
}

Deno.test("workflowSignal: a run with a second open wait is awaiting resume only once that wait has an outcome too", async () => {
  const { run, first, second } = suspendedAtTwoWaits();
  const fixture = await fixtureOf([run]);

  const one = await send(fixture, first, { verdict: "ship" });
  assert(one.kind === "completed", JSON.stringify(one));
  assertEquals(one.data.awaitingResume, false);

  const two = await send(fixture, second, { verdict: "fix" });
  assert(two.kind === "completed", JSON.stringify(two));
  assertEquals(two.data.awaitingResume, true);
});

Deno.test("workflowSignal: a run whose other wait timed out is awaiting resume, as the resume fails that step", async () => {
  const { run, first, second } = suspendedAtTwoWaits();
  const fixture = await fixtureOf([run]);
  const other = run.getJob("main")!.getStep("b")!;
  await fixture.waits.settle({
    ...cancelledOutcome(waitRefOf(run, other)!, IN_TIME),
    kind: "timed_out",
  });
  assertEquals((await outcomeOf(fixture, second))?.kind, "timed_out");

  const event = await send(fixture, first, { verdict: "ship" });

  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.awaitingResume, true);
});

Deno.test("workflowSignal: an empty sender falls back, so the receipt names one", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run]);

  const events = await withMockedEnv(
    { USER: "", USERNAME: undefined },
    () =>
      collect<WorkflowSignalEvent>(
        workflowSignal(createLibSwampContext(), fixture.deps, {
          waitId,
          payload: { verdict: "ship" },
        }),
      ),
  );

  const event = events.at(-1)!;
  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.signal.submittedBy, "unknown");
  // The stored outcome reads back with its receipt intact.
  const stored = await outcomeOf(fixture, waitId);
  assert(stored?.kind === "accepted");
  assertEquals(stored.receipt.submittedBy, "unknown");
});

Deno.test("workflowSignal: every refusal names the wait id exactly as typed", async () => {
  const workflow = makeWorkflow();
  const typed = (waitId: string) => ` ${waitId.toUpperCase()}  `;
  const refusals: Array<() => Promise<{ message: string; typedId: string }>> = [
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const event = await send(await fixtureOf([run]), typed(waitId), {
        verdict: 1,
      });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const event = await send(
        await fixtureOf([run], { now: TOO_LATE }),
        typed(waitId),
        { verdict: "ship" },
      );
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const fixture = await fixtureOf([run]);
      await send(fixture, waitId, { verdict: "ship" });
      const event = await send(fixture, typed(waitId), { verdict: "ship" });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const fixture = await fixtureOf([run]);
      await closeRunWaits(fixture.waits, run, IN_TIME);
      const event = await send(fixture, typed(waitId), { verdict: "ship" });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      cancelAndSettle(run, workflow, "operator");
      const event = await send(
        await fixtureOf([run], { registered: false }),
        typed(waitId),
        { verdict: "ship" },
      );
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const fixture = await fixtureOf([run]);
      fixture.waits.registrations.set(waitId, new Uint8Array([1]));
      fixture.stored.clear();
      const event = await send(fixture, typed(waitId), { verdict: "ship" });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run } = suspendedAtWait(workflow);
      const unknown = typed(crypto.randomUUID());
      const event = await send(await fixtureOf([run]), unknown, {
        verdict: "ship",
      });
      return { message: errorOf(event).message, typedId: unknown };
    },
  ];
  for (const refusal of refusals) {
    const { message, typedId } = await refusal();
    const firstLine = message.split("\n")[0];
    assertStringIncludes(firstLine, typedId);
    // The normalised form, which telemetry would not recognise, is absent.
    assertEquals(
      firstLine.includes(typedId.trim().toLowerCase()),
      false,
      firstLine,
    );
  }
});

Deno.test("workflowSignal: the already-settled message names no person; the receipt stays in the details", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run]);
  const first = await send(fixture, waitId, { verdict: "ship" });
  assert(first.kind === "completed");

  const again = await send(fixture, waitId, { verdict: "fix" });

  assert(again.kind === "error");
  assertEquals(again.error.message.includes("tux"), false);
  assertEquals(
    again.error.message.includes(first.data.signal.receivedAt),
    false,
  );
  assertEquals(
    (again.error.details as { receipt: unknown }).receipt,
    first.data.signal,
  );
});
