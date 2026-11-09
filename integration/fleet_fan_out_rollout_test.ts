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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRunData } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { Fleet, type FleetWorker } from "./fleet_harness.ts";

await initializeLogging({});

// The gateway's grace and dispatch timers outlive a test body by design.
const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };

interface StepSpec {
  name: string;
  after?: string;
  assert?: string;
}

function rolloutJob(
  fleet: Fleet,
  rollout: object,
  steps: StepSpec[] = [{ name: "apply" }],
  job: object = {},
) {
  return {
    name: "patch",
    fanOut: { rollout },
    labels: WEB,
    ...job,
    steps: steps.map((step) => ({
      name: step.name,
      ...(step.after
        ? {
          dependsOn: [{
            step: step.after,
            condition: { type: "succeeded" },
          }],
        }
        : {}),
      task: step.assert !== undefined
        ? { type: "assert", expr: step.assert, message: `${step.name} failed` }
        : {
          type: "model_method",
          modelType: fleet.modelType.normalized,
          modelName: "host-patch",
          methodName: "run",
        },
    })),
  };
}

async function workers(fleet: Fleet, count: number): Promise<FleetWorker[]> {
  const added: FleetWorker[] = [];
  for (let i = 1; i <= count; i++) {
    added.push(await fleet.addWorker(`w-${i}`, { labels: WEB }));
  }
  return added;
}

function counts(entries: [string, number][]): Record<string, number> {
  return Object.fromEntries(entries);
}

function stepStatuses(data: WorkflowRunData): Record<string, string> {
  return Object.fromEntries(
    data.jobs.flatMap((job) =>
      job.steps.map((step) => [`${job.jobName}/${step.stepName}`, step.status])
    ),
  );
}

type AnyEvent = WorkflowRunEvent | WorkflowExecutionEvent;

function batchLanes(events: AnyEvent[]): string[][] {
  return events.flatMap((e) =>
    e.kind === "job_fanout_batch_started" ? [e.lanes] : []
  );
}

async function recordOf(fleet: Fleet, name: string, runId: string) {
  const workflow = await fleet.repoContext.workflowRepo.findByName(name);
  return await fleet.runRecord(workflow!, runId);
}

Deno.test({
  name:
    "fan-out rollout: batches [1, 2, 100%] over 5 lanes start each batch only after the one before it settles",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 5);
    for (const worker of w) worker.behavior = { kind: "hold" };
    await fleet.saveWorkflow({
      name: "canary",
      inputs: {},
      jobs: [rolloutJob(fleet, { batches: [1, 2, "100%"] })],
    });
    const events: WorkflowRunEvent[] = [];
    const running = fleet.runWorkflow("canary", { events });

    await waitFor(() => w[0].heldCount === 1, "the canary in flight");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0], ["w-4", 0], ["w-5", 0]]),
    );
    w[0].release(true);
    await waitFor(
      () => w[1].heldCount === 1 && w[2].heldCount === 1,
      "batch 2 in flight",
    );
    assertEquals(w[3].dispatchCount + w[4].dispatchCount, 0);
    w[1].release(true);
    assertEquals(w[3].dispatchCount + w[4].dispatchCount, 0);
    w[2].release(true);
    await waitFor(
      () => w[3].heldCount === 1 && w[4].heldCount === 1,
      "batch 3 in flight",
    );
    w[3].release(true);
    w[4].release(true);
    const run = await running;

    assertEquals(run.status, "succeeded");
    assertEquals(batchLanes(events), [["w-1"], ["w-2", "w-3"], [
      "w-4",
      "w-5",
    ]]);
    const planned = events.find((e) => e.kind === "job_fanout_planned");
    assert(planned?.kind === "job_fanout_planned");
    assertEquals(planned.batches, [["w-1"], ["w-2", "w-3"], ["w-4", "w-5"]]);
    assertEquals(planned.maxFailures, null);
  },
});

