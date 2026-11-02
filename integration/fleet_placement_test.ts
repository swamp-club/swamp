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
 * Affinity pinning baseline (swamp-club#4271), through the fleet harness:
 * the worker that runs an affinity group's first step keeps the group, a
 * pinned worker that drains or drops fails the group's next step, and
 * releasing the key frees it. Fleet fan-out binds each lane's affinity key
 * at plan time; these rows must not change for workflows that do not fan
 * out. Placement for each status is pinned in
 * src/domain/remote/scheduler_test.ts ("placement table").
 */

import { assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { WorkerAffinityLostError } from "../src/serve/dispatch_service.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };

/**
 * A job of two steps in order, both placed by label. The first is held on
 * w-b, the worker the name tiebreak picks, while a worker whose name sorts
 * first enrolls; then both steps run.
 */
async function runTwoStepJob(
  affinity: boolean,
): Promise<Record<string, number>> {
  await using fleet = await Fleet.start();
  const pinned = await fleet.addWorker("w-b", { labels: WEB });
  await fleet.addWorker("w-c", { labels: WEB });
  await fleet.saveDefinition("deploy");
  const task = {
    type: "model_method" as const,
    modelIdOrName: "deploy",
    methodName: "run",
  };
  await fleet.saveWorkflow({
    name: "two-steps",
    inputs: {},
    jobs: [{
      name: "rollout",
      affinity,
      labels: WEB,
      steps: [
        { name: "first", task },
        {
          name: "second",
          dependsOn: [{ step: "first", condition: { type: "succeeded" } }],
          task,
        },
      ],
    }],
  });

  pinned.behavior = { kind: "hold" };
  const running = fleet.runWorkflow("two-steps");
  await waitFor(() => pinned.heldCount === 1, "the first step to reach w-b");
  // w-a sorts first and is idle: without a pin the second step goes there.
  await fleet.addWorker("w-a", { labels: WEB });
  pinned.behavior = { kind: "succeed" };
  pinned.release();

  const run = await running;
  assertEquals(run.status, "succeeded");
  return fleet.dispatchCounts();
}

Deno.test({
  name:
    "fleet placement: an affinity group stays on the worker that ran its first step, even when a worker the tiebreak prefers has joined",
  ...SANITIZE,
  fn: async () => {
    assertEquals(await runTwoStepJob(true), { "w-b": 2, "w-c": 0, "w-a": 0 });
  },
});

Deno.test({
  name:
    "fleet placement: without affinity the same job's second step goes to the worker the tiebreak prefers (control for the affinity row)",
  ...SANITIZE,
  fn: async () => {
    assertEquals(await runTwoStepJob(false), { "w-b": 1, "w-c": 0, "w-a": 1 });
  },
});

Deno.test({
  name:
    "fleet placement: a pinned worker that drains fails the group's next step as a lost worker, and no other worker runs it",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const a = await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const def = await fleet.saveDefinition("deploy");
    const key = `group-${crypto.randomUUID()}`;
    const placement = { labels: WEB, affinityKey: key };

    assertEquals(await fleet.dispatchStep(def, placement, "first"), "w-a");
    await a.drain();
    const error = await assertRejects(
      () => fleet.dispatchStep(def, placement, "second"),
      WorkerAffinityLostError,
    );
    assertEquals(error.workerName, "w-a");
    assertEquals(error.affinityKey, key);
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-b": 0 });
  },
});

Deno.test({
  name:
    "fleet placement: a pinned worker that disconnects fails the group's next step during its grace window, and no other worker runs it",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ graceWindowMs: 60_000 });
    const a = await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    const def = await fleet.saveDefinition("deploy");
    const key = `group-${crypto.randomUUID()}`;
    const placement = { labels: WEB, affinityKey: key };

    assertEquals(await fleet.dispatchStep(def, placement, "first"), "w-a");
    await a.disconnect();
    const error = await assertRejects(
      () => fleet.dispatchStep(def, placement, "second"),
      WorkerAffinityLostError,
    );
    assertEquals(error.workerName, "w-a");
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-b": 0 });
  },
});

Deno.test({
  name:
    "fleet placement: releasing an affinity key lets the group's next step go wherever the tiebreak sends it",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-b", { labels: WEB });
    const def = await fleet.saveDefinition("deploy");
    const key = `group-${crypto.randomUUID()}`;
    const placement = { labels: WEB, affinityKey: key };

    assertEquals(await fleet.dispatchStep(def, placement, "first"), "w-b");
    await fleet.addWorker("w-a", { labels: WEB });
    assertEquals(await fleet.dispatchStep(def, placement, "second"), "w-b");
    fleet.dispatchService.releaseAffinity(key);
    assertEquals(await fleet.dispatchStep(def, placement, "third"), "w-a");
    assertEquals(fleet.dispatchCounts(), { "w-b": 2, "w-a": 1 });
  },
});
