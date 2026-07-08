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

import { assertEquals } from "@std/assert";
import {
  type BootReconciliationDeps,
  sweepStaleRecords,
  type TransitionInput,
} from "./boot_reconciliation.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { Data } from "../domain/data/data.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

const encoder = new TextEncoder();

interface DataItem {
  modelName: string;
  dataName: string;
  modelType: string;
  attrs: Record<string, unknown>;
}

function makeData(
  item: DataItem,
): { data: Data; modelType: ModelType; modelId: string } {
  const modelType = ModelType.create(item.modelType);
  const modelId = `def-${item.modelName}`;
  const data = Data.create({
    name: item.dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", modelName: item.modelName },
    ownerDefinition: { ownerType: "model-method", ownerRef: modelId },
  });
  return { data, modelType, modelId };
}

function createHarness(items: Map<string, DataItem[]>) {
  const transitions: TransitionInput[] = [];
  let failOn: string | null = null;
  const contentMap = new Map<string, Uint8Array>();
  const dataByType = new Map<
    string,
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >();

  for (const [typeKey, typeItems] of items) {
    const dataItems: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    for (const item of typeItems) {
      const d = makeData(item);
      dataItems.push(d);
      const key = `${d.modelType.normalized}/${d.modelId}/${d.data.name}`;
      contentMap.set(key, encoder.encode(JSON.stringify(item.attrs)));
    }
    dataByType.set(typeKey, dataItems);
  }

  const deps: BootReconciliationDeps = {
    repoDir: "/tmp/test",
    repoContext: {
      unifiedDataRepo: {
        findAllForType: (type: ModelType) => {
          return Promise.resolve(dataByType.get(type.normalized) ?? []);
        },
        getContent: (
          type: ModelType,
          modelId: string,
          dataName: string,
        ) => {
          const key = `${type.normalized}/${modelId}/${dataName}`;
          return Promise.resolve(contentMap.get(key) ?? null);
        },
      },
    } as unknown as RepositoryContext,
    runTransition: (input: TransitionInput) => {
      if (failOn && input.definitionName === failOn) {
        return Promise.reject(new Error(`transition failed: ${failOn}`));
      }
      transitions.push(input);
      return Promise.resolve();
    },
  };

  return {
    deps,
    transitions,
    setFailOn: (name: string) => {
      failOn = name;
    },
  };
}

