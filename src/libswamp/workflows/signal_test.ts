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
import { cancelAndSettle } from "../../domain/workflows/abort_settlement.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  unclaimedRuns,
  type WorkflowRunClaims,
} from "../../domain/workflows/run_claim.ts";

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

interface Store {
  deps: WorkflowSignalDeps;
  saved: WorkflowRun[];
  /** Calls made to the repository and the claim, in order. */
  calls: string[];
}

/**
 * A repository holding `runs` as stored records: each read returns a fresh
 * copy, so only a save changes what the next read sees.
 */
function storeOf(
  runs: WorkflowRun[],
  now: Date = IN_TIME,
  runClaims?: WorkflowRunClaims,
  ownerIsDead?: (run: WorkflowRun) => boolean,
): Store {
  const stored = new Map<string, WorkflowRunData>(
    runs.map((run) => [run.id, run.toData()]),
  );
  const saved: WorkflowRun[] = [];
  const calls: string[] = [];
  const all = () =>
    [...stored.values()].map((data) => ({
      run: WorkflowRun.fromData(data),
      workflowId: createWorkflowId(data.workflowId),
    }));
  const claims: WorkflowRunClaims = runClaims ?? {
    withClaim: async (runId, fn) => {
      calls.push(`claim:${runId}`);
      try {
        return await fn();
      } finally {
        calls.push(`release:${runId}`);
      }
    },
  };
  return {
    saved,
    calls,
    deps: {
      now: () => now,
      ownerIsDead,
      runClaims: claims,
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
        save: (_workflowId: WorkflowId, run: WorkflowRun) => {
          calls.push(`save:${run.id}`);
          stored.set(run.id, run.toData());
          saved.push(run);
          return Promise.resolve();
        },
      } as unknown as WorkflowSignalDeps["runRepo"],
    },
  };
}

async function send(
  store: Store,
  waitId: string,
  payload: unknown,
): Promise<WorkflowSignalEvent> {
  const events = await collect<WorkflowSignalEvent>(
    workflowSignal(createLibSwampContext(), store.deps, {
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

Deno.test("workflowSignal: a valid payload settles the wait, saves the run once and reports the receipt", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const store = storeOf([run]);

  const event = await send(store, waitId, { verdict: "ship" });

  assert(event.kind === "completed");
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

  assertEquals(store.saved.length, 1);
  const review = store.saved[0].getJob("main")!.getStep("review")!;
  assertEquals(review.status, "succeeded");
  assertEquals(review.output, {
    type: "wait_for_signal",
    payload: { verdict: "ship" },
    signal: event.data.signal,
  });
});

Deno.test("workflowSignal: the run is re-read and saved inside its claim", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run]);

  await send(store, waitId, { verdict: "ship" });

  const claimed = store.calls.indexOf(`claim:${run.id}`);
  const released = store.calls.indexOf(`release:${run.id}`);
  const reread = store.calls.indexOf(`findById:${run.id}`);
  const saved = store.calls.indexOf(`save:${run.id}`);
  assert(claimed >= 0 && released > claimed);
  assert(reread > claimed && reread < released, store.calls.join(" "));
  assert(saved > reread && saved < released, store.calls.join(" "));
});

Deno.test("workflowSignal: acts on the run as stored under the claim, not as first listed", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const held: { store?: Store } = {};
  // Another command cancels the run between the listing and the claim.
  const claims: WorkflowRunClaims = {
    withClaim: async (_runId, fn) => {
      const current = await held.store!.deps.runRepo.findById(
        createWorkflowId(run.workflowId),
        run.id,
      );
      cancelAndSettle(current!, workflow, "operator");
      await held.store!.deps.runRepo.save(
        createWorkflowId(run.workflowId),
        current!,
      );
      held.store!.saved.length = 0;
      return await fn();
    },
  };
  const store = storeOf([run], IN_TIME, claims);
  held.store = store;

  const error = errorOf(await send(store, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "is closed");
  assertEquals(store.saved, []);
});

Deno.test("workflowSignal: an unknown wait id is not found, and nothing is claimed or saved", async () => {
  const { run } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run]);

  for (const waitId of [crypto.randomUUID(), "not-a-wait", "", "   "]) {
    const error = errorOf(await send(store, waitId, { verdict: "ship" }));
    assertEquals(error.code, "not_found");
  }
  assertEquals(store.saved, []);
  assertEquals(store.calls.filter((c) => c.startsWith("claim:")), []);
});

Deno.test("workflowSignal: the wait id matches whatever its letter case", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run]);

  const event = await send(store, ` ${waitId.toUpperCase()} `, {
    verdict: "ship",
  });

  assertEquals(event.kind, "completed");
});

Deno.test("workflowSignal: an invalid payload is refused with its errors and the wait stays open", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run]);

  const error = errorOf(await send(store, waitId, { verdict: "maybe" }));

  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "Payload refused");
  assertStringIncludes(error.message, "the wait stays open");
  assertStringIncludes(error.message, "verdict");
  assertEquals(store.saved, []);
  // The same wait accepts a valid payload afterwards.
  assertEquals(
    (await send(store, waitId, { verdict: "fix" })).kind,
    "completed",
  );
});

