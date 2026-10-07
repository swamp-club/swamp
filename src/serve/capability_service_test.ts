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
import {
  signalChange,
  type UnscopedChange,
  useUnscopedChangeReporterForTesting,
} from "../infrastructure/persistence/unit_of_work_scope.ts";

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

// ── reserved vault name tests (hoisted guards) ──────────────────────────

Deno.test("resolveSecret: rejects _token-secrets vault name", async () => {
  const service = createService(undefined);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "_token-secrets",
        secretKey: "some-key",
      }),
    Error,
    "reserved vault",
  );
});

Deno.test("putSecret: rejects _token-secrets vault name", async () => {
  const service = createService(undefined);
  await assertRejects(
    () =>
      service.putSecret("worker-1", {
        vaultName: "_token-secrets",
        secretKey: "some-key",
        secretValue: "val",
      }),
    Error,
    "reserved vault",
  );
});

Deno.test("resolveSecret: rejects oauth-access-token- prefixed keys", async () => {
  const service = createService(undefined);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "oauth-access-token-github",
      }),
    Error,
    "infrastructure secrets",
  );
});

Deno.test("putSecret: rejects oauth-client-secret key", async () => {
  const service = createService(undefined);
  await assertRejects(
    () =>
      service.putSecret("worker-1", {
        vaultName: "default",
        secretKey: "oauth-client-secret",
        secretValue: "evil",
      }),
    Error,
    "infrastructure secrets",
  );
});

Deno.test("deleteData: the delete stages into a root unit over the repository context's hook (swamp-club#3056)", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const marks: (string | undefined)[] = [];
  const markDirty = (path?: string) => {
    marks.push(path);
    return Promise.resolve();
  };
  const repoContext = stubRepoContext() as unknown as {
    markDirty: typeof markDirty;
    unifiedDataRepo: Record<string, unknown>;
  };
  repoContext.markDirty = markDirty;
  // As the data repository signals before it deletes.
  repoContext.unifiedDataRepo.delete = () =>
    signalChange(markDirty, { kind: "remove", path: "result" });
  const service = new CapabilityService({
    repoDir: "/tmp/test",
    repoContext: repoContext as unknown as RepositoryContext,
    dispatches,
    createVaultService: () => Promise.reject(new Error("no vault")),
  });
  const reports: UnscopedChange[] = [];
  const dispose = useUnscopedChangeReporterForTesting((report) => {
    reports.push(report);
  });
  try {
    assertEquals(
      await service.deleteData("worker-1", {
        modelType: "acme/invoices",
        modelId: "m-1",
        dataName: "result",
        dispatchId: "d-1",
      }),
      { deleted: true },
    );
  } finally {
    dispose();
  }
  assertEquals(reports, []);
  assertEquals(marks, ["result"]);
});

// ── control-plane records hidden from workers (swamp-club#3129) ─────────

interface RecordingContext {
  context: RepositoryContext;
  queryOptions: unknown[];
  definitionReads: string[];
  outputReads: string[];
}

function recordingRepoContext(opts: {
  queryResult?: unknown[];
  byNameGlobal?: { definition: unknown; type: ModelType } | null;
  allDefinitions?: { definition: unknown; type: ModelType }[];
} = {}): RecordingContext {
  const recorded: RecordingContext = {
    context: undefined as unknown as RepositoryContext,
    queryOptions: [],
    definitionReads: [],
    outputReads: [],
  };
  recorded.context = {
    dataQueryService: {
      query: (_predicate: string, options: unknown) => {
        recorded.queryOptions.push(options);
        return Promise.resolve(opts.queryResult ?? []);
      },
    },
    unifiedDataRepo: {
      listVersions: () => Promise.resolve([1, 2]),
    },
    definitionRepo: {
      findByName: (type: ModelType) => {
        recorded.definitionReads.push(type.normalized);
        return Promise.resolve({ id: "def-1" });
      },
      findByNameGlobal: () => Promise.resolve(opts.byNameGlobal ?? null),
      findAllGlobal: () => Promise.resolve(opts.allDefinitions ?? []),
      findAllIncludingAutoGlobal: () =>
        Promise.resolve(opts.allDefinitions ?? []),
    },
    outputRepo: {
      findById: (type: ModelType) => {
        recorded.outputReads.push(type.normalized);
        return Promise.resolve({ id: "out-1" });
      },
      findLatestByDefinition: (type: ModelType) => {
        recorded.outputReads.push(type.normalized);
        return Promise.resolve({ id: "out-1" });
      },
      findByDefinition: (type: ModelType) => {
        recorded.outputReads.push(type.normalized);
        return Promise.resolve([{ id: "out-1" }]);
      },
      findAll: (type: ModelType) => {
        recorded.outputReads.push(type.normalized);
        return Promise.resolve([{ id: "out-1" }]);
      },
    },
  } as unknown as RepositoryContext;
  return recorded;
}

