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
import { computeChecksum } from "../domain/models/checksum.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { VaultExtractionResult } from "../domain/expressions/vault_reference_extractor.ts";
import {
  SENSITIVE_FIELDS_VERSION,
  SENSITIVE_FIELDS_VERSION_TAG,
} from "../domain/models/data_writer.ts";
import { SecretRedactor } from "../domain/secrets/secret_redactor.ts";
import {
  currentVaultAccess,
  RunVaultAccess,
  VaultAccessDeniedError,
} from "../domain/vaults/run_vault_access.ts";
import {
  signalChange,
  type UnscopedChange,
  useUnscopedChangeReporterForTesting,
} from "../infrastructure/persistence/unit_of_work_scope.ts";
import { RpcChannel, RpcError } from "../domain/remote/rpc_channel.ts";
import { SECRET_NOT_FOUND_CODE } from "../domain/vaults/secret_not_found_error.ts";
import { RemoteMethod } from "../domain/remote/protocol.ts";

interface StubQueryOptions {
  limit?: number;
  after?: { key: string };
}

/** honours limit and after the way DataQueryService.queryPage does */
function pagedQuery(
  results: unknown[],
  onCall: (options: unknown) => void = () => {},
) {
  return (_predicate: string, options?: StubQueryOptions) => {
    onCall(options);
    const start = options?.after ? Number(options.after.key) + 1 : 0;
    const limit = options?.limit ?? Infinity;
    const page: unknown[] = [];
    for (let i = start; i < results.length && page.length < limit; i++) {
      page.push(results[i]);
    }
    const lastIndex = start + page.length - 1;
    return Promise.resolve({
      results: page,
      last: page.length > 0
        ? { key: String(lastIndex), id: ["", "", "", "", lastIndex] }
        : undefined,
    });
  };
}

function stubRepoContext(
  queryResult: unknown[] = [],
): RepositoryContext {
  return {
    dataQueryService: {
      query: () => Promise.resolve(queryResult),
      queryPage: pagedQuery(queryResult),
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

Deno.test("registerHandlers: refuses malformed capability params before the verb runs", async () => {
  const workerSide: RpcChannel = new RpcChannel({
    send: (data) =>
      void Promise.resolve().then(() => serveSide.handleRaw(data)),
  });
  const serveSide: RpcChannel = new RpcChannel({
    send: (data) =>
      void Promise.resolve().then(() => workerSide.handleRaw(data)),
  });
  createService().registerHandlers(serveSide, "worker-1");
  await assertRejects(() =>
    workerSide.call(RemoteMethod.getData, { modelType: 1, modelId: 2 })
  );
});

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

function connectWorker(storeError: Error) {
  const service = new CapabilityService({
    repoDir: "/tmp/test",
    repoContext: stubRepoContext(),
    createVaultService: () =>
      Promise.resolve({ get: () => Promise.reject(storeError) } as never),
  });
  const workerSide: RpcChannel = new RpcChannel({
    send: (data) =>
      void Promise.resolve().then(() => serveSide.handleRaw(data)),
  });
  const serveSide: RpcChannel = new RpcChannel({
    send: (data) =>
      void Promise.resolve().then(() => workerSide.handleRaw(data)),
  });
  service.registerHandlers(serveSide, "worker-1");
  return workerSide;
}

Deno.test("resolveSecret: a store's missing key reaches the worker as secret_not_found in swamp's own words", async () => {
  const storeError = Object.assign(
    new Error("[ERROR] 'gone' isn't an item in the 'Private' vault"),
    { code: SECRET_NOT_FOUND_CODE },
  );
  const workerSide = connectWorker(storeError);
  const error = await assertRejects(
    () =>
      workerSide.call(RemoteMethod.resolveSecret, {
        vaultName: "creds",
        secretKey: "gone",
      }),
    RpcError,
  );
  assertEquals(error.code, SECRET_NOT_FOUND_CODE);
  assertEquals(error.message, "Secret 'gone' not found in vault 'creds'");
});

Deno.test("resolveSecret: a store's other failure still reaches the worker as handler_failed", async () => {
  const workerSide = connectWorker(new Error("token expired"));
  const error = await assertRejects(
    () =>
      workerSide.call(RemoteMethod.resolveSecret, {
        vaultName: "creds",
        secretKey: "gone",
      }),
    RpcError,
  );
  assertEquals(error.code, "handler_failed");
  assertEquals(error.message, "token expired");
});

Deno.test("resolveSecret: registers the delivered value with the dispatch redactor (swamp-club#3527)", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [{ vaultName: "default", secretKey: "api-key" }],
    hasDynamicRefs: false,
  });
  const dispatch = dispatches.forDispatch("worker-1", "d-1")!;
  const redactor = new SecretRedactor();
  redactor.addSecret("shipped-value");
  dispatch.redactor = redactor;
  const service = createServiceWithVault(dispatches, {
    "api-key": "learned-value",
  });

  await service.resolveSecret("worker-1", {
    vaultName: "default",
    secretKey: "api-key",
  });

  assertEquals(
    redactor.redact("shipped-value then learned-value"),
    "*** then ***",
  );
});

