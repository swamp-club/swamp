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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { DataRecord } from "../data/data_record.ts";
import type { DataQueryService } from "../data/data_query_service.ts";
import { EventBus } from "../events/event_bus.ts";
import { createModelCreated, createModelUpdated } from "../events/types.ts";
import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import { PolicySnapshotLoader } from "./policy_snapshot_loader.ts";

await initializeLogging({});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeGrantRecord(grant: Grant): DataRecord {
  return {
    id: crypto.randomUUID(),
    name: "grant-main",
    version: 1,
    isLatest: true,
    createdAt: "2026-01-01T00:00:00Z",
    namespace: "",
    attributes: grant as unknown as Record<string, unknown>,
    tags: {},
    modelName: `grant-${grant.id}`,
    modelId: crypto.randomUUID(),
    modelType: "swamp/grant",
    specName: "grant",
    dataType: "grant",
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
  };
}

function makeGroupRecord(group: Group): DataRecord {
  return {
    id: crypto.randomUUID(),
    name: "group-main",
    version: 1,
    isLatest: true,
    createdAt: "2026-01-01T00:00:00Z",
    namespace: "",
    attributes: group as unknown as Record<string, unknown>,
    tags: {},
    modelName: group.name,
    modelId: crypto.randomUUID(),
    modelType: "swamp/group",
    specName: "group",
    dataType: "group",
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
  };
}

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeGroup(name: string, memberIds: string[]): Group {
  return {
    name,
    members: memberIds.map((id) => ({ kind: "user" as const, id })),
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function createMockQueryService(
  grantRecords: DataRecord[],
  groupRecords: DataRecord[],
): DataQueryService {
  return {
    query(predicate: string) {
      if (predicate.includes("swamp/grant")) {
        return Promise.resolve(grantRecords);
      }
      if (predicate.includes("swamp/group")) {
        return Promise.resolve(groupRecords);
      }
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;
}

Deno.test("PolicySnapshotLoader.load: builds snapshot from DataQueryService", async () => {
  const grant = makeGrant();
  const group = makeGroup("devs", ["adam"]);
  const queryService = createMockQueryService(
    [makeGrantRecord(grant)],
    [makeGroupRecord(group)],
  );
  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus);

  const snapshot = await loader.load();

  assertEquals(snapshot.grantsForSubjects(["user:adam"]).length, 1);
  assertEquals([...snapshot.groupsForPrincipal("user:adam")], ["devs"]);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader.load: filters out revoked grants", async () => {
  const active = makeGrant({ state: "active" });
  const revoked = makeGrant({ state: "revoked" });
  const queryService = createMockQueryService(
    [makeGrantRecord(active), makeGrantRecord(revoked)],
    [],
  );
  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus);

  const snapshot = await loader.load();
  assertEquals(snapshot.grantsForSubjects(["user:adam"]).length, 1);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: rebuilds snapshot on ModelCreated for grant model", async () => {
  let callCount = 0;
  const grant = makeGrant();
  const queryService = {
    query(predicate: string) {
      if (predicate.includes("swamp/grant")) {
        callCount++;
        if (callCount > 1) {
          return Promise.resolve([makeGrantRecord(grant)]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus);

  await loader.load();
  assertEquals(loader.snapshot.grantsForSubjects(["user:adam"]).length, 0);

  await eventBus.publish(
    createModelCreated("swamp/grant", "123", "my-grant"),
  );

  await delay(700);
  assertEquals(loader.snapshot.grantsForSubjects(["user:adam"]).length, 1);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: rebuilds snapshot on ModelUpdated for group model", async () => {
  let callCount = 0;
  const group = makeGroup("devs", ["adam"]);
  const queryService = {
    query(predicate: string) {
      if (predicate.includes("swamp/group")) {
        callCount++;
        if (callCount > 1) {
          return Promise.resolve([makeGroupRecord(group)]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus);

  await loader.load();
  assertEquals(loader.snapshot.groupsForPrincipal("user:adam").length, 0);

  await eventBus.publish(
    createModelUpdated("swamp/group", "456", "devs"),
  );

  await delay(700);
  assertEquals([...loader.snapshot.groupsForPrincipal("user:adam")], ["devs"]);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: ignores events for non-access models", async () => {
  let queryCallCount = 0;
  const queryService = {
    query() {
      queryCallCount++;
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus);

  await loader.load();
  const initialCount = queryCallCount;

  await eventBus.publish(
    createModelCreated("swamp/echo", "789", "my-echo"),
  );

  assertEquals(queryCallCount, initialCount);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader.dispose: unsubscribes from EventBus", async () => {
  let queryCallCount = 0;
  const queryService = {
    query() {
      queryCallCount++;
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus);

  await loader.load();
  const initialCount = queryCallCount;

  await loader.dispose();

  await eventBus.publish(
    createModelCreated("swamp/grant", "123", "my-grant"),
  );

  assertEquals(queryCallCount, initialCount);
});

Deno.test("PolicySnapshotLoader: manual mode does not subscribe to EventBus", async () => {
  let queryCallCount = 0;
  const queryService = {
    query() {
      queryCallCount++;
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus, "manual");

  await loader.load();
  const initialCount = queryCallCount;

  await eventBus.publish(
    createModelCreated("swamp/grant", "123", "my-grant"),
  );

  assertEquals(queryCallCount, initialCount);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: auto mode subscribes to EventBus", async () => {
  let callCount = 0;
  const grant = makeGrant();
  const queryService = {
    query(predicate: string) {
      if (predicate.includes("swamp/grant")) {
        callCount++;
        if (callCount > 1) {
          return Promise.resolve([makeGrantRecord(grant)]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
  } as unknown as DataQueryService;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus, "auto");

  await loader.load();
  assertEquals(loader.snapshot.grantsForSubjects(["user:adam"]).length, 0);

  await eventBus.publish(
    createModelCreated("swamp/grant", "123", "my-grant"),
  );

  await delay(700);
  assertEquals(loader.snapshot.grantsForSubjects(["user:adam"]).length, 1);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader.loadWithCounts: returns counts", async () => {
  const grant = makeGrant();
  const group = makeGroup("devs", ["adam"]);
  const queryService = createMockQueryService(
    [makeGrantRecord(grant)],
    [makeGroupRecord(group)],
  );

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(queryService, eventBus, "manual");
  const result = await loader.loadWithCounts();

  assertEquals(result.grantCount, 1);
  assertEquals(result.groupCount, 1);

  await loader.dispose();
});
