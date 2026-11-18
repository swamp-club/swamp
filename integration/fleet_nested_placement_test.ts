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
import type { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Fleet } from "./fleet_harness.ts";
import { BASELINE_VAULT } from "./remote_secrets_baseline_harness.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };
const TASK = {
  type: "model_method" as const,
  modelIdOrName: "deploy",
  methodName: "run",
};
const CALL_CHILD = { type: "workflow" as const, workflowIdOrName: "child" };
const AFTER_CADDY = [{ step: "caddy", condition: { type: "succeeded" } }];

type WorkflowData = Parameters<Fleet["saveWorkflow"]>[0];
type JobData = WorkflowData["jobs"][number];

async function saveChild(
  fleet: Fleet,
  extra: Partial<WorkflowData> = {},
  job: Partial<JobData> = {},
): Promise<Workflow> {
  return await fleet.saveWorkflow({
    name: "child",
    inputs: {},
    jobs: [{ name: "work", steps: [{ name: "setcap", task: TASK }], ...job }],
    ...extra,
  });
}

/**
 * w-b runs the caller's first step while held, then w-a, which the name
 * tiebreak prefers, joins idle: only a pin keeps later steps on w-b
 */
async function runPinnedOnWb(
  fleet: Fleet,
  parent: WorkflowData,
  capacity = 1,
): Promise<string> {
  const pinned = await fleet.addWorker("w-b", { labels: WEB, capacity });
  await fleet.saveDefinition("deploy");
  await fleet.saveWorkflow(parent);
  pinned.behavior = { kind: "hold" };
  const running = fleet.runWorkflow(parent.name);
  await waitFor(() => pinned.heldCount === 1, "the first step to reach w-b");
  await fleet.addWorker("w-a", { labels: WEB });
  pinned.behavior = { kind: "succeed" };
  pinned.release();
  const run = await running;
  assertEquals(run.status, "succeeded");
  return run.id;
}

function stepsOn(fleet: Fleet, worker: string): string[] {
  return fleet.worker(worker).received.map((d) =>
    `${d.workflowName}/${d.stepName}`
  );
}

Deno.test({
  name:
    "nested placement: an unplaced child of a parent placed by target runs its steps on the parent's worker",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.addWorker("w-b");
    await fleet.saveDefinition("deploy");
    const task = {
      type: "model_method" as const,
      modelIdOrName: "deploy",
      methodName: "run",
    };
    await fleet.saveWorkflow({
      name: "child",
      inputs: {},
      jobs: [{ name: "work", steps: [{ name: "setcap", task }] }],
    });
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      target: "w-a",
      jobs: [{
        name: "install",
        steps: [
          { name: "caddy", task },
          {
            name: "sudo",
            dependsOn: [{ step: "caddy", condition: { type: "succeeded" } }],
            task: { type: "workflow", workflowIdOrName: "child" },
          },
        ],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(stepsOn(fleet, "w-a"), ["parent/caddy", "child/setcap"]);
    assertEquals(stepsOn(fleet, "w-b"), []);
  },
});

Deno.test({
  name:
    "nested placement: a child keeps its caller's workflow affinity pin, even when a worker the tiebreak prefers has joined",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await saveChild(fleet, {}, {
      steps: [
        { name: "setcap", task: TASK },
        {
          name: "restart",
          dependsOn: [{ step: "setcap", condition: { type: "succeeded" } }],
          task: TASK,
        },
      ],
    });
    await runPinnedOnWb(fleet, {
      name: "parent",
      inputs: {},
      labels: WEB,
      affinity: true,
      jobs: [{
        name: "install",
        steps: [
          { name: "caddy", task: TASK },
          { name: "sudo", dependsOn: AFTER_CADDY, task: CALL_CHILD },
        ],
      }],
    });

    assertEquals(stepsOn(fleet, "w-b"), [
      "parent/caddy",
      "child/setcap",
      "child/restart",
    ]);
    assertEquals(stepsOn(fleet, "w-a"), []);
  },
});