Deno.test("sweepStaleRecords: clean boot returns zeros with no transitions", async () => {
  const h = createHarness(new Map());
  const result = await sweepStaleRecords(h.deps);

  assertEquals(result, { leases: 0, pendingDispatches: 0, workers: 0 });
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: expires active leases", async () => {
  const h = createHarness(
    new Map([
      ["swamp/step-lease", [
        {
          modelName: "leases",
          dataName: "data-main",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "lease-1", state: "active" },
        },
        {
          modelName: "leases",
          dataName: "data-secondary",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "lease-2", state: "active" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.leases, 2);
  assertEquals(h.transitions.length, 2);
  assertEquals(h.transitions[0].typeArg, "swamp/step-lease");
  assertEquals(h.transitions[0].methodName, "expire");
  assertEquals(h.transitions[0].inputs.leaseId, "lease-1");
  assertEquals(h.transitions[0].inputs.error, "orchestrator restart");
  assertEquals(h.transitions[1].inputs.leaseId, "lease-2");
});

Deno.test("sweepStaleRecords: orphans waiting pending dispatches", async () => {
  const h = createHarness(
    new Map([
      ["swamp/pending-dispatch", [
        {
          modelName: "pending",
          dataName: "data-main",
          modelType: "swamp/pending-dispatch",
          attrs: { queueId: "q-1", state: "waiting" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.pendingDispatches, 1);
  assertEquals(h.transitions.length, 1);
  assertEquals(h.transitions[0].typeArg, "swamp/pending-dispatch");
  assertEquals(h.transitions[0].methodName, "orphan");
  assertEquals(h.transitions[0].inputs.queueId, "q-1");
  assertEquals(typeof h.transitions[0].inputs.endedAt, "string");
});

Deno.test("sweepStaleRecords: disconnects stale workers", async () => {
  const h = createHarness(
    new Map([
      ["swamp/worker", [
        {
          modelName: "worker-w1",
          dataName: "state-main",
          modelType: "swamp/worker",
          attrs: { name: "w1", status: "idle" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.workers, 1);
  assertEquals(h.transitions.length, 1);
  assertEquals(h.transitions[0].typeArg, "swamp/worker");
  assertEquals(h.transitions[0].definitionName, "worker-w1");
  assertEquals(h.transitions[0].methodName, "set_status");
  assertEquals(h.transitions[0].inputs.status, "disconnected");
});

Deno.test("sweepStaleRecords: transition failure warns but continues sweeping", async () => {
  const h = createHarness(
    new Map([
      ["swamp/step-lease", [
        {
          modelName: "leases",
          dataName: "data-main",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "bad-lease", state: "active" },
        },
        {
          modelName: "leases",
          dataName: "data-secondary",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "good-lease", state: "active" },
        },
      ]],
    ]),
  );
  h.setFailOn("leases");

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.leases, 0);
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: mixed failure and success across model types", async () => {
  let callCount = 0;
  const leaseItem = makeData({
    modelName: "leases",
    dataName: "data-main",
    modelType: "swamp/step-lease",
    attrs: { leaseId: "l1", state: "active" },
  });
  const leaseAttrs = { leaseId: "l1", state: "active" };

  const workerItem = makeData({
    modelName: "worker-w1",
    dataName: "state-main",
    modelType: "swamp/worker",
    attrs: { name: "w1", status: "busy" },
  });
  const workerAttrs = { name: "w1", status: "busy" };

  const contentMap = new Map<string, Uint8Array>();
  contentMap.set(
    `${leaseItem.modelType.normalized}/${leaseItem.modelId}/${leaseItem.data.name}`,
    encoder.encode(JSON.stringify(leaseAttrs)),
  );
  contentMap.set(
    `${workerItem.modelType.normalized}/${workerItem.modelId}/${workerItem.data.name}`,
    encoder.encode(JSON.stringify(workerAttrs)),
  );

  const deps: BootReconciliationDeps = {
    repoDir: "/tmp/test",
    repoContext: {
      unifiedDataRepo: {
        findAllForType: (type: ModelType) => {
          if (type.normalized === "swamp/step-lease") {
            return Promise.resolve([leaseItem]);
          }
          if (type.normalized === "swamp/worker") {
            return Promise.resolve([workerItem]);
          }
          return Promise.resolve([]);
        },
        getContent: (
          type: ModelType,
          modelId: string,
          dataName: string,
        ) => {
          const key = `${type.normalized}/${modelId}/${dataName}`;
          return Promise.resolve(contentMap.get(key) ?? null);
        },
      },
    } as unknown as RepositoryContext,
    runTransition: () => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("lease transition failed"));
      }
      return Promise.resolve();
    },
  };

  const result = await sweepStaleRecords(deps);

  assertEquals(result.leases, 0);
  assertEquals(result.pendingDispatches, 0);
  assertEquals(result.workers, 1);
});

Deno.test("sweepStaleRecords: skips records with missing leaseId attribute", async () => {
  const h = createHarness(
    new Map([
      ["swamp/step-lease", [
        {
          modelName: "leases",
          dataName: "data-main",
          modelType: "swamp/step-lease",
          attrs: { state: "active" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.leases, 0);
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: skips records with missing queueId attribute", async () => {
  const h = createHarness(
    new Map([
      ["swamp/pending-dispatch", [
        {
          modelName: "pending",
          dataName: "data-main",
          modelType: "swamp/pending-dispatch",
          attrs: { state: "waiting" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.pendingDispatches, 0);
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: skips records with missing worker name attribute", async () => {
  const h = createHarness(
    new Map([
      ["swamp/worker", [
        {
          modelName: "worker-orphan",
          dataName: "state-main",
          modelType: "swamp/worker",
          attrs: { status: "idle" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.workers, 0);
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: sweeps all three model types together", async () => {
  const h = createHarness(
    new Map([
      ["swamp/step-lease", [
        {
          modelName: "leases",
          dataName: "data-main",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "l1", state: "active" },
        },
      ]],
      ["swamp/pending-dispatch", [
        {
          modelName: "pending",
          dataName: "data-main",
          modelType: "swamp/pending-dispatch",
          attrs: { queueId: "q1", state: "waiting" },
        },
      ]],
      ["swamp/worker", [
        {
          modelName: "worker-w1",
          dataName: "state-main",
          modelType: "swamp/worker",
          attrs: { name: "w1", status: "idle" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result, { leases: 1, pendingDispatches: 1, workers: 1 });
  assertEquals(h.transitions.length, 3);
});
