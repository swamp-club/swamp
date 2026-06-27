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
import { Data } from "../data/data.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { EventBus } from "../events/event_bus.ts";
import { createModelCreated, createModelUpdated } from "../events/types.ts";
import type { Grant } from "../models/access/grant_model.ts";
import { GRANT_MODEL_TYPE } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import { GROUP_MODEL_TYPE } from "../models/access/group_model.ts";
import type { ModelType } from "../models/model_type.ts";
import { PolicySnapshotLoader } from "./policy_snapshot_loader.ts";

await initializeLogging({});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

function makeData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
  });
}

interface ContentEntry {
  type: string;
  modelId: string;
  dataName: string;
  content: Record<string, unknown>;
}

function createMockDataRepo(
  grantItems: Array<{ attrs: Grant; modelId: string; dataName: string }>,
  groupItems: Array<{ attrs: Group; modelId: string; dataName: string }>,
): UnifiedDataRepository {
  const contentMap = new Map<string, Uint8Array>();

  const entries: ContentEntry[] = [];
  for (const item of grantItems) {
    const key =
      `${GRANT_MODEL_TYPE.normalized}/${item.modelId}/${item.dataName}`;
    contentMap.set(
      key,
      new TextEncoder().encode(JSON.stringify(item.attrs)),
    );
    entries.push({
      type: GRANT_MODEL_TYPE.normalized,
      modelId: item.modelId,
      dataName: item.dataName,
      content: item.attrs as unknown as Record<string, unknown>,
    });
  }
  for (const item of groupItems) {
    const key =
      `${GROUP_MODEL_TYPE.normalized}/${item.modelId}/${item.dataName}`;
    contentMap.set(
      key,
      new TextEncoder().encode(JSON.stringify(item.attrs)),
    );
    entries.push({
      type: GROUP_MODEL_TYPE.normalized,
      modelId: item.modelId,
      dataName: item.dataName,
      content: item.attrs as unknown as Record<string, unknown>,
    });
  }

  return {
    findAllForType(type: ModelType) {
      const typeStr = type.normalized;
      const matching = entries.filter((e) => e.type === typeStr);
      return Promise.resolve(
        matching.map((e) => ({
          data: makeData(e.dataName),
          modelType: type,
          modelId: e.modelId,
        })),
      );
    },
    getContent(
      type: ModelType,
      modelId: string,
      dataName: string,
    ) {
      const key = `${type.normalized}/${modelId}/${dataName}`;
      return Promise.resolve(contentMap.get(key) ?? null);
    },
  } as unknown as UnifiedDataRepository;
}

