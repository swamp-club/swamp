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
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { SignalWait } from "./signal_wait.ts";
import {
  acceptedOutcomeFor,
  InMemorySignalWaitStore,
  unsignalledOutcomeFor,
} from "./signal_wait_store_test_helpers.ts";
import { decideContinuation } from "./run_continuation.ts";

const OPENED = new Date("2026-01-01T00:00:00.000Z");
const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

type StepKind = "wait" | "gate" | "work";

/** A run with one job whose steps are of the given kinds, started. */
function runOf(kinds: Record<string, StepKind>): WorkflowRun {
  const run = WorkflowRun.create(
    Workflow.create({
      name: "release",
      jobs: [
        Job.create({
          name: "main",
          steps: Object.entries(kinds).map(([name, kind]) =>
            Step.create({
              name,
              task: kind === "wait"
                ? StepTask.waitForSignal(60, SCHEMA)
                : kind === "gate"
                ? StepTask.manualApproval("ok?")
                : StepTask.modelMethod("model", "method"),
            })
          ),
        }),
      ],
    }),
  );
  run.start();
  run.getJob("main")!.start();
  return run;
}

function stepOf(run: WorkflowRun, name: string) {
  return run.getJob("main")!.getStep(name)!;
}

function openWait(run: WorkflowRun, name: string): SignalWait {
  const wait = SignalWait.open(SCHEMA, 60, OPENED);
  const step = stepOf(run, name);
  step.start();
  step.waitForSignal(wait);
  return wait;
}

Deno.test("decideContinuation: a run that is not suspended is blocked", async () => {
  const run = runOf({ a: "wait" });
  openWait(run, "a");
  assertEquals(
    await decideContinuation(run, new InMemorySignalWaitStore()),
    { kind: "blocked", reason: "not_suspended" },
  );
});

Deno.test("decideContinuation: a wait with no outcome blocks, and a signal or a timeout releases it", async () => {
  for (const kind of ["accepted", "timed_out"] as const) {
    const run = runOf({ a: "wait" });
    const wait = openWait(run, "a");
    run.suspend();
    const store = new InMemorySignalWaitStore();
    assertEquals(
      await decideContinuation(run, store),
      { kind: "blocked", reason: "wait_unsettled" },
    );

    await store.settle(
      kind === "accepted"
        ? acceptedOutcomeFor(wait, { verdict: "ship" }, { runId: run.id })
        : unsignalledOutcomeFor(wait, kind, { runId: run.id }),
    );
    assertEquals(await decideContinuation(run, store), { kind: "resumable" });
  }
});

Deno.test("decideContinuation: every wait needs an outcome", async () => {
  const run = runOf({ a: "wait", b: "wait" });
  const a = openWait(run, "a");
  const b = openWait(run, "b");
  run.suspend();
  const store = new InMemorySignalWaitStore();
  await store.settle(
    acceptedOutcomeFor(a, { verdict: "ship" }, { runId: run.id }),
  );
  assertEquals(
    await decideContinuation(run, store),
    { kind: "blocked", reason: "wait_unsettled" },
  );
  await store.settle(
    acceptedOutcomeFor(b, { verdict: "fix" }, { runId: run.id }),
  );
  assertEquals(await decideContinuation(run, store), { kind: "resumable" });
});

Deno.test("decideContinuation: an undecided gate blocks a run whose waits are settled", async () => {
  const run = runOf({ a: "wait", g: "gate" });
  const wait = openWait(run, "a");
  const gate = stepOf(run, "g");
  gate.start();
  gate.waitForApproval();
  run.suspend();
  const store = new InMemorySignalWaitStore();
  await store.settle(
    acceptedOutcomeFor(wait, { verdict: "ship" }, { runId: run.id }),
  );
  assertEquals(
    await decideContinuation(run, store),
    { kind: "blocked", reason: "gate_undecided" },
  );
});

Deno.test("decideContinuation: a step still running blocks a suspended run", async () => {
  const run = runOf({ a: "wait", w: "work" });
  const wait = openWait(run, "a");
  stepOf(run, "w").start();
  run.suspend();
  const store = new InMemorySignalWaitStore();
  await store.settle(
    acceptedOutcomeFor(wait, { verdict: "ship" }, { runId: run.id }),
  );
  assertEquals(
    await decideContinuation(run, store),
    { kind: "blocked", reason: "steps_running" },
  );
});

Deno.test("decideContinuation: an outcome that cannot be read blocks", async () => {
  const run = runOf({ a: "wait" });
  const wait = openWait(run, "a");
  run.suspend();
  const store = new InMemorySignalWaitStore();
  store.outcomes.set(wait.id, new TextEncoder().encode("not json"));
  assertEquals(
    await decideContinuation(run, store),
    { kind: "blocked", reason: "wait_unreadable" },
  );
});

Deno.test("decideContinuation: a suspended run with every gate decided and no wait is resumable", async () => {
  const run = runOf({ g: "gate" });
  const gate = stepOf(run, "g");
  gate.start();
  gate.waitForApproval();
  run.suspend();
  gate.recordApprovalDecision({
    approved: true,
    decidedAt: OPENED.toISOString(),
  });
  gate.succeed();
  assertEquals(
    await decideContinuation(run, new InMemorySignalWaitStore()),
    { kind: "resumable" },
  );
});

Deno.test("decideContinuation: a cancelled wait blocks, since only a run that ended cancels its waits", async () => {
  const run = runOf({ a: "wait", b: "wait" });
  const a = openWait(run, "a");
  const b = openWait(run, "b");
  run.suspend();
  const store = new InMemorySignalWaitStore();
  await store.settle(
    acceptedOutcomeFor(a, { verdict: "ship" }, { runId: run.id }),
  );
  await store.settle(unsignalledOutcomeFor(b, "cancelled", { runId: run.id }));
  assertEquals(
    await decideContinuation(run, store),
    { kind: "blocked", reason: "run_ended" },
  );
});