Deno.test({
  name:
    "fan-out rollout: a failed canary assertion under maxFailures 0 sends one dispatch, holds the other four lanes, fails the job and skips the downstream job",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 5);
    await fleet.saveWorkflow({
      name: "canary",
      inputs: {},
      jobs: [
        rolloutJob(fleet, { batches: [1, 2, "100%"], maxFailures: 0 }, [
          { name: "apply" },
          {
            name: "verify",
            after: "apply",
            assert: 'self.worker.name != "w-1"',
          },
        ]),
        {
          name: "report",
          dependsOn: [{ job: "patch", condition: { type: "succeeded" } }],
          steps: [{
            name: "done",
            task: { type: "assert", expr: "true", message: "unreachable" },
          }],
        },
      ],
    });
    const events: WorkflowRunEvent[] = [];
    const run = await fleet.runWorkflow("canary", { events });

    assertEquals(run.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0], ["w-4", 0], ["w-5", 0]]),
    );
    const data = await recordOf(fleet, "canary", run.id);
    const statuses = stepStatuses(data);
    assertEquals(statuses["patch/apply[w-1]"], "succeeded");
    assertEquals(statuses["patch/verify[w-1]"], "failed");
    for (const worker of ["w-2", "w-3", "w-4", "w-5"]) {
      for (const step of ["apply", "verify"]) {
        assertEquals(statuses[`patch/${step}[${worker}]`], "skipped");
      }
    }
    const patch = data.jobs.find((job) => job.jobName === "patch")!;
    assertEquals(patch.status, "failed");
    assertEquals(patch.fanOutHalts, [{
      batch: 1,
      maxFailures: 0,
      failed: ["w-1"],
      held: ["w-2", "w-3", "w-4", "w-5"],
    }]);
    assertEquals(
      data.jobs.find((job) => job.jobName === "report")!.status,
      "skipped",
    );
    const halted = events.find((e) => e.kind === "job_fanout_halted");
    assertEquals(
      halted?.kind === "job_fanout_halted" ? halted.held : undefined,
      ["w-2", "w-3", "w-4", "w-5"],
    );
    const summary = events.find((e) => e.kind === "job_fanout_summary");
    assert(summary?.kind === "job_fanout_summary");
    assertEquals(summary.held, ["w-2", "w-3", "w-4", "w-5"]);
    assertEquals(summary.budget, { used: 1, allowed: 0 });
  },
});

Deno.test({
  name:
    "fan-out rollout: maxFailures 25% over 8 lanes halts on the third failure mid-batch; the running lane finishes and the rest are held",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 8);
    for (const failing of [w[1], w[2], w[3]]) {
      failing.behavior = { kind: "fail", error: "patch failed" };
    }
    for (const held of w.slice(4)) held.behavior = { kind: "hold" };
    await fleet.saveWorkflow({
      name: "budget",
      inputs: {},
      jobs: [rolloutJob(
        fleet,
        { batches: [1, "100%"], maxFailures: "25%" },
        [{ name: "apply" }],
        { concurrency: 2 },
      )],
    });
    const running = fleet.runWorkflow("budget");
    await waitFor(() => w[4].heldCount === 1, "w-5 in flight");
    w[4].release(true);
    const run = await running;

    assertEquals(run.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([
        ["w-1", 1],
        ["w-2", 1],
        ["w-3", 1],
        ["w-4", 1],
        ["w-5", 1],
        ["w-6", 0],
        ["w-7", 0],
        ["w-8", 0],
      ]),
    );
    const data = await recordOf(fleet, "budget", run.id);
    const statuses = stepStatuses(data);
    assertEquals(statuses["patch/apply[w-5]"], "succeeded");
    assertEquals(data.jobs[0].fanOutHalts, [{
      batch: 1,
      maxFailures: 2,
      failed: ["w-2", "w-3", "w-4"],
      held: ["w-6", "w-7", "w-8"],
    }]);
  },
});

