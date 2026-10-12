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
import { outcomeAt } from "../../domain/workflows/signal_wait_cleanup.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import {
  signalLastWait,
  signalRefusalKind,
  type SignalWaitSubject,
  workflowSignal,
  type WorkflowSignalDeps,
  type WorkflowSignalEvent,
  type WorkflowSignalInput,
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
  takePendingSignalsOfRun,
  waitRefOf,
} from "../../domain/workflows/signal_wait_cleanup.ts";
import { cancelAndSettle } from "../../domain/workflows/abort_settlement.ts";
import {
  claimWaitKey,
  type WaitKeyClaim,
  waitKeyRecordKey,
  waitRefOfClaim,
} from "../../domain/workflows/wait_key_claim.ts";
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
    /** The workflows a signal by key can name. */
    workflows?: Workflow[];
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
      findWorkflow: (idOrName: string) =>
        Promise.resolve(
          (options.workflows ?? []).find((workflow) =>
            workflow.name === idOrName || workflow.id === idOrName
          ) ?? null,
        ),
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
  idempotencyKey?: string,
): Promise<WorkflowSignalEvent> {
  const events = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), fixture.deps, {
      waitId,
      payload,
      // No letter of it is a hex digit, so no UUID in a message holds it.
      submittedBy: "tux",
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
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
  assertEquals(event.data.runRecordAvailable, true);
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
  // Whether the run can resume is not known here, and the result says so.
  assertEquals(event.data.awaitingResume, false);
  assertEquals(event.data.runRecordAvailable, false);
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

  assertStringIncludes(error.message, "closed before a signal arrived");
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
    [(o) => cancelledOutcome(o, IN_TIME), "closed before a signal arrived"],
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

Deno.test("workflowSignal: names read from a wait record are printed without control characters", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const fixture = await fixtureOf([run], { now: TOO_LATE });
  const stored = await fixture.waits.findRegistration(waitId);
  assert(stored.kind === "found");
  await fixture.waits.removeRegistration(waitId);
  // As a writer of the datastore could leave it.
  await fixture.waits.register({
    ...stored.record,
    stepName: "review\u001b[2J",
    workflowName: "release\u0007",
  });
  fixture.stored.clear();

  const error = errorOf(await send(fixture, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, 'step "review?[2J"');
  assertStringIncludes(error.message, 'workflow "release?"');
  // deno-lint-ignore no-control-regex
  assertEquals(/[\u0000-\u001f]/.test(error.message), false);
});

// --- refusal kinds, the authorization hook and the run-record scan ---

/** Sends a signal with an `authorize` hook that records what it was asked. */
async function sendAuthorized(
  fixture: Pick<Fixture, "deps">,
  waitId: string,
  payload: unknown,
  allow: boolean,
): Promise<{ event: WorkflowSignalEvent; asked: SignalWaitSubject[] }> {
  const asked: SignalWaitSubject[] = [];
  const authorize: WorkflowSignalInput["authorize"] = (wait) => {
    asked.push(wait);
    return Promise.resolve(allow);
  };
  const events = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), fixture.deps, {
      waitId,
      payload,
      submittedBy: "tux",
      authorize,
    }),
  );
  return { event: events.at(-1)!, asked };
}

function kindOf(event: WorkflowSignalEvent): string | undefined {
  assert(event.kind === "error", `expected a refusal, got ${event.kind}`);
  return signalRefusalKind(event.error);
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

Deno.test("workflowSignal: every refusal carries its kind", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);

  const open = await fixtureOf([run]);
  assertEquals(kindOf(await send(open, UNKNOWN_ID, {})), "unknown");
  assertEquals(kindOf(await send(open, "not-a-uuid", {})), "unknown");
  assertEquals(
    kindOf(await send(open, waitId, { verdict: "maybe" })),
    "invalid_payload",
  );
  assertEquals(
    (await send(open, waitId, { verdict: "ship" })).kind,
    "completed",
  );
  assertEquals(
    kindOf(await send(open, waitId, { verdict: "fix" })),
    "already_settled",
  );

  const late = await fixtureOf([run], { now: TOO_LATE });
  assertEquals(
    kindOf(await send(late, waitId, { verdict: "ship" })),
    "expired",
  );

  const closed = await fixtureOf([run]);
  await closed.waits.settle(
    cancelledOutcome(
      waitRefOf(run, run.getJob("main")!.getStep("review")!)!,
      IN_TIME,
    ),
  );
  assertEquals(
    kindOf(await send(closed, waitId, { verdict: "ship" })),
    "closed",
  );

  const unsupported = await fixtureOf([run]);
  unsupported.deps.signalWaits = { supported: false, reason: "no store" };
  assertEquals(
    kindOf(await send(unsupported, waitId, { verdict: "ship" })),
    "unsupported",
  );
});

Deno.test("workflowSignal: authorize is asked with the wait's place and the run's recorded workflow", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);

  const { event, asked } = await sendAuthorized(
    fixture,
    waitId,
    { verdict: "ship" },
    true,
  );

  assertEquals(event.kind, "completed");
  assertEquals(asked, [{
    waitId,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    runId: run.id,
    runWorkflow: {
      workflowId: run.workflowId,
      workflowName: run.workflowName,
    },
  }]);
});

Deno.test("workflowSignal: authorize gets no run workflow when this host has no run record", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);
  fixture.stored.clear();

  const { event, asked } = await sendAuthorized(
    fixture,
    waitId,
    { verdict: "ship" },
    true,
  );

  assertEquals(event.kind, "completed");
  assertEquals(asked.length, 1);
  assertEquals(asked[0].runWorkflow, undefined);
});

Deno.test("workflowSignal: a refused caller gets the unknown answer and nothing is stored", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);
  const unknown = errorOf(await send(fixture, UNKNOWN_ID, { verdict: "ship" }));

  for (
    const payload of [
      { verdict: "ship" },
      { verdict: "maybe" },
      "not an object",
    ]
  ) {
    const { event } = await sendAuthorized(fixture, waitId, payload, false);
    const refusal = errorOf(event);
    assertEquals(refusal.code, unknown.code);
    assertEquals(
      refusal.message,
      unknown.message.replace(UNKNOWN_ID, waitId),
    );
    assertEquals(kindOf(event), "unknown");
  }
  assertEquals((await fixture.waits.findOutcome(waitId)).kind, "absent");
});

Deno.test("workflowSignal: a refused caller learns nothing of a settled, expired or closed wait", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);

  const settled = await fixtureOf([run]);
  await send(settled, waitId, { verdict: "ship" });
  const late = await fixtureOf([run], { now: TOO_LATE });
  const closed = await fixtureOf([run]);
  await closed.waits.settle(
    cancelledOutcome(
      waitRefOf(run, run.getJob("main")!.getStep("review")!)!,
      IN_TIME,
    ),
  );

  for (const fixture of [settled, late, closed]) {
    const { event } = await sendAuthorized(
      fixture,
      waitId,
      { verdict: "ship" },
      false,
    );
    assertEquals(kindOf(event), "unknown");
    const { message } = errorOf(event);
    assertEquals(message.includes(run.id), false);
    assertEquals(message.includes(workflow.name), false);
    assertEquals(message.includes("review"), false);
  }
  // The refused attempt on the expired wait did not settle it either.
  assertEquals((await late.waits.findOutcome(waitId)).kind, "absent");
});

