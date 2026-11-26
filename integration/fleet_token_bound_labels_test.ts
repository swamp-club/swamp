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

import { assertEquals, assertRejects } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { RpcError } from "../src/domain/remote/rpc_channel.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

// The gateway's grace and dispatch timers outlive a test body by design.
const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const FLEET_A = { fleet: "a" };

async function runFleetAFanOut(fleet: Fleet): Promise<string[]> {
  const workflow = await fleet.saveWorkflow({
    name: "fleet-a-rollout",
    inputs: {},
    jobs: [{
      name: "rollout",
      fanOut: "all",
      labels: FLEET_A,
      steps: [{
        name: "apply",
        task: {
          type: "model_method" as const,
          modelType: fleet.modelType.normalized,
          modelName: "host-patch",
          methodName: "run",
        },
      }],
    }],
  });
  const run = await fleet.runWorkflow("fleet-a-rollout");
  assertEquals(run.status, "succeeded");
  const [stored] = await fleet.repoContext.workflowRunRepo
    .findAllByWorkflowId(workflow.id);
  return stored.getJob("rollout")!.fanOutPlan!.members.map((m) => m.worker)
    .sort();
}

async function refusedEnrollment(
  fleet: Fleet,
  name: string,
  options: Parameters<Fleet["addWorker"]>[1],
): Promise<void> {
  const error = await assertRejects(
    () => fleet.addWorker(name, options),
    RpcError,
  );
  assertEquals(error.code, "label_conflict");
  fleet.workers.delete(name);
  assertEquals(fleet.gateway.worker(name), null);
  assertEquals(await fleet.tokenBindingCount(name), 0);
}

Deno.test({
  name:
    "bound labels: a leaked token bound to fleet b cannot enroll as fleet a or join fleet a's fan-out",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    const member = await fleet.addWorker("w-a", { tokenLabels: FLEET_A });
    assertEquals(fleet.gateway.worker("w-a")?.labels, FLEET_A);

    await refusedEnrollment(fleet, "w-leak", {
      tokenLabels: { fleet: "b" },
      labels: FLEET_A,
    });

    assertEquals(await runFleetAFanOut(fleet), ["w-a"]);
    assertEquals(member.dispatchCount, 1);
  },
});

Deno.test({
  name:
    "reserved labels: a leaked token that binds nothing cannot claim a reserved fleet label",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start({ reservedLabelKeys: ["fleet"] });
    await fleet.addWorker("w-a", { tokenLabels: FLEET_A });
    await fleet.addWorker("w-plain", { labels: { region: "eu" } });
    assertEquals(fleet.gateway.worker("w-plain")?.labels, { region: "eu" });

    await refusedEnrollment(fleet, "w-leak", { labels: FLEET_A });

    assertEquals(await runFleetAFanOut(fleet), ["w-a"]);
  },
});

Deno.test({
  name:
    "bound labels: with no bound labels and no reserved keys a worker keeps the labels it offers, as before",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-self", { labels: FLEET_A });
    assertEquals(fleet.gateway.worker("w-self")?.labels, FLEET_A);
    assertEquals(await runFleetAFanOut(fleet), ["w-self"]);
  },
});
