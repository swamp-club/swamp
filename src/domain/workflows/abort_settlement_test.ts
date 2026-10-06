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
import {
  cancelAndSettle,
  completeAndSettle,
  resolveSettlementWorkflow,
  settleCancelledRun,
} from "./abort_settlement.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import { CANCELLED_STEP_ERROR, WorkflowRun } from "./workflow_run.ts";
import { SignalWait } from "./signal_wait.ts";

function gate(name: string): Step {
  return Step.create({ name, task: StepTask.manualApproval(`${name}?`) });
}

function modelStep(
  name: string,
  after?: { step: string; condition: TriggerCondition },
  extra: { guard?: string; forEach?: { item: string; in: string } } = {},
): Step {
  return Step.create({
    name,
    task: StepTask.model("m", "run"),
    dependsOn: after ? [after] : [],
    ...extra,
  });
}

function job(
  name: string,
  steps: Step[],
  after?: { job: string; condition: TriggerCondition },
): Job {
  return Job.create({ name, steps, dependsOn: after ? [after] : [] });
}

/** The issue's workflow: two gated parallel jobs and an always-teardown. */
function issueWorkflow(): Workflow {
  return Workflow.create({
    name: "e2e-wf",
    jobs: [
      job("a-side", [
        gate("gate2"),
        modelStep("s", {
          step: "gate2",
          condition: TriggerCondition.succeeded(),
        }),
      ]),
      job("main", [
        gate("gate"),
        modelStep("post", {
          step: "gate",
          condition: TriggerCondition.succeeded(),
        }),
      ]),
      job("teardown", [modelStep("t")], {
        job: "main",
        condition: TriggerCondition.always(),
      }),
    ],
  });
}

/** A run as the store holds it: no forEach mappings, as after a load. */
function reload(run: WorkflowRun): WorkflowRun {
  return WorkflowRun.fromData(run.toData());
}

/** The issue's run, suspended with `gate` approved and `gate2` waiting. */
function suspendedIssueRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  for (const name of ["a-side", "main"]) run.getJob(name)!.start();
  run.getJob("a-side")!.getStep("gate2")!.waitForApproval("gate2?");
  run.getJob("main")!.getStep("gate")!.succeed();
  run.suspend();
  return reload(run);
}

function statuses(run: WorkflowRun): Record<string, string> {
  const result: Record<string, string> = {};
  for (const jobRun of run.jobs) {
    result[jobRun.jobName] = jobRun.status;
    for (const step of jobRun.steps) {
      result[`${jobRun.jobName}/${step.stepName}`] = step.status;
    }
  }
  return result;
}

const noSnapshot = () => Promise.resolve(null);

Deno.test("cancelAndSettle: settles the issue's suspended run as an abort would", () => {
  const workflow = issueWorkflow();
  const run = suspendedIssueRun(workflow);

  cancelAndSettle(run, workflow, "Cancelled by user");

  assertEquals(run.status, "cancelled");
  assertEquals(run.tags["cancel_reason"], "Cancelled by user");
  assertEquals(statuses(run), {
    "a-side": "failed",
    "a-side/gate2": "failed",
    "a-side/s": "skipped",
    "main": "failed",
    "main/gate": "succeeded",
    "main/post": "failed",
    "teardown": "failed",
    "teardown/t": "failed",
  });
  const aSide = run.getJob("a-side")!;
  assertEquals(aSide.getStep("gate2")!.error, CANCELLED_STEP_ERROR);
  assertEquals(aSide.getStep("s")!.skipReason, { kind: "dependency" });
  for (const ref of ["a-side/gate2", "a-side/s", "main/post", "teardown/t"]) {
    const [jobName, stepName] = ref.split("/");
    assertEquals(
      run.getJob(jobName)!.getStep(stepName)!.settledByAbort,
      true,
      ref,
    );
  }
  assertEquals(run.getJob("main")!.getStep("gate")!.settledByAbort, false);
});

/** The issue's run, suspended with both gates waiting. */
function suspendedAtBothGates(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  for (const name of ["a-side", "main"]) run.getJob(name)!.start();
  run.getJob("a-side")!.getStep("gate2")!.waitForApproval("gate2?");
  run.getJob("main")!.getStep("gate")!.waitForApproval("gate?");
  run.suspend();
  return reload(run);
}