Deno.test("workflowSignal: authorize is asked before an unregistered wait is registered", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run], { registered: false });

  const refused = await sendAuthorized(
    fixture,
    waitId,
    { verdict: "ship" },
    false,
  );
  assertEquals(kindOf(refused.event), "unknown");
  assertEquals(refused.asked.length, 1);
  assertEquals(refused.asked[0].runWorkflow?.workflowName, workflow.name);
  assertEquals((await fixture.waits.findRegistration(waitId)).kind, "absent");

  const allowed = await sendAuthorized(
    fixture,
    waitId,
    { verdict: "ship" },
    true,
  );
  assertEquals(allowed.event.kind, "completed");
  // Asked once: the run record placed the wait and was the run it named.
  assertEquals(allowed.asked.length, 1);
  assertEquals((await fixture.waits.findRegistration(waitId)).kind, "found");
});

Deno.test("workflowSignal: with only an outcome left, authorize is asked with the workflow the run recorded", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);
  fixture.deps.scanRunRecords = false;
  await send(fixture, waitId, { verdict: "ship" });
  // The run ended and its registration was removed; the run record is kept.
  await fixture.waits.removeRegistration(waitId);

  const refused = await sendAuthorized(
    fixture,
    waitId,
    { verdict: "fix" },
    false,
  );
  assertEquals(kindOf(refused.event), "unknown");
  assertEquals(refused.asked, [{
    waitId,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    runId: run.id,
    runWorkflow: {
      workflowId: run.workflowId,
      workflowName: run.workflowName,
    },
  }]);
  assertEquals(fixture.calls.includes("findAllGlobal"), false);
  assertEquals(fixture.calls.includes("findGlobalByStatus"), false);
});

Deno.test("workflowSignal: with only an outcome left and no run record, authorize is asked by workflow id", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);
  await send(fixture, waitId, { verdict: "ship" });
  // The run ended and its registration was removed; this host lost the run.
  await fixture.waits.removeRegistration(waitId);
  fixture.stored.clear();

  const refused = await sendAuthorized(
    fixture,
    waitId,
    { verdict: "fix" },
    false,
  );
  assertEquals(kindOf(refused.event), "unknown");
  assertEquals(refused.asked, [{
    waitId,
    workflowId: run.workflowId,
    runId: run.id,
  }]);

  const allowed = await sendAuthorized(
    fixture,
    waitId,
    { verdict: "fix" },
    true,
  );
  assertEquals(kindOf(allowed.event), "already_settled");
});

Deno.test("workflowSignal: with the scan off an unregistered wait is unknown and no run is read", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run], { registered: false });
  fixture.deps.scanRunRecords = false;

  const event = await send(fixture, waitId, { verdict: "ship" });

  assertEquals(kindOf(event), "unknown");
  assertEquals(fixture.calls, []);
  assertEquals((await fixture.waits.findRegistration(waitId)).kind, "absent");
});

Deno.test("workflowSignal: with the scan off a registered wait is delivered as before", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const fixture = await fixtureOf([run]);
  fixture.deps.scanRunRecords = false;

  const event = await send(fixture, waitId, { verdict: "ship" });

  assertEquals(event.kind, "completed");
  assertEquals(fixture.calls.includes("findAllGlobal"), false);
  assertEquals(fixture.calls.includes("findGlobalByStatus"), false);
});

// A signal addressed by workflow and key (swamp-club#3210).

const KEY = "release-verdict";

function keyedWorkflow(name = "release", key = KEY): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(60, SCHEMA, key),
          }),
        ],
      }),
    ],
  });
}

/** A run suspended at its keyed wait, with the wait's claim on the key. */
async function suspendedHoldingKey(
  workflow: Workflow,
  waits: InMemorySignalWaitStore,
  key = KEY,
): Promise<{ run: WorkflowRun; waitId: string; claim: WaitKeyClaim }> {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const review = job.getStep("review")!;
  review.start();
  const wait = SignalWait.open(SCHEMA, 60, OPENED, undefined, key);
  const claimed = await claimWaitKey(waits, {
    workflowId: workflow.id,
    key,
    waitId: wait.id,
    runId: run.id,
    jobName: "main",
    stepName: "review",
    deadline: wait.deadline.toISOString(),
  }, OPENED);
  assert(claimed.kind === "acquired", `got ${claimed.kind}`);
  review.waitForSignal(wait);
  run.suspend();
  return { run, waitId: wait.id, claim: claimed.claim };
}

async function keyedFixture(
  options: { now?: Date } = {},
): Promise<
  Fixture & {
    workflow: Workflow;
    run: WorkflowRun;
    waitId: string;
    claim: WaitKeyClaim;
  }
> {
  const workflow = keyedWorkflow();
  const waits = new InMemorySignalWaitStore();
  const held = await suspendedHoldingKey(workflow, waits);
  const fixture = await fixtureOf([held.run], {
    waits,
    workflows: [workflow],
    now: options.now,
  });
  return { ...fixture, workflow, ...held };
}

async function sendByKey(
  fixture: Pick<Fixture, "deps">,
  workflow: string,
  key: string,
  payload: unknown,
  idempotencyKey?: string,
): Promise<WorkflowSignalEvent> {
  const events = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), fixture.deps, {
      workflow,
      key,
      payload,
      submittedBy: "tux",
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    }),
  );
  assertEquals(events[0], { kind: "resolving" });
  return events.at(-1)!;
}

function refusalOf(event: WorkflowSignalEvent) {
  assert(event.kind === "error", `expected a refusal, got ${event.kind}`);
  return {
    kind: signalRefusalKind(event.error),
    code: event.error.code,
    message: event.error.message,
    details: event.error.details as Record<string, unknown>,
    lastWait: signalLastWait(event.error),
  };
}

Deno.test("workflowSignal: a signal by workflow and key reaches the holder and names the wait that took it", async () => {
  const fixture = await keyedFixture();
  const before = structuredClone(fixture.stored.get(fixture.run.id));
  const keyRecords = new Map(fixture.waits.keyRecords);

  const event = await sendByKey(fixture, "release", KEY, { verdict: "ship" });

  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.waitId, fixture.waitId);
  assertEquals(event.data.key, KEY);
  assertEquals(event.data.runId, fixture.run.id);
  assertEquals(event.data.stepName, "review");
  assertEquals(event.data.signal.waitId, fixture.waitId);
  const outcome = await outcomeOf(fixture, fixture.waitId);
  assert(outcome?.kind === "accepted");
  assertEquals(outcome.payload, { verdict: "ship" });
  assertEquals(outcome.receipt, event.data.signal);
  // Neither the run record nor a key record is written.
  assertEquals(fixture.stored.get(fixture.run.id), before);
  assertEquals(fixture.waits.keyRecords, keyRecords);
});

Deno.test("workflowSignal: the workflow of a key address may be given by ID", async () => {
  const fixture = await keyedFixture();
  const event = await sendByKey(fixture, fixture.workflow.id, KEY, {
    verdict: "fix",
  });
  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.waitId, fixture.waitId);
});

