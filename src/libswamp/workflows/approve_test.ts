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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowApprove,
  type WorkflowApproveDeps,
  type WorkflowApproveEvent,
} from "./approve.ts";
import {
  workflowReject,
  type WorkflowRejectDeps,
  type WorkflowRejectEvent,
} from "./reject.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { cancelAndSettle } from "../../domain/workflows/abort_settlement.ts";
import {
  unclaimedRuns,
  type WorkflowRunClaims,
} from "../../domain/workflows/run_claim.ts";
import { SignalWait } from "../../domain/workflows/signal_wait.ts";

/** The approve deps, with no evaluated snapshot to settle a reject against. */
function rejectDeps(deps: WorkflowApproveDeps): WorkflowRejectDeps {
  return { ...deps, findEvaluatedWorkflow: () => Promise.resolve(null) };
}

function makeWorkflow(gateNames: string[], name = "gated"): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          ...gateNames.map((name) =>
            Step.create({
              name,
              task: StepTask.manualApproval(`Approve ${name}`),
            })
          ),
          Step.create({
            name: "deploy",
            task: StepTask.model("deployer", "run"),
          }),
        ],
      }),
    ],
  });
}

/** Suspends a run with every named gate parked in waiting_approval. */
function suspendAtGates(workflow: Workflow, gateNames: string[]): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  for (const name of gateNames) {
    const step = job.getStep(name)!;
    step.start();
    step.waitForApproval();
  }
  run.suspend();
  return run;
}

function makeDeps(workflow: Workflow, run: WorkflowRun): WorkflowApproveDeps {
  return {
    runClaims: unclaimedRuns,
    workflowRepo: {
      findByName: (name: string) =>
        Promise.resolve(name === workflow.name ? workflow : null),
      findById: () => Promise.resolve(null),
    } as unknown as WorkflowApproveDeps["workflowRepo"],
    runRepo: {
      findById: () => Promise.resolve(run),
      findAllByWorkflowId: () => Promise.resolve([run]),
      save: () => Promise.resolve(),
    } as unknown as WorkflowApproveDeps["runRepo"],
  };
}

async function approve(
  deps: WorkflowApproveDeps,
  stepName: string,
): Promise<WorkflowApproveEvent | undefined> {
  const events = await collect<WorkflowApproveEvent>(
    workflowApprove(createLibSwampContext(), deps, {
      workflowIdOrName: "gated",
      stepName,
      decidedBy: "approver",
    }),
  );
  return events.at(-1);
}

Deno.test("workflowApprove: reports allGatesDecided when the last gate is approved", async () => {
  const workflow = makeWorkflow(["gate"]);
  const run = suspendAtGates(workflow, ["gate"]);

  const last = await approve(makeDeps(workflow, run), "gate");

  assertEquals(last?.kind, "completed");
  if (last?.kind === "completed") {
    assertEquals(last.data.allGatesDecided, true);
    assertEquals(last.data.runId, run.id);
    assertEquals(last.data.workflowName, "gated");
  }
});

Deno.test("workflowApprove: reports allGatesDecided false while a sibling gate still waits", async () => {
  const workflow = makeWorkflow(["gate-a", "gate-b"]);
  const run = suspendAtGates(workflow, ["gate-a", "gate-b"]);
  const deps = makeDeps(workflow, run);

  const first = await approve(deps, "gate-a");
  assertEquals(first?.kind, "completed");
  if (first?.kind === "completed") {
    assertEquals(first.data.allGatesDecided, false);
  }

  const second = await approve(deps, "gate-b");
  assertEquals(second?.kind, "completed");
  if (second?.kind === "completed") {
    assertEquals(second.data.allGatesDecided, true);
  }
});

/**
 * Deps holding `target` and an impostor workflow named with `target`'s id,
 * each with its own suspended run, and recording which workflow's run was
 * saved.
 */
