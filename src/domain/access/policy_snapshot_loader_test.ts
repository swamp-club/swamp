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

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { readConditionTypeLiterals } from "../../infrastructure/cel/grant_condition_environment.ts";
import { Data } from "../data/data.ts";
import type {
  FindAllForTypeOptions,
  UnifiedDataRepository,
} from "../data/repositories.ts";
import { EventBus } from "../events/event_bus.ts";
import {
  createDefinitionCreated,
  createDefinitionUpdated,
  createModelCreated,
  createModelUpdated,
} from "../events/types.ts";
import type { Grant } from "../models/access/grant_model.ts";
import { GRANT_MODEL_TYPE } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import { GROUP_MODEL_TYPE } from "../models/access/group_model.ts";
import type { ModelType } from "../models/model_type.ts";
import {
  conditionReferencesField,
  createConditionEvaluator,
  PolicySnapshotLoader,
  retainedUnreadableGrant,
  withoutAllowsToGroups,
} from "./policy_snapshot_loader.ts";
import { UnreadableAccessRecordsError } from "./unreadable_access_records.ts";
import { MissingConditionFieldError } from "./condition_fields.ts";
import { UserError } from "../errors.ts";
import type { PrincipalContext } from "./principal_context.ts";

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

Deno.test("PolicySnapshotLoader: rebuilds snapshot on DefinitionCreated for grant model", async () => {
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
    createDefinitionCreated("swamp/grant", "def-123", "my-grant"),
  );

  await delay(700);
  assertEquals(loader.snapshot.grantsForSubjects(["user:adam"]).length, 1);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: rebuilds snapshot on DefinitionUpdated for group model", async () => {
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
    createDefinitionUpdated("swamp/group", "def-456", "devs"),
  );

  await delay(700);
  assertEquals([...loader.snapshot.groupsForPrincipal("user:adam")], ["devs"]);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: ignores DefinitionCreated for non-access models", async () => {
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
    createDefinitionCreated("swamp/echo", "def-789", "my-echo"),
  );

  assertEquals(findAllCallCount, initialCount);

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader: rebuilds snapshot on ModelUpdated for grant revoke", async () => {
  let callCount = 0;
  const activeGrant = makeGrant({ state: "active" });
  const revokedGrant = makeGrant({ ...activeGrant, state: "revoked" });

  const dataRepo = {
    findAllForType(type: ModelType) {
      if (type.normalized === GRANT_MODEL_TYPE.normalized) {
        callCount++;
        return Promise.resolve([{
          data: makeData("grant-main"),
          modelType: type,
          modelId: "g1",
        }]);
      }
      return Promise.resolve([]);
    },
    getContent(
      type: ModelType,
      _modelId: string,
      _dataName: string,
    ) {
      if (type.normalized === GRANT_MODEL_TYPE.normalized) {
        const grant = callCount <= 1 ? activeGrant : revokedGrant;
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
  assertEquals(loader.snapshot.grantsForSubjects(["user:adam"]).length, 1);

  await eventBus.publish(
    createModelUpdated("swamp/grant", "g1", "my-grant"),
  );

  await delay(700);
  assertEquals(loader.snapshot.grantsForSubjects(["user:adam"]).length, 0);

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

Deno.test("PolicySnapshotLoader.decisionService: defaults to run implying approve", async () => {
  const dataRepo = createMockDataRepo(
    [{
      attrs: makeGrant({ actions: ["run"] }),
      modelId: "g1",
      dataName: "grant-main",
    }],
    [],
  );
  const loader = new PolicySnapshotLoader(dataRepo, new EventBus(), "manual");
  await loader.load();

  const principal = {
    principal: { kind: "user" as const, id: "adam" },
    collectives: [],
    groups: [],
  };
  const resource = { kind: "workflow" as const, name: "deploy", fields: {} };
  assertEquals(loader.decisionService.runImpliesApprove, true);
  assertEquals(
    loader.decisionService.decide(principal, "approve", resource)?.effect,
    "allow",
  );

  await loader.dispose();
});

Deno.test("PolicySnapshotLoader.decisionService: keeps runImpliesApprove false across reloads", async () => {
  const dataRepo = createMockDataRepo(
    [{
      attrs: makeGrant({ actions: ["run"] }),
      modelId: "g1",
      dataName: "grant-main",
    }],
    [],
  );
  const loader = new PolicySnapshotLoader(
    dataRepo,
    new EventBus(),
    "manual",
    { runImpliesApprove: false },
  );
  const principal = {
    principal: { kind: "user" as const, id: "adam" },
    collectives: [],
    groups: [],
  };
  const resource = { kind: "workflow" as const, name: "deploy", fields: {} };

  await loader.load();
  const first = loader.decisionService;
  assertEquals(first.runImpliesApprove, false);
  assertEquals(first.decide(principal, "approve", resource), null);

  await loader.loadWithCounts();
  const rebuilt = loader.decisionService;
  assertEquals(rebuilt === first, false);
  assertEquals(rebuilt.runImpliesApprove, false);
  assertEquals(rebuilt.decide(principal, "approve", resource), null);
  assertEquals(rebuilt.decide(principal, "run", resource)?.effect, "allow");

  await loader.dispose();
});

const PRINCIPAL: PrincipalContext = {
  sub: "user-123",
  groups: ["release-managers", "platform"],
  collectives: ["acme", "ops"],
};

Deno.test("createConditionEvaluator: returns true when condition matches", () => {
  const evaluate = createConditionEvaluator();
  assertEquals(
    evaluate(
      'tags.env == "staging"',
      "workflow",
      { name: "deploy", tags: { env: "staging" } },
      PRINCIPAL,
    ),
    true,
  );
});

Deno.test("createConditionEvaluator: returns false when condition does not match", () => {
  const evaluate = createConditionEvaluator();
  assertEquals(
    evaluate(
      'tags.env == "prod"',
      "workflow",
      { name: "deploy", tags: { env: "staging" } },
      PRINCIPAL,
    ),
    false,
  );
});

Deno.test("createConditionEvaluator: evaluates principal context", () => {
  const evaluate = createConditionEvaluator();
  assertEquals(
    evaluate(
      'tags.env == "staging" && "ops" in principal.collectives && size(principal.groups) > 1',
      "workflow",
      { name: "deploy", tags: { env: "staging" } },
      PRINCIPAL,
    ),
    true,
  );
});

Deno.test("createConditionEvaluator: returns false for a non-boolean result", () => {
  const evaluate = createConditionEvaluator();
  assertEquals(
    evaluate("name", "access", { name: "admin-grant" }, PRINCIPAL),
    false,
  );
});

Deno.test("createConditionEvaluator: evaluates methodName, which the runtime once lacked", () => {
  const evaluate = createConditionEvaluator();
  const model = { name: "m", modelType: "aws/ec2", tags: {} };
  assertEquals(
    evaluate('methodName == "read"', "model", {
      ...model,
      methodName: "read",
    }, PRINCIPAL),
    true,
  );
  assertEquals(
    evaluate('methodName == "read"', "model", {
      ...model,
      methodName: "create",
    }, PRINCIPAL),
    false,
  );
});

Deno.test("createConditionEvaluator: an absent request field evaluates as its zero value", () => {
  const evaluate = createConditionEvaluator();
  const model = { name: "m", modelType: "aws/ec2", tags: {} };
  assertEquals(
    evaluate('methodName == "read"', "model", model, PRINCIPAL),
    false,
  );
  assertEquals(evaluate('methodName == ""', "model", model, PRINCIPAL), true);
});

Deno.test("createConditionEvaluator: an absent resource field throws MissingConditionFieldError", () => {
  const evaluate = createConditionEvaluator();
  const error = assertThrows(
    () => evaluate('tags.env == "prod"', "model", { name: "m" }, PRINCIPAL),
    MissingConditionFieldError,
  );
  assertEquals(error.fields, ["tags"]);
});

Deno.test("createConditionEvaluator: a variable no handler supplies is missing", () => {
  const evaluate = createConditionEvaluator();
  assertThrows(
    () =>
      evaluate(
        'collective == "acme"',
        "workflow",
        { name: "w", tags: {} },
        PRINCIPAL,
      ),
    MissingConditionFieldError,
  );
});

Deno.test("createConditionEvaluator: a tag key the resource lacks is an evaluation error, not a missing field", () => {
  const evaluate = createConditionEvaluator();
  const error = assertThrows(() =>
    evaluate('tags.env == "prod"', "model", {
      name: "m",
      modelType: "t",
      tags: {},
    }, PRINCIPAL)
  );
  assertEquals(error instanceof MissingConditionFieldError, false);
});

Deno.test("createConditionEvaluator: a name bound by a comprehension is not a field reference", () => {
  const evaluate = createConditionEvaluator();
  assertEquals(
    evaluate(
      'principal.groups.exists(owner, owner == "platform")',
      "data",
      { name: "d", ns: "", tags: {} },
      PRINCIPAL,
    ),
    true,
  );
});

/** Runs `fn` with the snapshot loader's warnings captured, as messages. */
async function capturingLoaderWarnings(
  fn: () => Promise<void>,
): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["swamp", "domain", "access", "policy-snapshot"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => record.message.map(String).join(""));
}

Deno.test("PolicySnapshotLoader.load: a vault grant with a name or key condition raises no unsupplied-field warning (swamp-club#2676)", async () => {
  const byName = makeGrant({
    resource: { kind: "vault", pattern: "prod-*" },
    condition: 'name == "prod-db"',
  });
  const byKey = makeGrant({
    effect: "deny",
    resource: { kind: "vault", pattern: "*" },
    condition: 'key.startsWith("root-")',
  });
  // A condition on an unsupplied field is still named, so the capture works.
  const onOwner = makeGrant({
    resource: { kind: "data", pattern: "*" },
    condition: 'owner.kind == "user"',
  });
  const dataRepo = createMockDataRepo(
    [
      { attrs: byName, modelId: "g1", dataName: "grant-main" },
      { attrs: byKey, modelId: "g2", dataName: "grant-main" },
      { attrs: onOwner, modelId: "g3", dataName: "grant-main" },
    ],
    [],
  );
  const loader = new PolicySnapshotLoader(dataRepo, new EventBus());
  const warnings = await capturingLoaderWarnings(async () => {
    await loader.load();
  });
  await loader.dispose();

  assertEquals(warnings.filter((w) => w.includes(onOwner.id)).length, 1);
  assertEquals(
    warnings.filter((w) => w.includes(byName.id) || w.includes(byKey.id)),
    [],
  );
});

Deno.test("createConditionEvaluator: a vault key condition sees an absent key as empty, not missing (swamp-club#2676)", () => {
  const evaluate = createConditionEvaluator();
  assertEquals(
    evaluate('key == "api"', "vault", { name: "prod" }, PRINCIPAL),
    false,
  );
  assertEquals(
    evaluate('key == "api"', "vault", { name: "prod", key: "api" }, PRINCIPAL),
    true,
  );
  assertEquals(
    evaluate('name == "prod"', "vault", { name: "prod" }, PRINCIPAL),
    true,
  );
});

Deno.test("conditionReferencesField: finds a variable structurally; an unparsable condition counts as referencing it", () => {
  assertEquals(
    conditionReferencesField('key.startsWith("app-")', "vault", "key"),
    true,
  );
  assertEquals(
    conditionReferencesField('name == "erp" || key == ""', "vault", "key"),
    true,
  );
  assertEquals(
    conditionReferencesField('name == "erp"', "vault", "key"),
    false,
  );
  assertEquals(
    conditionReferencesField('"key" == principal.id', "vault", "key"),
    false,
  );
  assertEquals(conditionReferencesField("key ==", "vault", "key"), true);
});

Deno.test("PolicySnapshotLoader.load: names each non-canonical type spelling once across reloads (swamp-club#3130)", async () => {
  const deny = makeGrant({
    effect: "deny",
    resource: { kind: "model", pattern: "AWS::EC2::*" },
    source: "file:grants-dir/deny.yaml",
  });
  const allow = makeGrant({
    resource: { kind: "model", pattern: "*" },
    condition: 'modelType == "Acme.Tools.Probe"',
  });
  const canonical = makeGrant({
    resource: { kind: "model", pattern: "@acme/*" },
    condition: 'modelType == "exp/probe"',
  });
  const dataRepo = createMockDataRepo(
    [
      { attrs: deny, modelId: "g1", dataName: "grant-main" },
      { attrs: allow, modelId: "g2", dataName: "grant-main" },
      { attrs: canonical, modelId: "g3", dataName: "grant-main" },
    ],
    [],
  );
  const loader = new PolicySnapshotLoader(
    dataRepo,
    new EventBus(),
    "auto",
    {},
    readConditionTypeLiterals,
  );
  const warnings = await capturingLoaderWarnings(async () => {
    await loader.load();
    await loader.load();
  });
  await loader.dispose();

  const forDeny = warnings.filter((w) => w.includes(deny.id));
  assertEquals(forDeny.length, 1);
  assertEquals(forDeny[0].includes("model:aws/ec2/*"), true);
  assertEquals(forDeny[0].includes("file:grants-dir/deny.yaml"), true);
  const forAllow = warnings.filter((w) => w.includes(allow.id));
  assertEquals(forAllow.length, 1);
  assertEquals(forAllow[0].includes("acme/tools/probe"), true);
  assertEquals(warnings.filter((w) => w.includes(canonical.id)), []);
});

Deno.test("PolicySnapshotLoader.load: reports a spelling again once its grant returns after a revoke", async () => {
  const deny = makeGrant({
    effect: "deny",
    resource: { kind: "model", pattern: "AWS::EC2::*" },
  });
  const withGrant = createMockDataRepo(
    [{ attrs: deny, modelId: "g1", dataName: "grant-main" }],
    [],
  );
  const revoked = createMockDataRepo(
    [{
      attrs: { ...deny, state: "revoked" },
      modelId: "g1",
      dataName: "grant-main",
    }],
    [],
  );
  let current = withGrant;
  const dataRepo = new Proxy({} as UnifiedDataRepository, {
    get: (_, key) => current[key as keyof UnifiedDataRepository],
  });
  const loader = new PolicySnapshotLoader(dataRepo, new EventBus());
  const warnings = await capturingLoaderWarnings(async () => {
    await loader.load();
    current = revoked;
    await loader.load();
    current = withGrant;
    await loader.load();
  });
  await loader.dispose();

  assertEquals(warnings.filter((w) => w.includes(deny.id)).length, 2);
});

Deno.test("PolicySnapshotLoader.load: checks a grant again when its selector changes under the same id", async () => {
  const first = makeGrant({
    effect: "deny",
    resource: { kind: "model", pattern: "AWS::EC2::*" },
  });
  const changed = {
    ...first,
    resource: { kind: "model" as const, pattern: "Acme::*" },
  };
  let current = createMockDataRepo(
    [{ attrs: first, modelId: "g1", dataName: "grant-main" }],
    [],
  );
  const dataRepo = new Proxy({} as UnifiedDataRepository, {
    get: (_, key) => current[key as keyof UnifiedDataRepository],
  });
  const loader = new PolicySnapshotLoader(dataRepo, new EventBus());
  const warnings = await capturingLoaderWarnings(async () => {
    await loader.load();
    await loader.load();
    current = createMockDataRepo(
      [{ attrs: changed, modelId: "g1", dataName: "grant-main" }],
      [],
    );
    await loader.load();
  });
  await loader.dispose();

  const forGrant = warnings.filter((w) => w.includes(first.id));
  assertEquals(forGrant.length, 2);
  assertEquals(forGrant[1].includes("model:acme/*"), true);
});

// --- Records that cannot be read (swamp-club#3386) ---

type FakeRecord =
  | { kind: "grant"; attrs: Grant }
  | { kind: "group"; attrs: Group }
  | {
    kind: "grant" | "group";
    unreadable:
      | "content"
      | "content-syntax"
      | "missing"
      | "invalid"
      | "listing"
      | "metadata"
      | "schema"
      | "validation"
      | "no-metadata"
      | "json";
    /** Listed under the orphaned `@`-prefixed type, with no definition. */
    orphaned?: boolean;
  };

/**
 * A data repository over records a test can change between loads. A record
 * unreadable at "listing" is reported by findAllForType, as the filesystem
 * repository reports a directory it cannot read, and at "metadata" as it
 * reports metadata that does not parse, and at "schema" as it reports
 * metadata that fails its schema, and at "validation" as it reports any
 * other metadata error; at "content", getContent throws,
 * with a message that differs on every read, as a remote error's may; at
 * "content-syntax", it throws SyntaxError, as a remote read of a malformed
 * response may; at "missing", it returns null; at "invalid", the content
 * parses but fails the grant or group schema; at "json", the content does
 * not parse.
 */
function createChangingDataRepo(
  records: Map<string, FakeRecord>,
): UnifiedDataRepository & {
  failListing: boolean;
  failOrphanedListing: boolean;
} {
  let reads = 0;
  const repo = {
    failListing: false,
    failOrphanedListing: false,
    findAllForType(
      type: ModelType,
      options?: FindAllForTypeOptions,
    ) {
      const orphaned = type.normalized.startsWith("@");
      if (repo.failListing || (orphaned && repo.failOrphanedListing)) {
        return Promise.reject(new Deno.errors.PermissionDenied("type dir"));
      }
      const canonical = orphaned ? type.normalized.slice(1) : type.normalized;
      const kind = canonical === GRANT_MODEL_TYPE.normalized
        ? "grant"
        : canonical === GROUP_MODEL_TYPE.normalized
        ? "group"
        : null;
      const found = [];
      for (const [modelId, record] of records) {
        if (record.kind !== kind) continue;
        const recordOrphaned = "unreadable" in record &&
          record.orphaned === true;
        if (recordOrphaned !== orphaned) continue;
        if (
          "unreadable" in record &&
          (record.unreadable === "listing" ||
            record.unreadable === "metadata" ||
            record.unreadable === "schema" ||
            record.unreadable === "validation" ||
            record.unreadable === "no-metadata")
        ) {
          const schemaError = new Error("metadata fails its schema");
          schemaError.name = "ZodError";
          options?.unreadable?.push({
            modelType: type,
            modelId,
            error: record.unreadable === "listing"
              ? new Deno.errors.PermissionDenied("listing")
              : record.unreadable === "metadata"
              ? new SyntaxError("bad metadata.yaml")
              : record.unreadable === "schema"
              ? schemaError
              : record.unreadable === "no-metadata"
              ? new Deno.errors.NotFound("metadata.yaml is missing")
              : new Error("invalid data id"),
          });
          continue;
        }
        found.push({
          data: makeData(`${kind}-main`),
          modelType: type,
          modelId,
        });
      }
      return Promise.resolve(found);
    },
    getContent(_type: ModelType, modelId: string) {
      const record = records.get(modelId);
      if (!record) return Promise.resolve(null);
      if ("unreadable" in record) {
        if (record.unreadable === "content") {
          return Promise.reject(
            new Deno.errors.PermissionDenied(`raw, read ${++reads}`),
          );
        }
        if (record.unreadable === "content-syntax") {
          return Promise.reject(new SyntaxError("malformed response"));
        }
        if (record.unreadable === "missing") return Promise.resolve(null);
        if (record.unreadable === "invalid") {
          return Promise.resolve(new TextEncoder().encode("{}"));
        }
        return Promise.resolve(new TextEncoder().encode("{not json"));
      }
      return Promise.resolve(
        new TextEncoder().encode(JSON.stringify(record.attrs)),
      );
    },
  };
  return repo as unknown as UnifiedDataRepository & {
    failListing: boolean;
    failOrphanedListing: boolean;
  };
}

/** Runs `fn` with the snapshot loader's logs captured, as level and text. */
async function capturingLoaderLogs(
  fn: () => Promise<void>,
): Promise<Array<{ level: string; message: string }>> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["swamp", "domain", "access", "policy-snapshot"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => ({
    level: record.level,
    message: record.message.map(String).join(""),
  }));
}

function effectsFor(loader: PolicySnapshotLoader, subject: string): string[] {
  return loader.snapshot.grantsForSubjects([subject]).map((g) =>
    `${g.effect}:${g.id}`
  ).sort();
}

Deno.test("PolicySnapshotLoader.load: an unreadable deny it read before stays in force, an unreadable allow is left out, and other revokes apply", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const allow = makeGrant({ id: "allow-1" });
  const other = makeGrant({ id: "allow-2" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
    ["a", { kind: "grant", attrs: allow }],
    ["o", { kind: "grant", attrs: other }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  assertEquals(effectsFor(loader, "user:adam"), [
    "allow:allow-1",
    "allow:allow-2",
    "deny:deny-1",
  ]);

  for (const unreadable of ["content", "listing"] as const) {
    records.set("d", { kind: "grant", unreadable });
    records.set("a", { kind: "grant", unreadable });
    records.set("o", { kind: "grant", attrs: { ...other, state: "revoked" } });
    await loader.load();

    assertEquals(effectsFor(loader, "user:adam"), ["deny:deny-1"]);
    assertEquals(
      loader.unreadable.map((r) => [r.record, r.kind, r.outcome]).sort(),
      [
        ["swamp/grant/a", "grant", "left-out"],
        ["swamp/grant/d", "grant", "kept-last-known-deny"],
      ],
    );
  }
  await loader.dispose();
});

Deno.test("PolicySnapshotLoader.load: the first build refuses a record it cannot read, so serve does not start without a deny", async () => {
  for (
    const unreadable of [
      "content",
      "listing",
      "metadata",
      "schema",
      "json",
    ] as const
  ) {
    const records = new Map<string, FakeRecord>([
      ["d", { kind: "grant", unreadable }],
      ["a", { kind: "grant", attrs: makeGrant({ id: "allow-1" }) }],
    ]);
    const loader = new PolicySnapshotLoader(
      createChangingDataRepo(records),
      new EventBus(),
      "manual",
    );
    const error = await assertRejects(
      () => loader.load(),
      UnreadableAccessRecordsError,
    );
    assertEquals(error.records.map((r) => r.record), ["swamp/grant/d"]);
    assertStringIncludes(error.message, "swamp/grant/d");
    // Nothing was committed: the snapshot is still the empty one.
    assertEquals(effectsFor(loader, "user:adam"), []);
    assertEquals(loader.unreadable, []);

    // Once readable, the first build succeeds.
    records.set("d", {
      kind: "grant",
      attrs: makeGrant({ id: "deny-1", effect: "deny" }),
    });
    await loader.load();
    await loader.dispose();
    assertEquals(effectsFor(loader, "user:adam"), [
      "allow:allow-1",
      "deny:deny-1",
    ]);
  }
});

Deno.test("PolicySnapshotLoader.load: after a first build, a new record it never read is left out and logged as not enforced", async () => {
  const records = new Map<string, FakeRecord>();
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  records.set("d", { kind: "grant", unreadable: "content" });
  const logs = await capturingLoaderLogs(async () => {
    await loader.load();
  });
  await loader.dispose();

  assertEquals(effectsFor(loader, "user:adam"), []);
  assertEquals(loader.unreadable.map((r) => r.outcome), ["left-out"]);
  const errors = logs.filter((l) => l.level === "error");
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0].message, "swamp/grant/d");
  assertStringIncludes(errors[0].message, "never read by this process");
});

Deno.test("PolicySnapshotLoader.load: a rebuild that finds the same unreadable records logs the snapshot at debug", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  records.set("d", { kind: "grant", unreadable: "content" });
  const logs = await capturingLoaderLogs(async () => {
    await loader.load();
    await loader.load();
    await loader.load();
  });
  await loader.dispose();

  const loaded = logs.filter((l) => l.message.startsWith("Loaded policy"));
  assertEquals(loaded.map((l) => l.level), ["info", "debug", "debug"]);
});

