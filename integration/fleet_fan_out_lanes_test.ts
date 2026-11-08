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
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import type { WorkflowRunView } from "../src/libswamp/workflows/workflow_run_view.ts";
import {
  createWorkflowEvaluateDeps,
  workflowEvaluate,
} from "../src/libswamp/workflows/evaluate.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

// The gateway's grace and dispatch timers outlive a test body by design.
const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };

interface LaneStepSpec {
  name: string;
  after?: string;
  kind?: "behavior" | "assert";
  expr?: string;
  guard?: string;
  allowFailure?: boolean;
  behavior?: string;
}

function laneJob(fleet: Fleet, steps: LaneStepSpec[], job: object = {}) {
  return {
    name: "patch",
    fanOut: "all",
    labels: WEB,
    ...job,
    steps: steps.map((step) => ({
      name: step.name,
      ...(step.after
        ? {
          dependsOn: [{
            step: step.after,
            condition: { type: step.allowFailure ? "completed" : "succeeded" },
          }],
        }
        : {}),
      ...(step.guard ? { guard: step.guard } : {}),
      ...(step.allowFailure ? { allowFailure: true } : {}),
      task: step.kind === "assert"
        ? { type: "assert", expr: step.expr, message: `${step.name} failed` }
        : {
          type: "model_method",
          modelType: fleet.modelType.normalized,
          modelName: step.behavior ?? "host-patch",
          methodName: "run",
        },
    })),
  };
}

const APPLY_VERIFY: LaneStepSpec[] = [
  { name: "apply" },
  { name: "verify", after: "apply" },
];

function steps(run: WorkflowRunView): Record<string, string> {
  return Object.fromEntries(
    run.jobs.flatMap((job) =>
      job.steps.map((step) => [step.name, step.status])
    ),
  );
}

function stepError(run: WorkflowRunView, name: string): string {
  return run.jobs.flatMap((job) => job.steps)
    .find((step) => step.name === name)?.error ?? "";
}

async function autoDefinitions(fleet: Fleet): Promise<string[]> {
  const names: string[] = [];
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) await walk(`${dir}/${entry.name}`);
      else if (entry.name.startsWith("host-patch")) names.push(entry.name);
    }
  };
  await walk(`${fleet.repoDir}/.swamp/auto-definitions`);
  return names.sort();
}

Deno.test({
  name:
    "fan-out lanes: every connected matching worker runs its lane in parallel, on its own worker and its own instance; a worker outside the selector is never sent anything",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const a = await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    await fleet.addWorker("w-db", { labels: { fleet: "db" } });
    await fleet.saveWorkflow({
      name: "patch-all",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY)],
    });
    a.behavior = { kind: "hold" };
    b.behavior = { kind: "hold" };

    const running = fleet.runWorkflow("patch-all");
    await waitFor(
      () => a.heldCount === 1 && b.heldCount === 1,
      "both lanes' first steps in flight together",
    );
    a.behavior = { kind: "succeed" };
    b.behavior = { kind: "succeed" };
    a.release(true);
    b.release(true);
    const run = await running;

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.maxInFlight, 2);
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2, "w-db": 0 });
    assertEquals(a.received.map((r) => r.stepName), [
      "apply[w-a]",
      "verify[w-a]",
    ]);
    assertEquals(b.received.map((r) => r.stepName), [
      "apply[w-b]",
      "verify[w-b]",
    ]);
    assertEquals(await autoDefinitions(fleet), [
      "host-patch-w-a.yaml",
      "host-patch-w-b.yaml",
    ]);
  },
});

Deno.test({
  name:
    "fan-out lanes: an offline member waits, and runs its whole lane when its worker reconnects mid-run",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ graceWindowMs: 200 });
    const a = await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    await b.disconnect({ untilRemoved: true });
    await fleet.saveWorkflow({
      name: "patch-wait",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY)],
    });
    a.behavior = { kind: "hold" };

    const running = fleet.runWorkflow("patch-wait");
    await waitFor(() => a.heldCount === 1, "lane w-a in flight");
    assertEquals(b.dispatchCount, 0);
    await b.connect();
    a.behavior = { kind: "succeed" };
    a.release(true);
    const run = await running;

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });
  },
});

