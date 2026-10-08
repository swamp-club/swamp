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
import { Job } from "./job.ts";
import {
  assertNestedWaitsSettled,
  NestedRunLink,
  NestedRunPendingError,
  nestedWaitHint,
} from "./nested_run_link.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";
import { WorkflowRun, type WorkflowRunData } from "./workflow_run.ts";
import { SignalWait } from "./signal_wait.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";

class Runs {
  readonly byId = new Map<string, WorkflowRun>();
  add(...runs: WorkflowRun[]): void {
    for (const run of runs) this.byId.set(run.id.toLowerCase(), run);
  }
  findById(
    _workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null> {
    return Promise.resolve(this.byId.get(runId.toLowerCase()) ?? null);
  }
}

class Workflows {
  readonly byId = new Map<string, Workflow>();
  constructor(...workflows: Workflow[]) {
    for (const workflow of workflows) this.byId.set(workflow.id, workflow);
  }
  findById(id: WorkflowId): Promise<Workflow | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
}

function gatedChildWorkflow(timeout?: number): Workflow {
  return Workflow.create({
    name: "child",
    jobs: [
      Job.create({
        name: "child-job",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve", timeout),
          }),
        ],
      }),
    ],
  });
}

const parentWorkflow = Workflow.create({
  name: "parent",
  jobs: [
    Job.create({
      name: "main",
      steps: [
        Step.create({ name: "call-child", task: StepTask.workflow("child") }),
      ],
    }),
  ],
});

/** A parent suspended on a child suspended at its gate, linked both ways. */
function linkedPair(childWorkflow = gatedChildWorkflow()): {
  parent: WorkflowRun;
  child: WorkflowRun;
  runs: Runs;
  deps: { runRepo: Runs; workflowRepo: Workflows };
} {
  const parent = WorkflowRun.create(parentWorkflow);
  parent.start();
  const child = WorkflowRun.create(childWorkflow);
  child.recordParentRun({
    workflowId: parentWorkflow.id,
    workflowName: parentWorkflow.name,
    runId: parent.id,
    jobName: "main",
    stepName: "call-child",
    nestingDepth: 1,
    ancestorWorkflowNames: [parentWorkflow.name],
  });
  child.start();
  const gate = child.getJob("child-job")!.getStep("gate")!;
  gate.start();
  gate.waitForApproval("Approve");
  child.suspend();
  parent.getJob("main")!.getStep("call-child")!.waitForNestedRun({
    workflowId: childWorkflow.id,
    workflowName: childWorkflow.name,
    runId: child.id,
  });
  parent.suspend();
  const runs = new Runs();
  runs.add(parent, child);
  return {
    parent,
    child,
    runs,
    deps: {
      runRepo: runs,
      workflowRepo: new Workflows(parentWorkflow, childWorkflow),
    },
  };
}

Deno.test("NestedRunLink.resolveChild: follows a link the child links back to", async () => {
  const { parent, child, deps } = linkedPair();
  const [wait] = parent.findNestedWaits();
  const resolved = await new NestedRunLink(deps).resolveChild(parent, wait);
  assert(resolved.kind === "resolved");
  assertEquals(resolved.child.id, child.id);
});

Deno.test("NestedRunLink.resolveChild: a missing child is reported, not followed", async () => {
  const { parent, child, runs, deps } = linkedPair();
  runs.byId.delete(child.id.toLowerCase());
  const [wait] = parent.findNestedWaits();
  const resolved = await new NestedRunLink(deps).resolveChild(parent, wait);
  assertEquals(resolved.kind, "missing");
});

Deno.test("NestedRunLink.resolveChild: refuses a child that links back to another step or run", async () => {
  const { parent, child, deps } = linkedPair();
  // The same child, but its back-link names another run.
  const back = child.parentRun;
  assert(back?.kind === "valid");
  const forged = WorkflowRun.fromData({
    ...child.toData(),
    parentRun: { ...back.ref, runId: "55555555-5555-4555-8555-555555555555" },
  });
  deps.runRepo.add(forged);
  const [wait] = parent.findNestedWaits();
  const resolved = await new NestedRunLink(deps).resolveChild(parent, wait);
  assertEquals(resolved.kind, "broken");
});

