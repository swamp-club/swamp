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
  acceptedOutcomeFor,
  InMemorySignalWaitStore,
  unsignalledOutcomeFor,
} from "../../domain/workflows/signal_wait_store_test_helpers.ts";
import { assertEquals } from "@std/assert";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { Workflow as RealWorkflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun as RealWorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { SignalWait } from "../../domain/workflows/signal_wait.ts";
import {
  nestedWaitView,
  workflowHistoryGet,
  type WorkflowHistoryGetDeps,
  type WorkflowHistoryGetEvent,
} from "./history_get.ts";

const testWorkflow = {
  id: "wf-1" as unknown as WorkflowId,
  name: "my-workflow",
} as unknown as Workflow;

const testRun = {
  id: "run-1",
  workflowId: "wf-1" as unknown as WorkflowId,
  workflowName: "my-workflow",
  status: "completed",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: new Date("2026-01-01T00:01:00Z"),
  jobs: [],
} as unknown as WorkflowRun;

function makeDeps(
  overrides: Partial<WorkflowHistoryGetDeps> = {},
): WorkflowHistoryGetDeps {
  return {
    isPartialId: () => false,
    matchRunByPartialId: () =>
      Promise.resolve({ status: "not_found" as const }),
    findWorkflow: () => Promise.resolve(testWorkflow),
    findLatestRun: () => Promise.resolve(testRun),
    getRunPath: () => "/repo/.swamp/runs/wf-1/run-1",
    resolveStepOutputs: () =>
      Promise.reject(new Error("outputs were not requested")),
    ...overrides,
  };
}

function runWithOneStep(): WorkflowRun {
  const workflow = RealWorkflow.create({
    name: "my-workflow",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "write",
            task: StepTask.model("writer", "execute"),
          }),
        ],
      }),
    ],
  });
  const run = RealWorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("write")!;
  step.start();
  step.succeed({ type: "model_method", model: "writer", resources: {} });
  job.succeed();
  run.complete();
  return run;
}

Deno.test("workflowHistoryGet: reads no step outputs unless asked", async () => {
  // The default resolveStepOutputs rejects, so any read fails the test.
  const deps = makeDeps({
    findLatestRun: () => Promise.resolve(runWithOneStep()),
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "my-workflow"),
  );

  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.jobs[0].steps[0].outputs, undefined);
});