Deno.test("workflowSignal: a wait past its deadline is refused and names the resume", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run], TOO_LATE);

  const error = errorOf(await send(store, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "expired");
  assertStringIncludes(
    error.message,
    `swamp workflow resume release --run ${run.id}`,
  );
  assertEquals(store.saved, []);
});

Deno.test("workflowSignal: a settled wait refuses a second signal with the stored receipt, even after the run finished", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run]);
  const first = await send(store, waitId, { verdict: "ship" });
  assert(first.kind === "completed");

  const again = errorOf(await send(store, waitId, { verdict: "fix" }));
  assertStringIncludes(again.message, "already settled");
  assertStringIncludes(again.message, first.data.signal.id);
  assertEquals(store.saved.length, 1);

  // Once the run has finished it is no longer among the suspended runs.
  const finished = store.saved[0];
  finished.getJob("main")!.succeed();
  finished.complete();
  const later = storeOf([finished]);
  const afterFinish = errorOf(await send(later, waitId, { verdict: "fix" }));
  assertStringIncludes(afterFinish.message, "already settled");
  assertEquals(later.calls.includes("findAllGlobal"), true);
  assertEquals(later.saved, []);
});

Deno.test("workflowSignal: a run stored as suspended while a sibling step still runs is not ready", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  const data = run.toData();
  data.jobs[0].steps[1].status = "running";
  data.jobs[0].steps[1].completedAt = undefined;
  const store = storeOf([WorkflowRun.fromData(data)]);

  const error = errorOf(await send(store, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "has not suspended yet");
  assertStringIncludes(error.message, "again");
  assertEquals(store.saved, []);
});

Deno.test("workflowSignal: a run still stored as running is not ready, and is found outside the suspended runs", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const data = run.toData();
  data.status = "running";
  const store = storeOf([WorkflowRun.fromData(data)]);

  const error = errorOf(await send(store, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "has not suspended yet");
  assertEquals(store.calls.includes("findAllGlobal"), true);
  assertEquals(store.saved, []);
});

Deno.test("workflowSignal: a cancelled wait is closed", async () => {
  const workflow = makeWorkflow();
  const { run, waitId } = suspendedAtWait(workflow);
  cancelAndSettle(run, workflow, "operator");
  const store = storeOf([run]);

  const error = errorOf(await send(store, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "is closed");
  assertStringIncludes(error.message, "failed");
  assertEquals(store.saved, []);
});

Deno.test("workflowSignal: the refusals are distinct messages", async () => {
  const workflow = makeWorkflow();
  const messages = new Set<string>();
  const kinds = [
    async () => {
      const { run } = suspendedAtWait(workflow);
      return await send(storeOf([run]), crypto.randomUUID(), {});
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      return await send(storeOf([run]), waitId, { verdict: "no" });
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      return await send(storeOf([run], TOO_LATE), waitId, { verdict: "ship" });
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const store = storeOf([run]);
      await send(store, waitId, { verdict: "ship" });
      return await send(store, waitId, { verdict: "ship" });
    },
  ];
  for (const kind of kinds) {
    // The first few words say which refusal it is.
    messages.add(
      errorOf(await kind()).message.replace(/[0-9a-f-]{36}/g, "ID").slice(
        0,
        24,
      ),
    );
  }
  assertEquals(messages.size, kinds.length, [...messages].join(" | "));
});

Deno.test("workflowSignal: with unclaimed runs it still delivers", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run], IN_TIME, unclaimedRuns);

  assertEquals(
    (await send(store, waitId, { verdict: "ship" })).kind,
    "completed",
  );
});