Deno.test("resolveSecret: creates the dispatch redactor when the step shipped no secrets", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [{ vaultName: "default", secretKey: "api-key" }],
    hasDynamicRefs: false,
  });
  const dispatch = dispatches.forDispatch("worker-1", "d-1")!;
  assertEquals(dispatch.redactor, undefined);
  const service = createServiceWithVault(dispatches, {
    "api-key": "learned-value",
  });

  await service.resolveSecret("worker-1", {
    vaultName: "default",
    secretKey: "api-key",
  });

  assertEquals(
    dispatches.forDispatch("worker-1", "d-1")!.redactor?.redact(
      "got learned-value",
    ),
    "got ***",
  );
});

Deno.test("resolveSecret: an annotation read registers nothing with the dispatch redactor", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, {
    staticRefs: [{ vaultName: "default", secretKey: "api-key" }],
    hasDynamicRefs: false,
  });
  const dispatch = dispatches.forDispatch("worker-1", "d-1")!;
  const service = createServiceWithVault(dispatches, {
    "api-key": "learned-value",
  });

  const result = await service.resolveSecret("worker-1", {
    vaultName: "default",
    secretKey: "api-key",
    annotation: true,
  });

  assertEquals(result.value, null);
  assertEquals(dispatch.redactor, undefined);
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
      queryPage: pagedQuery(
        opts.queryResult ?? [],
        (options) => recorded.queryOptions.push(options),
      ),
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
      findPages: async function* (type: ModelType) {
        recorded.outputReads.push(type.normalized);
        yield* [[{ id: "out-1" }]];
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

function scopeCheckingVault(): CapabilityService {
  const checked = (vault: string, action: "read" | "write") =>
    currentVaultAccess()?.check(
      vault,
      action,
      action === "read" ? "get" : "put",
    ) ?? Promise.resolve();
  return new CapabilityService({
    repoDir: "/tmp/test",
    repoContext: stubRepoContext(),
    dispatches: scopedDispatches(),
    createVaultService: () =>
      Promise.resolve({
        get: async (vault: string) => {
          await checked(vault, "read");
          return "secret";
        },
        getAnnotation: async (vault: string) => {
          await checked(vault, "read");
          return null;
        },
        put: (vault: string) => checked(vault, "write"),
        putAnnotation: (vault: string) => checked(vault, "write"),
        deleteAnnotation: (vault: string) => checked(vault, "write"),
      } as never),
  });
}

function scopedDispatches(): DispatchRegistry {
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
    vaultAccess: RunVaultAccess.create({ allowedVaults: ["roomcontrol"] }),
  });
  return dispatches;
}

const SCOPED_CALLS: {
  name: string;
  call: (s: CapabilityService, vaultName: string) => Promise<unknown>;
}[] = [
  {
    name: "resolveSecret value",
    call: (s, vaultName) =>
      s.resolveSecret("worker-1", { vaultName, secretKey: "k" }),
  },
  {
    name: "resolveSecret annotation",
    call: (s, vaultName) =>
      s.resolveSecret("worker-1", {
        vaultName,
        secretKey: "k",
        annotation: true,
      }),
  },
  {
    name: "putSecret put",
    call: (s, vaultName) =>
      s.putSecret("worker-1", { vaultName, secretKey: "k", secretValue: "v" }),
  },
  {
    name: "putSecret putAnnotation",
    call: (s, vaultName) =>
      s.putSecret("worker-1", {
        vaultName,
        secretKey: "k",
        annotation: {} as never,
      }),
  },
  {
    name: "putSecret deleteAnnotation",
    call: (s, vaultName) =>
      s.putSecret("worker-1", {
        vaultName,
        secretKey: "k",
        deleteAnnotation: true,
      }),
  },
];

