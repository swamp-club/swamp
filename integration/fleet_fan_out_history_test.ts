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
import { setColorEnabled } from "@std/fmt/colors";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
} from "../src/libswamp/workflows/history_get.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import type {
  FanOutRunView,
  WorkflowRunView,
} from "../src/libswamp/workflows/workflow_run_view.ts";
import { renderWorkflowRunDisplay } from "../src/presentation/renderers/workflow_run_display.ts";
import {
  handleWorkflowApprove,
  handleWorkflowHistoryGet,
} from "../src/serve/handlers/workflow_handlers.ts";
import { Fleet, type FleetWorker } from "./fleet_harness.ts";

await initializeLogging({});

// The gateway's grace and dispatch timers outlive a test body by design.
const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };
const PLAN = "patch[approve-plan]";
const CANARY = "patch[approve-canary]";

function fanOutJob(fleet: Fleet, fanOut: object) {
  return {
    name: "patch",
    fanOut,
    labels: WEB,
    steps: [{
      name: "apply",
      task: {
        type: "model_method",
        modelType: fleet.modelType.normalized,
        modelName: "host-patch",
        methodName: "run",
      },
    }],
  };
}

async function workers(fleet: Fleet, count: number): Promise<FleetWorker[]> {
  const added: FleetWorker[] = [];
  for (let i = 1; i <= count; i++) {
    added.push(await fleet.addWorker(`w-${i}`, { labels: WEB }));
  }
  return added;
}

function captured(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  setColorEnabled(false);
  try {
    fn();
  } finally {
    console.log = original;
    setColorEnabled(true);
  }
  return lines.join("\n");
}

function socketInto(sent: string[]): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
  } as unknown as WebSocket;
}

interface Inspected {
  view: WorkflowRunView;
  fanOut: FanOutRunView | undefined;
  log: string;
  json: WorkflowRunView;
}

/** reads the run as history get does: libswamp in both modes, and serve's reply */
async function inspect(fleet: Fleet, runId: string): Promise<Inspected> {
  const ctx = fleet.serveContext(false);
  const deps = createWorkflowHistoryGetDeps(
    ctx.repoDir,
    ctx.datastoreResolver,
    ctx.repoContext.workflowRepo,
  );
  let view: WorkflowRunView | undefined;
  for await (
    const event of workflowHistoryGet(createLibSwampContext(), deps, runId)
  ) {
    if (event.kind === "completed") view = event.data;
    if (event.kind === "error") throw new Error(event.error.message);
  }
  assert(view !== undefined);
  const log = captured(() => renderWorkflowRunDisplay(view!, "log"));
  const json = JSON.parse(
    captured(() => renderWorkflowRunDisplay(view!, "json")),
  );

  const sent: string[] = [];
  await handleWorkflowHistoryGet(
    socketInto(sent),
    ctx,
    "history-1",
    { workflowIdOrName: runId },
    new AbortController(),
    null,
  );
  const reply = JSON.parse(sent[0]);
  assertEquals(reply.type, "workflow.history.get", sent[0]);
  const served = reply.payload.data as WorkflowRunView;
  assertEquals(
    served.jobs.map((job) => job.fanOut),
    view.jobs.map((job) => job.fanOut),
  );
  assertEquals(json.jobs, JSON.parse(JSON.stringify(view.jobs)));
  assert(!JSON.stringify(served).includes(fleet.worker("w-1").instanceUuid));
  return { view, fanOut: view.jobs[0].fanOut, log, json };
}

function laneResults(fanOut: FanOutRunView | undefined) {
  return Object.fromEntries(
    (fanOut?.members ?? []).map((member) => [member.worker, member.lane]),
  );
}

async function approveThroughServe(
  ctx: ReturnType<Fleet["serveContext"]>,
  workflow: string,
  runId: string,
  stepName: string,
): Promise<Record<string, unknown>> {
  const sent: string[] = [];
  await handleWorkflowApprove(
    socketInto(sent),
    ctx,
    "approve-1",
    { workflowIdOrName: workflow, stepName, runId },
    new AbortController(),
    null,
  );
  const reply = JSON.parse(sent[0]);
  assertEquals(reply.type, "workflow.approve", sent[0]);
  return reply.payload.data;
}