Deno.test({
  name:
    "fan-out lanes: an offline member that never reconnects fails its lane at queueTimeout while the other lane completes",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({
      graceWindowMs: 200,
      queueTimeoutMs: 1_000,
    });
    await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    await b.disconnect({ untilRemoved: true });
    await fleet.saveWorkflow({
      name: "patch-timeout",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY)],
    });

    const run = await fleet.runWorkflow("patch-timeout");

    assertEquals(run.status, "failed");
    assertEquals(steps(run), {
      "apply[w-a]": "succeeded",
      "verify[w-a]": "succeeded",
      "apply[w-b]": "failed",
      "verify[w-b]": "skipped",
    });
    assertStringIncludes(
      stepError(run, "apply[w-b]"),
      "Timed out waiting for a worker matching target 'w-b'",
    );
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 0 });
  },
});

Deno.test({
  name:
    "fan-out lanes: offline skip records the member and the job succeeds; offline fail records it and fails the job; neither is sent anything",
  ...SANITIZE,
  fn: async () => {
    for (const offline of ["skip", "fail"] as const) {
      await using fleet = await Fleet.start({ graceWindowMs: 200 });
      await fleet.addWorker("w-a", { labels: WEB });
      const b = await fleet.addWorker("w-b", { labels: WEB });
      await b.disconnect({ untilRemoved: true });
      const workflow = await fleet.saveWorkflow({
        name: `patch-${offline}`,
        inputs: {},
        jobs: [laneJob(fleet, APPLY_VERIFY, { fanOut: { offline } })],
      });

      const run = await fleet.runWorkflow(`patch-${offline}`);

      assertEquals(run.status, offline === "skip" ? "succeeded" : "failed");
      assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 0 });
      const [stored] = await fleet.repoContext.workflowRunRepo
        .findAllByWorkflowId(workflow.id);
      const member = stored.getJob("patch")!.fanOutPlan!.members.find((m) =>
        m.worker === "w-b"
      );
      assertEquals(
        member?.disposition,
        offline === "skip" ? "skipped" : "failed",
      );
      assertEquals(member?.reason, "disconnected");
    }
  },
});

Deno.test({
  name:
    "fan-out lanes: unverified and draining workers are excluded at plan time and never receive a dispatch",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-unv", { labels: WEB, unverified: true });
    const drain = await fleet.addWorker("w-drain", { labels: WEB });
    await drain.drain();
    const workflow = await fleet.saveWorkflow({
      name: "patch-excluded",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY)],
    });

    const run = await fleet.runWorkflow("patch-excluded");

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), {
      "w-a": 2,
      "w-unv": 0,
      "w-drain": 0,
    });
    const [stored] = await fleet.repoContext.workflowRunRepo
      .findAllByWorkflowId(workflow.id);
    assertEquals(
      stored.getJob("patch")!.fanOutPlan!.members.map((m) => [
        m.worker,
        m.disposition,
        m.reason,
      ]),
      [
        ["w-a", "dispatch", undefined],
        ["w-drain", "excluded", "draining"],
        ["w-unv", "excluded", "unverified"],
      ],
    );
  },
});

Deno.test({
  name:
    "fan-out lanes: a worker that starts draining after the plan fails its lane with worker_ineligible, and is never sent the lane",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const a = await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    await fleet.saveWorkflow({
      name: "patch-drain",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY, { concurrency: 1 })],
    });
    a.behavior = { kind: "hold" };

    const running = fleet.runWorkflow("patch-drain");
    await waitFor(() => a.heldCount === 1, "lane w-a in flight first");
    await b.drain();
    a.behavior = { kind: "succeed" };
    a.release(true);
    const run = await running;

    assertEquals(run.status, "failed");
    assertEquals(steps(run)["apply[w-b]"], "failed");
    assertStringIncludes(stepError(run, "apply[w-b]"), "worker_ineligible");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 0 });
  },
});