Deno.test("workflowSignal: a run with a second open wait is not yet awaiting resume", async () => {
  const workflow = Workflow.create({
    name: "two-waits",
    jobs: [
      Job.create({
        name: "main",
        steps: ["first", "second"].map((name) =>
          Step.create({ name, task: StepTask.waitForSignal(60, SCHEMA) })
        ),
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const ids: string[] = [];
  for (const name of ["first", "second"]) {
    const wait = SignalWait.open(SCHEMA, 60, OPENED);
    job.getStep(name)!.waitForSignal(wait);
    ids.push(wait.id);
  }
  run.suspend();
  const store = storeOf([run]);

  const first = await send(store, ids[0], { verdict: "ship" });
  const second = await send(store, ids[1], { verdict: "fix" });

  assert(first.kind === "completed" && second.kind === "completed");
  assertEquals(first.data.stepName, "first");
  assertEquals(first.data.awaitingResume, false);
  assertEquals(second.data.stepName, "second");
  assertEquals(second.data.awaitingResume, true);
});

/** The run as a process killed mid-level leaves it: suspended, a step running. */
function abandonedMidLevel(workflow: Workflow): {
  run: WorkflowRun;
  waitId: string;
} {
  const { run, waitId } = suspendedAtWait(workflow);
  const data = run.toData();
  data.jobs[0].steps[1].status = "running";
  data.jobs[0].steps[1].completedAt = undefined;
  return { run: WorkflowRun.fromData(data), waitId };
}

Deno.test("workflowSignal: a run its dead owner left suspended with a step running accepts the signal", async () => {
  const { run, waitId } = abandonedMidLevel(makeWorkflow());
  const asked: string[] = [];
  const store = storeOf([run], IN_TIME, undefined, (candidate) => {
    asked.push(candidate.id);
    return true;
  });

  const event = await send(store, waitId, { verdict: "ship" });

  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(asked, [run.id]);
  assertEquals(store.saved.length, 1);
  const saved = store.saved[0].getJob("main")!;
  assertEquals(saved.getStep("review")!.status, "succeeded");
  // The abandoned step is left for the resume to run again.
  assertEquals(saved.getStep("sibling")!.status, "running");
});

Deno.test("workflowSignal: the same run is refused while its owner is alive, and names the cancel", async () => {
  const { run, waitId } = abandonedMidLevel(makeWorkflow());
  const store = storeOf([run], IN_TIME, undefined, () => false);

  const error = errorOf(await send(store, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "has not suspended yet");
  assertStringIncludes(
    error.message,
    `swamp workflow cancel release --run ${run.id}`,
  );
  assertEquals(store.saved, []);
});

Deno.test("workflowSignal: a run stored as running is refused even when its owner is dead", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const data = run.toData();
  data.status = "running";
  const store = storeOf(
    [WorkflowRun.fromData(data)],
    IN_TIME,
    undefined,
    () => true,
  );

  const error = errorOf(await send(store, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "has not suspended yet");
  assertEquals(store.saved, []);
});

Deno.test("workflowSignal: a drained suspended run never asks whether its owner is dead", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  let asked = 0;
  const store = storeOf([run], IN_TIME, undefined, () => {
    asked++;
    return false;
  });

  assertEquals(
    (await send(store, waitId, { verdict: "ship" })).kind,
    "completed",
  );
  assertEquals(asked, 0);
});

Deno.test("workflowSignal: a suspended run with no step running is not ready while its owner still runs the level", async () => {
  // The owner saved the record mid-level: the wait is open and a sibling
  // queued behind it is still pending, so no step is recorded running.
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run]);
  store.deps.ownerIsRunning = () => true;

  const error = errorOf(await send(store, waitId, { verdict: "ship" }));

  assertStringIncludes(error.message, "has not suspended yet");
  assertEquals(store.saved, []);

  // Once the owner has drained the level the same signal is delivered.
  store.deps.ownerIsRunning = () => false;
  assertEquals(
    (await send(store, waitId, { verdict: "ship" })).kind,
    "completed",
  );
});

Deno.test("workflowSignal: an empty sender falls back, so the receipt can be read back", async () => {
  const { run, waitId } = suspendedAtWait(makeWorkflow());
  const store = storeOf([run]);

  const events = await withMockedEnv(
    { USER: "", USERNAME: undefined },
    () =>
      collect<WorkflowSignalEvent>(
        workflowSignal(createLibSwampContext(), store.deps, {
          waitId,
          payload: { verdict: "ship" },
        }),
      ),
  );

  const event = events.at(-1)!;
  assert(event.kind === "completed", JSON.stringify(event));
  assertEquals(event.data.signal.submittedBy, "unknown");
  // The saved record reads back with its wait and receipt intact.
  const reloaded = WorkflowRun.fromData(store.saved[0].toData());
  assertEquals(
    reloaded.getJob("main")!.getStep("review")!.signalWait?.receipt
      ?.submittedBy,
    "unknown",
  );
});

Deno.test("workflowSignal: every refusal names the wait id exactly as typed", async () => {
  const workflow = makeWorkflow();
  const typed = (waitId: string) => ` ${waitId.toUpperCase()}  `;
  const refusals: Array<() => Promise<{ message: string; typedId: string }>> = [
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const event = await send(storeOf([run]), typed(waitId), { verdict: 1 });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const event = await send(storeOf([run], TOO_LATE), typed(waitId), {
        verdict: "ship",
      });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      const store = storeOf([run]);
      await send(store, waitId, { verdict: "ship" });
      const event = await send(store, typed(waitId), { verdict: "ship" });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = abandonedMidLevel(workflow);
      const event = await send(storeOf([run]), typed(waitId), {
        verdict: "ship",
      });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run, waitId } = suspendedAtWait(workflow);
      cancelAndSettle(run, workflow, "operator");
      const event = await send(storeOf([run]), typed(waitId), {
        verdict: "ship",
      });
      return { message: errorOf(event).message, typedId: typed(waitId) };
    },
    async () => {
      const { run } = suspendedAtWait(workflow);
      const unknown = typed(crypto.randomUUID());
      const event = await send(storeOf([run]), unknown, { verdict: "ship" });
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
  const store = storeOf([run]);
  const first = await send(store, waitId, { verdict: "ship" });
  assert(first.kind === "completed");

  const again = await send(store, waitId, { verdict: "fix" });

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