Deno.test("workflowSignal: a signal by wait ID to a keyed wait is delivered as before and reports the key", async () => {
  const fixture = await keyedFixture();
  const event = await send(fixture, fixture.waitId, { verdict: "ship" });
  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.key, KEY);

  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const unkeyed = await send(await fixtureOf([run]), waitId, {
    verdict: "ship",
  });
  assert(unkeyed.kind === "completed");
  assertEquals("key" in unkeyed.data, false);
});

Deno.test("workflowSignal: an unknown workflow, an undeclared key and a string that is no key are all not found with one message, and nothing is stored", async () => {
  const fixture = await keyedFixture();
  for (
    const [workflow, key] of [
      ["no-such-workflow", KEY],
      ["release", "other-key"],
      ["release", "Release-Verdict"],
      ["release", "../x"],
      ["release", ""],
    ]
  ) {
    const refusal = refusalOf(
      await sendByKey(fixture, workflow, key, { verdict: "ship" }),
    );
    assertEquals(refusal.kind, "unknown", `${workflow} ${key}`);
    assertEquals(refusal.code, "not_found");
    // One message, whichever of the three it was.
    assertEquals(
      refusal.message,
      `Signal wait not found: key "${key}" of workflow "${workflow}"`,
    );
  }
  assertEquals(fixture.waits.outcomes.size, 0);
});

Deno.test("workflowSignal: a declared key no open wait holds is refused as such and nothing is stored", async () => {
  const workflow = keyedWorkflow();
  const waits = new InMemorySignalWaitStore();
  const never = await fixtureOf([], { waits, workflows: [workflow] });
  const first = refusalOf(
    await sendByKey(never, "release", KEY, { verdict: "ship" }),
  );
  assertEquals(first.kind, "no_open_wait");
  assertEquals(first.code, "validation_failed");
  // Nothing ever held the key, so nothing is said of a last wait.
  assertEquals(first.lastWait, undefined);
  assertStringIncludes(
    first.message,
    `No open wait holds key "${KEY}" of workflow "release"`,
  );
  assertEquals(waits.outcomes.size, 0);
  assertEquals(waits.keyRecords.size, 0);

  // After the holder is settled the key is free again.
  const fixture = await keyedFixture();
  const sent = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(sent.kind === "completed");
  const second = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "fix" }),
  );
  assertEquals(second.kind, "no_open_wait");
  // The wait that last held the key, and the signal that settled it. The
  // same refusal reaches a sender who retries after a lost reply and one who
  // is early for the next run, so the message says when the wait was settled
  // and leaves the conclusion to the sender.
  assertEquals(second.lastWait?.waitId, fixture.waitId);
  assertEquals(second.lastWait?.settledAs, "accepted");
  assertEquals(second.lastWait?.receipt?.id, sent.data.signal.id);
  assertStringIncludes(
    second.message,
    `settled by signal ${sent.data.signal.id} at ${second.lastWait?.settledAt}.`,
  );
  assertEquals(second.message.includes("has already landed"), false);
  assertStringIncludes(second.message, 'Run "swamp workflow waits" for');

  // A caller that answers for a server names the command that reaches it.
  const events = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), fixture.deps, {
      workflow: "release",
      key: KEY,
      payload: { verdict: "fix" },
      waitsCommand: "swamp workflow waits --server <server>",
    }),
  );
  assertStringIncludes(
    refusalOf(events.at(-1)!).message,
    'Run "swamp workflow waits --server <server>" for the waits that are open.',
  );
  const outcome = await outcomeOf(fixture, fixture.waitId);
  assert(outcome?.kind === "accepted");
  assertEquals(outcome.payload, { verdict: "ship" });
});

Deno.test("workflowSignal: by key, a payload the schema refuses lists its errors, leaves the wait open, and keeps the wait ID out of the message", async () => {
  const fixture = await keyedFixture();
  const refusal = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "maybe" }),
  );
  assertEquals(refusal.kind, "invalid_payload");
  assertStringIncludes(
    refusal.message,
    `Payload refused for wait holding key "${KEY}" of workflow "release"`,
  );
  assertStringIncludes(refusal.message, "swamp workflow waits");
  assertEquals(refusal.message.includes(fixture.waitId), false);
  assertEquals(refusal.details.waitId, fixture.waitId);
  assert(Array.isArray(refusal.details.errors));
  assertEquals(await outcomeOf(fixture, fixture.waitId), undefined);

  const accepted = await sendByKey(fixture, "release", KEY, {
    verdict: "ship",
  });
  assertEquals(accepted.kind, "completed");
});

Deno.test("workflowSignal: by key, a holder past its deadline is settled as timed out and answered expired", async () => {
  const fixture = await keyedFixture({ now: TOO_LATE });
  const refusal = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "ship" }),
  );
  assertEquals(refusal.kind, "expired");
  assertEquals(refusal.message.includes(fixture.waitId), false);
  assertEquals((await outcomeOf(fixture, fixture.waitId))?.kind, "timed_out");
});

Deno.test("workflowSignal: a holder settled between resolving and delivering is answered from what is stored, and the signal goes to no other wait", async () => {
  for (const settledAs of ["accepted", "cancelled"] as const) {
    const fixture = await keyedFixture();
    const other = acceptedOutcomeFor(
      { id: fixture.waitId, deadline: new Date(fixture.claim.deadline) },
      { verdict: "fix" },
      { runId: fixture.run.id, at: IN_TIME },
    );
    // The holder is read as open; before the signal is delivered another
    // writer settles it and the next run's wait claims the key.
    const store = fixture.waits;
    const findRegistration = store.findRegistration.bind(store);
    let next: WaitKeyClaim | undefined;
    store.findRegistration = async (waitId: string) => {
      if (waitId === fixture.waitId && next === undefined) {
        await store.settle(
          settledAs === "accepted"
            ? other
            : cancelledOutcome(waitRefOfClaim(fixture.claim), IN_TIME),
        );
        const later = await suspendedHoldingKey(fixture.workflow, store);
        next = later.claim;
      }
      return await findRegistration(waitId);
    };

    const refusal = refusalOf(
      await sendByKey(fixture, "release", KEY, { verdict: "ship" }),
    );
    assertEquals(
      refusal.kind,
      settledAs === "accepted" ? "already_settled" : "closed",
    );
    assertEquals(refusal.details.waitId, fixture.waitId);
    assert(next);
    // The wait that claimed the key meanwhile got nothing.
    assertEquals((await store.findOutcome(next.waitId)).kind, "absent");
  }
});

Deno.test("workflowSignal: a claim whose wait is registered to another workflow or under another key carries no signal there", async () => {
  // A claim altered to name a wait of another workflow.
  const victim = keyedWorkflow("payroll", "payroll-verdict");
  const waits = new InMemorySignalWaitStore();
  const target = await suspendedHoldingKey(victim, waits, "payroll-verdict");
  const workflow = keyedWorkflow();
  const fixture = await fixtureOf([target.run], {
    waits,
    workflows: [workflow, victim],
  });
  const forged: WaitKeyClaim = {
    ...target.claim,
    workflowId: workflow.id,
    key: KEY,
    generation: 1,
  };
  waits.keyRecords.set(
    waitKeyRecordKey(forged),
    new TextEncoder().encode(JSON.stringify(forged)),
  );

  const refusal = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "ship" }),
  );
  assertEquals(refusal.kind, "unreadable");
  assertEquals((await waits.findOutcome(target.waitId)).kind, "absent");
  // The wait still takes a signal addressed to it.
  const direct = await sendByKey(fixture, "payroll", "payroll-verdict", {
    verdict: "ship",
  });
  assertEquals(direct.kind, "completed");
});