function recordingService(
  recorded: RecordingContext,
  dispatches?: DispatchRegistry,
): CapabilityService {
  return new CapabilityService({
    repoDir: "/tmp/test",
    repoContext: recorded.context,
    dispatches,
    createVaultService: () => Promise.reject(new Error("no vault")),
  });
}

function withTypedDispatch(
  dispatches: DispatchRegistry,
  modelType: string,
  dispatchId = "d-1",
  workerName = "worker-1",
) {
  dispatches.register({
    workerName,
    dispatchId,
    leaseId: `l-${dispatchId}`,
    modelDef: {} as never,
    modelType: ModelType.create(modelType),
    modelId: "m-1",
    methodName: "run",
    definitionName: "probe",
    definitionTags: {},
  });
}

function excludedTypes(recorded: RecordingContext): string[] {
  const options = recorded.queryOptions[0] as {
    excludeModelTypes?: string[];
  };
  return options.excludeModelTypes ?? [];
}

Deno.test("queryData: excludes both stored forms of every control-plane type from the query", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext();
  await recordingService(recorded, dispatches).queryData("worker-1", {
    predicate: "isLatest == true",
  });
  const excluded = excludedTypes(recorded);
  for (
    const type of [
      "swamp/grant",
      "@swamp/grant",
      "@swamp/group",
      "swamp/pending-dispatch",
      "@swamp/fleet-probe",
      "swamp/fleet-probe",
    ]
  ) {
    assertEquals(excluded.includes(type), true, type);
  }
});

Deno.test("queryData: a worker cannot replace the control-plane exclusion", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext();
  await recordingService(recorded, dispatches).queryData("worker-1", {
    predicate: "true",
    options: { limit: 5, excludeModelTypes: [] } as never,
  });
  const options = recorded.queryOptions[0] as {
    limit?: number;
    excludeModelTypes: string[];
  };
  assertEquals(options.limit, 5);
  assertEquals(options.excludeModelTypes.includes("@swamp/grant"), true);
});

Deno.test("queryData: rejects a hidden record that got past the exclusion, in any spelling", async () => {
  for (const modelType of ["@swamp/grant", "@@swamp/group", "@Swamp::Worker"]) {
    const dispatches = new DispatchRegistry();
    withDispatch(dispatches);
    const recorded = recordingRepoContext({
      queryResult: [{ id: "1", modelType }],
    });
    await assertRejects(
      () =>
        recordingService(recorded, dispatches).queryData("worker-1", {
          predicate: "true",
        }),
      Error,
      "not permitted from workers",
    );
  }
});

Deno.test("queryData: a fleet-probe dispatch still queries its own records", async () => {
  const dispatches = new DispatchRegistry();
  withTypedDispatch(dispatches, "swamp/fleet-probe");
  const recorded = recordingRepoContext({
    queryResult: [
      { id: "1", modelType: "swamp/fleet-probe" },
      { id: "2", modelType: "@swamp/fleet-probe" },
    ],
  });
  const result = await recordingService(recorded, dispatches).queryData(
    "worker-1",
    { predicate: 'modelType == "swamp/fleet-probe"' },
  );
  assertEquals(result.length, 2);
  const excluded = excludedTypes(recorded);
  assertEquals(excluded.includes("swamp/fleet-probe"), false);
  assertEquals(excluded.includes("@swamp/fleet-probe"), false);
  assertEquals(excluded.includes("@swamp/grant"), true);
});

Deno.test("queryData: without a dispatch registry every control-plane type is excluded", async () => {
  const recorded = recordingRepoContext();
  await recordingService(recorded).queryData("worker-1", { predicate: "true" });
  assertEquals(excludedTypes(recorded).includes("swamp/fleet-probe"), true);
});

