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
import "../src/domain/models/models.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import type { WorkflowRunData } from "../src/domain/workflows/workflow_run.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { judgeRunRecord } from "../src/domain/datastore_v3/content_bindings.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { Fleet, type FleetWorker } from "./fleet_harness.ts";

await initializeLogging({});

// The gateway's grace and dispatch timers outlive a test body by design.
const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };
const PLAN = "patch[approve-plan]";
const CANARY = "patch[approve-canary]";

function gatedJob(fleet: Fleet, rollout: object, withVerify = false) {
  return {
    name: "patch",
    fanOut: { rollout },
    labels: WEB,
    steps: [
      {
        name: "apply",
        task: {
          type: "model_method",
          modelType: fleet.modelType.normalized,
          modelName: "host-patch",
          methodName: "run",
        },
      },
      ...(withVerify
        ? [{
          name: "verify",
          dependsOn: [{ step: "apply", condition: { type: "succeeded" } }],
          task: {
            type: "assert",
            expr: 'self.worker.name != "w-1"',
            message: "verify failed",
            severity: "low",
          },
          allowFailure: true,
        }]
        : []),
    ],
  };
}

const REPORT = {
  name: "report",
  dependsOn: [{ job: "patch", condition: { type: "succeeded" } }],
  steps: [{
    name: "done",
    task: { type: "assert", expr: "true", message: "unreachable" },
  }],
};

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

function approvalRequests(events: AnyEvent[]) {
  return events.flatMap((e) => e.kind === "approval_requested" ? [e] : []);
}

async function recordOf(fleet: Fleet, name: string, runId: string) {
  const workflow = await fleet.repoContext.workflowRepo.findByName(name);
  return await fleet.runRecord(workflow!, runId);
}

Deno.test({
  name:
    "fan-out approval: approve [plan] suspends with 0 dispatches and a prompt naming every member, its disposition and the batches; approving runs every lane",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 3);
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [gatedJob(fleet, {
        batches: [1, "100%"],
        maxFailures: 0,
        approve: ["plan"],
        approveTimeout: 3600,
      })],
    });
    const events: WorkflowRunEvent[] = [];
    const run = await fleet.runWorkflow("gated", { events });

    assertEquals(run.status, "suspended");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 0], ["w-2", 0], ["w-3", 0]]),
    );
    assertEquals(events.some((e) => e.kind === "job_fanout_waiting"), false);
    const [requested] = approvalRequests(events);
    assertEquals(requested.stepId, PLAN);
    assertEquals(requested.timeout, 3600);
    assertStringIncludes(requested.prompt, "Approve the fan-out plan");
    assertEquals(requested.fanOutGate?.gate, "plan");
    assertEquals(requested.fanOutGate?.members, [
      { worker: "w-1", disposition: "dispatch", batch: 0 },
      { worker: "w-2", disposition: "dispatch", batch: 1 },
      { worker: "w-3", disposition: "dispatch", batch: 1 },
    ]);
    assertEquals(requested.fanOutGate?.batches, [["w-1"], ["w-2", "w-3"]]);
    assertEquals(requested.fanOutGate?.budget, { allowed: 0 });
    assertEquals(requested.fanOutGate?.selector, { labels: WEB });
    const plannedFirst = events.find((e) => e.kind === "job_fanout_planned");
    assert(plannedFirst?.kind === "job_fanout_planned");
    assertEquals(plannedFirst.approve, ["plan"]);
    const suspended = events.find((e) => e.kind === "suspended");
    assert(suspended?.kind === "suspended");
    assertEquals(suspended.stepId, PLAN);

    const data = await recordOf(fleet, "gated", run.id);
    const gate = data.jobs[0].steps.find((s) => s.stepName === PLAN)!;
    assertEquals(gate.status, "waiting_approval");
    assertEquals(gate.approvalTimeout, 3600);
    assertEquals(
      data.jobs[0].steps.filter((s) => s.stepName !== PLAN)
        .every((s) => s.status === "pending"),
      true,
    );

    const decided = await fleet.decideGate("gated", run.id, PLAN, true);
    assertEquals(decided.kind, "completed");
    const resumeEvents: WorkflowExecutionEvent[] = [];
    const resumed = await fleet.resumeRun("gated", run.id, {
      events: resumeEvents,
    });

    assertEquals(resumed.status, "succeeded");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 1], ["w-3", 1]]),
    );
    assertEquals(batchLanes(resumeEvents), [["w-1"], ["w-2", "w-3"]]);
    assertEquals(approvalRequests(resumeEvents), []);
    // the continuation runs on the stored plan, as any resume does
    const planned = resumeEvents.find((e) => e.kind === "job_fanout_planned");
    assert(planned?.kind === "job_fanout_planned");
    assertEquals(planned.resumed?.rerun, ["w-1", "w-2", "w-3"]);
    const after = await recordOf(fleet, "gated", run.id);
    const approved = after.jobs[0].steps.find((s) => s.stepName === PLAN)!;
    assertEquals(approved.status, "succeeded");
    assertEquals(approved.approvalDecision?.approved, true);
  },
});