function makeCollidingDeps(): {
  deps: WorkflowApproveDeps;
  target: Workflow;
  targetRun: WorkflowRun;
  impostorRun: WorkflowRun;
  savedFor: string[];
} {
  const target = makeWorkflow(["gate"]);
  const impostor = makeWorkflow(["gate"], target.id);
  const targetRun = suspendAtGates(target, ["gate"]);
  const impostorRun = suspendAtGates(impostor, ["gate"]);
  const workflows = [target, impostor];
  const runs = new Map<string, WorkflowRun>([
    [target.id, targetRun],
    [impostor.id, impostorRun],
  ]);
  const savedFor: string[] = [];
  return {
    target,
    targetRun,
    impostorRun,
    savedFor,
    deps: {
      runClaims: unclaimedRuns,
      workflowRepo: {
        findByName: (name: string) =>
          Promise.resolve(workflows.find((w) => w.name === name) ?? null),
        findById: (id: string) =>
          Promise.resolve(workflows.find((w) => w.id === id) ?? null),
      } as unknown as WorkflowApproveDeps["workflowRepo"],
      runRepo: {
        findById: (wfId: string) => Promise.resolve(runs.get(wfId) ?? null),
        findAllByWorkflowId: (wfId: string) =>
          Promise.resolve(runs.has(wfId) ? [runs.get(wfId)!] : []),
        save: (wfId: string) => {
          savedFor.push(wfId);
          return Promise.resolve();
        },
      } as unknown as WorkflowApproveDeps["runRepo"],
    },
  };
}

Deno.test("workflowApprove: byId approves the workflow whose id matches, not one named with that id", async () => {
  const { deps, target, targetRun, savedFor } = makeCollidingDeps();

  const events = await collect<WorkflowApproveEvent>(
    workflowApprove(createLibSwampContext(), deps, {
      workflowIdOrName: target.id,
      byId: true,
      stepName: "gate",
      decidedBy: "approver",
    }),
  );
  const last = events.at(-1);

  assertEquals(last?.kind, "completed");
  if (last?.kind === "completed") {
    assertEquals(last.data.runId, targetRun.id);
    assertEquals(last.data.workflowName, "gated");
  }
  assertEquals(savedFor, [target.id]);
});

Deno.test("workflowApprove: without byId a workflow named with the id wins", async () => {
  const { deps, target, impostorRun } = makeCollidingDeps();

  const events = await collect<WorkflowApproveEvent>(
    workflowApprove(createLibSwampContext(), deps, {
      workflowIdOrName: target.id,
      stepName: "gate",
      decidedBy: "approver",
    }),
  );
  const last = events.at(-1);

  assertEquals(last?.kind, "completed");
  if (last?.kind === "completed") {
    assertEquals(last.data.runId, impostorRun.id);
  }
});

// --- Nested waits (swamp-club#2736) ------------------------------------------

/**
 * A run with one gate beside a nested step waiting on a child run, and the
 * child, which links back to it.
 */
function gateBesideNestedWait(childStatus: "suspended" | "succeeded"): {
  workflow: Workflow;
  run: WorkflowRun;
  deps: WorkflowApproveDeps;
} {
  const workflow = Workflow.create({
    name: "gated",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "gate", task: StepTask.manualApproval("ok") }),
          Step.create({ name: "call-child", task: StepTask.workflow("child") }),
        ],
      }),
    ],
  });
  const childWorkflow = makeWorkflow([], "child");
  const run = suspendAtGates(workflow, ["gate"]);
  const child = WorkflowRun.create(childWorkflow);
  child.recordParentRun({
    workflowId: workflow.id,
    workflowName: workflow.name,
    runId: run.id,
    jobName: "main",
    stepName: "call-child",
    nestingDepth: 1,
    ancestorWorkflowNames: [workflow.name],
  });
  child.start();
  if (childStatus === "succeeded") {
    child.getJob("main")!.succeed();
    child.complete();
  } else {
    child.suspend();
  }
  run.getJob("main")!.getStep("call-child")!.waitForNestedRun({
    workflowId: childWorkflow.id,
    workflowName: childWorkflow.name,
    runId: child.id,
  });
  const deps: WorkflowApproveDeps = {
    runClaims: unclaimedRuns,
    workflowRepo: {
      findByName: (name: string) =>
        Promise.resolve(name === workflow.name ? workflow : null),
      findById: () => Promise.resolve(null),
    } as unknown as WorkflowApproveDeps["workflowRepo"],
    runRepo: {
      findById: (_w: string, id: string) =>
        Promise.resolve(id === child.id ? child : run),
      findAllByWorkflowId: () => Promise.resolve([run]),
      save: () => Promise.resolve(),
    } as unknown as WorkflowApproveDeps["runRepo"],
  };
  return { workflow, run, deps };
}

