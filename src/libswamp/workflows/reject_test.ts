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
import {
  CANCELLED_STEP_ERROR,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import { TriggerCondition } from "../../domain/workflows/trigger_condition.ts";
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
      findEvaluatedWorkflow: () => Promise.resolve(null),
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
 * rejecting one gate fails the run and settles the other gate.
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
    findEvaluatedWorkflow: () => Promise.resolve(null),
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
  const mainGate = run.getJob("main")!.steps[0];
  assertEquals(mainGate.status, "failed");
  assertEquals(mainGate.error, CANCELLED_STEP_ERROR);
  assertEquals(mainGate.settledByAbort, true);
  assertEquals(run.getJob("main")!.status, "failed");

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

/** A gate, and a model step that runs once the gate succeeds. */
function gatedJob(name: string, gateName: string, after: string): Job {
  return Job.create({
    name,
    steps: [
      Step.create({
        name: gateName,
        task: StepTask.manualApproval(`${gateName}?`),
      }),
      Step.create({
        name: after,
        task: StepTask.model("worker", "run"),
        dependsOn: [{
          step: gateName,
          condition: TriggerCondition.succeeded(),
        }],
      }),
    ],
  });
}

/**
 * The workflow of swamp-club#2905: two parallel gated jobs and a teardown
 * job that always follows `main`.
 */
function issueWorkflow(mainJobName = "main"): Workflow {
  return Workflow.create({
    name: "e2e-wf",
    jobs: [
      gatedJob("a-side", "gate2", "s"),
      gatedJob(mainJobName, "gate", "post"),
      Job.create({
        name: "teardown",
        steps: [
          Step.create({ name: "t", task: StepTask.model("worker", "run") }),
        ],
        dependsOn: [{ job: mainJobName, condition: TriggerCondition.always() }],
      }),
    ],
  });
}

/** The run of `workflow`, suspended with both gates waiting. */
function suspendAtBothGates(
  workflow: Workflow,
  options: { snapshot?: boolean } = {},
): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  if (options.snapshot) run.captureRunPlan("fingerprint", run.id);
  for (const job of run.jobs.slice(0, 2)) {
    job.start();
    job.steps[0].start();
    job.steps[0].waitForApproval();
  }
  run.suspend();
  return WorkflowRun.fromData(run.toData());
}

function storedRunDeps(
  workflow: Workflow,
  run: WorkflowRun,
  findEvaluatedWorkflow: WorkflowRejectDeps["findEvaluatedWorkflow"] = () =>
    Promise.resolve(null),
): WorkflowRejectDeps {
  return {
    runClaims: unclaimedRuns,
    findEvaluatedWorkflow,
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
}

function statuses(run: WorkflowRun): Record<string, string> {
  const result: Record<string, string> = {};
  for (const job of run.jobs) {
    result[job.jobName] = job.status;
    for (const step of job.steps) {
      result[`${job.jobName}/${step.stepName}`] = step.status;
    }
  }
  return result;
}

Deno.test("workflowReject: settles the work the rejection leaves unfinished", async () => {
  const workflow = issueWorkflow();
  const run = suspendAtBothGates(workflow);

  const events = await collect<WorkflowRejectEvent>(
    workflowReject(createLibSwampContext(), storedRunDeps(workflow, run), {
      workflowIdOrName: "e2e-wf",
      stepName: "gate2",
      reason: "not today",
      runId: run.id,
      decidedBy: "approver",
    }),
  );

  assertEquals(events.at(-1)?.kind, "completed");
  assertEquals(run.status, "failed");
  assertEquals(statuses(run), {
    "a-side": "failed",
    "a-side/gate2": "failed",
    "a-side/s": "skipped",
    "main": "failed",
    "main/gate": "failed",
    "main/post": "skipped",
    "teardown": "failed",
    "teardown/t": "failed",
  });
  const rejected = run.getJob("a-side")!.getStep("gate2")!;
  assertEquals(rejected.error, "not today");
  assertEquals(rejected.settledByAbort, false);
  assertEquals(rejected.approvalDecision?.approved, false);
  const sibling = run.getJob("main")!.getStep("gate")!;
  assertEquals(sibling.error, CANCELLED_STEP_ERROR);
  assertEquals(sibling.approvalDecision, undefined);
  for (const ref of ["a-side/s", "main/gate", "main/post", "teardown/t"]) {
    const [jobName, stepName] = ref.split("/");
    assertEquals(
      run.getJob(jobName)!.getStep(stepName)!.settledByAbort,
      true,
      ref,
    );
  }
});

Deno.test("workflowReject: the run reports the rejected gate, not a settled gate stored before it", async () => {
  const workflow = issueWorkflow();
  const run = suspendAtBothGates(workflow);

  await collect<WorkflowRejectEvent>(
    workflowReject(createLibSwampContext(), storedRunDeps(workflow, run), {
      workflowIdOrName: "e2e-wf",
      stepName: "gate",
      reason: "not today",
      runId: run.id,
      decidedBy: "approver",
    }),
  );

  assertEquals(run.getJob("a-side")!.getStep("gate2")!.status, "failed");
  const data = run.toData();
  assertEquals(data.failedStep, "gate");
  assertEquals(data.failureReason, "not today");
});

Deno.test("workflowReject: settles against the run's evaluated snapshot", async () => {
  // The run's records carry the evaluated job name; the repository
  // definition still has the expression.
  const evaluated = issueWorkflow("main-prod");
  const repository = issueWorkflow("main-${{ inputs.env }}");
  const run = suspendAtBothGates(evaluated, { snapshot: true });
  let lookedUp: string | undefined;

  await collect<WorkflowRejectEvent>(
    workflowReject(
      createLibSwampContext(),
      storedRunDeps(repository, run, (id) => {
        lookedUp = id;
        return Promise.resolve(evaluated);
      }),
      {
        workflowIdOrName: "e2e-wf",
        stepName: "gate2",
        runId: run.id,
        decidedBy: "approver",
      },
    ),
  );

  assertEquals(lookedUp, run.id);
  // Settled in dependency order: `post` is skipped behind its cancelled
  // gate, where settling from the records alone would cancel it.
  assertEquals(run.getJob("main-prod")!.getStep("post")!.status, "skipped");
});