Deno.test({
  name:
    "nested placement: a caller's job-level pin holds for the child and is released when the caller's job ends",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await saveChild(fleet);
    const runId = await runPinnedOnWb(fleet, {
      name: "parent",
      inputs: {},
      labels: WEB,
      jobs: [{
        name: "install",
        affinity: true,
        steps: [
          { name: "caddy", task: TASK },
          { name: "sudo", dependsOn: AFTER_CADDY, task: CALL_CHILD },
        ],
      }],
    });

    assertEquals(stepsOn(fleet, "w-b"), ["parent/caddy", "child/setcap"]);
    const def = await fleet.saveDefinition("probe");
    assertEquals(
      await fleet.dispatchStep(def, {
        labels: WEB,
        affinityKey: `${runId}:install`,
      }),
      "w-a",
    );
  },
});

Deno.test({
  name:
    "nested placement: two nested steps running in parallel under one inherited pin both run on the pinned worker",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await saveChild(fleet);
    await runPinnedOnWb(fleet, {
      name: "parent",
      inputs: {},
      labels: WEB,
      affinity: true,
      jobs: [{
        name: "install",
        steps: [
          { name: "caddy", task: TASK },
          { name: "sudo-1", dependsOn: AFTER_CADDY, task: CALL_CHILD },
          { name: "sudo-2", dependsOn: AFTER_CADDY, task: CALL_CHILD },
        ],
      }],
    }, 2);

    assertEquals(stepsOn(fleet, "w-b").sort(), [
      "child/setcap",
      "child/setcap",
      "parent/caddy",
    ]);
    assertEquals(stepsOn(fleet, "w-a"), []);
  },
});

Deno.test({
  name:
    "nested placement: a forEach nested step with a target per item sends each child to its item's worker",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.addWorker("w-b");
    await fleet.addWorker("w-c");
    await fleet.saveDefinition("deploy");
    await saveChild(fleet);
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      jobs: [{
        name: "install",
        steps: [{
          name: "sudo-${{ self.host }}",
          forEach: { item: "host", in: "${{ ['w-a', 'w-c'] }}" },
          target: "${{ self.host }}",
          task: CALL_CHILD,
        }],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 1, "w-b": 0, "w-c": 1 });
  },
});