for (const { name, call } of SCOPED_CALLS) {
  Deno.test(`CapabilityService: ${name} is held to the dispatching run's vault scope`, async () => {
    const service = scopeCheckingVault();
    await assertRejects(
      () => call(service, "erp"),
      VaultAccessDeniedError,
    );
    await call(service, "roomcontrol");
  });
}

const CLAIM_DISPATCH_TYPE = ModelType.create("acme/invoices");

interface StoredRecord {
  name: string;
  version: number;
  tags: Record<string, string>;
  content: unknown;
  metadata?: {
    name?: string;
    version?: number;
    ownerRef?: string;
    checksum?: string | null;
  };
}

function createServiceWithRecord(
  dispatches: DispatchRegistry,
  record: StoredRecord | null,
  secrets: Record<string, string> = {},
): { service: CapabilityService; lookups: unknown[][] } {
  const lookups: unknown[][] = [];
  const encode = (content: unknown) =>
    new TextEncoder().encode(
      typeof content === "string" ? content : JSON.stringify(content),
    );
  const repoContext = {
    dataQueryService: {
      query: () => Promise.resolve([]),
      querySync: () => [],
    },
    unifiedDataRepo: {
      findByName: async (
        type: ModelType,
        modelId: string,
        name: string,
        version?: number,
      ) => {
        lookups.push([type.normalized, modelId, name, version]);
        const found = record !== null && record.name === name &&
          (version === undefined || version === record.version);
        return found
          ? {
            name: record.metadata?.name ?? name,
            version: record.metadata?.version ?? record.version,
            tags: record.tags,
            checksum: record.metadata?.checksum === null
              ? undefined
              : record.metadata?.checksum ??
                await computeChecksum(encode(record.content)),
            ownerDefinition: {
              ownerType: "model-method",
              ownerRef: record.metadata?.ownerRef ?? modelId,
            },
          }
          : null;
      },
      getContent: (_type: ModelType, _modelId: string, name: string) =>
        Promise.resolve(
          record !== null && record.name === name
            ? encode(record.content)
            : null,
        ),
    },
  } as unknown as RepositoryContext;
  const service = new CapabilityService({
    repoDir: "/tmp/test",
    repoContext,
    dispatches,
    createVaultService: () =>
      Promise.resolve({
        get: (_vault: string, key: string) =>
          key in secrets
            ? Promise.resolve(secrets[key])
            : Promise.reject(new Error(`secret not found: ${key}`)),
        getAnnotation: () => Promise.resolve({ note: "annotated" }),
        put: () => Promise.resolve(),
        putAnnotation: () => Promise.resolve(),
        deleteAnnotation: () => Promise.resolve(),
      } as never),
  });
  return { service, lookups };
}

const TAGGED: StoredRecord = {
  name: "state-main",
  version: 2,
  tags: {
    "_swamp.sensitiveFields": JSON.stringify(["password"]),
    [SENSITIVE_FIELDS_VERSION_TAG]: SENSITIVE_FIELDS_VERSION,
  },
  content: {
    password: "${{ vault.get('default', 'generated-key') }}",
    note: "${{ vault.get('default', 'untagged-key') }}",
  },
};

const EMPTY_ALLOWLIST: VaultExtractionResult = {
  staticRefs: [],
  hasDynamicRefs: false,
};

Deno.test("resolveSecret: a resource claim preserves independently allowlisted reads of legacy or missing records", async () => {
  for (
    const allowedSecrets of [
      undefined,
      { staticRefs: [], hasDynamicRefs: true },
      {
        staticRefs: [{ vaultName: "default", secretKey: "legacy-key" }],
        hasDynamicRefs: false,
      },
    ]
  ) {
    const dispatches = new DispatchRegistry();
    withDispatchAndSecrets(dispatches, allowedSecrets);
    const { service, lookups } = createServiceWithRecord(dispatches, null, {
      "legacy-key": "already-authorized",
    });
    assertEquals(
      await service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "legacy-key",
        resource: { name: "legacy", version: 1 },
      }),
      { value: "already-authorized" },
    );
    assertEquals(lookups, []);
  }
});