Deno.test("workflowSignal: a claim altered to name another workflow's wait is answered with nothing stored about that wait", async () => {
  const victim = keyedWorkflow("payroll", "payroll-verdict");
  const workflow = keyedWorkflow();
  const forge = (waits: InMemorySignalWaitStore, claim: WaitKeyClaim) => {
    const forged: WaitKeyClaim = {
      ...claim,
      workflowId: workflow.id,
      key: KEY,
      generation: 1,
    };
    waits.keyRecords.set(
      waitKeyRecordKey(forged),
      new TextEncoder().encode(JSON.stringify(forged)),
    );
  };
  const assertSaysNothing = (
    refusal: ReturnType<typeof refusalOf>,
    target: { run: WorkflowRun },
  ) => {
    assertEquals(refusal.kind, "unreadable");
    assertEquals(refusal.message.includes("payroll"), false);
    assertEquals(refusal.message.includes(target.run.id), false);
    assertEquals("receipt" in refusal.details, false);
  };

  // The wait is settled between resolving and delivering, and its run is
  // not on this host: only its outcome places it.
  const settledWaits = new InMemorySignalWaitStore();
  const settled = await suspendedHoldingKey(
    victim,
    settledWaits,
    "payroll-verdict",
  );
  forge(settledWaits, settled.claim);
  const findRegistration = settledWaits.findRegistration.bind(settledWaits);
  settledWaits.findRegistration = async (waitId: string) => {
    await settledWaits.settle(
      acceptedOutcomeFor(
        { id: settled.waitId, deadline: new Date(settled.claim.deadline) },
        { verdict: "ship" },
        { runId: settled.run.id, at: IN_TIME },
      ),
    );
    return await findRegistration(waitId);
  };
  const gone = await fixtureOf([], {
    waits: settledWaits,
    registered: false,
    workflows: [workflow, victim],
  });
  assertSaysNothing(
    refusalOf(await sendByKey(gone, "release", KEY, { verdict: "fix" })),
    settled,
  );

  // The wait has no registration, and its run record places it.
  const openWaits = new InMemorySignalWaitStore();
  const open = await suspendedHoldingKey(victim, openWaits, "payroll-verdict");
  forge(openWaits, open.claim);
  const unregistered = await fixtureOf([open.run], {
    waits: openWaits,
    registered: false,
    workflows: [workflow, victim],
  });
  assertSaysNothing(
    refusalOf(
      await sendByKey(unregistered, "release", KEY, { verdict: "fix" }),
    ),
    open,
  );
  assertEquals((await openWaits.findOutcome(open.waitId)).kind, "absent");
  assertEquals(openWaits.registrations.size, 0);
});

Deno.test("workflowSignal: a key whose highest record cannot be read is refused as unreadable", async () => {
  const fixture = await keyedFixture();
  fixture.waits.keyRecords.set(
    waitKeyRecordKey(fixture.claim),
    new TextEncoder().encode("{not json"),
  );
  const refusal = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "ship" }),
  );
  assertEquals(refusal.kind, "unreadable");
  assertEquals(await outcomeOf(fixture, fixture.waitId), undefined);
});

Deno.test("workflowSignal: a claim whose wait nothing here knows is not found, in the words of the key address", async () => {
  // The step claimed its key and stopped before it registered the wait or
  // saved the run.
  const workflow = keyedWorkflow();
  const waits = new InMemorySignalWaitStore();
  const held = await suspendedHoldingKey(workflow, waits);
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  const refusal = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "ship" }),
  );
  assertEquals(refusal.kind, "unknown");
  assertEquals(refusal.code, "not_found");
  assertEquals(
    refusal.message,
    `Signal wait not found: key "${KEY}" of workflow "release"`,
  );
  assertEquals(refusal.details.waitId, held.waitId);
  assertEquals(waits.outcomes.size, 0);
});

Deno.test("workflowSignal: by key on a datastore that cannot hold wait records is refused as unsupported", async () => {
  const fixture = await keyedFixture();
  const refusal = refusalOf(
    await sendByKey(
      {
        deps: {
          ...fixture.deps,
          signalWaits: { supported: false, reason: "no conditional writes" },
        },
      },
      "release",
      KEY,
      { verdict: "ship" },
    ),
  );
  assertEquals(refusal.kind, "unsupported");
});

// A signal that arrives before its wait opens (swamp-club#3212).

function earlyWorkflow(name = "release"): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(60, SCHEMA, KEY, 10),
          }),
        ],
      }),
    ],
  });
}

/** A run suspended at its keyed wait, opened at `at` by a step with acceptEarly. */
async function suspendedAtEarlyWait(
  workflow: Workflow,
  waits: InMemorySignalWaitStore,
  at: Date,
): Promise<{ run: WorkflowRun; waitId: string }> {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const review = job.getStep("review")!;
  review.start();
  const wait = SignalWait.open(SCHEMA, 60, at, undefined, KEY);
  const claimed = await claimWaitKey(waits, {
    workflowId: workflow.id,
    key: KEY,
    waitId: wait.id,
    runId: run.id,
    jobName: "main",
    stepName: "review",
    deadline: wait.deadline.toISOString(),
    acceptEarly: 10,
  }, at);
  assert(claimed.kind === "acquired", `got ${claimed.kind}`);
  review.waitForSignal(wait.withEarly(claimed.claim.early!));
  run.suspend();
  return { run, waitId: wait.id };
}

Deno.test("workflowSignal: a signal by key before the wait opens is held, with its receipt and until when", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  const sent = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(sent.kind === "pending", `got ${sent.kind}`);
  assertEquals(sent.data.pending, true);
  assertEquals(sent.data.key, KEY);
  assertEquals(sent.data.workflowId, workflow.id);
  assertEquals(sent.data.workflowName, "release");
  assertEquals(sent.data.signal.receivedAt, IN_TIME.toISOString());
  assertEquals(sent.data.signal.submittedBy, "tux");
  assertEquals(sent.data.heldUntil, "2026-01-01T00:00:40.000Z");
  // One pending record, and nothing that names a wait or a run.
  assertEquals(waits.pendingRecords.size, 1);
  assertEquals(waits.outcomes.size, 0);
  assertEquals(waits.keyRecords.size, 0);
  assertEquals(waits.registrations.size, 0);
  assertEquals(fixture.calls, []);
});

Deno.test("workflowSignal: a second early signal while one is pending is refused with the stored receipt, and names no person", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  const first = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(first.kind === "pending");
  const second = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "fix" }),
  );
  assertEquals(second.kind, "already_pending");
  assertEquals(second.details.receipt, first.data.signal);
  assertEquals(second.details.heldUntil, first.data.heldUntil);
  assertStringIncludes(second.message, first.data.signal.id);
  assertEquals(second.message.includes("tux"), false);
  assertEquals(waits.pendingRecords.size, 1);
});