/**
 * A parent suspended on a child that an older binary saved: the child's
 * parentRun dropped, every other field kept, then `childFields` applied.
 */
function droppedBackLinkPair(
  childFields: Partial<WorkflowRunData> = {},
): {
  parent: WorkflowRun;
  child: WorkflowRun;
  deps: ReturnType<typeof linkedPair>["deps"];
} {
  const childWorkflow = gatedChildWorkflow();
  const parent = WorkflowRun.create(parentWorkflow, undefined, "user:alice");
  parent.start();
  const step = parent.getJob("main")!.getStep("call-child")!;
  step.start();
  const child = WorkflowRun.create(childWorkflow, undefined, "user:alice");
  child.recordParentRun({
    workflowId: parentWorkflow.id,
    workflowName: parentWorkflow.name,
    runId: parent.id,
    jobName: "main",
    stepName: "call-child",
    nestingDepth: 1,
    ancestorWorkflowNames: [parentWorkflow.name],
  });
  child.start();
  child.suspend();
  step.waitForNestedRun({
    workflowId: childWorkflow.id,
    workflowName: childWorkflow.name,
    runId: child.id,
  });
  parent.suspend();
  const { parentRun: _dropped, ...kept } = child.toData();
  const saved = WorkflowRun.fromData({ ...kept, ...childFields });
  const runs = new Runs();
  runs.add(parent, saved);
  return {
    parent,
    child: saved,
    deps: {
      runRepo: runs,
      workflowRepo: new Workflows(parentWorkflow, childWorkflow),
    },
  };
}

Deno.test("NestedRunLink.resolveChild: accepts a child an older binary saved without its back-link when the fields it kept agree", async () => {
  const { parent, child, deps } = droppedBackLinkPair();
  assertEquals(child.parentRun, undefined);
  const [wait] = parent.findNestedWaits();
  const resolved = await new NestedRunLink(deps).resolveChild(parent, wait);
  assert(resolved.kind === "resolved");
  assertEquals(resolved.child.id, child.id);
  assertEquals(resolved.backLinkDropped, true);
});

Deno.test("NestedRunLink.resolveChild: refuses a child without a back-link whose initiator, trigger source or start disagrees", async () => {
  const disagreements: Partial<WorkflowRunData>[] = [
    { initiatedBy: "user:mallory" },
    { triggerSource: "manual" },
    { startedAt: "2020-01-01T00:00:00.000Z" },
  ];
  for (const fields of disagreements) {
    const { parent, deps } = droppedBackLinkPair(fields);
    const [wait] = parent.findNestedWaits();
    const resolved = await new NestedRunLink(deps).resolveChild(parent, wait);
    assertEquals(resolved.kind, "broken", JSON.stringify(fields));
  }
});

Deno.test("NestedRunLink.resolveChild: a malformed link is broken and never read", async () => {
  const { parent, deps } = linkedPair();
  const malformed = WorkflowRun.fromData({
    ...parent.toData(),
    jobs: [{
      jobName: "main",
      status: "running",
      steps: [{
        stepName: "call-child",
        status: "waiting_approval",
        nestedRun: { runId: "../../outside" },
      }],
    }],
  });
  const [wait] = malformed.findNestedWaits();
  const resolved = await new NestedRunLink(deps).resolveChild(
    malformed,
    wait,
  );
  assertEquals(resolved.kind, "broken");
});

Deno.test("NestedRunLink: an unfinished child is pending with the gate to approve; a finished one settles", async () => {
  const { parent, child, deps } = linkedPair();
  const link = new NestedRunLink(deps);
  const [pending] = await link.pendingWaits(parent);
  assertEquals(pending.action.kind, "approve");
  assert(pending.action.kind === "approve");
  assertEquals(pending.action.stepName, "gate");
  assertEquals(pending.action.target.runId, child.id);
  assertEquals(await link.childrenSettled(parent), false);

  child.getJob("child-job")!.getStep("gate")!.succeed();
  assertEquals((await link.pendingWaits(parent))[0].action.kind, "resume");

  child.getJob("child-job")!.succeed();
  child.complete();
  assertEquals(await link.childrenSettled(parent), true);
});