Deno.test("workflowApprove: a nested step waiting on its child run is not a gate to approve", async () => {
  const { deps } = gateBesideNestedWait("suspended");
  const last = await approve(deps, "call-child");
  assertEquals(last?.kind, "error");
  // The refusal points at the nested run to decide instead.
  if (last?.kind === "error") {
    assertEquals(last.error.message.includes("waits on nested run"), true);
    assertEquals(
      last.error.message.includes("swamp workflow resume child --run"),
      true,
    );
  }
});

Deno.test("workflowApprove: allGatesDecided waits for the nested run to finish, derived from the child", async () => {
  const pending = await approve(gateBesideNestedWait("suspended").deps, "gate");
  assertEquals(
    pending?.kind === "completed" && pending.data.allGatesDecided,
    false,
  );
  const settled = await approve(gateBesideNestedWait("succeeded").deps, "gate");
  assertEquals(
    settled?.kind === "completed" && settled.data.allGatesDecided,
    true,
  );
});

Deno.test("workflowApprove: an unreadable linked run after the decision is saved does not turn the approval into an error", async () => {
  const { deps, run } = gateBesideNestedWait("suspended");
  const throwing: WorkflowApproveDeps = {
    ...deps,
    runRepo: {
      ...deps.runRepo,
      // The run itself is read again under its claim; only its linked run
      // is unreadable.
      findById: (_w: string, id: string) =>
        id === run.id
          ? Promise.resolve(run)
          : Promise.reject(new Error("corrupt run file")),
      save: () => Promise.resolve(),
    } as unknown as WorkflowApproveDeps["runRepo"],
  };
  const last = await approve(throwing, "gate");
  assertEquals(last?.kind, "completed");
  if (last?.kind === "completed") {
    assertEquals(last.data.allGatesDecided, false);
    assertEquals(last.data.awaitingParent, undefined);
  }
});