Deno.test({
  name:
    "fan-out approval: rejecting the plan gate sends nothing, holds every lane, fails the job, skips the downstream job, and a retry is refused",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 3);
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [
        gatedJob(fleet, { batches: [1, "100%"], approve: ["plan"] }),
        REPORT,
      ],
    });
    const run = await fleet.runWorkflow("gated");
    assertEquals(run.status, "suspended");

    const decided = await fleet.decideGate(
      "gated",
      run.id,
      PLAN,
      false,
      "wrong hosts",
    );
    assert(decided.kind === "completed" && "runStatus" in decided.data);
    assertEquals(decided.data.fanOutHeld, {
      jobName: "patch",
      held: ["w-1", "w-2", "w-3"],
      reason: "rejected",
    });
    assertEquals(decided.data.runStatus, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 0], ["w-2", 0], ["w-3", 0]]),
    );
    const data = await recordOf(fleet, "gated", run.id);
    const statuses = stepStatuses(data);
    assertEquals(statuses[`patch/${PLAN}`], "failed");
    for (const worker of ["w-1", "w-2", "w-3"]) {
      assertEquals(statuses[`patch/apply[${worker}]`], "skipped");
    }
    const patch = data.jobs.find((job) => job.jobName === "patch")!;
    assertEquals(patch.status, "failed");
    assertEquals(patch.fanOutHalts, undefined);
    assertEquals(
      patch.steps.find((s) => s.stepName === "apply[w-1]")?.settledByAbort,
      true,
    );
    assertEquals(
      data.jobs.find((job) => job.jobName === "report")!.status,
      "skipped",
    );
    assertEquals(data.status, "failed");

    const before = JSON.stringify(await recordOf(fleet, "gated", run.id));
    for (const fromStep of [undefined, "apply"]) {
      let refused: unknown;
      try {
        await fleet.retryRun("gated", run.id, { fromStep });
      } catch (error) {
        refused = error;
      }
      assert(refused instanceof Error, `retry from ${fromStep} is refused`);
      assertStringIncludes(
        refused.message,
        `Approval gate "${PLAN}" of fan-out job "patch" was rejected; neither a retry nor --from asks it again. Start a new run.`,
      );
    }
    assertEquals(
      JSON.stringify(await recordOf(fleet, "gated", run.id)),
      before,
    );
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 0], ["w-2", 0], ["w-3", 0]]),
    );
  },
});

