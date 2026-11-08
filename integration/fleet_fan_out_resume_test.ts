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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { UserError } from "../src/domain/errors.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

// The gateway's grace and dispatch timers outlive a test body by design.
const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };

function patchJob(fleet: Fleet, job: object = {}) {
  const step = (name: string, after?: string) => ({
    name,
    ...(after
      ? { dependsOn: [{ step: after, condition: { type: "succeeded" } }] }
      : {}),
    task: {
      type: "model_method",
      modelType: fleet.modelType.normalized,
      modelName: "host-patch",
      methodName: "run",
    },
  });
  return {
    name: "patch",
    fanOut: "all",
    labels: WEB,
    ...job,
    steps: [step("apply"), step("verify", "apply")],
  };
}

async function saveAs(
  fleet: Fleet,
  workflow: Workflow,
  jobs: object[],
): Promise<void> {
  await fleet.repoContext.workflowRepo.save(
    Workflow.fromData(
      {
        id: workflow.id,
        name: workflow.name,
        inputs: {},
        jobs,
      } as Parameters<typeof Workflow.fromData>[0],
    ),
  );
}

function statuses(run: WorkflowRun): Record<string, string> {
  return Object.fromEntries(
    run.jobs.flatMap((job) => job.steps.map((s) => [s.stepName, s.status])),
  );
}

async function failedOnLane(fleet: Fleet, failing: string, job: object = {}) {
  const workflow = await fleet.saveWorkflow({
    name: "patch-all",
    inputs: {},
    jobs: [patchJob(fleet, job)],
  });
  const worker = fleet.worker(failing);
  worker.behavior = { kind: "fail", error: "apply failed" };
  const run = await fleet.runWorkflow("patch-all");
  assertEquals(run.status, "failed");
  worker.behavior = { kind: "succeed" };
  return { workflow, runId: run.id };
}

Deno.test({
  name:
    "fan-out resume: a retry after a lane failed dispatches only that lane; passed lanes get 0 new dispatches and keep their records",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const { runId } = await failedOnLane(fleet, "w-b");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 1 });

    const events: WorkflowExecutionEvent[] = [];
    const retried = await fleet.retryRun("patch-all", runId, { events });

    assertEquals(retried.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 3 });
    assertEquals(statuses(retried), {
      "apply[w-a]": "succeeded",
      "verify[w-a]": "succeeded",
      "apply[w-b]": "succeeded",
      "verify[w-b]": "succeeded",
    });
    const planned = events.find((e) => e.kind === "job_fanout_planned");
    assertEquals(
      planned?.kind === "job_fanout_planned" ? planned.resumed : undefined,
      { rerun: ["w-b"], kept: ["w-a"] },
    );
    const summary = events.find((e) => e.kind === "job_fanout_summary");
    assertEquals(
      summary?.kind === "job_fanout_summary"
        ? [summary.matching, summary.lanesSucceeded, summary.lanesFailed]
        : undefined,
      [2, 2, 0],
    );
  },
});

Deno.test({
  name:
    "fan-out resume: --from a lane step re-runs that step and its lane dependents only in lanes that did not succeed",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    await fleet.saveWorkflow({
      name: "patch-all",
      inputs: {},
      jobs: [patchJob(fleet)],
    });
    // verify fails on w-b: apply passed there, so --from apply re-runs both
    b.behavior = {
      kind: "fail",
      error: "verify failed",
      steps: ["verify[w-b]"],
    };
    const run = await fleet.runWorkflow("patch-all");
    assertEquals(run.status, "failed");
    b.behavior = { kind: "succeed" };
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });

    const retried = await fleet.retryRun("patch-all", run.id, {
      fromStep: "apply",
    });

    assertEquals(retried.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 4 });
  },
});

Deno.test({
  name:
    "fan-out resume: a member offline at plan time that never connected waits on a retry and runs when its worker connects as a new process",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    await b.disconnect();
    const workflow = await fleet.saveWorkflow({
      name: "patch-all",
      inputs: {},
      jobs: [patchJob(fleet, { queueTimeout: 1 })],
    });
    const run = await fleet.runWorkflow("patch-all");
    assertEquals(run.status, "failed");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 0 });
    const firstUuid = b.instanceUuid;
    // a longer wait on the retry, which is not a structural change
    await saveAs(fleet, workflow, [patchJob(fleet, { queueTimeout: 60 })]);

    const events: WorkflowExecutionEvent[] = [];
    const retrying = fleet.retryRun("patch-all", run.id, { events });
    await waitFor(
      () => events.some((e) => e.kind === "job_fanout_waiting"),
      "the retry to report w-b waiting",
    );
    await b.restart();
    const retried = await retrying;

    assertEquals(retried.status, "succeeded");
    assertEquals(b.instanceUuid === firstUuid, false);
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });
    const waiting = events.find((e) => e.kind === "job_fanout_waiting");
    assertEquals(
      waiting?.kind === "job_fanout_waiting"
        ? [waiting.worker, waiting.queueTimeoutSeconds]
        : undefined,
      ["w-b", 60],
    );
  },
});

Deno.test({
  name:
    "fan-out resume: a worker that enrolled after the plan gets no lane on a retry",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const { runId } = await failedOnLane(fleet, "w-b");
    await fleet.addWorker("w-c", { labels: WEB });

    const retried = await fleet.retryRun("patch-all", runId);

    assertEquals(retried.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 3, "w-c": 0 });
    assertEquals(
      Object.keys(statuses(retried)).some((name) => name.includes("w-c")),
      false,
    );
  },
});