Deno.test("PolicySnapshotLoader.load: a record whose JSON does not parse keeps its last-known deny", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  records.set("d", { kind: "grant", unreadable: "json" });
  await loader.load();
  await loader.dispose();

  assertEquals(effectsFor(loader, "user:adam"), ["deny:deny-1"]);
  assertEquals(loader.unreadable.map((r) => r.outcome), [
    "kept-last-known-deny",
  ]);
});

Deno.test("PolicySnapshotLoader.load: an unreadable group keeps its members for denies and suspends allows to it", async () => {
  const allowToGroup = makeGrant({
    id: "allow-devs",
    subject: { kind: "group", name: "devs" },
  });
  const denyToGroup = makeGrant({
    id: "deny-devs",
    effect: "deny",
    subject: { kind: "group", name: "devs" },
    resource: { kind: "model", pattern: "*" },
  });
  const records = new Map<string, FakeRecord>([
    ["ga", { kind: "grant", attrs: allowToGroup }],
    ["gd", { kind: "grant", attrs: denyToGroup }],
    ["devs", { kind: "group", attrs: makeGroup("devs", ["adam"]) }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  assertEquals(effectsFor(loader, "group:devs"), [
    "allow:allow-devs",
    "deny:deny-devs",
  ]);

  records.set("devs", { kind: "group", unreadable: "listing" });
  const logs = await capturingLoaderLogs(async () => {
    await loader.load();
  });

  assertEquals([...loader.snapshot.groupsForPrincipal("user:adam")], ["devs"]);
  assertEquals(effectsFor(loader, "group:devs"), ["deny:deny-devs"]);
  assertEquals(loader.unreadable.map((r) => r.outcome), [
    "kept-last-known-members",
  ]);
  const errors = logs.filter((l) => l.level === "error");
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0].message, "allow grants to the group");

  // Readable again: the allow comes back.
  records.set("devs", { kind: "group", attrs: makeGroup("devs", ["adam"]) });
  await loader.load();
  await loader.dispose();
  assertEquals(effectsFor(loader, "group:devs"), [
    "allow:allow-devs",
    "deny:deny-devs",
  ]);
  assertEquals(loader.unreadable, []);
});

Deno.test("PolicySnapshotLoader.load: an unreadable record is logged at error once, at debug while it repeats, and at info when it reads again", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  records.set("d", { kind: "grant", unreadable: "content" });
  const logs = await capturingLoaderLogs(async () => {
    await loader.load();
    await loader.load();
    await loader.load();
    records.set("d", { kind: "grant", attrs: deny });
    await loader.load();
  });
  await loader.dispose();

  const about = logs.filter((l) => l.message.includes("swamp/grant/d"));
  assertEquals(about.map((l) => l.level), ["error", "debug", "debug", "info"]);
  assertStringIncludes(about[0].message, "deny-1");
  assertStringIncludes(about[0].message, "stays in force");
});