Deno.test("NestedRunLink.describeWait: an expired gate is cancelled, not approved", async () => {
  const childWorkflow = gatedChildWorkflow(1);
  const { parent, child, runs, deps } = linkedPair(childWorkflow);
  const old = WorkflowRun.fromData({
    ...child.toData(),
    jobs: child.toData().jobs.map((job) => ({
      ...job,
      steps: job.steps.map((step) => ({
        ...step,
        startedAt: "2020-01-01T00:00:00.000Z",
      })),
    })),
  });
  runs.add(old);
  const [pending] = await new NestedRunLink(deps).pendingWaits(parent);
  assertEquals(pending.action.kind, "cancel");
});

Deno.test("NestedRunLink.describeWait: an interrupted child is recovered, a running one waited on", async () => {
  const { parent, child, deps } = linkedPair();
  const link = new NestedRunLink(deps);
  child.interrupt("crash");
  assertEquals((await link.pendingWaits(parent))[0].action.kind, "recover");
  const running = WorkflowRun.fromData({
    ...child.toData(),
    status: "running",
  });
  deps.runRepo.add(running);
  assertEquals((await link.pendingWaits(parent))[0].action.kind, "running");
});

Deno.test("NestedRunLink.isAwaitedByParent: only while the parent still waits on this exact run", async () => {
  const { parent, child, deps } = linkedPair();
  const link = new NestedRunLink(deps);
  assertEquals(await link.isAwaitedByParent(child), true);
  parent.endAsCancelled("stop");
  assertEquals(await link.isAwaitedByParent(child), false);
});

Deno.test("nestedWaitHint: names the --server form for a serve-owned run", () => {
  const target = {
    workflowId: "11111111-1111-4111-8111-111111111111",
    workflowName: "child",
    runId: "r-1",
    serveOwned: true,
  };
  const hint = nestedWaitHint({
    kind: "approve",
    target,
    jobName: "child-job",
    stepName: "gate",
  });
  assert(
    hint.includes("swamp workflow approve child gate --run r-1 --server <url>"),
  );
  assert(hint.includes("swamp workflow resume child --run r-1 --server <url>"));
});

Deno.test("nestedWaitHint: recover has no --server form, so a serve-owned run is recovered in the server's repository", () => {
  const target = {
    workflowId: "11111111-1111-4111-8111-111111111111",
    workflowName: "child",
    runId: "r-1",
    serveOwned: true,
  };
  const hint = nestedWaitHint({ kind: "recover", target });
  assert(hint.includes("'swamp workflow recover child --run r-1'"), hint);
  assert(!hint.includes("--server"), hint);
  assert(hint.includes("server's repository"), hint);
});

Deno.test("assertNestedWaitsSettled: refuses with every child named, and a generic message for callers that may not reveal them", async () => {
  const { parent, child, deps } = linkedPair();
  const error = await assertRejects(
    () => assertNestedWaitsSettled(deps, parent),
    NestedRunPendingError,
  );
  assert(error.message.includes(child.id));
  assert(error.message.includes(`--run ${parent.id}`));
  assertEquals(error.genericMessage.includes(child.id), false);

  child.getJob("child-job")!.getStep("gate")!.succeed();
  child.getJob("child-job")!.succeed();
  child.complete();
  await assertNestedWaitsSettled(deps, parent);
});