Deno.test("resolveSecret: a verified resource claim admits a tagged field's reference the allowlist does not name, looked up under the dispatch's own model", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, EMPTY_ALLOWLIST);
  const { service, lookups } = createServiceWithRecord(dispatches, TAGGED, {
    "generated-key": "s3cret",
  });
  const result = await service.resolveSecret("worker-1", {
    vaultName: "default",
    secretKey: "generated-key",
    resource: { name: "state-main", version: 2 },
  });
  assertEquals(result.value, "s3cret");
  assertEquals(lookups, [[
    CLAIM_DISPATCH_TYPE.normalized,
    "m-1",
    "state-main",
    2,
  ]]);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "generated-key",
      }),
    Error,
    "not referenced by the dispatched step",
  );
});

Deno.test("resolveSecret: a claim is refused for a missing resource, a wrong version, an untagged record, a reference outside the tagged fields, and a non-JSON record", async () => {
  const cases: Array<
    {
      record: StoredRecord | null;
      claim: { name: string; version: number };
      key: string;
      reason: string;
    }
  > = [
    ...[
      { name: "other-resource" },
      { version: 3 },
      { ownerRef: "other-model" },
    ].map((metadata) => ({
      record: { ...TAGGED, metadata },
      claim: { name: "state-main", version: 2 },
      key: "generated-key",
      reason: "the record identity does not match the dispatched behavior",
    })),
    {
      record: null,
      claim: { name: "state-main", version: 2 },
      key: "generated-key",
      reason: "no such resource of the dispatched behavior",
    },
    {
      record: TAGGED,
      claim: { name: "state-main", version: 1 },
      key: "generated-key",
      reason: "no such resource of the dispatched behavior",
    },
    {
      record: { ...TAGGED, tags: {} },
      claim: { name: "state-main", version: 2 },
      key: "generated-key",
      reason: "the record has no sensitive fields",
    },
    {
      record: { ...TAGGED, metadata: { checksum: null } },
      claim: { name: "state-main", version: 2 },
      key: "generated-key",
      reason: "the record has no content checksum",
    },
    {
      record: { ...TAGGED, metadata: { checksum: "0".repeat(64) } },
      claim: { name: "state-main", version: 2 },
      key: "generated-key",
      reason: "the record content does not match its checksum",
    },
    ...[undefined, "0", "2"].map((version) => ({
      record: {
        ...TAGGED,
        tags: {
          "_swamp.sensitiveFields": JSON.stringify(["password"]),
          ...(version === undefined
            ? {}
            : { [SENSITIVE_FIELDS_VERSION_TAG]: version }),
        },
      },
      claim: { name: "state-main", version: 2 },
      key: "generated-key",
      reason: "the record predates verified sensitive-field writes",
    })),
    {
      record: TAGGED,
      claim: { name: "state-main", version: 2 },
      key: "untagged-key",
      reason: "its sensitive fields do not reference it",
    },
    {
      record: { ...TAGGED, content: "not json" },
      claim: { name: "state-main", version: 2 },
      key: "generated-key",
      reason: "the record is not JSON",
    },
    {
      record: { ...TAGGED, content: ["list"] },
      claim: { name: "state-main", version: 2 },
      key: "generated-key",
      reason: "the record is not an object",
    },
  ];
  for (const { record, claim, key, reason } of cases) {
    const dispatches = new DispatchRegistry();
    withDispatchAndSecrets(dispatches, EMPTY_ALLOWLIST);
    const { service } = createServiceWithRecord(dispatches, record, {
      [key]: "value",
    });
    await assertRejects(
      () =>
        service.resolveSecret("worker-1", {
          vaultName: "default",
          secretKey: key,
          resource: claim,
        }),
      Error,
      `resolveSecret: secret '${key}' is not a tagged sensitive field of resource '${claim.name}' (${reason})`,
    );
  }
});