Deno.test({
  name:
    "nested placement: placement own runs an unplaced child on the orchestrator, as before inheritance",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.saveDefinition("deploy");
    await saveChild(fleet);
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      target: "w-a",
      jobs: [{
        name: "install",
        steps: [
          { name: "caddy", task: TASK },
          {
            name: "sudo",
            dependsOn: AFTER_CADDY,
            placement: "own",
            task: CALL_CHILD,
          },
        ],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(stepsOn(fleet, "w-a"), ["parent/caddy"]);
  },
});

Deno.test({
  name:
    "nested placement: a target on the call step places that child, overriding the caller's own placement",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.addWorker("w-b");
    await fleet.saveDefinition("deploy");
    await saveChild(fleet);
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      target: "w-a",
      jobs: [{
        name: "install",
        steps: [
          { name: "caddy", task: TASK },
          {
            name: "sudo",
            dependsOn: AFTER_CADDY,
            target: "w-b",
            task: CALL_CHILD,
          },
        ],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(stepsOn(fleet, "w-a"), ["parent/caddy"]);
    assertEquals(stepsOn(fleet, "w-b"), ["child/setcap"]);
  },
});

Deno.test({
  name:
    "nested placement: a child that declares its own labels runs by them, not by the caller's target or pin",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-db", { labels: { fleet: "db" } });
    await fleet.saveDefinition("deploy");
    await saveChild(fleet, { labels: { fleet: "db" } });
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      target: "w-a",
      affinity: true,
      jobs: [{
        name: "install",
        steps: [
          { name: "caddy", task: TASK },
          { name: "sudo", dependsOn: AFTER_CADDY, task: CALL_CHILD },
        ],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(stepsOn(fleet, "w-a"), ["parent/caddy"]);
    assertEquals(stepsOn(fleet, "w-db"), ["child/setcap"]);
  },
});

Deno.test({
  name:
    "nested placement: a child that declares labels {} stays on the orchestrator under a placed caller",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.saveDefinition("deploy");
    await saveChild(fleet, { labels: {} });
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      target: "w-a",
      jobs: [{
        name: "install",
        steps: [
          { name: "caddy", task: TASK },
          { name: "sudo", dependsOn: AFTER_CADDY, task: CALL_CHILD },
        ],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(stepsOn(fleet, "w-a"), ["parent/caddy"]);
  },
});

Deno.test({
  name:
    "nested placement: a grandchild inherits its caller's placement through the child",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.addWorker("w-b");
    await fleet.saveDefinition("deploy");
    await fleet.saveWorkflow({
      name: "grandchild",
      inputs: {},
      jobs: [{ name: "work", steps: [{ name: "unit", task: TASK }] }],
    });
    await saveChild(fleet, {}, {
      steps: [{
        name: "systemd",
        task: { type: "workflow", workflowIdOrName: "grandchild" },
      }],
    });
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      target: "w-b",
      jobs: [{
        name: "install",
        steps: [{ name: "sudo", task: CALL_CHILD }],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(stepsOn(fleet, "w-b"), ["grandchild/unit"]);
    assertEquals(stepsOn(fleet, "w-a"), []);
  },
});

Deno.test({
  name:
    "nested placement: a child suspended at a gate and resumed on its own dispatches to the inherited worker",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.addWorker("w-b");
    await fleet.saveDefinition("deploy");
    const child = await saveChild(fleet, {}, {
      steps: [
        {
          name: "gate",
          task: { type: "manual_approval", prompt: "setcap caddy?" },
        },
        {
          name: "setcap",
          dependsOn: [{ step: "gate", condition: { type: "succeeded" } }],
          task: TASK,
        },
      ],
    });
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      target: "w-b",
      jobs: [{
        name: "install",
        steps: [{ name: "sudo", task: CALL_CHILD }],
      }],
    });

    const parentRun = await fleet.runWorkflow("parent");
    assertEquals(parentRun.status, "suspended");
    const [childRun] = await fleet.repoContext.workflowRunRepo
      .findAllByWorkflowId(child.id);
    assertEquals(childRun.inheritedPlacement?.fields.target, "w-b");
    assertEquals(childRun.inheritedPlacement?.source, {
      workflowName: "parent",
      jobName: "install",
      stepName: "sudo",
    });

    await fleet.decideGate("child", childRun.id, "gate", true);
    const resumed = await fleet.resumeRun("child", childRun.id);

    assertEquals(resumed.status, "succeeded");
    assertEquals(stepsOn(fleet, "w-b"), ["child/setcap"]);
    assertEquals(stepsOn(fleet, "w-a"), []);
  },
});

Deno.test({
  name:
    "nested placement: a vault expression in a call step's target is refused at the call site",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.saveDefinition("deploy");
    await (await VaultService.fromRepository(fleet.repoDir)).put(
      BASELINE_VAULT,
      "host",
      "w-a",
    );
    await saveChild(fleet);
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      jobs: [{
        name: "install",
        steps: [{
          name: "sudo",
          target: `\${{ vault.get('${BASELINE_VAULT}', 'host') }}`,
          task: CALL_CHILD,
        }],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "failed");
    const step = run.jobs[0].steps[0];
    assert(step.error, "the call step names why it failed");
    assertStringIncludes(step.error, "sudo.placement");
    assertEquals(fleet.dispatchCounts(), { "w-a": 0 });
  },
});

Deno.test({
  name:
    "nested placement: a call step whose placement resolves to a non-string fails before the child starts",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: { rack: "1" } });
    await fleet.saveDefinition("deploy");
    const child = await saveChild(fleet);
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      jobs: [{
        name: "install",
        steps: [{
          name: "sudo-${{ self.n }}",
          forEach: { item: "n", in: "${{ [1] }}" },
          labels: { rack: "${{ self.n }}" },
          task: CALL_CHILD,
        }],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "failed");
    const step = run.jobs[0].steps[0];
    assert(step.error, "the call step names why it failed");
    assertStringIncludes(
      step.error,
      "sudo-1.placement.labels.rack must resolve to a string",
    );
    assertEquals(
      await fleet.repoContext.workflowRunRepo.findAllByWorkflowId(child.id),
      [],
    );
    assertEquals(fleet.dispatchCounts(), { "w-a": 0 });
  },
});

Deno.test({
  name:
    "nested placement: an unplaced caller with an unplaced child dispatches nothing",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    await fleet.saveDefinition("deploy");
    await saveChild(fleet);
    await fleet.saveWorkflow({
      name: "parent",
      inputs: {},
      jobs: [{
        name: "install",
        steps: [
          { name: "caddy", task: TASK },
          { name: "sudo", dependsOn: AFTER_CADDY, task: CALL_CHILD },
        ],
      }],
    });

    const run = await fleet.runWorkflow("parent");

    assertEquals(run.status, "succeeded");
    assertEquals(fleet.dispatchCounts(), { "w-a": 0 });
  },
});