Deno.test({
  name:
    "fan-out approval: approve [canary] runs the canary, suspends with exactly its dispatches and its results, and approving rolls out the rest in batch order",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 5);
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [gatedJob(fleet, {
        batches: [1, 2, "100%"],
        maxFailures: 1,
        approve: ["canary"],
      }, true)],
    });
    const events: WorkflowRunEvent[] = [];
    const run = await fleet.runWorkflow("gated", { events });

    assertEquals(run.status, "suspended");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0], ["w-4", 0], ["w-5", 0]]),
    );
    assertEquals(batchLanes(events), [["w-1"]]);
    const [requested] = approvalRequests(events);
    assertEquals(requested.stepId, CANARY);
    const prompt = requested.fanOutGate!;
    assertEquals(prompt.gate, "canary");
    assertEquals(prompt.canary?.lanes.map((l) => [l.worker, l.status]), [[
      "w-1",
      "succeeded",
    ]]);
    // a warning assertion under allowFailure is shown, not counted
    assertEquals(prompt.canary?.lanes[0].assertions.map((a) => a.step), [
      "verify[w-1]",
    ]);
    assertEquals(prompt.budget, { allowed: 1, used: 0 });
    assertEquals(prompt.next, ["w-2", "w-3"]);

    assertEquals(
      (await fleet.decideGate("gated", run.id, CANARY, true)).kind,
      "completed",
    );
    const resumeEvents: WorkflowExecutionEvent[] = [];
    const resumed = await fleet.resumeRun("gated", run.id, {
      events: resumeEvents,
    });
    assertEquals(resumed.status, "succeeded");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 1], ["w-3", 1], ["w-4", 1], ["w-5", 1]]),
    );
    assertEquals(batchLanes(resumeEvents), [["w-2", "w-3"], ["w-4", "w-5"]]);
    assertEquals(approvalRequests(resumeEvents), []);
  },
});

Deno.test({
  name:
    "fan-out approval: rejecting the canary gate keeps the canary's result and holds the rest",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 3);
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [gatedJob(fleet, { batches: [1, "100%"], approve: ["canary"] })],
    });
    const run = await fleet.runWorkflow("gated");
    assertEquals(run.status, "suspended");

    const decided = await fleet.decideGate("gated", run.id, CANARY, false);
    assert(decided.kind === "completed" && "runStatus" in decided.data);
    assertEquals(decided.data.fanOutHeld?.held, ["w-2", "w-3"]);
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0]]),
    );
    const statuses = stepStatuses(await recordOf(fleet, "gated", run.id));
    assertEquals(statuses["patch/apply[w-1]"], "succeeded");
    assertEquals(statuses["patch/apply[w-2]"], "skipped");
    assertEquals(statuses["patch/apply[w-3]"], "skipped");
    assertEquals(statuses[`patch/${CANARY}`], "failed");
  },
});

Deno.test({
  name:
    "fan-out approval: a canary failure that spends the budget halts as a rollout does, and the canary gate never opens",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 3);
    w[0].behavior = { kind: "fail", error: "canary broke" };
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [gatedJob(fleet, {
        batches: [1, "100%"],
        maxFailures: 0,
        approve: ["plan", "canary"],
      })],
    });
    const events: WorkflowRunEvent[] = [];
    const run = await fleet.runWorkflow("gated", { events });
    assertEquals(run.status, "suspended");
    assertEquals(approvalRequests(events).map((e) => e.stepId), [PLAN]);
    await fleet.decideGate("gated", run.id, PLAN, true);

    const resumeEvents: WorkflowExecutionEvent[] = [];
    const resumed = await fleet.resumeRun("gated", run.id, {
      events: resumeEvents,
    });
    assertEquals(resumed.status, "failed");
    assertEquals(approvalRequests(resumeEvents), []);
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 0], ["w-3", 0]]),
    );
    const data = await recordOf(fleet, "gated", run.id);
    const statuses = stepStatuses(data);
    // held with the lanes, never asked
    assertEquals(statuses[`patch/${CANARY}`], "skipped");
    assertEquals(
      data.jobs[0].steps.find((s) => s.stepName === CANARY)?.settledByAbort,
      true,
    );
    assertEquals(data.jobs[0].fanOutHalts?.[0].held, ["w-2", "w-3"]);

    // fixed and retried: the canary runs again, then the gate opens
    w[0].behavior = { kind: "succeed" };
    const retryEvents: WorkflowExecutionEvent[] = [];
    const retried = await fleet.retryRun("gated", run.id, {
      events: retryEvents,
    });
    assertEquals(retried.status, "suspended");
    assertEquals(approvalRequests(retryEvents).map((e) => e.stepId), [CANARY]);
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 2], ["w-2", 0], ["w-3", 0]]),
    );
  },
});