Deno.test({
  name:
    "fan-out resume: a run whose plan an older swamp stripped is refused, and its record is byte-identical before and after",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const { workflow, runId } = await failedOnLane(fleet, "w-b");
    const data = await fleet.runRecord(workflow, runId);
    for (const job of data.jobs) delete job.fanOutPlan;
    await fleet.saveRunRecord(workflow, data);
    const before = JSON.stringify(await fleet.runRecord(workflow, runId));

    await assertRejects(
      () => fleet.retryRun("patch-all", runId),
      UserError,
      'Job "patch" has fanOut but started without a fan-out plan',
    );

    assertEquals(
      JSON.stringify(await fleet.runRecord(workflow, runId)),
      before,
    );
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 1 });
  },
});

Deno.test({
  name:
    "fan-out resume: removing fanOut, adding it, or changing a fan-out job's labels between run and resume is refused with the record unchanged",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: { ...WEB, zone: "a" } });
    await fleet.addWorker("w-b", { labels: { ...WEB, zone: "a" } });
    const { workflow, runId } = await failedOnLane(fleet, "w-b");
    const { fanOut: _fanOut, labels: _labels, ...plain } = patchJob(fleet);
    const edits: [object, string][] = [
      [
        { ...plain, target: "w-a" },
        'Job "patch" ran as a fan-out job, and the workflow no longer sets fanOut on it.',
      ],
      [
        patchJob(fleet, { labels: { ...WEB, zone: "a" } }),
        'Fan-out job "patch" selects different workers than when the run began',
      ],
    ];
    const before = JSON.stringify(await fleet.runRecord(workflow, runId));
    for (const [job, refusal] of edits) {
      await saveAs(fleet, workflow, [job]);
      await assertRejects(
        () => fleet.retryRun("patch-all", runId),
        UserError,
        refusal,
      );
      assertEquals(
        JSON.stringify(await fleet.runRecord(workflow, runId)),
        before,
      );
    }

    // a plain job that ran, then gains fanOut
    const plainWorkflow = await fleet.saveWorkflow({
      name: "plain",
      inputs: {},
      jobs: [{ ...plain, target: "w-b" }],
    });
    fleet.worker("w-b").behavior = { kind: "fail", error: "apply failed" };
    const plainRun = await fleet.runWorkflow("plain");
    fleet.worker("w-b").behavior = { kind: "succeed" };
    assertEquals(plainRun.status, "failed");
    await saveAs(fleet, plainWorkflow, [patchJob(fleet)]);
    const plainBefore = JSON.stringify(
      await fleet.runRecord(plainWorkflow, plainRun.id),
    );
    await assertRejects(
      () => fleet.retryRun("plain", plainRun.id),
      UserError,
      'Job "patch" has fanOut but started without a fan-out plan',
    );
    assertEquals(
      JSON.stringify(await fleet.runRecord(plainWorkflow, plainRun.id)),
      plainBefore,
    );
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });
  },
});

Deno.test({
  name:
    "fan-out resume: an approval in a job before the fan-out job suspends the run, and the approved resume runs every lane once",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const workflow = await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [
        {
          name: "gate",
          steps: [{
            name: "approve",
            task: { type: "manual_approval", prompt: "patch the fleet?" },
          }],
        },
        {
          ...patchJob(fleet),
          dependsOn: [{ job: "gate", condition: { type: "succeeded" } }],
        },
      ],
    });
    const suspended = await fleet.runWorkflow("gated");
    assertEquals(suspended.status, "suspended");
    assertEquals(fleet.dispatchCounts(), { "w-a": 0, "w-b": 0 });

    const stored = await fleet.repoContext.workflowRunRepo.findById(
      workflow.id,
      createWorkflowRunId(suspended.id),
    );
    const gate = stored!.getJob("gate")!.getStep("approve")!;
    gate.recordApprovalDecision({
      approved: true,
      decidedBy: "user:test",
      decidedAt: new Date().toISOString(),
    });
    gate.succeed();
    await fleet.repoContext.workflowRunRepo.save(workflow.id, stored!);

    const resumed = await fleet.retryRun("gated", suspended.id);

    assertEquals(resumed.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });
  },
});

Deno.test({
  name:
    "fan-out recover: an interrupted run re-runs only the lane that was in flight; a finished lane gets 0 new dispatches",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const { workflow, runId } = await failedOnLane(fleet, "w-b");
    // as the boot reaper leaves a run whose w-b lane was in flight
    const data = await fleet.runRecord(workflow, runId);
    data.status = "interrupted";
    data.tags = { ...data.tags, interrupt_reason: "server_crash" };
    const patch = data.jobs[0];
    patch.status = "unknown";
    const apply = patch.steps.find((s) => s.stepName === "apply[w-b]")!;
    apply.status = "unknown";
    apply.error = "interrupted: server_crash";
    const verify = patch.steps.find((s) => s.stepName === "verify[w-b]")!;
    verify.status = "pending";
    delete verify.skipReason;
    await fleet.saveRunRecord(workflow, data);

    const recovered = await fleet.recoverRun("patch-all", runId);

    assertEquals(recovered.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 3 });
    assertStringIncludes(JSON.stringify(statuses(recovered)), "succeeded");
  },
});
