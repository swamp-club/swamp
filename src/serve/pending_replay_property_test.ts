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

import { assert } from "@std/assert";
import fc from "fast-check";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import type {
  PendingRunEntry,
  PendingRunOwner,
} from "../infrastructure/persistence/run_tracker_store.ts";
import {
  replayPendingRuns,
  type ReplayPendingRunsDeps,
} from "./boot_reconciliation.ts";
import { pendingOwnerLiveness } from "./pending_run_owner.ts";

const encoder = new TextEncoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));

interface Faults {
  heartbeatReads: boolean;
  ownerWrites: boolean;
  claimLandsUnseen: boolean;
}

// one control plane shared by every instance, with failures switched per pass
function sharedControlPlane(faults: Faults) {
  const data = new Map<string, Uint8Array>();
  const store: ControlPlaneStore = {
    put: (key, value) => {
      if (faults.ownerWrites && key.startsWith("pending-runs/")) {
        return Promise.reject(new Error("bucket unavailable"));
      }
      data.set(key, value);
      return Promise.resolve();
    },
    putIfAbsent: (key, value) => {
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, value);
      if (faults.claimLandsUnseen) {
        return Promise.reject(new Error("timed out"));
      }
      return Promise.resolve(true);
    },
    get: (key) => {
      if (faults.heartbeatReads && key.startsWith("heartbeats/")) {
        return Promise.reject(new Error("bucket unavailable"));
      }
      return Promise.resolve(data.get(key) ?? null);
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve([...data.keys()].filter((k) => k.startsWith(prefix))),
  };
  return { store, data };
}

interface Instance {
  owner: PendingRunOwner;
  alive: boolean;
  /** one entry per replay this instance holds in its queue */
  holding: string[];
  replayedRuns: Set<string>;
}

const ORIGIN: PendingRunOwner = { instanceId: "origin", pid: 1, host: "h0" };

type Action =
  | { kind: "pass"; instances: number[]; faults: Faults }
  | { kind: "crash"; instance: number }
  | { kind: "complete"; instance: number };

const faultsArb = fc.record({
  heartbeatReads: fc.boolean(),
  ownerWrites: fc.boolean(),
  claimLandsUnseen: fc.boolean(),
});

function scenarioArb() {
  return fc.integer({ min: 2, max: 4 }).chain((size) =>
    fc.record({
      size: fc.constant(size),
      // -1 is the origin, gone before the scenario starts
      runOwners: fc.array(fc.integer({ min: -1, max: size - 1 }), {
        minLength: 1,
        maxLength: 3,
      }),
      actions: fc.array(
        fc.oneof(
          {
            weight: 4,
            arbitrary: fc.record({
              kind: fc.constant("pass" as const),
              instances: fc.uniqueArray(fc.integer({ min: 0, max: size - 1 }), {
                minLength: 1,
                maxLength: size,
              }),
              faults: faultsArb,
            }),
          },
          {
            weight: 1,
            arbitrary: fc.record({
              kind: fc.constant("crash" as const),
              instance: fc.integer({ min: 0, max: size - 1 }),
            }),
          },
          {
            weight: 1,
            arbitrary: fc.record({
              kind: fc.constant("complete" as const),
              instance: fc.integer({ min: 0, max: size - 1 }),
            }),
          },
        ),
        { maxLength: 12 },
      ),
    })
  );
}

const NO_FAULTS: Faults = {
  heartbeatReads: false,
  ownerWrites: false,
  claimLandsUnseen: false,
};