Deno.test("workflowSignal: an early payload the definition's schema refuses is refused on arrival and nothing is stored", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  const refusal = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "maybe" }),
  );
  assertEquals(refusal.kind, "invalid_payload");
  assertEquals(refusal.details.early, true);
  assertStringIncludes(refusal.message, "nothing was stored");
  assertEquals(waits.pendingRecords.size, 0);
});

Deno.test("workflowSignal: a keyed wait without acceptEarly refuses an early signal as before and stores nothing", async () => {
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], {
    waits,
    workflows: [keyedWorkflow()],
  });
  const refusal = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "ship" }),
  );
  assertEquals(refusal.kind, "no_open_wait");
  assertEquals(waits.pendingRecords.size, 0);
});

Deno.test("workflowSignal: for a caller that cannot be told a signal is held, an early signal is refused as before and nothing is stored", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  const events = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), fixture.deps, {
      workflow: "release",
      key: KEY,
      payload: { verdict: "ship" },
      submittedBy: "tux",
      holdEarly: false,
    }),
  );
  const refusal = refusalOf(events.at(-1)!);
  assertEquals(refusal.kind, "no_open_wait");
  assertStringIncludes(refusal.message, "nothing was stored");
  assertStringIncludes(refusal.message, "upgrade swamp");
  assertEquals(waits.pendingRecords.size, 0);
});

Deno.test("workflowSignal: a wait opened over a pending signal its step never read is given that signal by the next signal that looks", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const empty = await fixtureOf([], { waits, workflows: [workflow] });
  const early = await sendByKey(empty, "release", KEY, { verdict: "ship" });
  assert(early.kind === "pending");
  // The step opens its wait five seconds later and stops before it reads
  // the slot: the wait is open and registered, with the signal unapplied.
  const opened = await suspendedAtEarlyWait(
    workflow,
    waits,
    new Date(IN_TIME.getTime() + 5_000),
  );
  const fixture = await fixtureOf([opened.run], {
    waits,
    workflows: [workflow],
    now: new Date(IN_TIME.getTime() + 6_000),
  });
  const later = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "fix" }),
  );
  // The earlier signal is the wait's outcome; this one came second.
  assertEquals(later.kind, "already_settled");
  const outcome = await waits.findOutcome(opened.waitId);
  assert(outcome.kind === "found" && outcome.record.kind === "accepted");
  assertEquals(outcome.record.payload, { verdict: "ship" });
  assertEquals(outcome.record.receipt.id, early.data.signal.id);
  assertEquals(outcome.record.receipt.waitId, opened.waitId);
});

Deno.test("workflowSignal: a signal that finds its key held by a wait past its deadline settles that wait and is held for the next", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const old = await suspendedAtEarlyWait(workflow, waits, OPENED);
  const fixture = await fixtureOf([old.run], {
    waits,
    workflows: [workflow],
    now: TOO_LATE,
  });
  const sent = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(sent.kind === "pending", `got ${sent.kind}`);
  const outcome = await waits.findOutcome(old.waitId);
  assertEquals(
    outcome.kind === "found" && outcome.record.kind,
    "timed_out",
  );
  // Stored for the claim after the one that timed out.
  const [address] = await waits.listPendingAddresses();
  assertEquals(address.slot, 2);
});

Deno.test("workflowSignal: a signal sent as the step opens its wait is delivered, whichever of them reads second", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  // The step claims and registers between the signal's create and its
  // second read, and has not read the slot.
  let opened: { run: WorkflowRun; waitId: string } | undefined;
  let first = true;
  const racing = new Proxy(waits, {
    get(target, property, receiver) {
      if (property !== "createPendingRecord") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (
        record: Parameters<InMemorySignalWaitStore["createPendingRecord"]>[0],
      ) => {
        const stored = await target.createPendingRecord(record);
        if (first) {
          first = false;
          opened = await suspendedAtEarlyWait(workflow, target, IN_TIME);
          const [ref] = opened.run.findSignalWaits();
          await target.register(registrationOf(
            {
              workflowId: workflow.id,
              workflowName: workflow.name,
              runId: opened.run.id,
              jobName: ref.jobName,
              stepName: ref.stepName,
            },
            ref.wait!,
            IN_TIME,
          ));
        }
        return stored;
      };
    },
  });
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  fixture.deps.signalWaits = { supported: true, store: racing };
  const sent = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(sent.kind === "completed", `got ${sent.kind}`);
  assertEquals(sent.data.waitId, opened!.waitId);
  assertEquals(sent.data.key, KEY);
  const outcome = await waits.findOutcome(opened!.waitId);
  assert(outcome.kind === "found" && outcome.record.kind === "accepted");
  // The receipt is the one the pending record carries: one signal, stored
  // once as pending and once as the outcome.
  assertEquals(outcome.record.receipt.id, sent.data.signal.id);
  const [address] = await waits.listPendingAddresses();
  const pending = await waits.findPendingRecord(address);
  assert(pending.kind === "found" && pending.record.kind === "pending");
  assertEquals(pending.record.receiptId, sent.data.signal.id);
});

// A signal sent again under its idempotency key (swamp-club#3212).

/**
 * An early signal sent under `idempotencyKey` that the first run's wait
 * took: the wait opened five seconds after it and was settled by the next
 * reader, so the key is free again.
 */
async function landedEarlySignal(idempotencyKey: string) {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const empty = await fixtureOf([], { waits, workflows: [workflow] });
  const early = await sendByKey(
    empty,
    "release",
    KEY,
    { verdict: "ship" },
    idempotencyKey,
  );
  assert(early.kind === "pending", `got ${early.kind}`);
  const opened = await suspendedAtEarlyWait(
    workflow,
    waits,
    new Date(IN_TIME.getTime() + 5_000),
  );
  const at = (seconds: number, runs: WorkflowRun[] = [opened.run]) =>
    fixtureOf(runs, {
      waits,
      workflows: [workflow],
      now: new Date(IN_TIME.getTime() + seconds * 1000),
    });
  // Whoever looks at the wait next gives it the signal.
  const reader = refusalOf(
    await sendByKey(await at(6), "release", KEY, { verdict: "fix" }),
  );
  assertEquals(reader.kind, "already_settled");
  return { workflow, waits, early: early.data, opened, at };
}

Deno.test("workflowSignal: a retry of an early signal a run took is answered with that signal, and nothing is held for the next run", async () => {
  const { waits, early, opened, at } = await landedEarlySignal("order-1");
  const held = waits.pendingRecords.size;

  const retry = await sendByKey(
    await at(7),
    "release",
    KEY,
    { verdict: "ship" },
    "order-1",
  );
  assert(retry.kind === "completed", `got ${retry.kind}`);
  assertEquals(retry.data.duplicate, true);
  assertEquals(retry.data.waitId, opened.waitId);
  assertEquals(retry.data.runId, opened.run.id);
  assertEquals(retry.data.signal.id, early.signal.id);
  assertEquals(retry.data.signal.idempotencyKey, "order-1");
  assertEquals(waits.pendingRecords.size, held);

  // Under another key, or none, it is a signal for the next run, as before.
  const other = await sendByKey(
    await at(8),
    "release",
    KEY,
    { verdict: "ship" },
    "order-2",
  );
  assert(other.kind === "pending", `got ${other.kind}`);
  assertEquals(other.data.duplicate, undefined);
});

