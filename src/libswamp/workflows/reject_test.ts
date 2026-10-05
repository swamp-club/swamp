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
  workflowReject,
  type WorkflowRejectDeps,
  type WorkflowRejectEvent,
} from "./reject.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { unclaimedRuns } from "../../domain/workflows/run_claim.ts";

function makeWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve gate"),
          }),
          Step.create({
            name: "deploy",
            task: StepTask.model("deployer", "run"),
          }),
        ],
      }),
    ],
  });
}

function suspendAtGate(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("gate")!;
  step.start();
  step.waitForApproval();
  run.suspend();
  return run;
}

/**
 * Deps holding `target` and an impostor workflow named with `target`'s id,
 * each with its own suspended run, and recording which workflow's run was
 * saved.
 */
function makeCollidingDeps(): {
  deps: WorkflowRejectDeps;
  target: Workflow;
  targetRun: WorkflowRun;
  impostorRun: WorkflowRun;
  savedFor: string[];
} {
  const target = makeWorkflow("gated");
  const impostor = makeWorkflow(target.id);
  const targetRun = suspendAtGate(target);
  const impostorRun = suspendAtGate(impostor);
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
      } as unknown as WorkflowRejectDeps["workflowRepo"],
      runRepo: {
        findById: (wfId: string) => Promise.resolve(runs.get(wfId) ?? null),
        findAllByWorkflowId: (wfId: string) =>
          Promise.resolve(runs.has(wfId) ? [runs.get(wfId)!] : []),
        save: (wfId: string) => {
          savedFor.push(wfId);
          return Promise.resolve();
        },
      } as unknown as WorkflowRejectDeps["runRepo"],
    },
  };
}

Deno.test("workflowReject: byId rejects the workflow whose id matches, not one named with that id", async () => {
  const { deps, target, targetRun, impostorRun, savedFor } =
    makeCollidingDeps();

  const events = await collect<WorkflowRejectEvent>(
    workflowReject(createLibSwampContext(), deps, {
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
  assertEquals(targetRun.status, "failed");
  assertEquals(impostorRun.status, "suspended");
});

Deno.test("workflowReject: without byId a workflow named with the id wins", async () => {
  const { deps, target, impostorRun } = makeCollidingDeps();

  const events = await collect<WorkflowRejectEvent>(
    workflowReject(createLibSwampContext(), deps, {
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

Deno.test("workflowReject: byId does not fall back to a name lookup", async () => {
  const { deps } = makeCollidingDeps();

  const events = await collect<WorkflowRejectEvent>(
    workflowReject(createLibSwampContext(), deps, {
      workflowIdOrName: "gated",
      byId: true,
      stepName: "gate",
      decidedBy: "approver",
    }),
  );
  const last = events.at(-1);

  assertEquals(last?.kind, "error");
  if (last?.kind === "error") {
    assertEquals(last.error.message.includes("Workflow not found"), true);
  }
});

/**
 * Two parallel jobs, each suspended at its own gate, as in swamp-club#2899:
 * rejecting one gate fails the run while the other gate still waits.
 */
function suspendAtParallelGates(): { workflow: Workflow; run: WorkflowRun } {
  const workflow = Workflow.create({
    name: "parallel",
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
  return { workflow, run };
}

Deno.test("workflowReject: a run failed by a rejected parallel gate names --from that gate", async () => {
  const { workflow, run } = suspendAtParallelGates();
  const deps: WorkflowRejectDeps = {
    runClaims: unclaimedRuns,
    workflowRepo: {
      findByName: (name: string) =>
        Promise.resolve(name === workflow.name ? workflow : null),
      findById: () => Promise.resolve(null),
    } as unknown as WorkflowRejectDeps["workflowRepo"],
    runRepo: {
      findById: () => Promise.resolve(run),
      findAllByWorkflowId: () => Promise.resolve([run]),
      save: () => Promise.resolve(),
    } as unknown as WorkflowRejectDeps["runRepo"],
  };
  const reject = async (stepName: string) =>
    (await collect<WorkflowRejectEvent>(
      workflowReject(createLibSwampContext(), deps, {
        workflowIdOrName: "parallel",
        stepName,
        runId: run.id,
        decidedBy: "approver",
      }),
    )).at(-1);

  assertEquals((await reject("side-gate"))?.kind, "completed");
  assertEquals(run.getJob("main")!.steps[0].status, "waiting_approval");

  const last = await reject("main-gate");
  if (last?.kind !== "error") {
    throw new Error(`expected an error event, got ${last?.kind}`);
  }
  assertEquals(last.error.code, "validation_failed");
  assertEquals(
    last.error.message,
    `Run ${run.id} is not suspended (status: failed). Ask again with ` +
      `'swamp workflow resume parallel --run ${run.id} --from side-gate'.`,
  );
});