Deno.test({
  name: "fan-out rollout: without maxFailures failures never halt the rollout",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 4);
    for (const worker of w) {
      worker.behavior = { kind: "fail", error: "patch failed" };
    }
    await fleet.saveWorkflow({
      name: "no-budget",
      inputs: {},
      jobs: [rolloutJob(fleet, { batches: [1, 1, "100%"] })],
    });
    const events: WorkflowRunEvent[] = [];
    const run = await fleet.runWorkflow("no-budget", { events });

    assertEquals(run.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 1], ["w-3", 1], ["w-4", 1]]),
    );
    assertEquals(batchLanes(events), [["w-1"], ["w-2"], ["w-3", "w-4"]]);
    const data = await recordOf(fleet, "no-budget", run.id);
    assertEquals(data.jobs[0].fanOutHalts, undefined);
    assert(!events.some((e) => e.kind === "job_fanout_halted"));
  },
});

Deno.test({
  name:
    "fan-out rollout: waiting lanes go in the last batches, a waiting lane's queueTimeout counts against the budget, and an excluded member does not",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({
      graceWindowMs: 200,
      queueTimeoutMs: 1_000,
    });
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const c = await fleet.addWorker("w-c", { labels: WEB });
    const d = await fleet.addWorker("w-d", { labels: WEB });
    const drain = await fleet.addWorker("w-drain", { labels: WEB });
    await c.disconnect({ untilRemoved: true });
    await d.disconnect({ untilRemoved: true });
    await drain.drain();
    await fleet.saveWorkflow({
      name: "waiting",
      inputs: {},
      jobs: [rolloutJob(fleet, { batches: [1, 1, 1, "100%"], maxFailures: 0 })],
    });
    const events: WorkflowRunEvent[] = [];
    const run = await fleet.runWorkflow("waiting", { events });

    assertEquals(run.status, "failed");
    assertEquals(batchLanes(events), [["w-a"], ["w-b"], ["w-c"]]);
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-a", 1], ["w-b", 1], ["w-c", 0], ["w-d", 0], [
        "w-drain",
        0,
      ]]),
    );
    const data = await recordOf(fleet, "waiting", run.id);
    assertEquals(data.jobs[0].fanOutHalts, [{
      batch: 3,
      maxFailures: 0,
      failed: ["w-c"],
      held: ["w-d"],
    }]);
  },
});

Deno.test({
  name:
    "fan-out rollout: halt, fix and resume runs the failed canary first, then the held lanes in the remaining batches; passed lanes get 0 new dispatches",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 5);
    w[0].behavior = { kind: "fail", error: "canary broke" };
    await fleet.saveWorkflow({
      name: "canary",
      inputs: {},
      jobs: [rolloutJob(fleet, { batches: [1, 2, "100%"], maxFailures: 0 })],
    });
    const run = await fleet.runWorkflow("canary");
    assertEquals(run.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0], ["w-4", 0], ["w-5", 0]]),
    );

    w[0].behavior = { kind: "succeed" };
    const events: WorkflowExecutionEvent[] = [];
    const retried = await fleet.retryRun("canary", run.id, { events });

    assertEquals(retried.status, "succeeded");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 2], ["w-2", 1], ["w-3", 1], ["w-4", 1], ["w-5", 1]]),
    );
    assertEquals(batchLanes(events), [["w-1"], ["w-2", "w-3"], [
      "w-4",
      "w-5",
    ]]);
    const planned = events.find((e) => e.kind === "job_fanout_planned");
    assert(planned?.kind === "job_fanout_planned");
    assertEquals(planned.resumed, {
      rerun: ["w-1", "w-2", "w-3", "w-4", "w-5"],
      kept: [],
      held: ["w-2", "w-3", "w-4", "w-5"],
    });
    const data = await recordOf(fleet, "canary", run.id);
    assertEquals(data.jobs[0].fanOutHalts?.length, 1);
  },
});