Deno.test("PolicySnapshotLoader.load: a build that throws keeps the previous snapshot and last-known records", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const repo = createChangingDataRepo(records);
  const loader = new PolicySnapshotLoader(repo, new EventBus(), "manual");
  await loader.load();
  const before = loader.snapshot;

  repo.failListing = true;
  await assertRejects(() => loader.load(), Deno.errors.PermissionDenied);
  assertEquals(loader.snapshot, before);
  assertEquals(loader.unreadable, []);

  // The deny read before the failed build is still the last-known version.
  repo.failListing = false;
  records.set("d", { kind: "grant", unreadable: "content" });
  await loader.load();
  await loader.dispose();
  assertEquals(effectsFor(loader, "user:adam"), ["deny:deny-1"]);
});

Deno.test("retainedUnreadableGrant: keeps only an active deny", () => {
  const deny = makeGrant({ effect: "deny" });
  assertEquals(retainedUnreadableGrant(deny), deny);
  assertEquals(retainedUnreadableGrant({ ...deny, state: "revoked" }), null);
  assertEquals(retainedUnreadableGrant(makeGrant()), null);
  assertEquals(retainedUnreadableGrant(undefined), null);
});

Deno.test("withoutAllowsToGroups: drops only allows whose subject is a suspended group", () => {
  const allowToDevs = makeGrant({ subject: { kind: "group", name: "devs" } });
  const denyToDevs = makeGrant({
    effect: "deny",
    subject: { kind: "group", name: "devs" },
  });
  const allowToOps = makeGrant({ subject: { kind: "group", name: "ops" } });
  const allowToUser = makeGrant({ subject: { kind: "user", name: "devs" } });
  assertEquals(
    withoutAllowsToGroups(
      [allowToDevs, denyToDevs, allowToOps, allowToUser],
      new Set(["devs"]),
    ),
    [denyToDevs, allowToOps, allowToUser],
  );
});