Deno.test("workflowSignal: a retry of a signal that is still held is answered with the held one, and another key is refused as already pending", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  const payload = { verdict: "ship" };
  const first = await sendByKey(fixture, "release", KEY, payload, "order-1");
  assert(first.kind === "pending");
  assertEquals(first.data.signal.idempotencyKey, "order-1");
  assertEquals(first.data.duplicate, undefined);

  const retry = await sendByKey(fixture, "release", KEY, payload, "order-1");
  assert(retry.kind === "pending", `got ${retry.kind}`);
  assertEquals(retry.data.duplicate, true);
  assertEquals(retry.data.signal, first.data.signal);
  assertEquals(retry.data.heldUntil, first.data.heldUntil);
  assertEquals(waits.pendingRecords.size, 1);

  const other = refusalOf(
    await sendByKey(fixture, "release", KEY, payload, "order-2"),
  );
  assertEquals(other.kind, "already_pending");
});

Deno.test("workflowSignal: a held signal past its age limit is not what a retry repeats, and the retry is held", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const payload = { verdict: "ship" };
  const first = await sendByKey(
    await fixtureOf([], { waits, workflows: [workflow] }),
    "release",
    KEY,
    payload,
    "order-1",
  );
  assert(first.kind === "pending");
  const later = await fixtureOf([], {
    waits,
    workflows: [workflow],
    now: new Date(IN_TIME.getTime() + 10_001),
  });
  const retry = await sendByKey(later, "release", KEY, payload, "order-1");
  assert(retry.kind === "pending", `got ${retry.kind}`);
  assertEquals(retry.data.duplicate, undefined);
  assertEquals(retry.data.signal.id === first.data.signal.id, false);
});

Deno.test("workflowSignal: a retry that arrives once the next run has opened its wait is not delivered to that wait", async () => {
  const { workflow, waits, early, opened, at } = await landedEarlySignal(
    "order-1",
  );
  const next = await suspendedAtEarlyWait(
    workflow,
    waits,
    new Date(IN_TIME.getTime() + 20_000),
  );
  const fixture = await at(21, [opened.run, next.run]);

  const retry = await sendByKey(
    fixture,
    "release",
    KEY,
    { verdict: "ship" },
    "order-1",
  );
  assert(retry.kind === "completed", `got ${retry.kind}`);
  assertEquals(retry.data.duplicate, true);
  assertEquals(retry.data.waitId, opened.waitId);
  assertEquals(retry.data.signal.id, early.signal.id);
  assertEquals((await waits.findOutcome(next.waitId)).kind, "absent");

  // Without the key it is a signal for the wait that is open.
  const plain = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(plain.kind === "completed", `got ${plain.kind}`);
  assertEquals(plain.data.waitId, next.waitId);
  assertEquals(plain.data.duplicate, undefined);
});

Deno.test("workflowSignal: a signal to an open wait keeps its idempotency key, and a retry by ID or by key is answered with it", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const opened = await suspendedAtEarlyWait(workflow, waits, OPENED);
  const fixture = await fixtureOf([opened.run], {
    waits,
    workflows: [workflow],
  });
  const payload = { verdict: "ship" };
  const first = await send(fixture, opened.waitId, payload, "order-1");
  assert(first.kind === "completed", `got ${first.kind}`);
  assertEquals(first.data.duplicate, undefined);
  assertEquals(first.data.signal.idempotencyKey, "order-1");

  const byId = await send(fixture, opened.waitId, payload, "order-1");
  assert(byId.kind === "completed", `got ${byId.kind}`);
  assertEquals(byId.data.duplicate, true);
  assertEquals(byId.data.signal, first.data.signal);

  const byKey = await sendByKey(fixture, "release", KEY, payload, "order-1");
  assert(byKey.kind === "completed", `got ${byKey.kind}`);
  assertEquals(byKey.data.duplicate, true);
  assertEquals(byKey.data.signal, first.data.signal);
  assertEquals(waits.pendingRecords.size, 0);

  // Another key, or none, is a second signal for a settled wait.
  assertEquals(
    refusalOf(await send(fixture, opened.waitId, payload, "order-2")).kind,
    "already_settled",
  );
  assertEquals(
    refusalOf(await send(fixture, opened.waitId, payload)).kind,
    "already_settled",
  );
});

Deno.test("workflowSignal: an idempotency key in another form is refused before anything is read", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  for (const key of ["", "has space", "a/b", "k".repeat(129)]) {
    const sent = await sendByKey(fixture, "release", KEY, {}, key);
    assert(sent.kind === "error", `got ${sent.kind}`);
    assertEquals(signalRefusalKind(sent.error), undefined);
    assertStringIncludes(sent.error.message, "idempotency key");
  }
  assertEquals(waits.pendingRecords.size, 0);
});

Deno.test("workflowSignal: a slot keeps one record however many early signals age out in it", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  let last: string | undefined;
  for (let i = 0; i < 20; i++) {
    const sent = await sendByKey(
      await fixtureOf([], {
        waits,
        workflows: [workflow],
        now: new Date(IN_TIME.getTime() + i * 10_001),
      }),
      "release",
      KEY,
      { verdict: "ship" },
    );
    assert(sent.kind === "pending", `got ${sent.kind}`);
    last = sent.data.signal.id;
  }
  // The highest record is the last signal; the ones it superseded are gone.
  const addresses = await waits.listPendingAddresses();
  assertEquals(addresses.map((at) => at.number), [20]);
  const head = await waits.highestPendingRecord({
    workflowId: workflow.id,
    key: KEY,
    slot: 1,
  });
  assertEquals(
    head.kind === "found" && head.record.kind === "pending" &&
      head.record.receiptId,
    last,
  );
});

Deno.test("workflowSignal: a held signal is not taken by a wait its sender is refused for, by the signaller or by a later reader", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const empty = await fixtureOf([], { waits, workflows: [workflow] });
  // Authorized on the workflow as it is named now; no wait exists to ask of.
  const early = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), empty.deps, {
      workflow: "release",
      key: KEY,
      payload: { verdict: "ship" },
      submittedBy: "tux",
      authorize: () => Promise.resolve(true),
    }),
  );
  assertEquals(early.at(-1)?.kind, "pending");

  // A run recorded under the workflow's earlier name opens its wait.
  const opened = await suspendedAtEarlyWait(
    workflow,
    waits,
    new Date(IN_TIME.getTime() + 5_000),
  );
  const [ref] = opened.run.findSignalWaits();
  await waits.register(registrationOf(
    {
      workflowId: workflow.id,
      workflowName: "release-old",
      runId: opened.run.id,
      jobName: ref.jobName,
      stepName: ref.stepName,
    },
    ref.wait!,
    new Date(IN_TIME.getTime() + 5_000),
  ));
  const later = await fixtureOf([], {
    waits,
    workflows: [workflow],
    now: new Date(IN_TIME.getTime() + 6_000),
  });
  // The next reader of the wait leaves the signal where it is.
  const registration = await waits.findRegistration(opened.waitId);
  assert(registration.kind === "found");
  assertEquals(
    (await outcomeAt(
      waits,
      registration.record,
      new Date(IN_TIME.getTime() + 6_000),
    )).kind,
    "absent",
  );
  // And a sender refused for that wait is told nothing, with nothing applied.
  const refused = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), later.deps, {
      workflow: "release",
      key: KEY,
      payload: { verdict: "fix" },
      submittedBy: "tux",
      authorize: () => Promise.resolve(false),
    }),
  );
  assertEquals(refusalOf(refused.at(-1)!).kind, "unknown");
  assertEquals((await waits.findOutcome(opened.waitId)).kind, "absent");
});

