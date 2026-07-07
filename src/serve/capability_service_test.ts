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
import type { ActiveDispatch } from "./dispatch_registry.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { VaultExtractionResult } from "../domain/expressions/vault_reference_extractor.ts";

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

function createServiceWithVault(
  dispatches?: DispatchRegistry,
  secrets: Record<string, string> = {},
): CapabilityService {
  return new CapabilityService({
    repoDir: "/tmp/test",
    repoContext: stubRepoContext(),
    dispatches,
    createVaultService: () =>
      Promise.resolve({
        get: (_vault: string, key: string) => {
          if (key in secrets) return Promise.resolve(secrets[key]);
          throw new Error(`secret not found: ${key}`);
        },
        getAnnotation: () => Promise.resolve(null),
        put: () => Promise.resolve(),
        putAnnotation: () => Promise.resolve(),
        deleteAnnotation: () => Promise.resolve(),
      } as never),
  });
}

function withDispatch(dispatches: DispatchRegistry, workerName = "worker-1") {
  dispatches.register({
    workerName,
    dispatchId: "d-1",
    leaseId: "l-1",
    modelDef: {} as never,
    modelType: ModelType.create("acme/invoices"),
    modelId: "m-1",
    methodName: "run",
    definitionName: "my-invoice",
    definitionTags: {},
  });
}

// ── queryData post-query filter tests ───────────────────────────────────

Deno.test("queryData: rejects results containing swamp/grant records", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const service = createService(dispatches, [
    { id: "1", modelType: "swamp/grant" },
  ]);
  await assertRejects(
    () =>
      service.queryData("worker-1", {
        predicate: 'modelType == "swamp/grant"',
      }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects results containing swamp/server-token", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const service = createService(dispatches, [
    { id: "1", modelType: "swamp/server-token" },
  ]);
  await assertRejects(
    () =>
      service.queryData("worker-1", {
        predicate: 'modelType == "swamp/server-token"',
      }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects results with denormalized model type", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const service = createService(dispatches, [
    { id: "1", modelType: "SWAMP.GRANT" },
  ]);
  await assertRejects(
    () => service.queryData("worker-1", { predicate: "true" }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: allows results with non-infrastructure model types", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const service = createService(dispatches, [
    { id: "1", modelType: "command/shell" },
  ]);
  const result = await service.queryData("worker-1", {
    predicate: 'modelType == "command/shell"',
  });
  assertEquals(result.length, 1);
});

Deno.test("queryData: allows results without modelType field", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const service = createService(dispatches, [{ id: "1" }]);
  const result = await service.queryData("worker-1", {
    predicate: "true",
  });
  assertEquals(result.length, 1);
});

Deno.test("queryData: rejects when select projection is provided", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const service = createService(dispatches);
  await assertRejects(
    () =>
      service.queryData("worker-1", {
        predicate: "true",
        options: { select: "attributes.secretKey" },
      }),
    Error,
    "not permitted from workers",
  );
});

Deno.test("queryData: rejects predicate exceeding max length", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const service = createService(dispatches);
  await assertRejects(
    () => service.queryData("worker-1", { predicate: "a".repeat(5000) }),
    Error,
    "maximum length",
  );
});

Deno.test("queryData: rejects when worker has no active dispatch", async () => {
  const dispatches = new DispatchRegistry();
  const service = createService(dispatches);
  await assertRejects(
    () => service.queryData("worker-1", { predicate: 'modelType == "test"' }),
    Error,
    "no active dispatch",
  );
});

Deno.test("queryData: passes without dispatch registry (no scoping)", async () => {
  const service = createService(undefined, [
    { id: "1", modelType: "command/shell" },
  ]);
  const result = await service.queryData("worker-1", {
    predicate: 'modelType == "command/shell"',
  });
  assertEquals(result.length, 1);
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

// ── secret key denylist tests ──────────────────────────────────────────

function withDispatchAndSecrets(
  dispatches: DispatchRegistry,
  allowedSecrets?: VaultExtractionResult,
  workerName = "worker-1",
): void {
  const dispatch: ActiveDispatch = {
    workerName,
    dispatchId: "d-1",
    leaseId: "l-1",
    modelDef: {} as never,
    modelType: ModelType.create("acme/invoices"),
    modelId: "m-1",
    methodName: "run",
    definitionName: "my-invoice",
    definitionTags: {},
    allowedSecrets,
  };
  dispatches.register(dispatch);
}

Deno.test("resolveSecret: rejects server-token-* keys", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [],
    hasDynamicRefs: true,
  });
  const service = createServiceWithVault(dispatches);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "server-token-admin",
      }),
    Error,
    "access denied",
  );
});

