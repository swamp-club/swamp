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
import type { DataRecord } from "../domain/data/data_record.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

function record(
  overrides: Partial<DataRecord> & {
    modelName: string;
    attributes: Record<string, unknown>;
  },
): DataRecord {
  return {
    id: "rec-1",
    name: "data-main",
    version: 1,
    isLatest: true,
    createdAt: "2026-07-04T00:00:00.000Z",
    namespace: "",
    tags: {},
    modelId: "def-1",
    modelType: "swamp/step-lease",
    specName: "lease",
    dataType: "resource",
    contentType: "application/json",
    lifetime: "infinite",
    ownerType: "model-method",
    streaming: false,
    size: 0,
    content: "",
    ownerRef: "",
    workflowRunId: "",
    workflowName: "",
    jobName: "",
    stepName: "",
    source: "",
    ...overrides,
  };
}

function createHarness(queryResults: Map<string, DataRecord[]>) {
  const transitions: TransitionInput[] = [];
  let failOn: string | null = null;

  const deps: BootReconciliationDeps = {
    repoDir: "/tmp/test",
    repoContext: {
      dataQueryService: {
        query: (predicate: string) => {
          for (const [key, records] of queryResults) {
            if (predicate.includes(key)) return Promise.resolve(records);
          }
          return Promise.resolve([]);
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
        record({
          modelName: "leases",
          modelType: "swamp/step-lease",
          attributes: { leaseId: "lease-1", state: "active" },
        }),
        record({
          modelName: "leases",
          modelType: "swamp/step-lease",
          attributes: { leaseId: "lease-2", state: "active" },
        }),
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
        record({
          modelName: "pending",
          modelType: "swamp/pending-dispatch",
          attributes: { queueId: "q-1", state: "waiting" },
        }),
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
        record({
          modelName: "worker-w1",
          modelType: "swamp/worker",
          name: "state-main",
          attributes: { name: "w1", status: "idle" },
        }),
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
        record({
          modelName: "leases",
          modelType: "swamp/step-lease",
          attributes: { leaseId: "bad-lease", state: "active" },
        }),
        record({
          modelName: "leases",
          modelType: "swamp/step-lease",
          attributes: { leaseId: "good-lease", state: "active" },
        }),
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
  const deps: BootReconciliationDeps = {
    repoDir: "/tmp/test",
    repoContext: {
      dataQueryService: {
        query: (predicate: string) => {
          if (predicate.includes("swamp/step-lease")) {
            return Promise.resolve([
              record({
                modelName: "leases",
                modelType: "swamp/step-lease",
                attributes: { leaseId: "l1", state: "active" },
              }),
            ]);
          }
          if (predicate.includes("swamp/worker")) {
            return Promise.resolve([
              record({
                modelName: "worker-w1",
                modelType: "swamp/worker",
                name: "state-main",
                attributes: { name: "w1", status: "busy" },
              }),
            ]);
          }
          return Promise.resolve([]);
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
        record({
          modelName: "leases",
          modelType: "swamp/step-lease",
          attributes: { state: "active" },
        }),
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
        record({
          modelName: "pending",
          modelType: "swamp/pending-dispatch",
          attributes: { state: "waiting" },
        }),
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
        record({
          modelName: "worker-orphan",
          modelType: "swamp/worker",
          name: "state-main",
          attributes: { status: "idle" },
        }),
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
        record({
          modelName: "leases",
          modelType: "swamp/step-lease",
          attributes: { leaseId: "l1", state: "active" },
        }),
      ]],
      ["swamp/pending-dispatch", [
        record({
          modelName: "pending",
          modelType: "swamp/pending-dispatch",
          attributes: { queueId: "q1", state: "waiting" },
        }),
      ]],
      ["swamp/worker", [
        record({
          modelName: "worker-w1",
          modelType: "swamp/worker",
          name: "state-main",
          attributes: { name: "w1", status: "idle" },
        }),
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result, { leases: 1, pendingDispatches: 1, workers: 1 });
  assertEquals(h.transitions.length, 3);
});