Deno.test("PolicySnapshotLoader.load: the first-build error tells a corrupt record from an unreadable one and names the fix", async () => {
  const records = new Map<string, FakeRecord>([
    ["bad-json", { kind: "grant", unreadable: "json" }],
    ["bad-meta", { kind: "group", unreadable: "metadata" }],
    ["no-access", { kind: "grant", unreadable: "content" }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  const error = await assertRejects(
    () => loader.load(),
    UnreadableAccessRecordsError,
  );
  await loader.dispose();

  assertEquals(error instanceof UserError, true);
  assertEquals(error.code, "access_records_unloadable");
  const lines = error.message.split("\n");
  const line = (id: string) => lines.find((l) => l.includes(`/${id} `)) ?? "";
  assertStringIncludes(line("bad-json"), "is corrupt");
  assertStringIncludes(
    line("bad-json"),
    "swamp data delete bad-json grant-main -y",
  );
  assertStringIncludes(line("bad-meta"), "is corrupt");
  assertStringIncludes(
    line("bad-meta"),
    "swamp data delete bad-meta group-main -y",
  );
  assertStringIncludes(line("no-access"), "cannot be read");
  assertStringIncludes(line("no-access"), "read access");
  assertEquals(line("no-access").includes("swamp data delete"), false);
  assertEquals(
    error.records.map((r) => [r.modelId, r.cause]).sort(),
    [["bad-json", "corrupt"], ["bad-meta", "corrupt"], [
      "no-access",
      "unreadable",
    ]],
  );
});

Deno.test("PolicySnapshotLoader.load: a corrupt record found after the first build logs the command that removes it", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  records.set("d", { kind: "grant", unreadable: "json" });
  const logs = await capturingLoaderLogs(async () => {
    await loader.load();
  });
  await loader.dispose();

  assertEquals(effectsFor(loader, "user:adam"), ["deny:deny-1"]);
  const errors = logs.filter((l) => l.level === "error");
  assertEquals(
    errors.some((l) => l.message.includes("swamp data delete d grant-main -y")),
    true,
  );
});

Deno.test("PolicySnapshotLoader.load: a rebuild that also loads a peer's change logs it and warns as usual while a record stays unreadable", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  records.set("d", { kind: "grant", unreadable: "content" });
  const onOwner = makeGrant({
    id: "on-owner",
    resource: { kind: "data", pattern: "*" },
    condition: 'owner.kind == "user"',
  });
  const logs = await capturingLoaderLogs(async () => {
    await loader.load();
    await loader.load();
    // A peer adds a grant while the other record stays unreadable.
    records.set("o", { kind: "grant", attrs: onOwner });
    await loader.load();
  });
  await loader.dispose();

  const loaded = logs.filter((l) => l.message.startsWith("Loaded policy"));
  assertEquals(loaded.map((l) => l.level), ["info", "debug", "info"]);
  assertEquals(
    logs.filter((l) => l.level === "warning" && l.message.includes("on-owner"))
      .length,
    1,
  );
});

Deno.test("PolicySnapshotLoader.load: the first-build error does not tell a record a newer swamp may have written to be deleted outright, and names an orphaned record's directory", async () => {
  const records = new Map<string, FakeRecord>([
    ["newer", { kind: "grant", unreadable: "schema" }],
    ["orphan", { kind: "grant", unreadable: "metadata", orphaned: true }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  const error = await assertRejects(
    () => loader.load(),
    UnreadableAccessRecordsError,
  );
  await loader.dispose();

  const lines = error.message.split("\n");
  const newer = lines.find((l) => l.includes("swamp/grant/newer ")) ?? "";
  assertStringIncludes(newer, "is not valid for this swamp");
  assertStringIncludes(newer, "if a newer swamp wrote it, upgrade this one");
  assertStringIncludes(newer, "swamp data delete newer grant-main -y");
  const orphan = lines.find((l) => l.includes("@swamp/grant/orphan ")) ?? "";
  assertStringIncludes(orphan, "is corrupt");
  assertStringIncludes(orphan, "data/@swamp/grant/orphan");
  assertEquals(orphan.includes("swamp data delete orphan"), false);
  assertEquals(
    error.records.map((r) => [r.modelId, r.cause, r.orphaned]).sort(),
    [["newer", "unrecognised", false], ["orphan", "corrupt", true]],
  );
});

Deno.test("PolicySnapshotLoader.load: each way a record fails is classed by where it failed", async () => {
  const cases: Array<[FakeRecord & { unreadable: string }, string]> = [
    [{ kind: "grant", unreadable: "content" }, "unreadable"],
    // A failed read is unreadable whatever its error class.
    [{ kind: "grant", unreadable: "content-syntax" }, "unreadable"],
    [{ kind: "grant", unreadable: "json" }, "corrupt"],
    [{ kind: "grant", unreadable: "invalid" }, "unrecognised"],
    [{ kind: "grant", unreadable: "listing" }, "unreadable"],
    [{ kind: "grant", unreadable: "metadata" }, "corrupt"],
    [{ kind: "grant", unreadable: "schema" }, "unrecognised"],
    [{ kind: "grant", unreadable: "validation" }, "unrecognised"],
  ];
  for (const [record, cause] of cases) {
    const loader = new PolicySnapshotLoader(
      createChangingDataRepo(new Map([["r", record]])),
      new EventBus(),
      "manual",
    );
    const error = await assertRejects(
      () => loader.load(),
      UnreadableAccessRecordsError,
    );
    await loader.dispose();
    assertEquals(
      error.records.map((r) => r.cause),
      [cause],
      record.unreadable,
    );
  }
});

Deno.test("PolicySnapshotLoader.load: a deny it read before stays in force when its content fails the schema or goes missing", async () => {
  for (const unreadable of ["invalid", "missing"] as const) {
    const deny = makeGrant({ id: "deny-1", effect: "deny" });
    const records = new Map<string, FakeRecord>([
      ["d", { kind: "grant", attrs: deny }],
    ]);
    const loader = new PolicySnapshotLoader(
      createChangingDataRepo(records),
      new EventBus(),
      "manual",
    );
    await loader.load();
    records.set("d", { kind: "grant", unreadable });
    await loader.load();
    await loader.dispose();

    assertEquals(effectsFor(loader, "user:adam"), ["deny:deny-1"], unreadable);
    assertEquals(
      loader.unreadable.map((r) => [r.cause, r.outcome]),
      [[
        unreadable === "invalid" ? "unrecognised" : "unreadable",
        "kept-last-known-deny",
      ]],
      unreadable,
    );
  }
});

Deno.test("PolicySnapshotLoader.load: a record never read whose content is missing is skipped, as before", async () => {
  const records = new Map<string, FakeRecord>([
    ["m", { kind: "grant", unreadable: "missing" }],
    ["a", { kind: "grant", attrs: makeGrant({ id: "allow-1" }) }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  await loader.dispose();
  assertEquals(effectsFor(loader, "user:adam"), ["allow:allow-1"]);
  assertEquals(loader.unreadable, []);
});

Deno.test("PolicySnapshotLoader.load: a grant that fails the schema is described by its first issues, not a JSON dump", async () => {
  const records = new Map<string, FakeRecord>([
    ["bad", { kind: "grant", unreadable: "invalid" }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  const error = await assertRejects(
    () => loader.load(),
    UnreadableAccessRecordsError,
  );
  await loader.dispose();

  const line = error.message.split("\n")[1];
  assertStringIncludes(line, "is not valid for this swamp");
  assertStringIncludes(line, "ZodError: ");
  assertStringIncludes(line, "subject: ");
  assertStringIncludes(line, "more");
  assertEquals(line.includes("[\n"), false);
  assertEquals(error.message.split("\n").length, 2);
});

Deno.test("PolicySnapshotLoader.load: other data of a grant model that fails, such as a report, neither fails the grant nor is named in a fix", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const inner = createChangingDataRepo(records);
  const repo = {
    ...inner,
    getContent: inner.getContent,
    findAllForType(type: ModelType, options?: FindAllForTypeOptions) {
      // The repository returns the grant's access data and reports only a
      // sibling report that failed, as it does per data name.
      options?.unreadable?.push({
        modelType: type,
        modelId: "d",
        dataName: "@swamp/method-summary",
        error: new SyntaxError("report metadata.yaml is empty"),
      });
      return inner.findAllForType(type, options);
    },
  } as unknown as UnifiedDataRepository;
  const loader = new PolicySnapshotLoader(repo, new EventBus(), "manual");
  await loader.load();
  await loader.dispose();

  assertEquals(effectsFor(loader, "user:adam"), ["deny:deny-1"]);
  assertEquals(loader.unreadable, []);
});

Deno.test("PolicySnapshotLoader.load: builds run one at a time, so an older build never overwrites a newer one", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const inner = createChangingDataRepo(records);
  let release: () => void = () => {};
  let gate: Promise<void> | null = null;
  const repo = {
    findAllForType: inner.findAllForType,
    async getContent(type: ModelType, modelId: string, dataName: string) {
      // Content is read when called; a gated read returns it only later.
      const content = await inner.getContent(type, modelId, dataName);
      if (gate) await gate;
      return content;
    },
  } as unknown as UnifiedDataRepository;
  const loader = new PolicySnapshotLoader(repo, new EventBus(), "manual");
  await loader.load();

  // Build A reads the active deny, then stalls before it commits. A turn of
  // the event loop runs every fake read, which resolve as microtasks.
  gate = new Promise((resolve) => release = resolve);
  const older = loader.load();
  await delay(0);
  // A peer revokes the deny, and build B is asked for after A. Run alongside
  // A, B would read the revoke and commit within this turn, and A, released
  // after it, would then commit the stale deny over it.
  gate = null;
  records.set("d", { kind: "grant", attrs: { ...deny, state: "revoked" } });
  const newer = loader.load();
  await delay(0);
  release();
  await Promise.all([older, newer]);
  await loader.dispose();

  // B ran after A, read the revoke, and committed last.
  assertEquals(effectsFor(loader, "user:adam"), []);
});

Deno.test("PolicySnapshotLoader.load: an orphaned type directory that cannot be listed fails the build, keeping its denies", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const repo = createChangingDataRepo(records);
  const loader = new PolicySnapshotLoader(repo, new EventBus(), "manual");
  await loader.load();

  repo.failOrphanedListing = true;
  await assertRejects(() => loader.load(), Deno.errors.PermissionDenied);
  await loader.dispose();
  assertEquals(effectsFor(loader, "user:adam"), ["deny:deny-1"]);
});

Deno.test("PolicySnapshotLoader.load: a record whose metadata goes missing keeps a deny it carried, and one never read is skipped", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
    ["new", { kind: "grant", unreadable: "no-metadata" }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  // A record never read with missing metadata does not fail the first build.
  await loader.load();
  assertEquals(loader.unreadable, []);

  records.set("d", { kind: "grant", unreadable: "no-metadata" });
  await loader.load();
  await loader.dispose();
  assertEquals(effectsFor(loader, "user:adam"), ["deny:deny-1"]);
  assertEquals(
    loader.unreadable.map((r) => [r.modelId, r.cause, r.outcome]),
    [["d", "unreadable", "kept-last-known-deny"]],
  );
});

Deno.test("PolicySnapshotLoader.load: a record whose cause changes under the same error class is logged at error again, with its fix", async () => {
  const deny = makeGrant({ id: "deny-1", effect: "deny" });
  const records = new Map<string, FakeRecord>([
    ["d", { kind: "grant", attrs: deny }],
  ]);
  const loader = new PolicySnapshotLoader(
    createChangingDataRepo(records),
    new EventBus(),
    "manual",
  );
  await loader.load();
  const logs = await capturingLoaderLogs(async () => {
    // A remote read failing with a SyntaxError is unreadable...
    records.set("d", { kind: "grant", unreadable: "content-syntax" });
    await loader.load();
    // ...and then the content is corrupt: SyntaxError again, another cause.
    records.set("d", { kind: "grant", unreadable: "json" });
    await loader.load();
  });
  await loader.dispose();

  const errors = logs.filter((l) =>
    l.level === "error" && l.message.includes("swamp/grant/d")
  );
  assertEquals(
    errors.some((l) => l.message.includes("swamp data delete d grant-main -y")),
    true,
  );
  assertEquals(
    loader.unreadable.map((r) => [r.cause, r.errorName]),
    [["corrupt", "SyntaxError"]],
  );
});