Deno.test({
  name:
    "fan-out history: a member offline at plan time shows as waiting (disconnected) and its lane as succeeded once it reconnected and ran",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ graceWindowMs: 60_000 });
    const w = await workers(fleet, 2);
    await w[1].disconnect();
    await fleet.saveWorkflow({
      name: "offline",
      inputs: {},
      jobs: [fanOutJob(fleet, { offline: "wait" })],
    });
    const events: WorkflowRunEvent[] = [];
    const running = fleet.runWorkflow("offline", { events });
    await waitFor(
      () => events.some((e) => e.kind === "job_fanout_planned"),
      "the plan to be made",
    );
    await w[1].connect();
    const run = await running;
    assertEquals(run.status, "succeeded");

    const { fanOut, log } = await inspect(fleet, run.id);
    assertEquals(fanOut?.policy, { offline: "wait", minWorkers: 1 });
    assertEquals(fanOut?.members.find((m) => m.worker === "w-2"), {
      worker: "w-2",
      disposition: "waiting",
      reason: "disconnected",
      batch: 0,
      lane: "succeeded",
    });
    assertEquals(laneResults(fanOut), {
      "w-1": "succeeded",
      "w-2": "succeeded",
    });
    assertStringIncludes(log, "Fan-out: fleet=web; offline wait, minWorkers 1");
    assertStringIncludes(
      log,
      "w-2: waiting (disconnected), batch 1, succeeded",
    );
  },
});

Deno.test({
  name:
    "fan-out history: a member still being verified at plan time shows as waiting (unverified) and its lane as succeeded once its probe passed",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ graceWindowMs: 60_000 });
    const w = await workers(fleet, 2);
    await w[1].disconnect();
    const settleProbe = fleet.holdProbe("w-2");
    await w[1].connect({ settle: false });
    await fleet.saveWorkflow({
      name: "verifying",
      inputs: {},
      jobs: [fanOutJob(fleet, { offline: "wait" })],
    });
    const events: WorkflowRunEvent[] = [];
    const running = fleet.runWorkflow("verifying", { events });
    await waitFor(
      () => events.some((e) => e.kind === "job_fanout_planned"),
      "the plan to be made",
    );
    settleProbe("pass");
    const run = await running;
    assertEquals(run.status, "succeeded");

    const { fanOut, log } = await inspect(fleet, run.id);
    assertEquals(fanOut?.members.find((m) => m.worker === "w-2"), {
      worker: "w-2",
      disposition: "waiting",
      reason: "unverified",
      batch: 0,
      lane: "succeeded",
    });
    assertStringIncludes(log, "w-2: waiting (unverified), batch 1, succeeded");
  },
});

Deno.test({
  name:
    "fan-out history: a canary halt shows the failed canary with its error, the held lanes and the spent budget",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 3);
    w[0].behavior = { kind: "fail", error: "canary broke" };
    await fleet.saveWorkflow({
      name: "canary",
      inputs: {},
      jobs: [fanOutJob(fleet, {
        rollout: { batches: [1, "100%"], maxFailures: 0 },
      })],
    });
    const run = await fleet.runWorkflow("canary");
    assertEquals(run.status, "failed");

    const { fanOut, log } = await inspect(fleet, run.id);
    assertEquals(fanOut?.batches, [["w-1"], ["w-2", "w-3"]]);
    assertEquals(fanOut?.budget, { allowed: 0, used: 1 });
    assertEquals(laneResults(fanOut), {
      "w-1": "failed",
      "w-2": "held",
      "w-3": "held",
    });
    const canary = fanOut?.members.find((m) => m.worker === "w-1");
    assertEquals(canary?.failedSteps?.[0].step, "apply[w-1]");
    assertStringIncludes(canary?.failedSteps?.[0].error ?? "", "canary broke");
    assertEquals(fanOut?.halts, [{
      reason: "budget",
      batch: 1,
      maxFailures: 0,
      failed: ["w-1"],
      held: ["w-2", "w-3"],
    }]);
    assertEquals(fanOut?.resume, undefined);
    assertStringIncludes(
      log,
      "attempt 1: budget spent in batch 2 (0 failed lane(s) allowed); failed w-1; held w-2, w-3",
    );
  },
});

Deno.test({
  name:
    "fan-out history: after a halt and a resume, the halt stays as recorded and the resume names the lanes it reran and the one it kept",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 3);
    w[1].behavior = { kind: "fail", error: "w-2 broke" };
    await fleet.saveWorkflow({
      name: "resumed",
      inputs: {},
      jobs: [fanOutJob(fleet, {
        rollout: { batches: [2, "100%"], maxFailures: 0 },
      })],
    });
    const run = await fleet.runWorkflow("resumed");
    assertEquals(run.status, "failed");
    w[1].behavior = { kind: "succeed" };
    const retried = await fleet.retryRun("resumed", run.id);
    assertEquals(retried.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-1": 1, "w-2": 2, "w-3": 1 });

    const { fanOut, log } = await inspect(fleet, run.id);
    assertEquals(laneResults(fanOut), {
      "w-1": "succeeded",
      "w-2": "succeeded",
      "w-3": "succeeded",
    });
    assertEquals(fanOut?.halts, [{
      reason: "budget",
      batch: 1,
      maxFailures: 0,
      failed: ["w-2"],
      held: ["w-3"],
    }]);
    assertEquals(fanOut?.budget.used, 0);
    assertEquals(fanOut?.resume?.rerun, ["w-2", "w-3"]);
    assertEquals(fanOut?.resume?.kept, ["w-1"]);
    assertStringIncludes(log, "rerun w-2, w-3; kept w-1");
  },
});