Deno.test({
  name:
    "fan-out lanes: a selector matching no worker, or fewer live members than minWorkers, fails the job and sends nothing",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.saveWorkflow({
      name: "patch-nobody",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY, { labels: { fleet: "none" } })],
    });
    await fleet.saveWorkflow({
      name: "patch-too-few",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY, { fanOut: { minWorkers: 2 } })],
    });

    const nobody = await fleet.runWorkflow("patch-nobody");
    const tooFew = await fleet.runWorkflow("patch-too-few");

    assertEquals(nobody.status, "failed");
    assertStringIncludes(
      stepError(nobody, "apply"),
      "needs at least 1 worker matching labels fleet=none that is connected or waiting, and 0 are",
    );
    assertEquals(tooFew.status, "failed");
    assertStringIncludes(
      stepError(tooFew, "apply"),
      "needs at least 2 workers matching labels fleet=web that are connected or waiting, and 1 is",
    );
    assertEquals(fleet.dispatchCounts(), { "w-a": 0 });
  },
});

Deno.test({
  name:
    "fan-out lanes: a failing assert fails only its lane and the job; the other lane runs to completion",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    await fleet.saveWorkflow({
      name: "patch-assert",
      inputs: {},
      jobs: [laneJob(fleet, [
        ...APPLY_VERIFY,
        {
          name: "landed",
          after: "verify",
          kind: "assert",
          expr:
            'self.worker.name == "w-a" && self.worker.labels.fleet == "web"',
        },
      ])],
    });

    const run = await fleet.runWorkflow("patch-assert");

    assertEquals(run.status, "failed");
    assertEquals(steps(run)["landed[w-a]"], "succeeded");
    assertEquals(steps(run)["landed[w-b]"], "failed");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });
  },
});

Deno.test({
  name:
    "fan-out lanes: self.worker resolves in a guard, and a lane's steps reference reads only its own lane's step",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    b.behavior = { kind: "fail", error: "apply broke on w-b" };
    await fleet.saveWorkflow({
      name: "patch-scope",
      inputs: {},
      jobs: [laneJob(fleet, [
        { name: "apply", allowFailure: true },
        {
          name: "same-lane",
          after: "apply",
          allowFailure: true,
          kind: "assert",
          expr: 'steps.apply.status == "succeeded"',
        },
        {
          name: "only-w-b",
          after: "apply",
          allowFailure: true,
          guard: '${{ self.worker.name == "w-a" }}',
        },
      ])],
    });

    const run = await fleet.runWorkflow("patch-scope");

    assertEquals(steps(run)["same-lane[w-a]"], "succeeded");
    assertEquals(steps(run)["same-lane[w-b]"], "failed");
    assertEquals(steps(run)["only-w-b[w-a]"], "skipped");
    assertEquals(steps(run)["only-w-b[w-b]"], "failed");
    assertEquals(b.received.map((r) => r.stepName), [
      "apply[w-b]",
      "only-w-b[w-b]",
    ]);
  },
});

Deno.test({
  name:
    "fan-out lanes: SWAMP_MAX_CONCURRENT_STEPS caps lanes in flight below the job's concurrency",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const workers = await Promise.all(
      ["w-a", "w-b", "w-c"].map((name) =>
        fleet.addWorker(name, { labels: WEB })
      ),
    );
    await fleet.saveWorkflow({
      name: "patch-capped",
      inputs: {},
      jobs: [laneJob(fleet, [{ name: "apply" }], { concurrency: 3 })],
    });
    for (const worker of workers) worker.behavior = { kind: "hold" };

    await withMockedEnv({ SWAMP_MAX_CONCURRENT_STEPS: "1" }, async () => {
      const running = fleet.runWorkflow("patch-capped");
      for (let released = 0; released < 3; released++) {
        await waitFor(
          () => workers.some((w) => w.heldCount === 1),
          "a lane in flight",
        );
        assertEquals(workers.filter((w) => w.heldCount > 0).length, 1);
        workers.find((w) => w.heldCount === 1)!.release();
      }
      assertEquals((await running).status, "succeeded");
    });
    assertEquals(fleet.maxInFlight, 1);
  },
});