Deno.test("workflowApprove: a run failed by a rejected parallel gate names --from that gate", async () => {
  // Two parallel jobs, each suspended at its own gate (swamp-club#2899).
  const workflow = Workflow.create({
    name: "gated",
    jobs: ["side", "main"].map((jobName) =>
      Job.create({
        name: jobName,
        steps: [
          Step.create({
            name: `${jobName}-gate`,
            task: StepTask.manualApproval(`Approve ${jobName}`),
          }),
        ],
      })
    ),
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  for (const job of run.jobs) {
    job.start();
    const step = job.steps[0];
    step.start();
    step.waitForApproval();
  }
  run.suspend();
  const deps = makeDeps(workflow, run);
  const rejected = await collect<WorkflowRejectEvent>(
    workflowReject(createLibSwampContext(), rejectDeps(deps), {
      workflowIdOrName: "gated",
      stepName: "side-gate",
      runId: run.id,
      decidedBy: "approver",
    }),
  );
  assertEquals(rejected.at(-1)?.kind, "completed");
  // The reject settled the other gate, so nothing is left to approve.
  assertEquals(run.getJob("main")!.steps[0].status, "failed");

  const last = await approve(deps, "main-gate");

  if (last?.kind !== "error") {
    throw new Error(`expected an error event, got ${last?.kind}`);
  }
  assertEquals(last.error.code, "validation_failed");
  assertEquals(
    last.error.message,
    `No suspended runs found for workflow "gated". The latest run is failed. ` +
      `Ask again with 'swamp workflow resume gated --run ${run.id} --from side-gate'.`,
  );
});

/**
 * Deps over one stored run record, read as a fresh copy each time as a
 * repository does, with claims that run `beforeClaimed` once the claim is
 * taken and before the claimed work starts.
 */
function makeStoredRunDeps(
  workflow: Workflow,
  run: WorkflowRun,
  beforeClaimed: (stored: { data: ReturnType<WorkflowRun["toData"]> }) => void =
    () => {},
) {
  const stored = { data: run.toData() };
  const saves: string[] = [];
  const claimed: string[] = [];
  let claimHeld = false;
  const runClaims: WorkflowRunClaims = {
    withClaim: async (runId, fn) => {
      claimed.push(runId);
      claimHeld = true;
      beforeClaimed(stored);
      try {
        return await fn();
      } finally {
        claimHeld = false;
      }
    },
  };
  const read = () => Promise.resolve(WorkflowRun.fromData(stored.data));
  const deps: WorkflowApproveDeps = {
    runClaims,
    workflowRepo: {
      findByName: (name: string) =>
        Promise.resolve(name === workflow.name ? workflow : null),
      findById: () => Promise.resolve(null),
    } as unknown as WorkflowApproveDeps["workflowRepo"],
    runRepo: {
      findById: read,
      findAllByWorkflowId: async () => [await read()],
      save: (_w: string, saved: WorkflowRun) => {
        saves.push(claimHeld ? "claimed" : "unclaimed");
        stored.data = saved.toData();
        return Promise.resolve();
      },
    } as unknown as WorkflowApproveDeps["runRepo"],
  };
  return { deps, stored, saves, claimed };
}

Deno.test("workflowApprove: reads the run and saves the decision under the run's claim", async () => {
  const workflow = makeWorkflow(["gate"]);
  const run = suspendAtGates(workflow, ["gate"]);
  const { deps, stored, saves, claimed } = makeStoredRunDeps(workflow, run);

  const last = await approve(deps, "gate");

  assertEquals(last?.kind, "completed");
  assertEquals(claimed, [run.id]);
  assertEquals(saves, ["claimed"]);
  assertEquals(
    WorkflowRun.fromData(stored.data).getJob("main")!.getStep("gate")!.status,
    "succeeded",
  );
});

Deno.test("workflowApprove: refuses a run cancelled before the claim was taken, and saves nothing", async () => {
  const workflow = makeWorkflow(["gate"]);
  const run = suspendAtGates(workflow, ["gate"]);
  // The cancel lands after approve first read the run suspended.
  const { deps, stored, saves } = makeStoredRunDeps(
    workflow,
    run,
    (record) => {
      const cancelled = WorkflowRun.fromData(record.data);
      cancelAndSettle(cancelled, workflow, "Cancelled by user");
      record.data = cancelled.toData();
    },
  );

  const last = await approve(deps, "gate");

  assertEquals(last?.kind, "error");
  if (last?.kind === "error") {
    assertEquals(
      last.error.message.includes("is not suspended (status: cancelled)"),
      true,
    );
  }
  assertEquals(saves, []);
  assertEquals(stored.data.status, "cancelled");
});

Deno.test("workflowReject: refuses a run cancelled before the claim was taken, and saves nothing", async () => {
  const workflow = makeWorkflow(["gate"]);
  const run = suspendAtGates(workflow, ["gate"]);
  const { deps, stored, saves, claimed } = makeStoredRunDeps(
    workflow,
    run,
    (record) => {
      const cancelled = WorkflowRun.fromData(record.data);
      cancelAndSettle(cancelled, workflow, "Cancelled by user");
      record.data = cancelled.toData();
    },
  );

  const events = await collect<WorkflowRejectEvent>(
    workflowReject(createLibSwampContext(), rejectDeps(deps), {
      workflowIdOrName: "gated",
      stepName: "gate",
      decidedBy: "approver",
    }),
  );
  const last = events.at(-1);

  assertEquals(claimed, [run.id]);
  assertEquals(last?.kind, "error");
  if (last?.kind === "error") {
    assertEquals(
      last.error.message.includes("is not suspended (status: cancelled)"),
      true,
    );
  }
  assertEquals(saves, []);
  assertEquals(stored.data.status, "cancelled");
});

Deno.test("workflowReject: reads the run and saves the decision under the run's claim", async () => {
  const workflow = makeWorkflow(["gate"]);
  const run = suspendAtGates(workflow, ["gate"]);
  const { deps, stored, saves, claimed } = makeStoredRunDeps(workflow, run);

  const events = await collect<WorkflowRejectEvent>(
    workflowReject(createLibSwampContext(), rejectDeps(deps), {
      workflowIdOrName: "gated",
      stepName: "gate",
      decidedBy: "approver",
    }),
  );

  assertEquals(events.at(-1)?.kind, "completed");
  assertEquals(claimed, [run.id]);
  assertEquals(saves, ["claimed"]);
  assertEquals(stored.data.status, "failed");
});

Deno.test("workflowApprove: reports allGatesDecided false while a step still waits for a signal, open or expired", async () => {
  for (const opened of [new Date(), new Date("2020-01-01T00:00:00.000Z")]) {
    const workflow = makeWorkflow(["gate"]);
    const run = suspendAtGates(workflow, ["gate"]);
    // The deploy step stands in for a wait_for_signal step beside the gate.
    run.getJob("main")!.getStep("deploy")!.waitForSignal(
      SignalWait.open({ type: "object" }, 60, opened),
    );

    const last = await approve(makeDeps(workflow, run), "gate");

    assertEquals(last?.kind, "completed");
    if (last?.kind === "completed") {
      assertEquals(last.data.allGatesDecided, false);
    }
  }
});

Deno.test("workflowApprove: a step waiting for a signal is not a gate to approve", async () => {
  const workflow = makeWorkflow(["gate"]);
  const run = suspendAtGates(workflow, ["gate"]);
  run.getJob("main")!.getStep("deploy")!.waitForSignal(
    SignalWait.open({ type: "object" }, 60, new Date()),
  );

  const last = await approve(makeDeps(workflow, run), "deploy");

  assertEquals(last?.kind, "error");
  assertEquals(run.getJob("main")!.getStep("deploy")!.status, "waiting_signal");
});

// --- timeout of a forEach-expanded gate (swamp-club#3218) ---

/**
 * A run suspended two hours ago on `approve-prod`, expanded from a forEach
 * gate with a one-hour timeout. `recorded` is whether the step run holds the
 * timeout, which a run suspended before swamp-club#3218 does not.
 */
function expiredForEachGate(
  recorded: boolean,
): { workflow: Workflow; run: WorkflowRun } {
  const template = "approve-${{ self.env }}";
  const workflow = Workflow.create({
    name: "gated",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: template,
            task: StepTask.manualApproval("Deploy?", 3600),
            forEach: { item: "env", in: "${{ inputs.envs }}" },
          }),
        ],
      }),
    ],
  });
  const suspended = WorkflowRun.create(workflow);
  suspended.start();
  suspended.getJob("main")!.start();
  suspended.suspend();
  const data = suspended.toData();
  const run = WorkflowRun.fromData({
    ...data,
    jobs: data.jobs.map((job) => ({
      ...job,
      steps: [{
        stepName: "approve-prod",
        status: "waiting_approval" as const,
        startedAt: new Date(Date.now() - 7_200_000).toISOString(),
        approvalPrompt: "Deploy?",
        forEachTemplate: template,
        ...(recorded ? { approvalTimeout: 3600 } : {}),
      }],
    })),
  });
  return { workflow, run };
}

