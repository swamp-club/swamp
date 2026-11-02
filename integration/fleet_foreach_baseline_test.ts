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

/**
 * Today's fleet pattern, recorded (swamp-club#4271): `forEach` over
 * `workers.connected()` with a `target` per item, as
 * design/enablers/expressions.md documents it, run through serve's own run
 * and retry paths with in-process workers. Each row is pinned by how many
 * dispatches each worker received.
 *
 * These rows describe what swamp does before fleet fan-out, not what it
 * should do. Fan-out jobs replace the pattern; a `forEach` job must keep
 * every row here. The workers.connected() fix (unverified and draining
 * workers dropped) is expected to change the unverified and draining rows,
 * and only those.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { WorkflowRunView } from "../src/libswamp/workflows/workflow_run_view.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

/** Seconds; the YAML unit. Short, so the queued rows end quickly. */
const QUEUE_TIMEOUT_S = 1;

/**
 * The documented fleet pattern over one definition. With `perWorker`, each
 * iteration runs its own definition (`<model>-<worker>`) instead.
 */
async function saveFleetPattern(
  fleet: Fleet,
  options: { model?: string; perWorker?: boolean } = {},
): Promise<string> {
  const model = options.model ?? "scanner";
  const name = `fleet-${crypto.randomUUID()}`;
  await fleet.saveWorkflow({
    name,
    inputs: {},
    jobs: [{
      name: "scan",
      queueTimeout: QUEUE_TIMEOUT_S,
      steps: [{
        name: "scan-${{ self.worker.attributes.name }}",
        forEach: { item: "worker", in: "${{ workers.connected() }}" },
        target: "${{ self.worker.attributes.name }}",
        task: {
          type: "model_method",
          modelIdOrName: options.perWorker
            ? `${model}-\${{ self.worker.attributes.name }}`
            : model,
          methodName: "run",
        },
      }],
    }],
  });
  return name;
}

/** Each step's status by name, across jobs. */
function viewSteps(run: WorkflowRunView): Record<string, string> {
  return Object.fromEntries(
    run.jobs.flatMap((job) => job.steps.map((s) => [s.name, s.status])),
  );
}

function viewError(run: WorkflowRunView, stepName: string): string {
  const step = run.jobs.flatMap((job) => job.steps).find((s) =>
    s.name === stepName
  );
  return step?.error ?? "";
}

function runSteps(run: WorkflowRun): Record<string, string> {
  return Object.fromEntries(
    run.toData().jobs.flatMap((job) =>
      job.steps.map((s) => [s.stepName, s.status])
    ),
  );
}

Deno.test({
  name:
    "fleet pattern: an offline host never appears in the expansion, is never dispatched, and the run does not report it",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    const offline = await fleet.addWorker("w-off");
    await offline.disconnect();
    await fleet.saveDefinition("scanner");

    const run = await fleet.runWorkflow(await saveFleetPattern(fleet));

    assertEquals(run.status, "succeeded");
    assertEquals(viewSteps(run), { "scan-w-a": "succeeded" });
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-off": 0 });
  },
});

Deno.test({
  name:
    "fleet pattern: an unverified host is expanded (its record is not disconnected) but never dispatched; its step queues until queueTimeout and fails the run",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.addWorker("w-unv", { unverified: true });
    await fleet.saveDefinition("scanner");

    const run = await fleet.runWorkflow(await saveFleetPattern(fleet));

    assertEquals(run.status, "failed");
    assertEquals(viewSteps(run), {
      "scan-w-a": "succeeded",
      "scan-w-unv": "failed",
    });
    assertStringIncludes(
      viewError(run, "scan-w-unv"),
      "Timed out waiting for a worker matching target 'w-unv'",
    );
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-unv": 0 });
  },
});

Deno.test({
  name:
    "fleet pattern: a draining host is expanded but never dispatched; its step queues until queueTimeout and fails the run",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    const draining = await fleet.addWorker("w-drain");
    await draining.drain();
    await fleet.saveDefinition("scanner");

    const run = await fleet.runWorkflow(await saveFleetPattern(fleet));

    assertEquals(run.status, "failed");
    assertEquals(viewSteps(run), {
      "scan-w-a": "succeeded",
      "scan-w-drain": "failed",
    });
    assertStringIncludes(
      viewError(run, "scan-w-drain"),
      "Timed out waiting for a worker matching target 'w-drain'",
    );
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-drain": 0 });
  },
});

/**
 * Holds every dispatch and lets them finish one at a time, checking at each
 * release that the held dispatch is the only one in flight. The control row
 * below shows the same harness seeing every iteration in flight at once
 * when nothing serializes them.
 */