/** A parent suspended on a child that waits for a signal opened at `now`. */
function signalWaitPair(now: Date, timeoutSeconds: number) {
  const childWorkflow = Workflow.create({
    name: "child",
    jobs: [
      Job.create({
        name: "child-job",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(timeoutSeconds, { type: "object" }),
          }),
        ],
      }),
    ],
  });
  const parent = WorkflowRun.create(parentWorkflow);
  parent.start();
  const child = WorkflowRun.create(childWorkflow);
  child.recordParentRun({
    workflowId: parentWorkflow.id,
    workflowName: parentWorkflow.name,
    runId: parent.id,
    jobName: "main",
    stepName: "call-child",
    nestingDepth: 1,
    ancestorWorkflowNames: [parentWorkflow.name],
  });
  child.start();
  const review = child.getJob("child-job")!.getStep("review")!;
  review.start();
  const wait = SignalWait.open({ type: "object" }, timeoutSeconds, now);
  review.waitForSignal(wait);
  child.suspend();
  parent.getJob("main")!.getStep("call-child")!.waitForNestedRun({
    workflowId: childWorkflow.id,
    workflowName: childWorkflow.name,
    runId: child.id,
  });
  parent.suspend();
  const runs = new Runs();
  runs.add(parent, child);
  return {
    parent,
    child,
    wait,
    deps: {
      runRepo: runs,
      workflowRepo: new Workflows(parentWorkflow, childWorkflow),
    },
  };
}

Deno.test("NestedRunLink.describeWait: a child with an open signal wait is signalled, and the hint names the wait", async () => {
  const { parent, deps, wait, child } = signalWaitPair(new Date(), 3600);

  const [pending] = await new NestedRunLink(deps).pendingWaits(parent);

  assertEquals(pending.action, {
    kind: "signal",
    target: pending.action.target,
    jobName: "child-job",
    stepName: "review",
    waitId: wait.id,
    deadline: wait.deadline.toISOString(),
  });
  const hint = nestedWaitHint(pending.action);
  assert(hint.includes(`swamp workflow signal ${wait.id}`));
  assert(hint.includes(`swamp workflow resume child --run ${child.id}`));
});

Deno.test("NestedRunLink.describeWait: a child whose signal wait expired is resumed, which fails its step", async () => {
  const { parent, deps } = signalWaitPair(
    new Date("2020-01-01T00:00:00.000Z"),
    1,
  );

  const [pending] = await new NestedRunLink(deps).pendingWaits(parent);

  assertEquals(pending.action.kind, "resume");
});

Deno.test("nestedWaitHint: the signal command quotes its payload placeholder so it can be pasted", () => {
  const hint = nestedWaitHint({
    kind: "signal",
    target: {
      workflowId: "w",
      workflowName: "child",
      runId: "r-1",
      serveOwned: false,
    },
    jobName: "child-job",
    stepName: "review",
    waitId: "wait-1",
    deadline: "2026-01-01T00:00:00.000Z",
  });

  assert(
    hint.includes("swamp workflow signal wait-1 --payload '<json>', then"),
    hint,
  );
});

Deno.test("nestedWaitHint: the signal command for a serve-owned run takes the server form", () => {
  const hint = nestedWaitHint({
    kind: "signal",
    target: {
      workflowId: "w",
      workflowName: "child",
      runId: "r-1",
      serveOwned: true,
    },
    jobName: "child-job",
    stepName: "review",
    waitId: "wait-1",
    deadline: "2026-01-01T00:00:00.000Z",
  });

  assert(
    hint.includes(
      "swamp workflow signal wait-1 --payload '<json>' --server <url>, then",
    ),
    hint,
  );
});

Deno.test("NestedRunLink.describeWait: with a wait store, the signal action carries the job and deadline of the open wait", async () => {
  const { parent, deps, wait } = signalWaitPair(new Date(), 3600);
  const store = new InMemorySignalWaitStore();

  const [pending] = await new NestedRunLink({
    ...deps,
    signalWaits: { supported: true, store },
  }).pendingWaits(parent);

  assertEquals(pending.action.kind, "signal");
  if (pending.action.kind !== "signal") return;
  assertEquals(pending.action.jobName, "child-job");
  assertEquals(pending.action.deadline, wait.deadline.toISOString());
});