Deno.test({
  name:
    "fan-out rollout: a resumed attempt has a fresh budget; the lanes the halt failed run first and a passed lane is kept",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 5);
    w[0].behavior = { kind: "fail", error: "w-1 broke" };
    w[1].behavior = { kind: "fail", error: "w-2 broke" };
    await fleet.saveWorkflow({
      name: "fresh",
      inputs: {},
      jobs: [rolloutJob(fleet, { batches: [1, 2, "100%"], maxFailures: 1 })],
    });
    const run = await fleet.runWorkflow("fresh");
    assertEquals(run.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 1], ["w-3", 1], ["w-4", 0], ["w-5", 0]]),
    );

    // w-1 still fails: one failure is within a fresh budget of 1
    w[1].behavior = { kind: "succeed" };
    const events: WorkflowExecutionEvent[] = [];
    const retried = await fleet.retryRun("fresh", run.id, { events });

    assertEquals(retried.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 2], ["w-2", 2], ["w-3", 1], ["w-4", 1], ["w-5", 1]]),
    );
    assertEquals(batchLanes(events), [["w-1", "w-2"], ["w-4", "w-5"]]);
    assert(!events.some((e) => e.kind === "job_fanout_halted"));
    const summary = events.find((e) => e.kind === "job_fanout_summary");
    assert(summary?.kind === "job_fanout_summary");
    assertEquals(summary.budget, { used: 1, allowed: 1 });
    assertEquals(summary.held, []);
  },
});

Deno.test({
  name:
    "fan-out rollout: a cancel mid-rollout holds nothing, records no halt and sends nothing new",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 3);
    w[0].behavior = { kind: "hold" };
    const workflow = await fleet.saveWorkflow({
      name: "cancel",
      inputs: {},
      jobs: [rolloutJob(fleet, { batches: [1, "100%"], maxFailures: 0 })],
    });
    const controller = new AbortController();
    const running = fleet.runWorkflow("cancel", { signal: controller.signal })
      .catch(() => undefined);
    await waitFor(() => w[0].heldCount === 1, "the canary in flight");
    controller.abort();
    w[0].release(true);
    await running;

    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0]]),
    );
    const [stored] = await fleet.repoContext.workflowRunRepo
      .findAllByWorkflowId(workflow.id);
    const job = stored.getJob("patch")!;
    assertEquals(job.fanOutHalts, []);
    for (const name of ["apply[w-2]", "apply[w-3]"]) {
      const step = job.getStep(name)!;
      assert(step.status !== "pending" && step.status !== "succeeded");
      assert(step.skipReason?.kind !== "job_skipped", name);
    }
  },
});

Deno.test({
  name:
    "fan-out rollout: a rollout interrupted while its canary ran and settled at boot is gated by the frozen batches when recovered",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 3);
    w[0].behavior = { kind: "hold" };
    const workflow = await fleet.saveWorkflow({
      name: "interrupted",
      inputs: {},
      jobs: [rolloutJob(fleet, { batches: [1, "100%"] })],
    });
    const controller = new AbortController();
    const running = fleet.runWorkflow("interrupted", {
      signal: controller.signal,
    }).catch(() => undefined);
    await waitFor(() => w[0].heldCount === 1, "the canary in flight");
    controller.abort();
    w[0].release(true);
    await running;
    const [stored] = await fleet.repoContext.workflowRunRepo
      .findAllByWorkflowId(workflow.id);

    // as the boot reaper leaves a run whose canary was in flight
    const data = stored.toData();
    data.status = "interrupted";
    data.tags = { ...data.tags, interrupt_reason: "server_crash" };
    const patch = data.jobs[0];
    patch.status = "unknown";
    for (const step of patch.steps) {
      delete step.settledByAbort;
      delete step.stoppedByAbort;
      delete step.skipReason;
      delete step.completedAt;
      if (step.stepName === "apply[w-1]") {
        step.status = "unknown";
        step.error = "interrupted: server_crash";
      } else {
        step.status = "pending";
        delete step.error;
      }
    }
    await fleet.saveRunRecord(workflow, data);

    const events: WorkflowExecutionEvent[] = [];
    const recovering = fleet.recoverRun("interrupted", data.id, { events });
    await waitFor(() => w[0].heldCount === 1, "the canary in flight again");
    assertEquals(w[1].dispatchCount + w[2].dispatchCount, 0);
    w[0].release(true);
    const recovered = await recovering;

    assertEquals(recovered.status, "succeeded");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 2], ["w-2", 1], ["w-3", 1]]),
    );
    assertEquals(batchLanes(events), [["w-1"], ["w-2", "w-3"]]);
  },
});