Deno.test("resolveSecret: rejects worker-token-* keys", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [],
    hasDynamicRefs: true,
  });
  const service = createServiceWithVault(dispatches);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "worker-token-ci-runner",
      }),
    Error,
    "access denied",
  );
});

Deno.test("resolveSecret: denylist is case-insensitive", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [],
    hasDynamicRefs: true,
  });
  const service = createServiceWithVault(dispatches);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "Server-Token-Admin",
      }),
    Error,
    "access denied",
  );
});

Deno.test("putSecret: rejects server-token-* keys", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [],
    hasDynamicRefs: true,
  });
  const service = createServiceWithVault(dispatches);
  await assertRejects(
    () =>
      service.putSecret("worker-1", {
        vaultName: "default",
        secretKey: "server-token-admin",
        secretValue: "evil",
      }),
    Error,
    "access denied",
  );
});

Deno.test("putSecret: rejects worker-token-* keys", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [],
    hasDynamicRefs: true,
  });
  const service = createServiceWithVault(dispatches);
  await assertRejects(
    () =>
      service.putSecret("worker-1", {
        vaultName: "default",
        secretKey: "worker-token-ci-runner",
        secretValue: "evil",
      }),
    Error,
    "access denied",
  );
});

Deno.test("putSecret: denylist is case-insensitive", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [],
    hasDynamicRefs: true,
  });
  const service = createServiceWithVault(dispatches);
  await assertRejects(
    () =>
      service.putSecret("worker-1", {
        vaultName: "default",
        secretKey: "Worker-Token-CI",
        secretValue: "evil",
      }),
    Error,
    "access denied",
  );
});

// ── per-step allowlist tests (resolveSecret only) ──────────────────────

Deno.test("resolveSecret: allows key present in static allowlist", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [{ vaultName: "default", secretKey: "api-key" }],
    hasDynamicRefs: false,
  });
  const service = createServiceWithVault(dispatches, { "api-key": "secret" });
  const result = await service.resolveSecret("worker-1", {
    vaultName: "default",
    secretKey: "api-key",
  });
  assertEquals(result.value, "secret");
});

Deno.test("resolveSecret: rejects key not in static allowlist", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [{ vaultName: "default", secretKey: "api-key" }],
    hasDynamicRefs: false,
  });
  const service = createServiceWithVault(dispatches);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "other-key",
      }),
    Error,
    "not referenced by the dispatched step",
  );
});

Deno.test("resolveSecret: skips allowlist when dispatch has dynamic refs", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [{ vaultName: "default", secretKey: "api-key" }],
    hasDynamicRefs: true,
  });
  const service = createServiceWithVault(dispatches, {
    "other-key": "value",
  });
  const result = await service.resolveSecret("worker-1", {
    vaultName: "default",
    secretKey: "other-key",
  });
  assertEquals(result.value, "value");
});

Deno.test("resolveSecret: empty allowlist denies all keys", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [],
    hasDynamicRefs: false,
  });
  const service = createServiceWithVault(dispatches);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "any-key",
      }),
    Error,
    "not referenced by the dispatched step",
  );
});

Deno.test("putSecret: allows keys not in allowlist (denylist-only)", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [{ vaultName: "default", secretKey: "api-key" }],
    hasDynamicRefs: false,
  });
  const service = createServiceWithVault(dispatches);
  const result = await service.putSecret("worker-1", {
    vaultName: "default",
    secretKey: "new-output-key",
    secretValue: "value",
  });
  assertEquals(result.ok, true);
});

Deno.test("resolveSecret: passes without dispatch registry (no scoping)", async () => {
  const service = createServiceWithVault(undefined, {
    "any-key": "value",
  });
  const result = await service.resolveSecret("worker-1", {
    vaultName: "default",
    secretKey: "any-key",
  });
  assertEquals(result.value, "value");
});

Deno.test("putSecret: passes without dispatch registry (no scoping)", async () => {
  const service = createServiceWithVault(undefined);
  const result = await service.putSecret("worker-1", {
    vaultName: "default",
    secretKey: "any-key",
    secretValue: "value",
  });
  assertEquals(result.ok, true);
});