Deno.test({
  name:
    "fan-out history: an approved plan gate and a rejected canary gate show who decided, when and why, and the rejection holds the rest",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 3);
    await fleet.saveWorkflow({
      name: "gated",
      inputs: {},
      jobs: [fanOutJob(fleet, {
        rollout: {
          batches: [1, "100%"],
          maxFailures: 0,
          approve: ["plan", "canary"],
        },
      })],
    });
    const run = await fleet.runWorkflow("gated");
    assertEquals(run.status, "suspended");
    const waiting = await inspect(fleet, run.id);
    assertEquals(
      waiting.fanOut?.gates.map((gate) => [gate.kind, gate.status]),
      [["plan", "waiting"], ["canary", "pending"]],
    );

    await fleet.decideGate("gated", run.id, PLAN, true);
    await fleet.resumeRun("gated", run.id);
    await fleet.decideGate(
      "gated",
      run.id,
      CANARY,
      false,
      "canary metrics looked wrong",
    );

    const { fanOut, log } = await inspect(fleet, run.id);
    const [plan, canary] = fanOut?.gates ?? [];
    assertEquals(plan.status, "approved");
    assertEquals(plan.approval?.approvedBy, "approver");
    assert(plan.approval?.approvedAt !== undefined);
    assertEquals(canary.status, "rejected");
    assertEquals(canary.approval?.rejectedBy, "approver");
    assertEquals(canary.approval?.reason, "canary metrics looked wrong");
    assertEquals(fanOut?.halts, [{
      reason: "gate_rejected",
      gate: "canary",
      held: ["w-2", "w-3"],
    }]);
    assertEquals(laneResults(fanOut), {
      "w-1": "succeeded",
      "w-2": "held",
      "w-3": "held",
    });
    assertStringIncludes(log, "plan: approved by approver");
    assertStringIncludes(log, "canary: rejected by approver");
    assertStringIncludes(log, "Reason: canary metrics looked wrong");
    assertStringIncludes(log, "canary gate rejected: held w-2, w-3");
  },
});

Deno.test({
  name:
    "fan-out history: a run serve continued after an approval shows the plan, lanes and halt of that continuation",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const w = await workers(fleet, 3);
    w[1].behavior = { kind: "fail", error: "w-2 broke" };
    const workflow = await fleet.saveWorkflow({
      name: "continued",
      inputs: {},
      jobs: [fanOutJob(fleet, {
        rollout: {
          batches: [1, 1, "100%"],
          maxFailures: 0,
          approve: ["canary"],
        },
      })],
    });
    const run = await fleet.runWorkflow("continued");
    assertEquals(run.status, "suspended");

    const ctx = fleet.serveContext(true);
    const reply = await approveThroughServe(ctx, "continued", run.id, CANARY);
    assertEquals(reply.autoResumed, true);
    // the record alone: inspect compares two reads, which differ mid-write
    await waitFor(
      async () => (await fleet.runRecord(workflow, run.id)).status === "failed",
      "serve's continuation to halt the rollout",
    );
    await waitFor(
      () => ctx.activeRunRegistry?.get(run.id) === undefined,
      "the continuation to end",
    );

    const { fanOut, log } = await inspect(fleet, run.id);
    assertEquals(fanOut?.batches, [["w-1"], ["w-2"], ["w-3"]]);
    assertEquals(laneResults(fanOut), {
      "w-1": "succeeded",
      "w-2": "failed",
      "w-3": "held",
    });
    assertEquals(fanOut?.gates.map((gate) => gate.status), ["approved"]);
    assertEquals(fanOut?.halts, [{
      reason: "budget",
      batch: 2,
      maxFailures: 0,
      failed: ["w-2"],
      held: ["w-3"],
    }]);
    assertEquals(fanOut?.resume?.kept, ["w-1"]);
    assertEquals(fanOut?.resume?.rerun, ["w-2", "w-3"]);
    assertStringIncludes(log, "w-2: dispatch, batch 2, failed");
    assertStringIncludes(
      log,
      "attempt 1: budget spent in batch 3 (0 failed lane(s) allowed); failed w-2; held w-3",
    );
  },
});

Deno.test({
  name:
    "fan-out history: a run with no fan-out job carries no fan-out view in either mode",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await workers(fleet, 1);
    await fleet.saveWorkflow({
      name: "plain",
      inputs: {},
      jobs: [{
        name: "main",
        steps: [{
          name: "check",
          task: { type: "assert", expr: "true", message: "never" },
        }],
      }],
    });
    const run = await fleet.runWorkflow("plain");
    assertEquals(run.status, "succeeded");

    const { view, log, json } = await inspect(fleet, run.id);
    assertEquals("fanOut" in view.jobs[0], false);
    assertEquals("fanOut" in json.jobs[0], false);
    assertEquals(log.includes("Fan-out"), false);
  },
});