Deno.test("resolveSecret: a claim never admits an annotation read or a denylisted key", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, EMPTY_ALLOWLIST);
  const { service, lookups } = createServiceWithRecord(dispatches, {
    ...TAGGED,
    content: {
      password: "${{ vault.get('default', 'server-token-x') }}",
      note: "n",
    },
  }, { "server-token-x": "token", "generated-key": "s3cret" });
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "server-token-x",
        resource: { name: "state-main", version: 2 },
      }),
    Error,
    "infrastructure secrets are not accessible",
  );
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "generated-key",
        annotation: true,
        resource: { name: "state-main", version: 2 },
      }),
    Error,
    "a resource claim admits a secret value, not an annotation",
  );
  assertEquals(lookups, []);
});

Deno.test("resolveSecret: a record's verified references are read once per dispatch, record and version", async () => {
  const dispatches = new DispatchRegistry();
  withDispatchAndSecrets(dispatches, EMPTY_ALLOWLIST);
  const { service, lookups } = createServiceWithRecord(dispatches, {
    ...TAGGED,
    tags: { ...TAGGED.tags, "_swamp.sensitiveFields": "*" },
    content: {
      password: "${{ vault.get('default', 'generated-key') }}",
      "dotted.key": "${{ vault.get('default', 'dotted-key') }}",
      nested: { deep: "${{ vault.get('default', 'nested-key') }}" },
    },
  }, { "generated-key": "s3cret", "dotted-key": "d0tted", "nested-key": "n" });
  const claim = { name: "state-main", version: 2 };
  const read = (secretKey: string) =>
    service.resolveSecret("worker-1", {
      vaultName: "default",
      secretKey,
      resource: claim,
    });
  assertEquals((await read("generated-key")).value, "s3cret");
  // Under the star tag a dotted top-level key is a location of its own,
  // and a reference nested below a key is not one the writer made.
  assertEquals((await read("dotted-key")).value, "d0tted");
  await assertRejects(
    () => read("nested-key"),
    Error,
    "its sensitive fields do not reference it",
  );
  assertEquals(lookups.length, 1);
  await assertRejects(
    () =>
      service.resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "generated-key",
        resource: { name: "state-main", version: 3 },
      }),
    Error,
    "no such resource of the dispatched behavior",
  );
  assertEquals(lookups.length, 2);
});

Deno.test("resolveSecret: a protocol version 6 dispatch's resource claim is refused before any vault read, while its method's own reads, its annotations and a version 5 dispatch are answered as before (typed-secrets 5.2)", async () => {
  const reads: string[] = [];
  const serviceFor = (protocolVersion: number) => {
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
      // An allowlist that admits everything, so only the version refuses.
      allowedSecrets: { staticRefs: [], hasDynamicRefs: true },
      protocolVersion,
    });
    return new CapabilityService({
      repoDir: "/tmp/test",
      repoContext: stubRepoContext(),
      dispatches,
      createVaultService: () =>
        Promise.resolve({
          get: (_vault: string, key: string) => {
            reads.push(key);
            return Promise.resolve("s3cret");
          },
          getAnnotation: () => Promise.resolve("a note"),
        } as never),
    });
  };

  await assertRejects(
    () =>
      serviceFor(6).resolveSecret("worker-1", {
        vaultName: "default",
        secretKey: "token",
        resource: { name: "state-main", version: 1 },
      }),
    Error,
    "reads a resource's sensitive fields through /data/secrets",
  );
  assertEquals(reads, []);
  assertEquals(
    await serviceFor(6).resolveSecret("worker-1", {
      vaultName: "default",
      secretKey: "token",
    }),
    { value: "s3cret" },
  );
  assertEquals(
    await serviceFor(6).resolveSecret("worker-1", {
      vaultName: "default",
      secretKey: "token",
      annotation: true,
    }),
    { value: "a note" },
  );
  assertEquals(
    await serviceFor(5).resolveSecret("worker-1", {
      vaultName: "default",
      secretKey: "token",
    }),
    { value: "s3cret" },
  );
  assertEquals(reads, ["token", "token"]);
});

function pagedService(
  recorded: RecordingContext,
  dispatches?: DispatchRegistry,
): CapabilityService {
  return new CapabilityService({
    repoDir: "/tmp/test",
    repoContext: recorded.context,
    dispatches,
    createVaultService: () => Promise.reject(new Error("no vault")),
    readPageSize: 2,
  });
}

function records(count: number): unknown[] {
  return Array.from(
    { length: count },
    (_, i) => ({ id: String(i), modelType: "acme/invoices" }),
  );
}