Deno.test("workflowHistoryGet: includeOutputs adds the resolved step outputs", async () => {
  const run = runWithOneStep();
  let resolvedRunId: string | undefined;
  const deps = makeDeps({
    findLatestRun: () => Promise.resolve(run),
    resolveStepOutputs: (r) => {
      resolvedRunId = r.id;
      return Promise.resolve({
        main: {
          write: {
            outputs: { stdout: "hello" },
            attributesByDataId: {},
          },
        },
      });
    },
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "my-workflow", {
      includeOutputs: true,
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(resolvedRunId, run.id);
  assertEquals(completed.data.jobs[0].steps[0].outputs, { stdout: "hello" });
});

Deno.test("workflowHistoryGet: yields resolving then completed on happy path", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "my-workflow"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.id, "run-1");
  assertEquals(completed.data.workflowName, "my-workflow");
});

Deno.test("workflowHistoryGet: yields error with not_found when workflow not found", async () => {
  const deps = makeDeps({
    findWorkflow: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "unknown-workflow"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowHistoryGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("workflowHistoryGet: yields error with not_found when no runs exist", async () => {
  const deps = makeDeps({
    findLatestRun: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "my-workflow"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowHistoryGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("workflowHistoryGet: resolves run by partial ID", async () => {
  const deps = makeDeps({
    isPartialId: () => true,
    matchRunByPartialId: () =>
      Promise.resolve({ status: "found" as const, match: testRun }),
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "run-1"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.id, "run-1");
});

Deno.test("workflowHistoryGet: yields error on ambiguous partial ID", async () => {
  const deps = makeDeps({
    isPartialId: () => true,
    matchRunByPartialId: () =>
      Promise.resolve({
        status: "ambiguous" as const,
        matches: [
          { id: "run-1", run: testRun },
          { id: "run-2", run: testRun },
        ],
      }),
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "run"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowHistoryGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("workflowHistoryGet: partial ID not found falls back to workflow name", async () => {
  const deps = makeDeps({
    isPartialId: () => true,
    matchRunByPartialId: () =>
      Promise.resolve({ status: "not_found" as const }),
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "my-workflow"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.id, "run-1");
});

Deno.test("workflowHistoryGet: acts on a passed reference without looking the argument up", async () => {
  const refused = () =>
    Promise.reject(new Error("the argument must not be looked up again"));
  const deps = makeDeps({
    isPartialId: () => {
      throw new Error("the argument must not be parsed again");
    },
    matchRunByPartialId: refused,
    findWorkflow: refused,
    findLatestRun: refused,
  });
  const run = runWithOneStep();
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "abd", {
      reference: { kind: "run", run },
    }),
  );
  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.id, run.id);
});

Deno.test("workflowHistoryGet: reports a passed workflow with no runs as today", async () => {
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), makeDeps(), "my-workflow", {
      reference: { kind: "workflow", workflow: testWorkflow, latest: null },
    }),
  );
  const error = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "error" }
  >;
  assertEquals(
    error.error.message,
    "Workflow run not found: no runs for workflow: my-workflow",
  );
});

/** A run suspended with `review` waiting for a signal opened at `opened`. */
function runWaitingForSignal(opened: Date): WorkflowRun {
  const workflow = RealWorkflow.create({
    name: "my-workflow",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(60, { type: "object" }),
          }),
        ],
      }),
    ],
  });
  const run = RealWorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("review")!;
  step.start();
  step.waitForSignal(SignalWait.open({ type: "object" }, 60, opened));
  run.suspend();
  return run;
}

Deno.test("workflowHistoryGet: a step waiting for a signal shows its wait", async () => {
  const run = runWaitingForSignal(new Date("2026-01-01T00:00:00.000Z"));
  const wait = run.getJob("main")!.getStep("review")!.signalWait!;
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(
      createLibSwampContext(),
      makeDeps({ findLatestRun: () => Promise.resolve(run) }),
      "my-workflow",
    ),
  );

  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  const step = completed.data.jobs[0].steps[0];
  assertEquals(step.status, "waiting");
  assertEquals(step.wait, {
    id: wait.id,
    deadline: "2026-01-01T00:01:00.000Z",
  });
});

Deno.test("workflowHistoryGet: a signalled step shows the receipt", async () => {
  const opened = new Date("2026-01-01T00:00:00.000Z");
  const run = runWaitingForSignal(opened);
  const review = run.getJob("main")!.getStep("review")!;
  const outcome = acceptedOutcomeFor(review.signalWait!, { ok: true }, {
    at: opened,
  });
  assertEquals(review.applyWaitOutcome(outcome), true);
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(
      createLibSwampContext(),
      makeDeps({ findLatestRun: () => Promise.resolve(run) }),
      "my-workflow",
    ),
  );

  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.jobs[0].steps[0].wait?.receipt, outcome.receipt);
});

Deno.test("workflowHistoryGet: a step signalled since the run suspended shows the receipt while it still waits, and the run is not written", async () => {
  const opened = new Date("2026-01-01T00:00:00.000Z");
  const run = runWaitingForSignal(opened);
  const review = run.getJob("main")!.getStep("review")!;
  const store = new InMemorySignalWaitStore();
  const outcome = acceptedOutcomeFor(review.signalWait!, { ok: true }, {
    at: opened,
    runId: run.id,
  });
  await store.settle(outcome);

  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(
      createLibSwampContext(),
      makeDeps({
        findLatestRun: () => Promise.resolve(run),
        signalWaits: { supported: true, store },
      }),
      "my-workflow",
    ),
  );

  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  const step = completed.data.jobs[0].steps[0];
  assertEquals(step.status, "waiting");
  assertEquals(step.wait?.receipt, outcome.receipt);
  // Only a resume writes a suspended run.
  assertEquals(review.status, "waiting_signal");
  assertEquals(review.signalWait?.receipt, undefined);
});