Deno.test({
  name:
    "fan-out rollout: a resume that halts again holds a failed-first lane whose earlier step already succeeded, keeping that step",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 3);
    const failVerify = (worker: FleetWorker) => {
      worker.behavior = {
        kind: "fail",
        error: "verify broke",
        steps: [`verify[${worker.name}]`],
      };
    };
    failVerify(w[0]);
    failVerify(w[1]);
    const steps = [{ name: "apply" }, { name: "verify", after: "apply" }];
    const rollout = { batches: [2, "100%"], maxFailures: 0 };
    const workflow = await fleet.saveWorkflow({
      name: "rehalt",
      inputs: {},
      jobs: [rolloutJob(fleet, rollout, steps)],
    });
    const run = await fleet.runWorkflow("rehalt");
    assertEquals(run.status, "failed");
    assertEquals(
      (await recordOf(fleet, "rehalt", run.id)).jobs[0].fanOutHalts,
      [{ batch: 1, maxFailures: 0, failed: ["w-1", "w-2"], held: ["w-3"] }],
    );

    // one lane at a time, so w-1 fails and halts before w-2 starts
    await fleet.repoContext.workflowRepo.save(
      Workflow.fromData(
        {
          id: workflow.id,
          name: workflow.name,
          inputs: {},
          jobs: [rolloutJob(fleet, rollout, steps, { concurrency: 1 })],
        } as Parameters<typeof Workflow.fromData>[0],
      ),
    );
    const retried = await fleet.retryRun("rehalt", run.id);

    assertEquals(retried.status, "failed");
    const data = await recordOf(fleet, "rehalt", run.id);
    const statuses = stepStatuses(data);
    assertEquals(statuses["patch/apply[w-2]"], "succeeded");
    assertEquals(statuses["patch/verify[w-2]"], "skipped");
    assertEquals(data.jobs[0].fanOutHalts?.[1], {
      batch: 0,
      maxFailures: 0,
      failed: ["w-1"],
      held: ["w-2", "w-3"],
    });
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 3], ["w-2", 2], ["w-3", 0]]),
    );
  },
});

Deno.test({
  name:
    "fan-out rollout: a resumed lane whose worker went offline fails before it starts and spends the budget, so nothing is sent and the rest are held",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ graceWindowMs: 200 });
    const w = await workers(fleet, 3);
    w[0].behavior = { kind: "fail", error: "canary broke" };
    await fleet.saveWorkflow({
      name: "offline",
      inputs: {},
      jobs: [rolloutJob(
        fleet,
        { batches: [1, "100%"], maxFailures: 0 },
        [{ name: "apply" }],
        {
          fanOut: {
            offline: "fail",
            rollout: { batches: [1, "100%"], maxFailures: 0 },
          },
        },
      )],
    });
    const run = await fleet.runWorkflow("offline");
    assertEquals(run.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0]]),
    );

    w[0].behavior = { kind: "succeed" };
    await w[1].disconnect();
    const retried = await fleet.retryRun("offline", run.id);

    assertEquals(retried.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0]]),
    );
    const data = await recordOf(fleet, "offline", run.id);
    assertEquals(data.jobs[0].fanOutHalts?.[1], {
      batch: 0,
      maxFailures: 0,
      failed: ["w-2"],
      held: ["w-1", "w-3"],
    });
  },
});