async function collectPages(
  pages: AsyncIterable<unknown[]>,
): Promise<unknown[][]> {
  const collected: unknown[][] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

Deno.test("streamQueryData: pages through the matches sorted by createdAt, each page after the last", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({ queryResult: records(5) });
  const pages = await collectPages(
    pagedService(recorded, dispatches).streamQueryData("worker-1", {
      predicate: "true",
      options: { loadAttributes: true },
    }),
  );
  assertEquals(pages.map((page) => page.length), [2, 2, 1]);
  assertEquals(
    pages.flat().map((r) => (r as { id: string }).id),
    ["0", "1", "2", "3", "4"],
  );
  const calls = recorded.queryOptions as {
    limit: number;
    loadAttributes: boolean;
    sort: { field: string; direction: string };
    after?: { key: string };
    excludeModelTypes: string[];
  }[];
  assertEquals(calls.length, 3);
  assertEquals(calls.map((c) => c.after?.key), [undefined, "1", "3"]);
  for (const call of calls) {
    assertEquals(call.limit, 2);
    assertEquals(call.loadAttributes, true);
    assertEquals(call.sort, { field: "createdAt", direction: "asc" });
    assertEquals(call.excludeModelTypes.includes("@swamp/grant"), true);
  }
});

Deno.test("streamQueryData: a worker limit caps the total across pages", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({ queryResult: records(5) });
  const pages = await collectPages(
    pagedService(recorded, dispatches).streamQueryData(
      "worker-1",
      { predicate: "true", options: { limit: 3 } },
    ),
  );
  assertEquals(pages.flat().length, 3);
  assertEquals(
    (recorded.queryOptions as { limit: number }[]).map((c) => c.limit),
    [2, 1],
  );
});

Deno.test("streamQueryData: a limit of zero or less answers nothing without querying", async () => {
  for (const limit of [0, -1]) {
    const dispatches = new DispatchRegistry();
    withDispatch(dispatches);
    const recorded = recordingRepoContext({ queryResult: records(5) });
    const result = await pagedService(recorded, dispatches).queryData(
      "worker-1",
      { predicate: "true", options: { limit } },
    );
    assertEquals(result, [], `limit ${limit}`);
    assertEquals(recorded.queryOptions, [], `limit ${limit}`);
  }
});

Deno.test("streamQueryData: a fractional limit keeps the unpaged result", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({ queryResult: records(5) });
  const pages = await collectPages(
    pagedService(recorded, dispatches).streamQueryData(
      "worker-1",
      { predicate: "true", options: { limit: 2.5 } },
    ),
  );
  assertEquals(pages.flat().length, 3);
});

Deno.test("streamQueryData: refusals are raised before any query runs", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({ queryResult: records(5) });
  const service = pagedService(recorded, dispatches);
  await assertRejects(
    () =>
      service.streamQueryData("worker-1", {
        predicate: "true",
        options: { select: "name" },
      }).next(),
    Error,
    "Select projections",
  );
  await assertRejects(
    () =>
      service.streamQueryData("worker-1", { predicate: "p".repeat(5000) })
        .next(),
    Error,
    "maximum length",
  );
  await assertRejects(
    () => service.streamQueryData("worker-2", { predicate: "true" }).next(),
    Error,
    "no active dispatch",
  );
  assertEquals(recorded.queryOptions, []);
});

Deno.test("streamQueryData: a dispatch released between pages stops the read before the next query", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({ queryResult: records(5) });
  const pages = pagedService(recorded, dispatches).streamQueryData(
    "worker-1",
    { predicate: "true" },
  );
  assertEquals(((await pages.next()).value as unknown[]).length, 2);
  dispatches.unregister("worker-1", "d-1");
  await assertRejects(() => pages.next(), Error, "dispatch ended");
  assertEquals(recorded.queryOptions.length, 1);
});

Deno.test("streamQueryData: a hidden record on a later page fails that page after the earlier ones were yielded", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({
    queryResult: [...records(2), { id: "g", modelType: "@swamp/grant" }],
  });
  const pages = pagedService(recorded, dispatches).streamQueryData(
    "worker-1",
    { predicate: "true" },
  );
  assertEquals(((await pages.next()).value as unknown[]).length, 2);
  await assertRejects(() => pages.next(), Error, "not permitted from workers");
});