for (const recorded of [true, false]) {
  const which = recorded
    ? "past its timeout"
    : "past its timeout on a run suspended before the step run held it";

  Deno.test(`workflowApprove: refuses a forEach-expanded gate ${which}`, async () => {
    const { workflow, run } = expiredForEachGate(recorded);

    const last = await approve(makeDeps(workflow, run), "approve-prod");

    assertEquals(last?.kind, "error");
    if (last?.kind === "error") {
      assertStringIncludes(
        last.error.message,
        'Approval timed out: step "approve-prod"',
      );
      assertStringIncludes(last.error.message, "(timeout: 3600s)");
    }
    assertEquals(
      run.getJob("main")!.getStep("approve-prod")!.status,
      "waiting_approval",
    );
  });

  Deno.test(`workflowReject: refuses a forEach-expanded gate ${which}`, async () => {
    const { workflow, run } = expiredForEachGate(recorded);

    const events = await collect<WorkflowRejectEvent>(
      workflowReject(
        createLibSwampContext(),
        rejectDeps(makeDeps(workflow, run)),
        { workflowIdOrName: "gated", stepName: "approve-prod", decidedBy: "x" },
      ),
    );
    const last = events.at(-1);

    assertEquals(last?.kind, "error");
    if (last?.kind === "error") {
      assertStringIncludes(
        last.error.message,
        'Approval timed out: step "approve-prod"',
      );
    }
    assertEquals(
      run.getJob("main")!.getStep("approve-prod")!.status,
      "waiting_approval",
    );
  });
}

Deno.test("workflowApprove: approves a forEach-expanded gate inside its timeout", async () => {
  const { workflow, run } = expiredForEachGate(true);
  const step = run.getJob("main")!.getStep("approve-prod")!;
  step.start();
  step.waitForApproval("Deploy?", 3600);

  const last = await approve(makeDeps(workflow, run), "approve-prod");

  assertEquals(last?.kind, "completed");
  assertEquals(step.status, "succeeded");
});