Deno.test({
  name:
    "fan-out lanes: cancelling the run mid-lane starts no further lane or step, and the run ends cancelled",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const a = await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const workflow = await fleet.saveWorkflow({
      name: "patch-cancel",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY, { concurrency: 1 })],
    });
    a.behavior = { kind: "hold" };
    const controller = new AbortController();

    const running = fleet.runWorkflow("patch-cancel", {
      signal: controller.signal,
    })
      .catch(() => undefined);
    await waitFor(() => a.heldCount === 1, "lane w-a in flight");
    controller.abort();
    a.release(true);
    await running;

    const [stored] = await fleet.repoContext.workflowRunRepo
      .findAllByWorkflowId(workflow.id);
    assert(stored.status !== "running" && stored.status !== "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-b": 0 });
    const job = stored.getJob("patch")!;
    assert(job.status !== "running", job.status);
    for (const name of ["verify[w-a]", "apply[w-b]", "verify[w-b]"]) {
      const status = job.getStep(name)?.status;
      assert(
        status !== "running" && status !== "succeeded" && status !== "pending",
        `${name} ${status}`,
      );
    }
  },
});

Deno.test({
  name:
    "fan-out lanes: a child workflow holding a fan-out job runs its lanes from the parent's workflow step",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    await fleet.saveWorkflow({
      name: "child-patch",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY)],
    });
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      jobs: [{
        name: "outer",
        steps: [{
          name: "call",
          task: { type: "workflow", workflowIdOrName: "child-patch" },
        }],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });
  },
});

Deno.test({
  name:
    "fan-out lanes: workflow evaluate leaves self.worker for run time, and a --last-evaluated run resolves it in each lane",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    await fleet.saveWorkflow({
      name: "patch-evaluated",
      inputs: {},
      jobs: [laneJob(fleet, [
        { name: "apply", guard: '${{ self.worker.name == "w-a" }}' },
      ])],
    });
    const events = [];
    for await (
      const event of workflowEvaluate(
        createLibSwampContext(),
        createWorkflowEvaluateDeps(
          fleet.repoDir,
          fleet.repoContext.workflowRepo,
        ),
        { workflowIdOrName: "patch-evaluated", inputs: {} },
      )
    ) {
      events.push(event);
    }
    const completed = events.find((event) => event.kind === "completed");
    assert(completed !== undefined, JSON.stringify(events));
    assertStringIncludes(JSON.stringify(completed), "self.worker.name");

    const run = await fleet.runWorkflow("patch-evaluated", {
      lastEvaluated: true,
    });

    assertEquals(run.status, "succeeded");
    assertEquals(steps(run), {
      "apply[w-a]": "skipped",
      "apply[w-b]": "succeeded",
    });
    assertEquals(b.received.map((r) => r.stepName), ["apply[w-b]"]);
  },
});

Deno.test({
  name:
    "fan-out lanes: a behaviorName that already references self.worker is left as written, one instance per worker",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const job = laneJob(fleet, [{ name: "apply" }]);
    job.steps[0].task = {
      ...job.steps[0].task,
      modelName: "host-patch-${{ self.worker.name }}",
    } as typeof job.steps[0]["task"];
    await fleet.saveWorkflow({ name: "patch-named", inputs: {}, jobs: [job] });

    const run = await fleet.runWorkflow("patch-named");

    assertEquals(run.status, "succeeded");
    assertEquals(await autoDefinitions(fleet), [
      "host-patch-w-a.yaml",
      "host-patch-w-b.yaml",
    ]);
  },
});