Deno.test("streamQueryData: without a dispatch registry it pages to the end with no liveness check", async () => {
  const recorded = recordingRepoContext({ queryResult: records(5) });
  const pages = await collectPages(
    pagedService(recorded).streamQueryData("worker-1", { predicate: "true" }),
  );
  assertEquals(pages.flat().length, 5);
  assertEquals(recorded.queryOptions.length, 3);
});

function withOutputPages(
  recorded: RecordingContext,
  pages: unknown[][],
): { pageSizes: number[] } {
  const seen = { pageSizes: [] as number[] };
  (recorded.context.outputRepo as unknown as {
    findPages: (
      type: ModelType,
      options: { pageSize: number },
    ) => AsyncGenerator<unknown[]>;
  }).findPages = async function* (type, options) {
    recorded.outputReads.push(type.normalized);
    seen.pageSizes.push(options.pageSize);
    yield* pages;
  };
  return seen;
}

Deno.test("streamOutputList: yields each page of outputs and readOutput collects them", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext();
  const seen = withOutputPages(recorded, [[{ id: "a" }, { id: "b" }], [{
    id: "c",
  }]]);
  const service = pagedService(recorded, dispatches);
  assertEquals(
    await collectPages(
      service.streamOutputList("worker-1", { modelType: "acme/invoices" }),
    ),
    [[{ id: "a" }, { id: "b" }], [{ id: "c" }]],
  );
  assertEquals(
    await service.readOutput("worker-1", { modelType: "acme/invoices" }),
    { result: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  );
  assertEquals(seen.pageSizes, [2, 2]);
});

Deno.test("streamOutputList: a control-plane type yields nothing without reading", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext();
  withOutputPages(recorded, [[{ id: "a" }]]);
  assertEquals(
    await collectPages(
      pagedService(recorded, dispatches).streamOutputList("worker-1", {
        modelType: "@swamp/grant",
      }),
    ),
    [],
  );
  assertEquals(recorded.outputReads, []);
});

Deno.test("streamOutputList: a dispatch released between pages stops the read", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext();
  withOutputPages(recorded, [[{ id: "a" }], [{ id: "b" }]]);
  const pages = pagedService(recorded, dispatches).streamOutputList(
    "worker-1",
    { modelType: "acme/invoices" },
  );
  assertEquals((await pages.next()).value, [{ id: "a" }]);
  dispatches.unregister("worker-1", "d-1");
  await assertRejects(() => pages.next(), Error, "dispatch ended");
});

Deno.test("queryData: the control-socket verb reads the whole reply in one sorted query", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({ queryResult: records(5) });
  const result = await pagedService(recorded, dispatches).queryData(
    "worker-1",
    { predicate: "true" },
  );
  assertEquals(result.length, 5);
  const calls = recorded.queryOptions as {
    limit: number;
    sort: { field: string; direction: string };
  }[];
  assertEquals(calls.length, 1);
  assertEquals(calls[0].limit, Infinity);
  assertEquals(calls[0].sort, { field: "createdAt", direction: "asc" });
});

Deno.test("streamQueryData: a dispatch re-registered under the same id between pages stops the read", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({ queryResult: records(5) });
  const pages = pagedService(recorded, dispatches).streamQueryData(
    "worker-1",
    { predicate: "true" },
  );
  assertEquals(((await pages.next()).value as unknown[]).length, 2);
  dispatches.unregister("worker-1", "d-1");
  withDispatch(dispatches);
  await assertRejects(() => pages.next(), Error, "dispatch ended");
  assertEquals(recorded.queryOptions.length, 1);
});

Deno.test("CapabilityService: a read page size below one pages one record at a time", async () => {
  const dispatches = new DispatchRegistry();
  withDispatch(dispatches);
  const recorded = recordingRepoContext({ queryResult: records(3) });
  const service = new CapabilityService({
    repoDir: "/tmp/test",
    repoContext: recorded.context,
    dispatches,
    createVaultService: () => Promise.reject(new Error("no vault")),
    readPageSize: 0,
  });
  const pages = await collectPages(
    service.streamQueryData("worker-1", { predicate: "true" }),
  );
  assertEquals(pages.map((page) => page.length), [1, 1, 1]);
});