async function runScenario(
  size: number,
  runOwners: number[],
  actions: Action[],
): Promise<void> {
  const faults: Faults = { ...NO_FAULTS };
  const { store, data } = sharedControlPlane(faults);
  const instances: Instance[] = Array.from({ length: size }, (_, i) => ({
    owner: { instanceId: `inst-${i}`, pid: 100 + i, host: `h${i + 1}` },
    alive: true,
    holding: [],
    replayedRuns: new Set<string>(),
  }));
  const now = new Date().toISOString();
  for (const instance of instances) {
    data.set(
      `heartbeats/${instance.owner.instanceId}`,
      encode({
        instanceId: instance.owner.instanceId,
        hostname: instance.owner.host,
        pid: instance.owner.pid,
        startedAt: now,
        heartbeatAt: now,
      }),
    );
  }
  runOwners.forEach((ownerIndex, i) => {
    const id = `run-${i}`;
    const owner = ownerIndex < 0 ? ORIGIN : instances[ownerIndex].owner;
    const entry: PendingRunEntry = {
      id,
      source: "cron",
      workflowIdOrName: "nightly",
      createdAt: now,
      owner,
    };
    data.set(`pending-runs/${id}`, encode(entry));
    if (ownerIndex >= 0) instances[ownerIndex].holding.push(id);
  });

  const pass = (instance: Instance) => {
    const deps: ReplayPendingRunsDeps = {
      runTracker: {
        findAllPendingRuns: () => [],
        deletePendingRun: () => {},
        claimPendingRun: () => true,
      } as unknown as ReplayPendingRunsDeps["runTracker"],
      scheduledExecution: {
        enqueueForReplay: (entry: { pendingRunId: string }) =>
          instance.holding.push(entry.pendingRunId),
      } as unknown as ReplayPendingRunsDeps["scheduledExecution"],
      controlPlaneStore: store,
      configuredWebhookWorkflows: new Set(),
      configuredWebhookRoutes: new Set(),
      configuredCronWorkflows: new Set(["nightly"]),
      ownerAlive: pendingOwnerLiveness({
        instanceId: instance.owner.instanceId,
        controlPlaneStore: store,
        unjudgedOwner: "alive",
        hostIdentity: () => instance.owner.host!,
        isGone: () => true,
      }),
      claimAs: instance.owner,
      replayedRuns: instance.replayedRuns,
      sweep: true,
    };
    return replayPendingRuns(deps);
  };

  const assertNoRunHeldTwice = (context: string) => {
    const holds = new Map<string, number>();
    for (const instance of instances) {
      if (!instance.alive) continue;
      for (const id of instance.holding) {
        holds.set(id, (holds.get(id) ?? 0) + 1);
      }
    }
    for (const [id, count] of holds) {
      assert(
        count <= 1,
        `${id} is queued ${count} times by live instances ${context}`,
      );
    }
  };

  for (const action of actions) {
    if (action.kind === "pass") {
      const live = action.instances.map((i) => instances[i]).filter((i) =>
        i.alive
      );
      Object.assign(faults, action.faults);
      await Promise.all(live.map((instance) => pass(instance)));
      Object.assign(faults, NO_FAULTS);
    } else if (action.kind === "crash") {
      const instance = instances[action.instance];
      instance.alive = false;
      instance.holding = [];
      data.delete(`heartbeats/${instance.owner.instanceId}`);
    } else {
      const instance = instances[action.instance];
      if (!instance.alive) continue;
      for (const id of instance.holding) data.delete(`pending-runs/${id}`);
      instance.holding = [];
    }
    assertNoRunHeldTwice(`after ${JSON.stringify(action)}`);
  }

  const live = instances.filter((i) => i.alive);
  if (live.length === 0) return;
  for (let round = 0; round < 2; round++) {
    for (const instance of live) await pass(instance);
  }
  assertNoRunHeldTwice("after the settling passes");
  const pending = [...data.keys()]
    .filter((k) => k.startsWith("pending-runs/"))
    .map((k) => k.slice("pending-runs/".length));
  for (const id of pending) {
    const held = live.filter((i) => i.holding.includes(id)).length;
    assert(
      held === 1,
      `${id} is queued by ${held} live instances once settled`,
    );
  }
}

Deno.test("replayPendingRuns: instances sweeping one control plane queue each gone owner's run exactly once", async () => {
  await fc.assert(
    fc.asyncProperty(scenarioArb(), async ({ size, runOwners, actions }) => {
      await runScenario(size, runOwners, actions);
    }),
    { numRuns: 300 },
  );
});