Deno.test({
  name:
    "fan-out lanes: after a cancel a started lane still runs its cleanup step, as a plain job does, and a lane not yet started sends nothing",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const a = await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    await fleet.saveWorkflow({
      name: "patch-cleanup",
      inputs: {},
      jobs: [laneJob(fleet, [
        { name: "apply" },
        { name: "release", after: "apply", allowFailure: true },
      ], { concurrency: 1 })],
    });
    a.behavior = { kind: "hold" };
    const controller = new AbortController();

    const running = fleet.runWorkflow("patch-cleanup", {
      signal: controller.signal,
    }).catch(() => undefined);
    await waitFor(() => a.heldCount === 1, "lane w-a's apply in flight");
    a.behavior = { kind: "succeed" };
    controller.abort();
    a.release(true);
    await running;

    assertEquals(a.received.map((r) => r.stepName), [
      "apply[w-a]",
      "release[w-a]",
    ]);
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 0 });
  },
});

Deno.test({
  name:
    "fan-out lanes: SWAMP_MAX_CONCURRENT_STEPS is one ceiling across lanes whose levels hold several steps",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const workers = await Promise.all(
      ["w-a", "w-b"].map((name) =>
        fleet.addWorker(name, { labels: WEB, capacity: 2 })
      ),
    );
    await fleet.saveWorkflow({
      name: "patch-wide",
      inputs: {},
      jobs: [laneJob(fleet, [
        { name: "left", behavior: "host-left" },
        { name: "right", behavior: "host-right" },
      ], {
        concurrency: 2,
      })],
    });
    for (const worker of workers) worker.behavior = { kind: "hold" };

    await withMockedEnv({ SWAMP_MAX_CONCURRENT_STEPS: "2" }, async () => {
      let done = false;
      const running = fleet.runWorkflow("patch-wide").finally(() => {
        done = true;
      });
      const held = () => workers.reduce((n, w) => n + w.heldCount, 0);
      await waitFor(() => held() === 2, "the ceiling's two steps in flight");
      while (!done) {
        await waitFor(
          () => done || workers.some((w) => w.heldCount > 0),
          "a step in flight or the run done",
        );
        for (const worker of workers) worker.release(true);
      }
      assertEquals((await running).status, "succeeded");
    });
    assertEquals(fleet.maxInFlight, 2);
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });
  },
});

Deno.test({
  name:
    "fan-out lanes: behaviors that would share one instance across two workers refuse the plan, and nothing is sent",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("a-b", { labels: WEB });
    await fleet.addWorker("b", { labels: WEB });
    await fleet.saveWorkflow({
      name: "patch-clash",
      inputs: {},
      jobs: [laneJob(fleet, [
        { name: "apply", behavior: "host" },
        { name: "verify", after: "apply", behavior: "host-a" },
      ])],
    });

    const run = await fleet.runWorkflow("patch-clash");

    assertEquals(run.status, "failed");
    assertStringIncludes(
      stepError(run, "apply"),
      "as the same instance 'host-a-b'",
    );
    assertEquals(fleet.dispatchCounts(), { "a-b": 0, "b": 0 });
  },
});

Deno.test({
  name:
    "fan-out lanes: an offline member whose worker comes back as a restarted process (a new instance UUID) still runs its lane",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ graceWindowMs: 200 });
    const a = await fleet.addWorker("w-a", { labels: WEB });
    const b = await fleet.addWorker("w-b", { labels: WEB });
    await b.disconnect({ untilRemoved: true });
    await fleet.saveWorkflow({
      name: "patch-restart",
      inputs: {},
      jobs: [laneJob(fleet, APPLY_VERIFY)],
    });
    a.behavior = { kind: "hold" };

    const running = fleet.runWorkflow("patch-restart");
    await waitFor(() => a.heldCount === 1, "lane w-a in flight");
    const planned = b.instanceUuid;
    await b.restart();
    assert(b.instanceUuid !== planned);
    a.behavior = { kind: "succeed" };
    a.release(true);
    const run = await running;

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2 });
  },
});
