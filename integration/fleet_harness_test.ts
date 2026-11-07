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
 * Self-test of the fleet harness (swamp-club#4271): every state a later
 * fan-out test sets up is the state the gateway and the worker records
 * really hold, and the fleet pattern's target expression names each worker.
 */

import { assert, assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import { getWorkerPoolReader } from "../src/domain/remote/worker_pool.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

// The gateway's grace and dispatch timers outlive a test body by design.
const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name:
    "fleet harness: workers enroll idle, or unverified when their probe fails, with their labels and capacity",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: { fleet: "web" }, capacity: 2 });
    await fleet.addWorker("w-b", { unverified: true });

    const a = fleet.gateway.worker("w-a");
    assertEquals(a?.status, "idle");
    assertEquals(a?.labels, { fleet: "web" });
    assertEquals(a?.capacity, 2);
    assertEquals(fleet.gateway.worker("w-b")?.status, "unverified");
    assertEquals(await fleet.recordStatus("w-a"), "idle");
    assertEquals(await fleet.recordStatus("w-b"), "unverified");
  },
});

Deno.test({
  name:
    "fleet harness: drain marks a worker draining in the pool and its record",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const worker = await fleet.addWorker("w-drain");
    await worker.drain();
    assertEquals(worker.status(), "draining");
    assertEquals(await fleet.recordStatus("w-drain"), "draining");
  },
});

Deno.test({
  name:
    "fleet harness: a disconnect records disconnected, and a reconnect with the same token and instance returns the worker to idle",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ graceWindowMs: 60_000 });
    const worker = await fleet.addWorker("w-bounce");
    const instanceUuid = fleet.gateway.worker("w-bounce")?.instanceUuid;

    await worker.disconnect();
    assertEquals(fleet.gateway.worker("w-bounce")?.connected, false);
    assertEquals(await fleet.recordStatus("w-bounce"), "disconnected");

    await worker.connect();
    const back = fleet.gateway.worker("w-bounce");
    assertEquals(back?.connected, true);
    assertEquals(back?.status, "idle");
    assertEquals(back?.instanceUuid, instanceUuid);
    assertEquals(await fleet.recordStatus("w-bounce"), "idle");
  },
});

Deno.test({
  name:
    "fleet harness: a disconnected worker leaves the pool once the grace window ends",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ graceWindowMs: 50 });
    const worker = await fleet.addWorker("w-gone");
    await worker.disconnect({ untilRemoved: true });
    assertEquals(fleet.gateway.worker("w-gone"), null);
    assertEquals(await fleet.recordStatus("w-gone"), "disconnected");
  },
});

Deno.test({
  name:
    "fleet harness: the documented fleet pattern targets each connected worker by name, and each worker counts its own dispatch",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-one");
    await fleet.addWorker("w-two");
    await fleet.saveDefinition("scanner");
    await fleet.saveWorkflow({
      name: "fleet-pattern",
      inputs: {},
      jobs: [{
        name: "scan",
        steps: [{
          name: "scan-${{ self.worker.attributes.name }}",
          forEach: { item: "worker", in: "${{ workers.connected() }}" },
          target: "${{ self.worker.attributes.name }}",
          task: {
            type: "model_method",
            modelIdOrName: "scanner",
            methodName: "run",
          },
        }],
      }],
    });

    const run = await fleet.runWorkflow("fleet-pattern");

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-one": 1, "w-two": 1 });
    assertEquals(
      fleet.worker("w-one").received.map((d) => d.stepName),
      ["scan-w-one"],
    );
    assertEquals(
      fleet.worker("w-two").received.map((d) => d.stepName),
      ["scan-w-two"],
    );
  },
});

Deno.test({
  name:
    "fleet harness: serve's worker pool reader is registered while the fleet runs and cleared when it is disposed",
  ...SANITIZE,
  fn: async () => {
    {
      await using fleet = await Fleet.start();
      await fleet.addWorker("w-a", { labels: { fleet: "web" } });
      const reader = getWorkerPoolReader();
      assert(reader !== null);
      assertEquals((await reader.readPool()).map((w) => w.name), ["w-a"]);
    }
    assertEquals(getWorkerPoolReader(), null);
  },
});
