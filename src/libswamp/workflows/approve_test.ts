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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowApprove,
  type WorkflowApproveDeps,
  type WorkflowApproveEvent,
} from "./approve.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";

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