async function runOneAtATime(
  fleet: Fleet,
  workflowName: string,
  expected: number,
): Promise<WorkflowRunView> {
  for (const worker of fleet.workers.values()) {
    worker.behavior = { kind: "hold" };
  }
  const running = fleet.runWorkflow(workflowName);
  const held = () =>
    [...fleet.workers.values()].reduce((n, w) => n + w.heldCount, 0);
  for (let released = 0; released < expected; released++) {
    await waitFor(() => held() > 0, `dispatch ${released + 1} to arrive`);
    assertEquals(held(), 1, `in flight at dispatch ${released + 1}`);
    [...fleet.workers.values()].find((w) => w.heldCount > 0)!.release();
  }
  return await running;
}

Deno.test({
  name:
    "fleet pattern: iterations of one shared definition serialize on its per-model lock, one dispatch in flight at a time",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.addWorker("w-b");
    await fleet.addWorker("w-c");
    await fleet.saveDefinition("scanner");

    const run = await runOneAtATime(fleet, await saveFleetPattern(fleet), 3);

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-b": 1, "w-c": 1 });
    assertEquals(fleet.maxInFlight, 1);
  },
});

Deno.test({
  name:
    "fleet pattern: iterations over one definition per worker run at the same time (control for the per-model lock row)",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    for (const name of ["w-a", "w-b", "w-c"]) {
      await fleet.addWorker(name);
      await fleet.saveDefinition(`scanner-${name}`);
    }
    const workflowName = await saveFleetPattern(fleet, { perWorker: true });

    for (const worker of fleet.workers.values()) {
      worker.behavior = { kind: "hold" };
    }
    const running = fleet.runWorkflow(workflowName);
    await waitFor(
      () => [...fleet.workers.values()].every((w) => w.heldCount === 1),
      "every iteration to be in flight at once",
    );
    for (const worker of fleet.workers.values()) worker.release(true);
    const run = await running;

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-b": 1, "w-c": 1 });
    assertEquals(fleet.maxInFlight, 3);
  },
});

Deno.test({
  name:
    "fleet pattern: with no connected workers the list is empty, the step expands to nothing, and the run succeeds",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const gone = await fleet.addWorker("w-off");
    await gone.disconnect();
    await fleet.saveDefinition("scanner");

    const run = await fleet.runWorkflow(await saveFleetPattern(fleet));

    assertEquals(run.status, "succeeded");
    assertEquals(viewSteps(run), {});
    assertEquals(fleet.dispatchCounts(), { "w-off": 0 });
  },
});

async function failedRunOnThreeWorkers(
  fleet: Fleet,
): Promise<{ workflowName: string; runId: string }> {
  await fleet.addWorker("w-a");
  await fleet.addWorker("w-b");
  const failing = await fleet.addWorker("w-c");
  failing.behavior = { kind: "fail", error: "patch failed on w-c" };
  await fleet.saveDefinition("scanner");
  const workflowName = await saveFleetPattern(fleet);
  const first = await fleet.runWorkflow(workflowName);
  assertEquals(first.status, "failed");
  assertEquals(viewSteps(first), {
    "scan-w-a": "succeeded",
    "scan-w-b": "succeeded",
    "scan-w-c": "failed",
  });
  assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-b": 1, "w-c": 1 });
  failing.behavior = { kind: "succeed" };
  return { workflowName, runId: first.id };
}

Deno.test({
  name:
    "fleet pattern: retrying a failed run over an unchanged pool dispatches every iteration again, passed ones included",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const { workflowName, runId } = await failedRunOnThreeWorkers(fleet);

    const retried = await fleet.retryRun(workflowName, runId);

    assertEquals(retried.status, "succeeded");
    assertEquals(runSteps(retried), {
      "scan-w-a": "succeeded",
      "scan-w-b": "succeeded",
      "scan-w-c": "succeeded",
    });
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2, "w-c": 2 });
  },
});

Deno.test({
  name:
    "fleet pattern: a --from retry at the forEach template dispatches every iteration again, as a plain retry does",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const { workflowName, runId } = await failedRunOnThreeWorkers(fleet);

    const retried = await fleet.retryRun(workflowName, runId, {
      fromStep: "scan-${{ self.worker.attributes.name }}",
    });

    assertEquals(retried.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 2, "w-b": 2, "w-c": 2 });
  },
});

Deno.test({
  name:
    "fleet pattern: a retry re-expands against the live pool: a worker that joined is dispatched, and the iteration of one that left fails as stranded",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const { workflowName, runId } = await failedRunOnThreeWorkers(fleet);
    await fleet.worker("w-b").disconnect();
    await fleet.addWorker("w-d");

    const retried = await fleet.retryRun(workflowName, runId);

    assertEquals(retried.status, "failed");
    assertEquals(runSteps(retried), {
      "scan-w-a": "succeeded",
      "scan-w-b": "failed",
      "scan-w-c": "succeeded",
      "scan-w-d": "succeeded",
    });
    const stranded = retried.toData().jobs[0].steps.find((step) =>
      step.stepName === "scan-w-b"
    );
    assertStringIncludes(
      stranded?.error ?? "",
      "a forEach collection changed since the run",
    );
    assertEquals(fleet.dispatchCounts(), {
      "w-a": 2,
      "w-b": 1,
      "w-c": 2,
      "w-d": 1,
    });
  },
});