Deno.test("workflowHistoryGet: an open wait, a timed-out wait and a store that fails all show the wait without a receipt", async () => {
  const opened = new Date("2026-01-01T00:00:00.000Z");
  const read = async (signalWaits: WorkflowHistoryGetDeps["signalWaits"]) => {
    const run = runWaitingForSignal(opened);
    const wait = run.getJob("main")!.getStep("review")!.signalWait!;
    const events = await collect<WorkflowHistoryGetEvent>(
      workflowHistoryGet(
        createLibSwampContext(),
        makeDeps({ findLatestRun: () => Promise.resolve(run), signalWaits }),
        "my-workflow",
      ),
    );
    const completed = events[1] as Extract<
      WorkflowHistoryGetEvent,
      { kind: "completed" }
    >;
    return { wait, shown: completed.data.jobs[0].steps[0].wait };
  };

  const open = await read({
    supported: true,
    store: new InMemorySignalWaitStore(),
  });
  assertEquals(open.shown?.receipt, undefined);
  assertEquals(open.shown?.id, open.wait.id);

  const unsupported = await read({ supported: false, reason: "no store" });
  assertEquals(unsupported.shown?.receipt, undefined);

  const failing = new InMemorySignalWaitStore();
  failing.findOutcome = () => Promise.reject(new Error("store is down"));
  const failed = await read({ supported: true, store: failing });
  assertEquals(failed.shown?.receipt, undefined);
  assertEquals(failed.shown?.id, failed.wait.id);
});

Deno.test("workflowHistoryGet: a wait settled as timed out shows no receipt", async () => {
  const opened = new Date("2026-01-01T00:00:00.000Z");
  const run = runWaitingForSignal(opened);
  const review = run.getJob("main")!.getStep("review")!;
  const store = new InMemorySignalWaitStore();
  await store.settle(
    unsignalledOutcomeFor(review.signalWait!, "timed_out", { runId: run.id }),
  );

  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(
      createLibSwampContext(),
      makeDeps({
        findLatestRun: () => Promise.resolve(run),
        signalWaits: { supported: true, store },
      }),
      "my-workflow",
    ),
  );
  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.jobs[0].steps[0].wait?.receipt, undefined);
});

Deno.test("nestedWaitView: a run with a finished nested run is not awaiting resume while a step waits for a signal", async () => {
  const childWorkflow = RealWorkflow.create({
    name: "child",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "work", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
  const parentWorkflow = RealWorkflow.create({
    name: "parent",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "call", task: StepTask.workflow("child") }),
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(60, { type: "object" }),
          }),
        ],
      }),
    ],
  });
  const parent = RealWorkflowRun.create(parentWorkflow);
  parent.start();
  const child = RealWorkflowRun.create(childWorkflow);
  child.recordParentRun({
    workflowId: parentWorkflow.id,
    workflowName: parentWorkflow.name,
    runId: parent.id,
    jobName: "main",
    stepName: "call",
    nestingDepth: 1,
    ancestorWorkflowNames: [parentWorkflow.name],
  });
  child.start();
  child.complete();
  const job = parent.getJob("main")!;
  job.start();
  job.getStep("call")!.waitForNestedRun({
    workflowId: childWorkflow.id,
    workflowName: childWorkflow.name,
    runId: child.id,
  });
  const review = job.getStep("review")!;
  review.waitForSignal(SignalWait.open({ type: "object" }, 60, new Date()));
  parent.suspend();
  const deps = {
    runRepo: { findById: () => Promise.resolve(child) },
    workflowRepo: { findById: () => Promise.resolve(childWorkflow) },
  };

  const waiting = await nestedWaitView(deps, parent);
  assertEquals(waiting.nestedWaits?.length, 1);
  assertEquals(waiting.awaitingResume, undefined);

  review.applyWaitOutcome(acceptedOutcomeFor(review.signalWait!, {}));
  assertEquals((await nestedWaitView(deps, parent)).awaitingResume, true);
});