Deno.test("workflowSignal: an idempotency key another sender used is not a match, and shows no receipt", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  const first = await sendByKey(
    fixture,
    "release",
    KEY,
    { verdict: "ship" },
    "build-1",
  );
  assert(first.kind === "pending");
  const other = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), fixture.deps, {
      workflow: "release",
      key: KEY,
      payload: { verdict: "ship" },
      submittedBy: "penguin",
      idempotencyKey: "build-1",
    }),
  );
  // Their own signal, refused as any second signal is while one is held.
  assertEquals(refusalOf(other.at(-1)!).kind, "already_pending");
});

Deno.test("workflowSignal: a caller that cannot be told a signal is held is not told so of a duplicate either", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  const first = await sendByKey(
    fixture,
    "release",
    KEY,
    { verdict: "ship" },
    "build-1",
  );
  assert(first.kind === "pending");
  const events = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), fixture.deps, {
      workflow: "release",
      key: KEY,
      payload: { verdict: "ship" },
      submittedBy: "tux",
      idempotencyKey: "build-1",
      holdEarly: false,
    }),
  );
  assertEquals(refusalOf(events.at(-1)!).kind, "no_open_wait");
  assertEquals(waits.pendingRecords.size, 1);
});

Deno.test("workflowSignal: of two copies of a signal sent to an open wait at the same moment, the one that loses is answered with the other", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const opened = await suspendedAtEarlyWait(workflow, waits, OPENED);
  const fixture = await fixtureOf([opened.run], {
    waits,
    workflows: [workflow],
  });
  const payload = { verdict: "ship" };
  // The other copy settles the wait between this one's read and its create.
  let winner: WorkflowSignalEvent | undefined;
  let first = true;
  const racing = new Proxy(waits, {
    get(target, property, receiver) {
      if (property !== "settle") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (
        outcome: Parameters<InMemorySignalWaitStore["settle"]>[0],
      ) => {
        if (first) {
          first = false;
          winner = await send(fixture, opened.waitId, payload, "order-1");
        }
        return await target.settle(outcome);
      };
    },
  });
  const loser = await send(
    {
      deps: {
        ...fixture.deps,
        signalWaits: { supported: true, store: racing },
      },
    },
    opened.waitId,
    payload,
    "order-1",
  );
  assert(winner?.kind === "completed", `got ${winner?.kind}`);
  assertEquals(winner.data.duplicate, undefined);
  assert(loser.kind === "completed", `got ${loser.kind}`);
  assertEquals(loser.data.duplicate, true);
  assertEquals(loser.data.signal, winner.data.signal);
});

Deno.test("workflowSignal: an early signal whose other copy was delivered to the wait that opened is answered with it, and nothing is held for the next run", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const payload = { verdict: "ship" };
  // The step opens its wait and the other copy is delivered to it, between
  // this copy's create and its second read of the key.
  let opened: { run: WorkflowRun; waitId: string } | undefined;
  let delivered: WorkflowSignalEvent | undefined;
  let first = true;
  const racing = new Proxy(waits, {
    get(target, property, receiver) {
      if (property !== "createPendingRecord") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (
        record: Parameters<InMemorySignalWaitStore["createPendingRecord"]>[0],
      ) => {
        if (!first) return await target.createPendingRecord(record);
        first = false;
        // The step claimed and read its slot before this record existed.
        opened = await suspendedAtEarlyWait(workflow, target, IN_TIME);
        const during = await fixtureOf([opened.run], {
          waits: target,
          workflows: [workflow],
        });
        delivered = await send(during, opened.waitId, payload, "order-1");
        return await target.createPendingRecord(record);
      };
    },
  });
  const empty = await fixtureOf([], { waits, workflows: [workflow] });
  const early = await sendByKey(
    {
      deps: {
        ...empty.deps,
        signalWaits: { supported: true, store: racing },
      },
    },
    "release",
    KEY,
    payload,
    "order-1",
  );
  assert(delivered?.kind === "completed", `got ${delivered?.kind}`);
  assert(early.kind === "completed", `got ${early.kind}`);
  assertEquals(early.data.duplicate, true);
  assertEquals(early.data.waitId, opened?.waitId);
  assertEquals(early.data.signal, delivered.data.signal);
  // Nothing waits in the next claim's slot.
  assertEquals(
    (await waits.listPendingAddresses()).map((at) => at.slot),
    [1],
  );
});

Deno.test("workflowSignal: a copy that reads the key as free because its other copy just settled the open wait is not held for the next run", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const opened = await suspendedAtEarlyWait(workflow, waits, OPENED);
  const fixture = await fixtureOf([opened.run], {
    waits,
    workflows: [workflow],
  });
  const payload = { verdict: "ship" };
  // The other copy is delivered between this copy's lookup by idempotency
  // key, which reads the key first, and its read of the key's holder.
  let delivered: WorkflowSignalEvent | undefined;
  let reads = 0;
  const racing = new Proxy(waits, {
    get(target, property, receiver) {
      if (property !== "highestKeyRecord") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (workflowId: string, key: string) => {
        if (++reads === 2) {
          delivered = await sendByKey(
            fixture,
            "release",
            KEY,
            payload,
            "order-1",
          );
        }
        return await target.highestKeyRecord(workflowId, key);
      };
    },
  });
  const late = await sendByKey(
    {
      deps: {
        ...fixture.deps,
        signalWaits: { supported: true, store: racing },
      },
    },
    "release",
    KEY,
    payload,
    "order-1",
  );
  assert(delivered?.kind === "completed", `got ${delivered?.kind}`);
  assertEquals(delivered.data.duplicate, undefined);
  assert(late.kind === "completed", `got ${late.kind}`);
  assertEquals(late.data.duplicate, true);
  assertEquals(late.data.waitId, opened.waitId);
  assertEquals(late.data.signal, delivered.data.signal);

  // It stored nothing: the next run's wait opens over an empty slot.
  assertEquals(waits.pendingRecords.size, 0);
  const next = await suspendedAtEarlyWait(
    workflow,
    waits,
    new Date(IN_TIME.getTime() + 1_000),
  );
  const again = await fixtureOf([opened.run, next.run], {
    waits,
    workflows: [workflow],
    now: new Date(IN_TIME.getTime() + 2_000),
  });
  const registration = await waits.findRegistration(next.waitId);
  assert(registration.kind === "found");
  assertEquals(
    (await outcomeAt(
      waits,
      registration.record,
      new Date(IN_TIME.getTime() + 2_000),
    )).kind,
    "absent",
  );
  assertEquals(again.calls, []);
});