Deno.test("completeAndSettle: fails a run on its rejected gate and settles the rest", () => {
  const workflow = issueWorkflow();
  const run = suspendedAtBothGates(workflow);

  run.getJob("a-side")!.getStep("gate2")!.fail("Approval rejected");
  completeAndSettle(run, workflow);

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
  assertEquals(
    run.getJob("a-side")!.getStep("gate2")!.error,
    "Approval rejected",
  );
  assertEquals(run.getJob("a-side")!.getStep("gate2")!.settledByAbort, false);
  assertEquals(
    run.getJob("main")!.getStep("gate")!.error,
    CANCELLED_STEP_ERROR,
  );
  for (const ref of ["a-side/s", "main/gate", "main/post", "teardown/t"]) {
    const [jobName, stepName] = ref.split("/");
    assertEquals(
      run.getJob(jobName)!.getStep(stepName)!.settledByAbort,
      true,
      ref,
    );
  }
});

Deno.test("completeAndSettle: settles from the records alone with no definition", () => {
  const run = suspendedAtBothGates(issueWorkflow());

  run.getJob("a-side")!.getStep("gate2")!.fail("Approval rejected");
  completeAndSettle(run, undefined);

  assertEquals(run.status, "failed");
  for (const jobRun of run.jobs) {
    assertEquals(jobRun.status, "failed", jobRun.jobName);
    for (const step of jobRun.steps) {
      assertEquals(step.status, "failed", `${jobRun.jobName}/${step.stepName}`);
    }
  }
});

Deno.test("completeAndSettle: a resume reopens the work it settled, not the rejected gate", () => {
  const workflow = issueWorkflow();
  const run = suspendedAtBothGates(workflow);
  run.getJob("a-side")!.getStep("gate2")!.fail("Approval rejected");
  completeAndSettle(run, workflow);

  const stored = reload(run);
  stored.reopenAbortedWork();

  assertEquals(statuses(stored), {
    "a-side": "pending",
    "a-side/gate2": "failed",
    "a-side/s": "pending",
    "main": "pending",
    "main/gate": "pending",
    "main/post": "pending",
    "teardown": "pending",
    "teardown/t": "pending",
  });
});

Deno.test("completeAndSettle: leaves a finished run untouched", () => {
  const workflow = issueWorkflow();
  const run = suspendedAtBothGates(workflow);
  cancelAndSettle(run, workflow, "Cancelled by user");
  const before = run.toData();

  completeAndSettle(run, workflow);

  assertEquals(run.toData(), before);
});

Deno.test("cancelAndSettle: leaves a finished run untouched", () => {
  const workflow = issueWorkflow();
  for (
    const finish of [
      (run: WorkflowRun) => run.complete(),
      (run: WorkflowRun) => run.endAsCancelled("earlier"),
      (run: WorkflowRun) => run.interrupt("server_crash"),
    ]
  ) {
    const run = WorkflowRun.create(workflow);
    run.start();
    finish(run);
    const before = run.toData();

    cancelAndSettle(run, workflow, "late");

    assertEquals(run.toData(), before);
  }
});

Deno.test("settleCancelledRun: settling twice changes nothing", () => {
  const workflow = issueWorkflow();
  const run = suspendedIssueRun(workflow);

  settleCancelledRun(run, workflow);
  const once = run.toData();
  settleCancelledRun(run, workflow);

  assertEquals(run.toData(), once);
});