Deno.test({
  name:
    "fan-out approval: a resume after a halt past the canary gate walks the remaining batches without asking the gate again",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 4);
    w[1].behavior = { kind: "fail", error: "batch 2 broke" };
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [gatedJob(fleet, {
        batches: [1, 1, "100%"],
        maxFailures: 0,
        approve: ["canary"],
      })],
    });
    const run = await fleet.runWorkflow("gated");
    assertEquals(run.status, "suspended");
    await fleet.decideGate("gated", run.id, CANARY, true);
    const halted = await fleet.resumeRun("gated", run.id);
    assertEquals(halted.status, "failed");
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 1], ["w-3", 0], ["w-4", 0]]),
    );

    w[1].behavior = { kind: "succeed" };
    const events: WorkflowExecutionEvent[] = [];
    const retried = await fleet.retryRun("gated", run.id, { events });
    assertEquals(retried.status, "succeeded");
    assertEquals(approvalRequests(events), []);
    assertEquals(
      fleet.dispatchCounts(),
      counts([["w-1", 1], ["w-2", 2], ["w-3", 1], ["w-4", 1]]),
    );
  },
});

Deno.test({
  name:
    "fan-out approval: a gate timeout refuses both decisions and starts no lane",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 2);
    const workflow = await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [gatedJob(fleet, {
        batches: ["100%"],
        approve: ["plan"],
        approveTimeout: 60,
      })],
    });
    const run = await fleet.runWorkflow("gated");
    assertEquals(run.status, "suspended");
    // the gate has waited past its timeout
    const data = await fleet.runRecord(workflow, run.id);
    const gate = data.jobs[0].steps.find((s) => s.stepName === PLAN)!;
    gate.startedAt = new Date(Date.now() - 120_000).toISOString();
    await fleet.saveRunRecord(workflow, data);

    for (const approved of [true, false]) {
      const decided = await fleet.decideGate("gated", run.id, PLAN, approved);
      assert(decided.kind === "error");
      assertStringIncludes(decided.error.message, "Approval timed out");
    }
    const after = await fleet.runRecord(workflow, run.id);
    assertEquals(after.status, "suspended");
    assertEquals(
      after.jobs[0].steps.find((s) => s.stepName === PLAN)?.status,
      "waiting_approval",
    );
    assertEquals(fleet.dispatchCounts(), counts([["w-1", 0], ["w-2", 0]]));
  },
});

Deno.test({
  name:
    "fan-out approval: a fan-out job without approve writes no gate records",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 2);
    const workflow = await fleet.saveWorkflow({
      name: "plain",
      inputs: {},
      jobs: [gatedJob(fleet, { batches: [1, "100%"] })],
    });
    const run = await fleet.runWorkflow("plain");
    assertEquals(run.status, "succeeded");
    const data = await fleet.runRecord(workflow, run.id);
    assertEquals(data.jobs[0].steps.map((s) => s.stepName), [
      "apply[w-1]",
      "apply[w-2]",
    ]);
    assertEquals(
      WorkflowRun.fromData(data).findWaitingApprovalStep(),
      undefined,
    );
  },
});

Deno.test({
  name:
    "fan-out approval: an approved plan gate is not asked again on a retry, and is asked again when --from reruns the job from its start",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 2);
    w[0].behavior = { kind: "fail", error: "broke" };
    w[1].behavior = { kind: "fail", error: "broke" };
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [gatedJob(fleet, { batches: ["100%"], approve: ["plan"] })],
    });
    const run = await fleet.runWorkflow("gated");
    await fleet.decideGate("gated", run.id, PLAN, true);
    assertEquals((await fleet.resumeRun("gated", run.id)).status, "failed");
    assertEquals(fleet.dispatchCounts(), counts([["w-1", 1], ["w-2", 1]]));

    const retryEvents: WorkflowExecutionEvent[] = [];
    const retried = await fleet.retryRun("gated", run.id, {
      events: retryEvents,
    });
    assertEquals(retried.status, "failed");
    assertEquals(approvalRequests(retryEvents), []);
    assertEquals(fleet.dispatchCounts(), counts([["w-1", 2], ["w-2", 2]]));

    const fromEvents: WorkflowExecutionEvent[] = [];
    const again = await fleet.retryRun("gated", run.id, {
      fromStep: "apply",
      events: fromEvents,
    });
    assertEquals(again.status, "suspended");
    assertEquals(approvalRequests(fromEvents).map((e) => e.stepId), [PLAN]);
    assertEquals(fleet.dispatchCounts(), counts([["w-1", 2], ["w-2", 2]]));
  },
});

