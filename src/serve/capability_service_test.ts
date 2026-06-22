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

import { assertRejects } from "@std/assert";
import { assertEquals } from "@std/assert";
import { CapabilityService } from "./capability_service.ts";
import { DispatchRegistry } from "./dispatch_registry.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";

function stubRepoContext(
  queryResult: unknown[] = [],
): RepositoryContext {
  return {
    dataQueryService: {
      query: () => Promise.resolve(queryResult),
      querySync: () => queryResult,
    },
    unifiedDataRepo: {
      findByName: () => Promise.resolve(null),
      findById: () => Promise.resolve(null),
      listVersions: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      removeLatestMarker: () => Promise.resolve(),
    },
  } as unknown as RepositoryContext;
}

function createService(
  dispatches?: DispatchRegistry,
  queryResult: unknown[] = [],
): CapabilityService {
  return new CapabilityService({
    repoDir: "/tmp/test",
    repoContext: stubRepoContext(queryResult),
    dispatches,
    createVaultService: () => Promise.reject(new Error("no vault")),
  });
}

// ── queryData deny-list tests ───────────────────────────────────────────

Deno.test("queryData: rejects predicate containing swamp/grant", async () => {
  const service = createService();
  await assertRejects(
    () => service.queryData({ predicate: 'modelType == "swamp/grant"' }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects uppercase SWAMP/GRANT", async () => {
  const service = createService();
  await assertRejects(
    () => service.queryData({ predicate: 'modelType == "SWAMP/GRANT"' }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects dot separator swamp.grant", async () => {
  const service = createService();
  await assertRejects(
    () => service.queryData({ predicate: 'modelType == "swamp.grant"' }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects double-colon swamp::grant", async () => {
  const service = createService();
  await assertRejects(
    () => service.queryData({ predicate: 'modelType == "swamp::grant"' }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects swamp/server-token", async () => {
  const service = createService();
  await assertRejects(
    () => service.queryData({ predicate: 'modelType == "swamp/server-token"' }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects swamp/enrollment-token", async () => {
  const service = createService();
  await assertRejects(
    () =>
      service.queryData({
        predicate: 'modelType == "swamp/enrollment-token"',
      }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects swamp/worker", async () => {
  const service = createService();
  await assertRejects(
    () => service.queryData({ predicate: 'modelType == "swamp/worker"' }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects swamp/step-lease", async () => {
  const service = createService();
  await assertRejects(
    () => service.queryData({ predicate: 'modelType == "swamp/step-lease"' }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: allows clean predicate", async () => {
  const service = createService(undefined, [{ id: "1" }]);
  const result = await service.queryData({
    predicate: 'modelType == "command/shell"',
  });
  assertEquals(result.length, 1);
});

Deno.test("queryData: rejects predicate exceeding max length", async () => {
  const service = createService();
  await assertRejects(
    () => service.queryData({ predicate: "a".repeat(5000) }),
    Error,
    "maximum length",
  );
});

// ── dispatch scoping tests ──────────────────────────────────────────────

Deno.test("getData: rejects when worker has no active dispatch", async () => {
  const dispatches = new DispatchRegistry();
  const service = createService(dispatches);
  await assertRejects(
    () =>
      service.getData("worker-1", {
        modelType: "command/shell",
        modelId: "abc",
        dataName: "result",
      }),
    Error,
    "no active dispatch",
  );
});

Deno.test("getData: rejects when model type is outside dispatch scope", async () => {
  const dispatches = new DispatchRegistry();
  dispatches.register({
    workerName: "worker-1",
    dispatchId: "d-1",
    leaseId: "l-1",
    modelDef: {} as never,
    modelType: ModelType.create("acme/invoices"),
    modelId: "m-1",
    methodName: "run",
    definitionName: "my-invoice",
    definitionTags: {},
  });
  const service = createService(dispatches);
  await assertRejects(
    () =>
      service.getData("worker-1", {
        modelType: "swamp/grant",
        modelId: "abc",
        dataName: "result",
      }),
    Error,
    "outside the active dispatch scope",
  );
});

Deno.test("deleteData: rejects when model type is outside dispatch scope", async () => {
  const dispatches = new DispatchRegistry();
  dispatches.register({
    workerName: "worker-1",
    dispatchId: "d-1",
    leaseId: "l-1",
    modelDef: {} as never,
    modelType: ModelType.create("acme/invoices"),
    modelId: "m-1",
    methodName: "run",
    definitionName: "my-invoice",
    definitionTags: {},
  });
  const service = createService(dispatches);
  await assertRejects(
    () =>
      service.deleteData("worker-1", {
        modelType: "swamp/grant",
        modelId: "abc",
        dataName: "result",
      }),
    Error,
    "outside the active dispatch scope",
  );
});

Deno.test("resolveSecret: rejects when worker has no active dispatch", async () => {
  const dispatches = new DispatchRegistry();
  const service = createService(dispatches);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "some-key",
      }),
    Error,
    "no active dispatch",
  );
});

Deno.test("putSecret: rejects when worker has no active dispatch", async () => {
  const dispatches = new DispatchRegistry();
  const service = createService(dispatches);
  await assertRejects(
    () =>
      service.putSecret("worker-1", {
        vaultName: "default",
        secretKey: "some-key",
        secretValue: "val",
      }),
    Error,
    "no active dispatch",
  );
});

Deno.test("getData: passes when no dispatch registry configured", async () => {
  const service = createService(undefined);
  const result = await service.getData("worker-1", {
    modelType: "command/shell",
    modelId: "abc",
    dataName: "result",
  });
  assertEquals(result.found, false);
});