Deno.test("settleCancelledRun: skips a pending job whose dependsOn is unmet", () => {
  const workflow = Workflow.create({
    name: "wf",
    jobs: [
      job("main", [gate("gate")]),
      job("deploy", [modelStep("d")], {
        job: "main",
        condition: TriggerCondition.succeeded(),
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  run.getJob("main")!.start();
  run.getJob("main")!.getStep("gate")!.waitForApproval();
  run.suspend();

  settleCancelledRun(run, workflow);

  assertEquals(run.getJob("main")!.status, "failed");
  assertEquals(run.getJob("deploy")!.status, "skipped");
  const d = run.getJob("deploy")!.getStep("d")!;
  assertEquals(d.status, "skipped");
  assertEquals(d.settledByAbort, true);
});

Deno.test("settleCancelledRun: leaves a guarded step undecided", () => {
  const workflow = Workflow.create({
    name: "wf",
    jobs: [
      job("main", [
        gate("gate"),
        modelStep(
          "create",
          { step: "gate", condition: TriggerCondition.succeeded() },
          { guard: "${{ true }}" },
        ),
      ]),
      job("later", [modelStep("x", undefined, { guard: "${{ true }}" })]),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  run.getJob("main")!.start();
  run.getJob("main")!.getStep("gate")!.succeed();
  run.suspend();

  settleCancelledRun(run, workflow);

  assertEquals(run.getJob("main")!.getStep("create")!.status, "pending");
  assertEquals(run.getJob("main")!.status, "unknown");
  assertEquals(run.getJob("later")!.getStep("x")!.status, "pending");
  assertEquals(run.getJob("later")!.status, "pending");
});

Deno.test("settleCancelledRun: fails a dead owner's in-flight step as cancelled", () => {
  const workflow = Workflow.create({
    name: "wf",
    jobs: [
      job("main", [
        modelStep("build"),
        modelStep("ship", {
          step: "build",
          condition: TriggerCondition.succeeded(),
        }),
      ]),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start(12345);
  run.getJob("main")!.start();
  run.getJob("main")!.getStep("build")!.start();

  cancelAndSettle(run, workflow, "Cancelled by user");

  const build = run.getJob("main")!.getStep("build")!;
  assertEquals(build.status, "failed");
  assertEquals(build.error, CANCELLED_STEP_ERROR);
  assertEquals(build.settledByAbort, false);
  assertEquals(run.getJob("main")!.getStep("ship")!.status, "skipped");
  assertEquals(run.getJob("main")!.status, "failed");
});

Deno.test("cancelAndSettle: fails a stopped owner's in-flight steps with the error given", () => {
  const workflow = Workflow.create({
    name: "wf",
    jobs: [job("main", [modelStep("build"), gate("gate")])],
  });
  const run = WorkflowRun.create(workflow);
  run.start(12345);
  run.getJob("main")!.start();
  run.getJob("main")!.getStep("build")!.start();
  run.getJob("main")!.getStep("gate")!.waitForApproval();

  cancelAndSettle(run, workflow, "r", { inFlightStepError: "owner stopped" });

  const main = run.getJob("main")!;
  assertEquals(main.getStep("build")!.error, "owner stopped");
  assertEquals(main.getStep("gate")!.error, CANCELLED_STEP_ERROR);
  assertEquals(main.status, "failed");
});

Deno.test("settleCancelledRun: settles forEach iterations with their step's definition on a loaded run", () => {
  const workflow = Workflow.create({
    name: "wf",
    jobs: [
      job("deploy", [
        gate("gate"),
        modelStep(
          "build",
          { step: "gate", condition: TriggerCondition.succeeded() },
          { forEach: { item: "env", in: '${{ ["dev", "qa"] }}' } },
        ),
        // Runs only when build failed: the aggregate over its iterations.
        modelStep("rollback", {
          step: "build",
          condition: TriggerCondition.failed(),
        }),
      ]),
    ],
  });
  const started = WorkflowRun.create(workflow);
  started.start();
  const jobRun = started.getJob("deploy")!;
  jobRun.start();
  jobRun.getStep("gate")!.succeed();
  jobRun.replaceExpandedSteps("build", ["build-dev", "build-qa"]);
  started.suspend();
  const run = reload(started);

  settleCancelledRun(run, workflow);

  assertEquals(statuses(run), {
    "deploy": "failed",
    "deploy/gate": "succeeded",
    "deploy/build-dev": "failed",
    "deploy/build-qa": "failed",
    "deploy/rollback": "failed",
  });
});

Deno.test("settleCancelledRun: skips forEach iterations behind an undecided gate", () => {
  const workflow = Workflow.create({
    name: "wf",
    jobs: [
      job("deploy", [
        gate("gate"),
        modelStep(
          "build",
          { step: "gate", condition: TriggerCondition.succeeded() },
          { forEach: { item: "env", in: '${{ ["dev", "qa"] }}' } },
        ),
      ]),
    ],
  });
  const started = WorkflowRun.create(workflow);
  started.start();
  const jobRun = started.getJob("deploy")!;
  jobRun.start();
  jobRun.getStep("gate")!.waitForApproval();
  jobRun.replaceExpandedSteps("build", ["build-dev", "build-qa"]);
  started.suspend();
  const run = reload(started);

  settleCancelledRun(run, workflow);

  assertEquals(run.getJob("deploy")!.getStep("build-dev")!.status, "skipped");
  assertEquals(run.getJob("deploy")!.getStep("build-qa")!.status, "skipped");
  assertEquals(run.getJob("deploy")!.status, "failed");
});

Deno.test("settleCancelledRun: settles a job record the definition lacks from its records", () => {
  const workflow = issueWorkflow();
  const run = suspendedIssueRun(workflow);
  const edited = Workflow.create({
    name: "e2e-wf",
    jobs: [job("teardown", [modelStep("t")])],
  });

  settleCancelledRun(run, edited);

  // a-side and main are not in the edited definition: every unfinished step
  // is cancelled, so s is cancelled rather than skipped.
  assertEquals(statuses(run), {
    "a-side": "failed",
    "a-side/gate2": "failed",
    "a-side/s": "failed",
    "main": "failed",
    "main/gate": "succeeded",
    "main/post": "failed",
    "teardown": "failed",
    "teardown/t": "failed",
  });
});

Deno.test("settleCancelledRun: settles from the records alone with no definition", () => {
  const run = suspendedIssueRun(issueWorkflow());

  settleCancelledRun(run, undefined);

  assertEquals(run.getJob("a-side")!.getStep("s")!.status, "failed");
  assertEquals(run.getJob("teardown")!.status, "failed");
  for (const jobRun of run.jobs) {
    for (const step of jobRun.steps) {
      assertEquals(
        ["pending", "running", "waiting_approval"].includes(step.status),
        false,
        step.stepName,
      );
    }
  }
});

Deno.test("settleCancelledRun: falls back to the records when the definition has a cycle", () => {
  const run = suspendedIssueRun(issueWorkflow());
  const cyclic = Workflow.create({
    name: "e2e-wf",
    jobs: [
      job("a-side", [modelStep("x")], {
        job: "main",
        condition: TriggerCondition.always(),
      }),
      job("main", [modelStep("y")], {
        job: "a-side",
        condition: TriggerCondition.always(),
      }),
      job("teardown", [modelStep("t")]),
    ],
  });

  settleCancelledRun(run, cyclic);

  assertEquals(run.getJob("a-side")!.status, "failed");
  assertEquals(run.getJob("main")!.status, "failed");
  assertEquals(run.getJob("teardown")!.status, "failed");
});

Deno.test("settleCancelledRun: settles an evaluated job name through the run's snapshot", async () => {
  // The repository definition still holds the unevaluated name; the run's
  // records and its snapshot carry the evaluated one.
  const snapshot = Workflow.create({
    name: "wf",
    jobs: [
      job("deploy-prod", [gate("gate")]),
      job("report", [modelStep("r")], {
        job: "deploy-prod",
        condition: TriggerCondition.failed(),
      }),
    ],
  });
  const raw = Workflow.create({
    id: snapshot.id,
    name: "wf",
    jobs: [
      job("deploy-raw", [gate("gate")]),
      job("report", [modelStep("r")], {
        job: "deploy-raw",
        condition: TriggerCondition.failed(),
      }),
    ],
  });
  const suspended = (): WorkflowRun => {
    const run = WorkflowRun.create(snapshot);
    run.start();
    run.captureRunPlan("fingerprint", run.id);
    run.getJob("deploy-prod")!.start();
    run.getJob("deploy-prod")!.getStep("gate")!.waitForApproval();
    run.suspend();
    return reload(run);
  };

  const withSnapshot = suspended();
  const looked: string[] = [];
  cancelAndSettle(
    withSnapshot,
    await resolveSettlementWorkflow(withSnapshot, raw, (runId) => {
      looked.push(runId);
      return Promise.resolve(snapshot);
    }),
    "r",
  );
  assertEquals(looked, [withSnapshot.id]);
  assertEquals(withSnapshot.getJob("deploy-prod")!.status, "failed");
  assertEquals(withSnapshot.getJob("report")!.status, "failed");
  assertEquals(withSnapshot.getJob("report")!.getStep("r")!.status, "failed");

  // Without the snapshot the raw definition cannot name deploy-prod, so its
  // failed condition does not hold and report is skipped.
  const withoutSnapshot = suspended();
  cancelAndSettle(
    withoutSnapshot,
    await resolveSettlementWorkflow(withoutSnapshot, raw, noSnapshot),
    "r",
  );
  assertEquals(withoutSnapshot.getJob("deploy-prod")!.status, "failed");
  assertEquals(withoutSnapshot.getJob("report")!.status, "skipped");
});

Deno.test("resolveSettlementWorkflow: falls back to the repository definition", async () => {
  const workflow = issueWorkflow();
  const run = WorkflowRun.create(workflow);
  const calls: string[] = [];

  // No run plan: the lookup is never asked.
  assertEquals(
    await resolveSettlementWorkflow(run, workflow, (id) => {
      calls.push(id);
      return Promise.resolve(null);
    }),
    workflow,
  );
  assertEquals(calls, []);

  run.captureRunPlan("fingerprint", run.id);
  assertEquals(
    await resolveSettlementWorkflow(run, workflow, noSnapshot),
    workflow,
  );
  assertEquals(
    await resolveSettlementWorkflow(
      run,
      workflow,
      () => Promise.reject(new Error("unparsable snapshot")),
    ),
    workflow,
  );
  assertEquals(
    await resolveSettlementWorkflow(run, undefined, noSnapshot),
    undefined,
  );
});

/** A gate and a signal wait side by side, then a step depending on each. */
function gateAndWaitWorkflow(): Workflow {
  return Workflow.create({
    name: "gate-and-wait",
    jobs: [
      job("main", [
        gate("gate"),
        Step.create({
          name: "review",
          task: StepTask.waitForSignal(600, { type: "object" }),
        }),
        modelStep("after-gate", {
          step: "gate",
          condition: TriggerCondition.succeeded(),
        }),
        modelStep("on-timeout", {
          step: "review",
          condition: TriggerCondition.failed(),
        }),
      ]),
    ],
  });
}

function suspendedAtGateAndWait(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const main = run.getJob("main")!;
  main.start();
  main.getStep("gate")!.waitForApproval("gate?");
  const review = main.getStep("review")!;
  review.start();
  review.waitForSignal(SignalWait.open({ type: "object" }, 600, new Date()));
  run.suspend();
  return reload(run);
}

Deno.test("cancelAndSettle: an unsignalled wait fails as cancelled, marked settled by the abort, and nothing stays waiting", () => {
  const workflow = gateAndWaitWorkflow();
  const run = suspendedAtGateAndWait(workflow);

  cancelAndSettle(run, workflow, "operator");

  assertEquals(run.status, "cancelled");
  const review = run.getJob("main")!.getStep("review")!;
  assertEquals(review.status, "failed");
  assertEquals(review.error, CANCELLED_STEP_ERROR);
  assertEquals(review.settledByAbort, true);
  assertEquals(
    Object.values(statuses(run)).filter((status) =>
      status === "waiting" || status === "waiting_signal" ||
      status === "waiting_approval" ||
      status === "running" || status === "pending"
    ),
    [],
  );
});

Deno.test("completeAndSettle: a rejected gate beside a wait leaves no step waiting", () => {
  const workflow = gateAndWaitWorkflow();
  const run = suspendedAtGateAndWait(workflow);
  run.getJob("main")!.getStep("gate")!.fail("rejected");

  completeAndSettle(run, workflow);

  assertEquals(run.status, "failed");
  assertEquals(statuses(run)["main/review"], "failed");
  assertEquals(
    Object.values(statuses(run)).filter((status) =>
      status === "waiting" || status === "waiting_signal" ||
      status === "waiting_approval"
    ),
    [],
  );
});

Deno.test("settleCancelledRun: settling a run with a wait twice changes nothing", () => {
  const workflow = gateAndWaitWorkflow();
  const run = suspendedAtGateAndWait(workflow);

  settleCancelledRun(run, workflow);
  const once = run.toData();
  settleCancelledRun(run, workflow);

  assertEquals(run.toData().jobs, once.jobs);
});