Deno.test({
  name:
    "fan-out approval: every save of the gated runs is accepted by the run-record judge as a forwarded record would be",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 4);
    const repo = fleet.repoContext.workflowRunRepo;
    const saves: { data: WorkflowRunData; decision: boolean }[] = [];
    let deciding = false;
    const save = repo.save.bind(repo);
    repo.save = async (workflowId, run) => {
      const data = structuredClone(run.toData());
      // the harness logs outside a run's canonical log, which is not under test
      delete data.logFile;
      saves.push({ data, decision: deciding });
      return await save(workflowId, run);
    };
    const decide = async (runId: string, gate: string, approved: boolean) => {
      deciding = true;
      try {
        await fleet.decideGate("gated", runId, gate, approved);
      } finally {
        deciding = false;
      }
    };
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [
        gatedJob(fleet, {
          batches: [1, 1, "100%"],
          maxFailures: 0,
          approve: ["plan", "canary"],
        }),
        REPORT,
      ],
    });
    // approve both gates, halt in batch 2, fix and retry
    w[1].behavior = { kind: "fail", error: "broke" };
    const first = await fleet.runWorkflow("gated");
    await decide(first.id, PLAN, true);
    await fleet.resumeRun("gated", first.id);
    await decide(first.id, CANARY, true);
    assertEquals((await fleet.resumeRun("gated", first.id)).status, "failed");
    w[1].behavior = { kind: "succeed" };
    assertEquals(
      (await fleet.retryRun("gated", first.id)).status,
      "succeeded",
    );
    // a rejection at the canary gate
    const second = await fleet.runWorkflow("gated");
    await decide(second.id, PLAN, true);
    await fleet.resumeRun("gated", second.id);
    await decide(second.id, CANARY, false);

    let judged = 0;
    for (const runId of [first.id, second.id]) {
      const ofRun = saves.filter((s) => s.data.id === runId);
      for (let i = 1; i < ofRun.length; i++) {
        // serve itself writes a decision; a member never forwards one
        if (ofRun[i].decision) continue;
        const verdict = judgeRunRecord({
          workflowId: ofRun[i].data.workflowId,
          runId,
          before: ofRun[i - 1].data,
          after: ofRun[i].data,
        });
        assertEquals(verdict.refusal, undefined, `save ${i} of run ${runId}`);
        judged++;
      }
    }
    assert(judged > 10, `judged only ${judged} saves`);
  },
});

Deno.test({
  name:
    "fan-out approval: a canary gate is not written when the plan has one batch, and the planned event says which gates it holds",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 1);
    const workflow = await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [gatedJob(fleet, {
        batches: [1, "100%"],
        approve: ["plan", "canary"],
      })],
    });
    const events: WorkflowRunEvent[] = [];
    const run = await fleet.runWorkflow("gated", { events });
    const planned = events.find((e) => e.kind === "job_fanout_planned");
    assert(planned?.kind === "job_fanout_planned");
    assertEquals(planned.batches, undefined);
    assertEquals(planned.approve, ["plan"]);
    await fleet.decideGate("gated", run.id, PLAN, true);
    assertEquals((await fleet.resumeRun("gated", run.id)).status, "succeeded");
    const data = await fleet.runRecord(workflow, run.id);
    assertEquals(data.jobs[0].steps.map((s) => s.stepName), [
      PLAN,
      "apply[w-1]",
    ]);
  },
});