Deno.test("PolicySnapshotLoader.load: builds snapshot from data repository", async () => {
  const grant = makeGrant();
  const group = makeGroup("devs", ["adam"]);
  const dataRepo = createMockDataRepo(
    [{ attrs: grant, modelId: "g1", dataName: "grant-main" }],
    [{ attrs: group, modelId: "grp1", dataName: "group-main" }],
  );
  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus);

  const snapshot = await loader.load();

  assertEquals(snapshot.grantsForSubjects(["user:adam"]).length, 1);
  assertEquals([...snapshot.groupsForPrincipal("user:adam")], ["devs"]);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader.load: filters out revoked grants", async () => {
  const active = makeGrant({ state: "active" });
  const revoked = makeGrant({ state: "revoked" });
  const dataRepo = createMockDataRepo(
    [
      { attrs: active, modelId: "g1", dataName: "grant-main" },
      { attrs: revoked, modelId: "g2", dataName: "grant-main" },
    ],
    [],
  );
  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus);

  const snapshot = await loader.load();
  assertEquals(snapshot.grantsForSubjects(["user:adam"]).length, 1);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: rebuilds snapshot on ModelCreated for grant model", async () => {
  let callCount = 0;
  const grant = makeGrant();

  const dataRepo = {
    findAllForType(type: ModelType) {
      if (type.normalized === GRANT_MODEL_TYPE.normalized) {
        callCount++;
        if (callCount > 1) {
          return Promise.resolve([{
            data: makeData("grant-main"),
            modelType: type,
            modelId: "g1",
          }]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
    getContent(
      type: ModelType,
      _modelId: string,
      _dataName: string,
    ) {
      if (type.normalized === GRANT_MODEL_TYPE.normalized && callCount > 1) {
        return Promise.resolve(
          new TextEncoder().encode(JSON.stringify(grant)),
        );
      }
      return Promise.resolve(null);
    },
  } as unknown as UnifiedDataRepository;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus);

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

  const dataRepo = {
    findAllForType(type: ModelType) {
      if (type.normalized === GROUP_MODEL_TYPE.normalized) {
        callCount++;
        if (callCount > 1) {
          return Promise.resolve([{
            data: makeData("group-main"),
            modelType: type,
            modelId: "grp1",
          }]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
    getContent(
      type: ModelType,
      _modelId: string,
      _dataName: string,
    ) {
      if (type.normalized === GROUP_MODEL_TYPE.normalized && callCount > 1) {
        return Promise.resolve(
          new TextEncoder().encode(JSON.stringify(group)),
        );
      }
      return Promise.resolve(null);
    },
  } as unknown as UnifiedDataRepository;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus);

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
  let findAllCallCount = 0;
  const dataRepo = {
    findAllForType() {
      findAllCallCount++;
      return Promise.resolve([]);
    },
    getContent() {
      return Promise.resolve(null);
    },
  } as unknown as UnifiedDataRepository;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus);

  await loader.load();
  const initialCount = findAllCallCount;

  await eventBus.publish(
    createModelCreated("swamp/echo", "789", "my-echo"),
  );

  assertEquals(findAllCallCount, initialCount);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader.dispose: unsubscribes from EventBus", async () => {
  let findAllCallCount = 0;
  const dataRepo = {
    findAllForType() {
      findAllCallCount++;
      return Promise.resolve([]);
    },
    getContent() {
      return Promise.resolve(null);
    },
  } as unknown as UnifiedDataRepository;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus);

  await loader.load();
  const initialCount = findAllCallCount;

  await loader.dispose();

  await eventBus.publish(
    createModelCreated("swamp/grant", "123", "my-grant"),
  );

  assertEquals(findAllCallCount, initialCount);
});

Deno.test("PolicySnapshotLoader: manual mode does not subscribe to EventBus", async () => {
  let findAllCallCount = 0;
  const dataRepo = {
    findAllForType() {
      findAllCallCount++;
      return Promise.resolve([]);
    },
    getContent() {
      return Promise.resolve(null);
    },
  } as unknown as UnifiedDataRepository;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus, "manual");

  await loader.load();
  const initialCount = findAllCallCount;

  await eventBus.publish(
    createModelCreated("swamp/grant", "123", "my-grant"),
  );

  assertEquals(findAllCallCount, initialCount);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: auto mode subscribes to EventBus", async () => {
  let callCount = 0;
  const grant = makeGrant();

  const dataRepo = {
    findAllForType(type: ModelType) {
      if (type.normalized === GRANT_MODEL_TYPE.normalized) {
        callCount++;
        if (callCount > 1) {
          return Promise.resolve([{
            data: makeData("grant-main"),
            modelType: type,
            modelId: "g1",
          }]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
    getContent(
      type: ModelType,
      _modelId: string,
      _dataName: string,
    ) {
      if (type.normalized === GRANT_MODEL_TYPE.normalized && callCount > 1) {
        return Promise.resolve(
          new TextEncoder().encode(JSON.stringify(grant)),
        );
      }
      return Promise.resolve(null);
    },
  } as unknown as UnifiedDataRepository;

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus, "auto");

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
  const dataRepo = createMockDataRepo(
    [{ attrs: grant, modelId: "g1", dataName: "grant-main" }],
    [{ attrs: group, modelId: "grp1", dataName: "group-main" }],
  );

  const eventBus = new EventBus();
  const loader = new PolicySnapshotLoader(dataRepo, eventBus, "manual");
  const result = await loader.loadWithCounts();

  assertEquals(result.grantCount, 1);
  assertEquals(result.groupCount, 1);

  await loader.dispose();
});