// What a signal by key is told when its wait is opening or was open already
// (swamp-club#3307).

/** `waits`, with `hooks` run around the calls a signal by key makes of it. */
function racingStore(
  waits: InMemorySignalWaitStore,
  hooks: {
    /** Once, after the signal's pending record is created. */
    afterStored?: () => Promise<void>;
    /** Once, before the claims are listed to look for the signal's taker. */
    beforeTakerLookup?: () => Promise<void>;
  },
): InMemorySignalWaitStore {
  let stored = false;
  let looked = false;
  return new Proxy(waits, {
    get(target, property, receiver) {
      if (property === "createPendingRecord") {
        return async (
          record: Parameters<InMemorySignalWaitStore["createPendingRecord"]>[0],
        ) => {
          const created = await target.createPendingRecord(record);
          if (!stored) {
            stored = true;
            await hooks.afterStored?.();
          }
          return created;
        };
      }
      if (property === "listKeyRecords") {
        return async () => {
          if (stored && !looked) {
            looked = true;
            await hooks.beforeTakerLookup?.();
          }
          return await target.listKeyRecords();
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function registerEarlyWait(
  waits: InMemorySignalWaitStore,
  workflow: Workflow,
  run: WorkflowRun,
  at: Date,
): Promise<void> {
  const [ref] = run.findSignalWaits();
  await waits.register(registrationOf(
    {
      workflowId: workflow.id,
      workflowName: workflow.name,
      runId: run.id,
      jobName: ref.jobName,
      stepName: ref.stepName,
    },
    ref.wait!,
    at,
  ));
}

Deno.test("workflowSignal: a signal too old for the wait that is opening is refused, not answered as held, and a retry is delivered", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  // The step claims its key eleven seconds after the signal was received,
  // under an age limit of ten, and has not registered its wait.
  const claimedAt = new Date(IN_TIME.getTime() + 11_000);
  let opened: { run: WorkflowRun; waitId: string } | undefined;
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  fixture.deps.signalWaits = {
    supported: true,
    store: racingStore(waits, {
      afterStored: async () => {
        opened = await suspendedAtEarlyWait(workflow, waits, claimedAt);
      },
    }),
  };
  const refusal = refusalOf(
    await sendByKey(fixture, "release", KEY, { verdict: "ship" }, "build-1"),
  );
  assertEquals(refusal.kind, "no_open_wait");
  assertStringIncludes(refusal.message, "was not delivered");
  assertStringIncludes(refusal.message, "Send it again once the wait is open");

  // The step registers and reads its slot: no reader gives it the signal.
  await registerEarlyWait(waits, workflow, opened!.run, claimedAt);
  assertEquals(await takePendingSignalsOfRun(waits, opened!.run), 0);
  assertEquals((await waits.findOutcome(opened!.waitId)).kind, "absent");

  // The retry is not answered from the record left in the slot: it is
  // delivered to the wait, which is open now.
  const later = await fixtureOf([opened!.run], {
    waits,
    registered: false,
    workflows: [workflow],
    now: new Date(claimedAt.getTime() + 1_000),
  });
  const retry = await sendByKey(
    later,
    "release",
    KEY,
    { verdict: "ship" },
    "build-1",
  );
  assert(retry.kind === "completed", `got ${retry.kind}`);
  assertEquals(retry.data.waitId, opened!.waitId);
  assertEquals(retry.data.duplicate, undefined);
  assertEquals(retry.data.taken, undefined);
  assertEquals(retry.data.awaitingResume, true);
});

Deno.test("workflowSignal: a signal within the age limit of the wait that is opening is answered as held, and the wait takes it", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  // Claimed exactly the age limit after the signal: the edge of the window.
  const claimedAt = new Date(IN_TIME.getTime() + 10_000);
  let opened: { run: WorkflowRun; waitId: string } | undefined;
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  fixture.deps.signalWaits = {
    supported: true,
    store: racingStore(waits, {
      afterStored: async () => {
        opened = await suspendedAtEarlyWait(workflow, waits, claimedAt);
      },
    }),
  };
  const sent = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(sent.kind === "pending", `got ${sent.kind}`);
  await registerEarlyWait(waits, workflow, opened!.run, claimedAt);
  assertEquals(await takePendingSignalsOfRun(waits, opened!.run), 1);
  const outcome = await waits.findOutcome(opened!.waitId);
  assert(outcome.kind === "found" && outcome.record.kind === "accepted");
  assertEquals(outcome.record.receipt.id, sent.data.signal.id);
});

Deno.test("workflowSignal: a held signal another reader gave to a suspended wait is answered taken, with the resume its run needs", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const claimedAt = new Date(IN_TIME.getTime() + 1_000);
  let opened: { run: WorkflowRun; waitId: string } | undefined;
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  fixture.deps.signalWaits = {
    supported: true,
    store: racingStore(waits, {
      // The step opened its wait, read an empty slot and suspended before
      // the signaller read the key again.
      afterStored: async () => {
        opened = await suspendedAtEarlyWait(workflow, waits, claimedAt);
        await registerEarlyWait(waits, workflow, opened.run, claimedAt);
        fixture.stored.set(opened.run.id, opened.run.toData());
      },
      // The sweep gives the wait its pending signal before the signaller
      // looks for who took it.
      beforeTakerLookup: async () => {
        assertEquals(await takePendingSignalsOfRun(waits, opened!.run), 1);
      },
    }),
  };
  const sent = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(sent.kind === "completed", `got ${sent.kind}`);
  assertEquals(sent.data.taken, true);
  assertEquals(sent.data.waitId, opened!.waitId);
  assertEquals(sent.data.runRecordAvailable, true);
  // The run is suspended and nothing resumed it.
  assertEquals(sent.data.awaitingResume, true);
});

Deno.test("workflowSignal: a held signal the step took as it opened its wait is answered taken, with no resume", async () => {
  const workflow = earlyWorkflow();
  const waits = new InMemorySignalWaitStore();
  const claimedAt = new Date(IN_TIME.getTime() + 1_000);
  let waitId: string | undefined;
  const fixture = await fixtureOf([], { waits, workflows: [workflow] });
  fixture.deps.signalWaits = {
    supported: true,
    store: racingStore(waits, {
      // The step claims, registers, takes the signal and goes on: its run
      // never suspends.
      afterStored: async () => {
        const opened = await suspendedAtEarlyWait(workflow, waits, claimedAt);
        waitId = opened.waitId;
        await registerEarlyWait(waits, workflow, opened.run, claimedAt);
        assertEquals(await takePendingSignalsOfRun(waits, opened.run), 1);
        const run = WorkflowRun.create(workflow);
        run.start();
        fixture.stored.set(opened.run.id, {
          ...run.toData(),
          id: opened.run.id,
        });
      },
    }),
  };
  const sent = await sendByKey(fixture, "release", KEY, { verdict: "ship" });
  assert(sent.kind === "completed", `got ${sent.kind}`);
  assertEquals(sent.data.taken, true);
  assertEquals(sent.data.waitId, waitId);
  assertEquals(sent.data.runRecordAvailable, true);
  assertEquals(sent.data.awaitingResume, false);
});