Deno.test("readDefinition: a control-plane type reads as not found without touching the repository", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext();
  const service = recordingService(recorded, dispatches);
  for (
    const definitionType of ["@swamp/grant", "swamp/group", "@@swamp/worker"]
  ) {
    assertEquals(
      await service.readDefinition("worker-1", {
        definitionType,
        idOrName: "anything",
      }),
      { found: false, definition: null },
    );
  }
  assertEquals(recorded.definitionReads, []);
  const visible = await service.readDefinition("worker-1", {
    definitionType: "@acme/invoices",
    idOrName: "my-invoice",
  }) as { found: boolean };
  assertEquals(visible.found, true);
  assertEquals(recorded.definitionReads, ["@acme/invoices"]);
});

Deno.test("readOutput: a control-plane type reads as empty in each branch's shape", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext();
  const service = recordingService(recorded, dispatches);
  const definitionId = crypto.randomUUID();
  assertEquals(
    await service.readOutput("worker-1", {
      modelType: "@swamp/grant",
      methodName: "create",
      outputId: crypto.randomUUID(),
    }),
    { result: null },
  );
  assertEquals(
    await service.readOutput("worker-1", {
      modelType: "@swamp/grant",
      definitionId,
      latestOnly: true,
    }),
    { result: null },
  );
  assertEquals(
    await service.readOutput("worker-1", {
      modelType: "@swamp/grant",
      definitionId,
    }),
    { result: [] },
  );
  assertEquals(
    await service.readOutput("worker-1", { modelType: "swamp/group" }),
    { result: [] },
  );
  assertEquals(recorded.outputReads, []);
});

Deno.test("listVersions: a control-plane type lists no versions", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const service = recordingService(recordingRepoContext(), dispatches);
  assertEquals(
    await service.listVersions("worker-1", {
      modelType: "@swamp/grant",
      modelId: "m-1",
      dataName: "grant",
    }),
    [],
  );
  assertEquals(
    await service.listVersions("worker-1", {
      modelType: "@acme/invoices",
      modelId: "m-1",
      dataName: "result",
    }),
    [1, 2],
  );
});

Deno.test("resolveModel: a control-plane record named like a user model does not shadow it", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const grant = {
    definition: { id: "g-1", name: "shared" },
    type: ModelType.create("@swamp/grant"),
  };
  const userModel = {
    definition: { id: "u-1", name: "shared" },
    type: ModelType.create("@acme/invoices"),
  };
  const recorded = recordingRepoContext({
    byNameGlobal: grant,
    allDefinitions: [grant, userModel],
  });
  const result = await recordingService(recorded, dispatches).resolveModel(
    "worker-1",
    { modelIdOrName: "shared" },
  ) as { found: boolean; modelType?: string };
  assertEquals(result.found, true);
  assertEquals(result.modelType, "@acme/invoices");
});

Deno.test("resolveModel: a control-plane record alone resolves as not found", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const grant = {
    definition: { id: "g-1", name: "admins" },
    type: ModelType.create("@swamp/grant"),
  };
  const recorded = recordingRepoContext({
    byNameGlobal: grant,
    allDefinitions: [grant],
  });
  assertEquals(
    await recordingService(recorded, dispatches).resolveModel("worker-1", {
      modelIdOrName: "admins",
    }),
    { found: false },
  );
});

Deno.test("readDefinition: an ambiguous dispatch hides control-plane types instead of failing", async () => {
  const dispatches = new DispatchRegistry();
  withTypedDispatch(dispatches, "swamp/fleet-probe", "d-1");
  withTypedDispatch(dispatches, "swamp/fleet-probe", "d-2");
  const service = recordingService(recordingRepoContext(), dispatches);
  assertEquals(
    await service.readDefinition("worker-1", {
      definitionType: "swamp/fleet-probe",
      idOrName: "probe",
    }),
    { found: false, definition: null },
  );
  const scoped = await service.readDefinition("worker-1", {
    definitionType: "swamp/fleet-probe",
    idOrName: "probe",
    dispatchId: "d-2",
  }) as { found: boolean };
  assertEquals(scoped.found, true);
});
