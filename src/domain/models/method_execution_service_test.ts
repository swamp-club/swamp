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

import { join } from "@std/path";
import {
  MAX_REMOTE_LOCK_IDS,
  processLockHolderMarker,
  type RemoteLockHolder,
  SWAMP_LOCK_HOLDER_TOKENS,
} from "../datastore/lock_holder_marker.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { RunSensitiveValues, SecretRedactor } from "../secrets/mod.ts";
import { SecretDestinationRefusedError } from "./secret_destinations.ts";
import type { OutputRepository } from "./repositories.ts";
import type { SecretDestinationArgs } from "./model.ts";
import { shellModel } from "./command/shell/shell_model.ts";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type LegacyStepDelivery,
  type RemoteStepRequest,
  setRemoteOnlyMode,
  setRemoteStepDispatcher,
} from "../remote/remote_dispatch.ts";
import { fromResourceHandle } from "../data/data_record_mapper.ts";
import { createExtensionCelEnvironment } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  DefaultMethodExecutionService,
  deliverStepSecrets,
  recoveredDataHandles,
} from "./method_execution_service.ts";
import { createDefinitionId, Definition } from "../definitions/definition.ts";
import { ModelType } from "./model_type.ts";
import type {
  DataHandle,
  DataWriter,
  MethodContext,
  MethodDefinition,
  MethodResult,
  ModelDefinition,
} from "./model.ts";
import { modelRegistry } from "./model.ts";
import { z } from "zod";
import { setProcessArgumentParsePolicy } from "../untrusted_parse.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { SOLO_NAMESPACE } from "../data/namespace.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { type DataId, generateDataId } from "../data/data_id.ts";
import { Data } from "../data/data.ts";
import { errorPaths, markErrorPaths, UserError } from "../errors.ts";
import { MALFORMED_TYPE_VERSION_CODE } from "./definition_upgrade_service.ts";
import { getLogger } from "@logtape/logtape";
import { createModelOutputId, type ModelOutput } from "./model_output.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultService } from "../vaults/vault_service.ts";
import { SecretLoader } from "../vaults/secret_loader.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
} from "../vaults/run_vault_access.ts";

/** The reference every secret of these tests stands for. */
const REF = { vaultName: "v", key: "k" };

/**
 * A loader over a mock vault `v` holding `secrets`, as the evaluator's
 * loader reads them at delivery, with the keys each read asked for.
 */
function mockLoader(
  secrets: Record<string, string>,
): { loader: SecretLoader; reads: string[] } {
  const reads: string[] = [];
  const vaultService = new class extends VaultService {
    override get(vaultName: string, key: string, caller?: string) {
      reads.push(key);
      return super.get(vaultName, key, caller);
    }
  }();
  vaultService.registerVault({ name: "v", type: "mock", config: secrets });
  return {
    loader: new SecretLoader(() => Promise.resolve(vaultService)),
    reads,
  };
}

/**
 * Test model that mimics the echo model's write method.
 * Used for testing method execution without depending on deleted models.
 */
const TEST_ECHO_MODEL_TYPE = ModelType.create("test/echo");
const testEchoModel: ModelDefinition = {
  type: TEST_ECHO_MODEL_TYPE,
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string().min(1) }),
  resources: {
    "message": {
      description: "Test echo message",
      schema: z.object({ message: z.string(), timestamp: z.string() }),
      lifetime: "ephemeral",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write a test message",
      arguments: z.object({ message: z.string().min(1) }),
      execute: async (args: Record<string, unknown>, context) => {
        const data = {
          message: args.message as string,
          timestamp: new Date().toISOString(),
        };
        const handle = await context.writeResource!("message", "message", data);
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Stored result from mock data writer.
 */
interface MockWriterResult {
  handle: DataHandle;
  content: Uint8Array;
}

/**
 * Creates mock writeResource and createFileWriter functions that store written content in memory.
 */
function createMockWriters(): {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  createFileWriter: (specName: string, name: string) => DataWriter;
  getResults: () => MockWriterResult[];
} {
  const results: MockWriterResult[] = [];
  const getResults = (): MockWriterResult[] => results;
  let nextId = 1;

  const writeResource = (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle> => {
    const dataId = `mock-data-${nextId++}` as DataId;
    const content = new TextEncoder().encode(JSON.stringify(data));
    const handle: DataHandle = {
      name,
      specName,
      kind: "resource",
      dataId,
      version: 1,
      size: content.length,
      tags: {},
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: {},
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    };
    results.push({ handle, content });
    return Promise.resolve(handle);
  };

  const createFileWriter = (specName: string, name: string): DataWriter => {
    const dataId = `mock-data-${nextId++}` as DataId;

    const buildHandle = (content: Uint8Array): DataHandle => ({
      name,
      specName,
      kind: "file",
      dataId,
      version: 1,
      size: content.length,
      tags: {},
      metadata: {
        contentType: "application/octet-stream",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: {},
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    });

    return {
      dataId,
      name,
      writeAll(content: Uint8Array): Promise<DataHandle> {
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeText(text: string): Promise<DataHandle> {
        const content = new TextEncoder().encode(text);
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeLine(_line: string): Promise<void> {
        return Promise.resolve();
      },
      writeStream(
        _stream: ReadableStream<Uint8Array>,
      ): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      getFilePath(): Promise<string> {
        return Promise.resolve("/tmp/mock");
      },
      finalize(): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
    } as DataWriter;
  };

  return { writeResource, createFileWriter, getResults };
}

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    namespace: SOLO_NAMESPACE,
    findAllGlobal: () => Promise.resolve([]),
    findAllForType: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    iterateForModel: async function* () {
      yield* [];
    },
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    ensureContentLocal: () => Promise.resolve("current" as const),
    isContentAcceptedSync: () => true,
    delete: () => Promise.resolve(),
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({
        version: 1,
        contentPath: "/tmp/mock",
        priorVersions: [],
      }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    findByTaggedName: () => Promise.resolve([]),
    rename: () => {
      throw new Error("not implemented");
    },
    saveDeferred: () =>
      Promise.resolve({
        type: ModelType.create("test"),
        modelId: "",
        dataName: "",
        version: 1,
      }),
    finalizeVersionDeferred: () =>
      Promise.resolve({
        receipt: {
          type: ModelType.create("test"),
          modelId: "",
          dataName: "",
          version: 1,
        },
        size: 0,
        checksum: "",
      }),
    advanceLatestMarkers: () => Promise.resolve(),
    rollbackVersions: () => Promise.resolve(),
  };
}

/**
 * Creates a mock DefinitionRepository for testing.
 */
function createMockDefinitionRepo(): DefinitionRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: () => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createDefinitionId(crypto.randomUUID()),
    getPath: () => "",
  };
}

/**
 * Creates a test MethodContext with mocked repositories.
 */
function createTestContext(
  overrides?: Partial<MethodContext>,
): { context: MethodContext; getResults: () => MockWriterResult[] } {
  const { writeResource, createFileWriter, getResults } = createMockWriters();
  const context: MethodContext = {
    signal: new AbortController().signal,
    repoDir: ".",
    modelType: ModelType.create("swamp/echo"),
    modelId: crypto.randomUUID(),
    globalArgs: {},
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    methodName: "write",
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    writeResource,
    createFileWriter,
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
    createCelEnvironment: createExtensionCelEnvironment,
    ...overrides,
  };
  return { context, getResults };
}

Deno.test("execute with valid definition returns method result", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "Hello, world!" },
    methods: { write: { arguments: { message: "Hello, world!" } } },
  });

  const { context, getResults } = createTestContext();
  const result = await service.execute(
    definition,
    testEchoModel.methods.write,
    context,
  );

  // Echo model now returns data handles
  assertEquals(result.dataHandles?.length, 1);

  // Content is in the mock writer results
  const writerResults = getResults();
  assertEquals(writerResults.length, 1);
  const content = JSON.parse(
    new TextDecoder().decode(writerResults[0].content),
  );
  assertEquals(content.message, "Hello, world!");
  assertEquals(typeof content.timestamp, "string");
});

Deno.test("execute with missing required attribute throws error", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: { write: { arguments: {} } }, // Missing required 'message'
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, testEchoModel.methods.write, context),
    Error,
    "Method arguments validation failed",
  );
});

Deno.test("execute with invalid attribute type throws error", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: 123 },
    methods: { write: { arguments: { message: 123 } } }, // Should be string
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, testEchoModel.methods.write, context),
    Error,
    "Method arguments validation failed",
  );
});

Deno.test("execute with empty message throws error", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "" },
    methods: { write: { arguments: { message: "" } } }, // Empty message fails min(1) validation
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, testEchoModel.methods.write, context),
    Error,
    "Method arguments validation failed",
  );
});

Deno.test("execute error message includes Zod details", async () => {
  const service = new DefaultMethodExecutionService();
  // Pass an empty argument set — missing required 'message' field, no unknown keys.
  // This exercises the Zod validation error path (not the unknown-key path).
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: { write: { arguments: {} } },
  });

  const { context } = createTestContext();
  try {
    await service.execute(definition, testEchoModel.methods.write, context);
    throw new Error("Expected error to be thrown");
  } catch (error) {
    const message = (error as Error).message;
    assertEquals(
      message.startsWith("Method arguments validation failed:"),
      true,
    );
    // Should mention the missing 'message' field
    assertEquals(message.includes("message"), true);
  }
});

Deno.test("readResource is available on context during method execution", async () => {
  const service = new DefaultMethodExecutionService();

  let contextHadReadResource = false;
  const readTestModel: ModelDefinition = {
    type: ModelType.create("test/read"),
    version: "2026.02.09.1",
    globalArguments: z.object({}),
    resources: {
      "item": {
        description: "Test item",
        schema: z.object({ value: z.string() }),
        lifetime: "ephemeral",
        garbageCollection: 10,
      },
    },
    methods: {
      check: {
        description: "Check readResource availability",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          contextHadReadResource = typeof context.readResource === "function";
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: { check: { arguments: {} } },
  });

  const mockReadResource = (
    _instanceName: string,
    _version?: number,
  ): Promise<Record<string, unknown> | null> => Promise.resolve(null);

  const { context } = createTestContext({ readResource: mockReadResource });
  await service.execute(
    definition,
    readTestModel.methods.check,
    context,
  );

  assertEquals(contextHadReadResource, true);
});

// ---------- Workflow Tests ----------

/**
 * Helper to write data via context.writeResource and return a DataHandle.
 */
async function writeTestData(
  context: MethodContext,
  specName: string,
  attributes: Record<string, unknown>,
): Promise<DataHandle> {
  return await context.writeResource!(specName, specName, attributes);
}

/**
 * Creates a test model with configurable behavior for workflow testing.
 * Mock methods use context.writeResource to write data and return dataHandles.
 */
function createTestModel(options: {
  executeImpl?: (
    args: Record<string, unknown>,
    context: MethodContext,
  ) => Promise<MethodResult>;
}): ModelDefinition {
  const schema = z.object({
    counter: z.number().optional(),
    maxIterations: z.number().optional(),
    value: z.string().optional(),
  });

  return {
    type: ModelType.create("test/workflow"),
    version: "2026.02.09.1",
    globalArguments: schema,
    resources: {
      "data": {
        description: "Test data",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
    },
    methods: {
      start: {
        description: "Start method for testing",
        arguments: schema,
        execute: options.executeImpl ??
          (async (_args, context) => {
            const handle = await writeTestData(context, "data", {
              value: "started",
            });
            return { dataHandles: [handle] };
          }),
      },
    },
  };
}

Deno.test(
  "executeWorkflow - basic execution",
  async () => {
    const service = new DefaultMethodExecutionService();
    const model = createTestModel({});

    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { value: "test" },
    });

    const { context } = createTestContext({
      modelType: model.type,
    });
    const result = await service.executeWorkflow(
      definition,
      model,
      "start",
      context,
    );

    assertEquals(result.dataHandles !== undefined, true);
    assertEquals(result.dataHandles!.length >= 1, true);
  },
);

// swamp-club#2422: serve registers the reserved _token-secrets vault in every
// VaultService. It cannot hold user data, so the fail-fast must not count it:
// otherwise the method runs its side effects and only then fails to store the
// sensitive output.
Deno.test("executeWorkflow - fails fast for sensitive output when only a reserved vault is registered", async () => {
  const service = new DefaultMethodExecutionService();
  let ran = false;
  const model: ModelDefinition = {
    type: ModelType.create("test/sensitive-output"),
    version: "2026.02.09.1",
    globalArguments: z.object({}),
    resources: {
      "cred": {
        description: "Credential",
        schema: z.object({ secret: z.string() }),
        lifetime: "infinite",
        garbageCollection: 10,
        sensitiveOutput: true,
      },
    },
    methods: {
      create: {
        description: "Create a credential",
        arguments: z.object({}),
        execute: () => {
          ran = true;
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "_token-secrets",
    type: "mock",
    config: {},
  });
  const { context } = createTestContext({
    modelType: model.type,
    vaultService,
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({ name: "cred-maker", globalArguments: {} }),
        model,
        "create",
        context,
      ),
    UserError,
    'Behavior "cred-maker" has sensitive resource output fields but no vault is configured',
  );
  assertEquals(ran, false);
});

/** A model whose `create` writes a sensitive field kept in `fieldVault`. */
function sensitiveOutputModel(
  fieldVault: string | undefined,
  onRun: () => void,
): ModelDefinition {
  return {
    type: ModelType.create("test/sensitive-scope"),
    version: "2026.02.09.1",
    globalArguments: z.object({}),
    resources: {
      "cred": {
        description: "Credential",
        schema: z.object({
          secret: z.string().meta(
            fieldVault
              ? { sensitive: true, vaultName: fieldVault }
              : { sensitive: true },
          ),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      create: {
        description: "Create a credential",
        arguments: z.object({}),
        execute: () => {
          onRun();
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };
}

function vaultsWith(...names: string[]): VaultService {
  const vaultService = new VaultService();
  for (const name of names) {
    vaultService.registerVault({ name, type: "mock", config: {} });
  }
  return vaultService;
}

/** A policy allowing only the listed vault/action pairs. */
function scopeAllowing(
  allowed: string[],
): RunVaultAccess {
  return RunVaultAccess.create({
    policy: {
      principal: "bot:reporter",
      decide: (vaultName, action) =>
        allowed.includes(`${vaultName}:${action}`)
          ? { allowed: true, reason: "granted" }
          : { allowed: false, reason: "no grant allows it" },
    },
  });
}

Deno.test("executeWorkflow: refuses before running when the scope may not write a sensitive output's vault", async () => {
  const service = new DefaultMethodExecutionService();
  let ran = false;
  const model = sensitiveOutputModel("erp", () => ran = true);
  const vaultService = vaultsWith("outputs", "erp");
  const erpKeysBefore = await vaultService.list("erp");
  const { context } = createTestContext({
    modelType: model.type,
    vaultService,
  });

  const error = await runWithVaultAccess(
    scopeAllowing(["erp:read", "outputs:read", "outputs:write"]),
    () =>
      assertRejects(
        () =>
          service.executeWorkflow(
            Definition.create({ name: "cred-maker", globalArguments: {} }),
            model,
            "create",
            context,
          ),
        UserError,
      ),
  );
  assertStringIncludes(error.message, "vault 'erp'");
  assertStringIncludes(
    error.message,
    "no grant allows it. Change the principal's vault:erp grants",
  );
  assertStringIncludes(error.message, "bot:reporter");
  assertEquals(ran, false);
  assertEquals(await vaultService.list("erp"), erpKeysBefore);
});

Deno.test("executeWorkflow: refuses before running when the scope may not read back a sensitive output's vault", async () => {
  const service = new DefaultMethodExecutionService();
  let ran = false;
  const model = sensitiveOutputModel(undefined, () => ran = true);
  const vaultService = vaultsWith("outputs");
  const { context } = createTestContext({
    modelType: model.type,
    vaultService,
  });

  await runWithVaultAccess(
    scopeAllowing(["outputs:write"]),
    () =>
      assertRejects(
        () =>
          service.executeWorkflow(
            Definition.create({ name: "cred-maker", globalArguments: {} }),
            model,
            "create",
            context,
          ),
        UserError,
        "vault 'outputs'",
      ),
  );
  assertEquals(ran, false);
});

Deno.test("executeWorkflow: a step data output override's vault is decided before running", async () => {
  const service = new DefaultMethodExecutionService();
  let ran = false;
  const model = sensitiveOutputModel(undefined, () => ran = true);
  const vaultService = vaultsWith("outputs", "erp");
  const { context } = createTestContext({
    modelType: model.type,
    vaultService,
    dataOutputOverrides: [{ specName: "cred", vaultName: "erp" }],
  });

  const error = await runWithVaultAccess(
    RunVaultAccess.create({
      allowedVaults: ["outputs"],
      allowListSource: "wf",
    }),
    () =>
      assertRejects(
        () =>
          service.executeWorkflow(
            Definition.create({ name: "cred-maker", globalArguments: {} }),
            model,
            "create",
            context,
          ),
        UserError,
        "vault 'erp'",
      ),
  );
  // A workflow's vaults list refused: the fix is the list, not a grant.
  assertStringIncludes(
    error.message,
    "not in the vaults list of workflow 'wf'. Add 'erp' to the vaults list " +
      "of workflow 'wf', or point the output at a vault that list names.",
  );
  assertEquals(error.message.includes("rant"), false);
  assertEquals(ran, false);
});

Deno.test("executeWorkflow: runs when the scope may read and write every sensitive output vault", async () => {
  const service = new DefaultMethodExecutionService();
  let ran = false;
  const model = sensitiveOutputModel("erp", () => ran = true);
  const { context } = createTestContext({
    modelType: model.type,
    vaultService: vaultsWith("erp"),
  });

  await runWithVaultAccess(
    scopeAllowing(["erp:read", "erp:write"]),
    () =>
      service.executeWorkflow(
        Definition.create({ name: "cred-maker", globalArguments: {} }),
        model,
        "create",
        context,
      ),
  );
  assertEquals(ran, true);
});

/** A model whose `create` writes `secret`, kept under `vaultKey` if set. */
function keyedOutputModel(
  vaultKey: string | undefined,
  onRun: () => void,
): ModelDefinition {
  const model = sensitiveOutputModel(undefined, onRun);
  model.resources!.cred.schema = z.object({
    secret: z.string().meta(
      vaultKey ? { sensitive: true, vaultKey } : { sensitive: true },
    ),
  });
  return model;
}

/** A policy refusing writes to keys starting `deny-`; key-dependent. */
function keyConditionedScope(
  decided: unknown[][],
): RunVaultAccess {
  return RunVaultAccess.create({
    policy: {
      principal: "user:bot",
      decide: (vaultName, action, secretKey, options) => {
        decided.push([vaultName, action, secretKey, options?.keyUnknown]);
        if (options?.keyUnknown) {
          return { allowed: false, undetermined: true, reason: "key" };
        }
        return secretKey?.startsWith("deny-")
          ? { allowed: false, reason: "denied by grant g-key" }
          : { allowed: true, reason: "granted" };
      },
    },
  });
}

Deno.test("executeWorkflow: a field's own vaultKey is decided before running", async () => {
  const service = new DefaultMethodExecutionService();
  let ran = false;
  const model = keyedOutputModel("deny-token", () => ran = true);
  const { context } = createTestContext({
    modelType: model.type,
    vaultService: vaultsWith("outputs"),
  });
  const decided: unknown[][] = [];

  const error = await runWithVaultAccess(
    keyConditionedScope(decided),
    () =>
      assertRejects(
        () =>
          service.executeWorkflow(
            Definition.create({ name: "cred-maker", globalArguments: {} }),
            model,
            "create",
            context,
          ),
        UserError,
        "denied by grant g-key.",
      ),
  );
  assertStringIncludes(error.message, "vault 'outputs'");
  assertEquals(decided, [["outputs", "write", "deny-token", undefined]]);
  assertEquals(ran, false);
});

Deno.test("executeWorkflow: a key-dependent outcome for a generated key is left to the put", async () => {
  const service = new DefaultMethodExecutionService();
  let ran = false;
  const model = keyedOutputModel(undefined, () => ran = true);
  const { context } = createTestContext({
    modelType: model.type,
    vaultService: vaultsWith("outputs"),
  });
  const decided: unknown[][] = [];

  await runWithVaultAccess(
    keyConditionedScope(decided),
    () =>
      service.executeWorkflow(
        Definition.create({ name: "cred-maker", globalArguments: {} }),
        model,
        "create",
        context,
      ),
  );
  assertEquals(decided, [
    ["outputs", "write", undefined, true],
    ["outputs", "read", undefined, true],
  ]);
  assertEquals(ran, true);
});

Deno.test("executeWorkflow: a refusal that already says which grant to add is not followed by more grant advice", async () => {
  const service = new DefaultMethodExecutionService();
  const model = sensitiveOutputModel(undefined, () => {});
  const { context } = createTestContext({
    modelType: model.type,
    vaultService: vaultsWith("outputs"),
  });

  const error = await runWithVaultAccess(
    RunVaultAccess.create({
      policy: {
        principal: "user:bot",
        decide: () => ({
          allowed: false,
          reason:
            "the principal holds vault grants and none allows write on vault:outputs; add a vault:outputs allow grant for write to this principal",
        }),
      },
    }),
    () =>
      assertRejects(
        () =>
          service.executeWorkflow(
            Definition.create({ name: "cred-maker", globalArguments: {} }),
            model,
            "create",
            context,
          ),
        UserError,
      ),
  );
  assertStringIncludes(
    error.message,
    "add a vault:outputs allow grant for write to this principal. Or point " +
      "the output at a vault the principal holds.",
  );
  assertEquals(error.message.includes("Change the principal"), false);
});

Deno.test("executeWorkflow - throws error for unknown method", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { value: "test" },
  });

  const { context } = createTestContext({
    modelType: model.type,
  });

  await assertRejects(
    () => service.executeWorkflow(definition, model, "nonexistent", context),
    Error,
    "Method 'nonexistent' not found in behavior",
  );
});

// ---------- Reserved tag refusal (swamp-club#3635) ----------

const RESERVED_TAG = { "_swamp.sensitiveFields": JSON.stringify(["value"]) };

/** A model whose one method counts its runs, with optional spec tags. */
function reservedTagModel(specTags: {
  resource?: Record<string, string>;
  file?: Record<string, string>;
}): { model: ModelDefinition; runs: () => number } {
  let runs = 0;
  const model: ModelDefinition = {
    type: ModelType.create("test/reserved-tags"),
    version: "1",
    globalArguments: z.object({}),
    resources: {
      out: {
        schema: z.object({ value: z.string() }),
        lifetime: "infinite",
        garbageCollection: 5,
        ...(specTags.resource ? { tags: specTags.resource } : {}),
      },
    },
    files: {
      log: {
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        ...(specTags.file ? { tags: specTags.file } : {}),
      },
    },
    methods: {
      run: {
        description: "Counts its runs",
        arguments: z.object({}),
        execute: () => {
          runs++;
          return Promise.resolve({});
        },
      },
    },
  };
  return { model, runs: () => runs };
}

/** Where a reserved tag enters a run, and how the refusal names it. */
function reservedTagRunSources(tag: Record<string, string>): Array<{
  label: string;
  definitionTags?: Record<string, string>;
  specTags?: {
    resource?: Record<string, string>;
    file?: Record<string, string>;
  };
  context?: Partial<MethodContext>;
  expected: string;
}> {
  return [
    {
      label: "the definition's tags",
      definitionTags: tag,
      expected: "from the behavior definition's tags",
    },
    {
      label: "a resource spec's default tags",
      specTags: { resource: tag },
      expected:
        "from the default tags of resource spec 'out' in behavior type 'test/reserved-tags'",
    },
    {
      label: "a file spec's default tags",
      specTags: { file: tag },
      expected:
        "from the default tags of file spec 'log' in behavior type 'test/reserved-tags'",
    },
    {
      label: "--tag",
      context: { runtimeTags: tag },
      expected: "from --tag",
    },
    {
      label: "the workflow's tags",
      context: { tagOverrides: { workflow: "wf", ...tag } },
      expected: "from the workflow's tags",
    },
    {
      label: "a data output override",
      context: { dataOutputOverrides: [{ specName: "out", tags: tag }] },
      expected: "from the data output override for spec 'out'",
    },
  ];
}

// swamp-club#3684: specName is reserved like a _swamp. key.
for (
  const [key, value] of [
    ["_swamp.sensitiveFields", RESERVED_TAG["_swamp.sensitiveFields"]],
    ["specName", "forged-spec"],
  ]
) {
  for (const source of reservedTagRunSources({ [key]: value })) {
    Deno.test(`executeWorkflow: refuses a reserved ${key} tag from ${source.label} before the method runs`, async () => {
      const service = new DefaultMethodExecutionService();
      const { model, runs } = reservedTagModel(source.specTags ?? {});
      const definition = Definition.create({
        name: "reserved-tags",
        globalArguments: {},
        ...(source.definitionTags ? { tags: source.definitionTags } : {}),
      });
      const { context } = createTestContext({
        modelType: model.type,
        ...source.context,
      });

      const error = await assertRejects(
        () => service.executeWorkflow(definition, model, "run", context),
        Error,
        `Tag '${key}' ${source.expected} is reserved`,
      );
      assertEquals((error as Error).message.includes(value), false);
      assertEquals(runs(), 0);
    });
  }
}

Deno.test("executeWorkflow: runs when no tag source holds a reserved key", async () => {
  const service = new DefaultMethodExecutionService();
  const { model, runs } = reservedTagModel({ resource: { tier: "gold" } });
  const definition = Definition.create({
    name: "reserved-tags",
    globalArguments: {},
    tags: { "swamp.sensitiveFields": "lookalike" },
  });
  const { context } = createTestContext({
    modelType: model.type,
    runtimeTags: { env: "prod" },
    tagOverrides: { workflow: "wf" },
  });

  await service.executeWorkflow(definition, model, "run", context);
  assertEquals(runs(), 1);
});

Deno.test("execute passes logger in context to method", async () => {
  const service = new DefaultMethodExecutionService();
  let capturedLogger: unknown = undefined;

  const schema = z.object({ value: z.string().optional() });
  const model: ModelDefinition = {
    type: ModelType.create("test/logger-check"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Method that captures the logger from context",
        arguments: schema,
        execute: (_args, context) => {
          capturedLogger = context.logger;
          // Verify logger methods are callable (no-op in test env)
          context.logger.trace`trace message`;
          context.logger.debug`debug message`;
          context.logger.info`info message`;
          context.logger.warning`warning message`;
          context.logger.error`error message`;
          context.logger.fatal`fatal message`;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { value: "test" },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.executeWorkflow(definition, model, "run", context);

  assertEquals(capturedLogger !== undefined, true);
  assertEquals(typeof (capturedLogger as { info: unknown }).info, "function");
});

// ---------- globalArguments Fallback Tests ----------

Deno.test("execute: globalArguments provide fallback when method arguments are empty", async () => {
  const service = new DefaultMethodExecutionService();

  let receivedMessage = "";
  const model: ModelDefinition = {
    type: ModelType.create("test/global-fallback"),
    version: "1",
    globalArguments: z.object({ message: z.string().min(1) }),
    resources: {
      "message": {
        description: "Test message",
        schema: z.object({ message: z.string(), timestamp: z.string() }),
        lifetime: "ephemeral",
        garbageCollection: 10,
      },
    },
    methods: {
      write: {
        description: "Write a message",
        arguments: z.object({ message: z.string().min(1) }),
        execute: async (args: Record<string, unknown>, context) => {
          receivedMessage = args.message as string;
          const handle = await context.writeResource!("message", "message", {
            message: args.message,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        },
      },
    },
  };

  // globalArguments has "message" but methods.write.arguments is empty —
  // simulates `swamp model create command/shell my-model --global-arg 'run=echo hello'`
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "from-global" },
    methods: { write: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.execute(
    definition,
    model.methods.write,
    context,
  );

  assertEquals(receivedMessage, "from-global");
  assertEquals(result.dataHandles?.length, 1);
});

Deno.test("execute: per-method arguments override globalArguments", async () => {
  const service = new DefaultMethodExecutionService();

  let receivedMessage = "";
  const model: ModelDefinition = {
    type: ModelType.create("test/method-override"),
    version: "1",
    methods: {
      write: {
        description: "Write a message",
        arguments: z.object({ message: z.string().min(1) }),
        execute: (args: Record<string, unknown>) => {
          receivedMessage = args.message as string;
          return Promise.resolve({});
        },
      },
    },
  };

  // Both globalArguments and method arguments have "message" —
  // per-method should win
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "from-global" },
    methods: { write: { arguments: { message: "from-method" } } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.execute(definition, model.methods.write, context);

  assertEquals(receivedMessage, "from-method");
});

// ---------- Zod Type Coercion Tests ----------

Deno.test("execute coerces string boolean and number args before validation", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    deleteOrphans: z.boolean().default(false),
    maxCount: z.number().optional(),
    name: z.string(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/coercion"),
    version: "1",
    globalArguments: z.object({}),
    methods: {
      run: {
        description: "Test method with boolean and number args",
        arguments: schema,
        execute: (args: Record<string, unknown>) => {
          // Verify the args were coerced to the correct types
          assertEquals(args.deleteOrphans, true);
          assertEquals(args.maxCount, 5);
          assertEquals(args.name, "test");
          return Promise.resolve({});
        },
      },
    },
  };

  // Simulate CLI passing all values as strings
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: {
      run: {
        arguments: {
          deleteOrphans: "true",
          maxCount: "5",
          name: "test",
        },
      },
    },
  });

  const { context } = createTestContext({
    modelType: model.type,
    methodName: "run",
  });
  // Should not throw — coercion converts "true" → true and "5" → 5
  await service.execute(definition, model.methods.run, context);
});

Deno.test("executeWorkflow coerces string globalArguments before validation", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    enabled: z.boolean(),
    port: z.number(),
  });

  let receivedGlobalArgs: Record<string, unknown> = {};

  const model: ModelDefinition = {
    type: ModelType.create("test/global-coercion"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedGlobalArgs = context.globalArgs;
          return Promise.resolve({});
        },
      },
    },
  };

  // Global args come in as strings from CLI
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { enabled: "true", port: "8080" },
  });

  const { context } = createTestContext({ modelType: model.type });
  // Should not throw — coercion converts strings to correct types
  const result = await service.executeWorkflow(
    definition,
    model,
    "run",
    context,
  );
  assertEquals(result !== undefined, true);
  // Verify the method received coerced types, not strings
  assertEquals(receivedGlobalArgs.enabled, true);
  assertEquals(receivedGlobalArgs.port, 8080);
});

// ---------- globalArguments Validation Tests ----------

Deno.test("executeWorkflow - rejects invalid globalArguments after resolution", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    host: z.string(),
    port: z.number(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/global-args-validation"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  // Port is a string instead of a number — should fail validation
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { host: "localhost", port: "not-a-number" },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "run", context),
    Error,
    "Global arguments validation failed",
  );
});

Deno.test("executeWorkflow - passes with valid globalArguments", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    host: z.string(),
    port: z.number(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/global-args-valid"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { host: "localhost", port: 5432 },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "run",
    context,
  );
  // Should succeed without error
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - skips validation when model has no globalArguments schema", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/no-global-args"),
    version: "1",
    // No globalArguments schema
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { anything: "goes" },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "run",
    context,
  );
  // Should succeed without error
  assertEquals(result !== undefined, true);
});

// ---------- Resource Deletion Tracking Tests ----------

/**
 * Creates a mock DataRepo that returns specific data for findAllForModel
 * and iterateForModel.
 */
function createMockDataRepoWithData(
  existingData: Data[],
  contentByName?: Record<string, Uint8Array>,
): UnifiedDataRepository & {
  savedData: Array<{ data: Data; content: Uint8Array }>;
} {
  const savedData: Array<{ data: Data; content: Uint8Array }> = [];
  return {
    ...createMockDataRepo(),
    findAllForModel: () => Promise.resolve(existingData),
    iterateForModel: async function* () {
      yield* existingData;
    },
    save: (
      _type: ModelType,
      _modelId: string,
      data: Data,
      content: Uint8Array,
    ) => {
      savedData.push({ data, content });
      return Promise.resolve({ version: data.version });
    },
    getContent: (
      _type: ModelType,
      _modelId: string,
      name: string,
    ) => Promise.resolve(contentByName?.[name] ?? null),
    savedData,
  };
}

Deno.test("executeWorkflow - delete method writes deletion markers with last known state", async () => {
  const service = new DefaultMethodExecutionService();

  const existingData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    version: 3,
  });

  const activeContent = new TextEncoder().encode(JSON.stringify({
    id: "vol-abc123",
    name: "my-volume",
    region: "us-east-1",
  }));

  const mockRepo = createMockDataRepoWithData([existingData], {
    "my-resource": activeContent,
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/delete-marker"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      delete: {
        description: "Delete the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  const result = await service.executeWorkflow(
    definition,
    model,
    "delete",
    contextWithRepo,
  );

  // Should have saved a deletion marker
  assertEquals(mockRepo.savedData.length, 1);
  const saved = mockRepo.savedData[0];
  assertEquals(saved.data.lifecycle, "deleted");
  assertEquals(saved.data.version, 4); // existingData.version + 1
  assertEquals(saved.data.contentType, "application/json");

  // Marker content should include last known state merged with deletion metadata
  const content = JSON.parse(new TextDecoder().decode(saved.content));
  assertEquals(content.id, "vol-abc123");
  assertEquals(content.name, "my-volume");
  assertEquals(content.region, "us-east-1");
  assertEquals(typeof content.deletedAt, "string");
  assertEquals(content.deletedByMethod, "delete");

  // Result should include deletion marker as a data handle
  assertEquals(result.dataHandles?.length, 1);
  assertEquals(result.dataHandles?.[0].name, "my-resource");
  assertEquals(result.dataHandles?.[0].kind, "resource");
});

Deno.test("executeWorkflow - delete marker gracefully handles missing active content", async () => {
  const service = new DefaultMethodExecutionService();

  const existingData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    version: 3,
  });

  // No content provided — getContent returns null
  const mockRepo = createMockDataRepoWithData([existingData]);

  const model: ModelDefinition = {
    type: ModelType.create("test/delete-no-content"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      delete: {
        description: "Delete the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await service.executeWorkflow(
    definition,
    model,
    "delete",
    contextWithRepo,
  );

  // Should still write a deletion marker with just the metadata
  assertEquals(mockRepo.savedData.length, 1);
  const content = JSON.parse(
    new TextDecoder().decode(mockRepo.savedData[0].content),
  );
  assertEquals(typeof content.deletedAt, "string");
  assertEquals(content.deletedByMethod, "delete");
  // No last known state attributes since content was null
  assertEquals(Object.keys(content).length, 2);
});

Deno.test("executeWorkflow - read after delete throws UserError", async () => {
  const service = new DefaultMethodExecutionService();

  const deletedData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    lifecycle: "deleted",
  });

  const markerContent = new TextEncoder().encode(JSON.stringify({
    deletedAt: "2026-03-06T12:00:00.000Z",
    deletedByMethod: "delete",
  }));

  const mockRepo = {
    ...createMockDataRepo(),
    findAllForModel: () => Promise.resolve([deletedData]),
    iterateForModel: async function* () {
      yield deletedData;
    },
    getContent: () => Promise.resolve(markerContent),
  };

  const model: ModelDefinition = {
    type: ModelType.create("test/read-after-delete"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      get: {
        description: "Get the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await assertRejects(
    () => service.executeWorkflow(definition, model, "get", contextWithRepo),
    UserError,
    "was deleted at 2026-03-06T12:00:00.000Z",
  );
});

Deno.test("executeWorkflow - update after delete throws UserError", async () => {
  const service = new DefaultMethodExecutionService();

  const deletedData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    lifecycle: "deleted",
  });

  const mockRepo = {
    ...createMockDataRepo(),
    findAllForModel: () => Promise.resolve([deletedData]),
    iterateForModel: async function* () {
      yield deletedData;
    },
    getContent: () => Promise.resolve(null),
  };

  const model: ModelDefinition = {
    type: ModelType.create("test/update-after-delete"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      update: {
        description: "Update the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await assertRejects(
    () =>
      service.executeWorkflow(
        definition,
        model,
        "update",
        contextWithRepo,
      ),
    UserError,
    "was deleted at",
  );
});

Deno.test("executeWorkflow - create after delete succeeds (clears deletion state)", async () => {
  const service = new DefaultMethodExecutionService();

  // The create method writes a new resource via writeResource, which defaults to lifecycle: "active"
  // The fast-fail only applies to read/update, not create — so create should succeed
  const model: ModelDefinition = {
    type: ModelType.create("test/create-after-delete"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({ value: z.string() }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      create: {
        description: "Create the resource",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const handle = await context.writeResource!(
            "my-resource",
            "my-resource",
            { value: "new" },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  // Should succeed — create is not blocked by deleted resources
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result.dataHandles !== undefined, true);
  assertEquals(result.dataHandles!.length, 1);
});

Deno.test("executeWorkflow - delete skips already-deleted resources", async () => {
  const service = new DefaultMethodExecutionService();

  // Resource already has lifecycle: deleted
  const alreadyDeleted = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    lifecycle: "deleted",
  });

  const mockRepo = createMockDataRepoWithData([alreadyDeleted]);

  const model: ModelDefinition = {
    type: ModelType.create("test/delete-skip-deleted"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      delete: {
        description: "Delete the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await service.executeWorkflow(
    definition,
    model,
    "delete",
    contextWithRepo,
  );

  // Should NOT have written any new deletion markers
  assertEquals(mockRepo.savedData.length, 0);
});

Deno.test("executeWorkflow - explicit kind overrides name inference for deletion check", async () => {
  const service = new DefaultMethodExecutionService();

  // Method named "remove" but kind: "action" — should NOT trigger deletion markers
  const existingData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
  });

  const mockRepo = createMockDataRepoWithData([existingData]);

  const model: ModelDefinition = {
    type: ModelType.create("test/kind-override"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      remove: {
        description: "Remove (but kind is action, not delete)",
        kind: "action",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await service.executeWorkflow(
    definition,
    model,
    "remove",
    contextWithRepo,
  );

  // kind: "action" should NOT trigger deletion markers
  assertEquals(mockRepo.savedData.length, 0);
});

Deno.test("executeWorkflow - read succeeds when old data is deleted but current resource data is active", async () => {
  const service = new DefaultMethodExecutionService();

  // Old historical data entry (no specName tag) that was deleted — should NOT block
  const oldDeletedData = Data.create({
    name: "old-vpc-id-123",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    lifecycle: "deleted",
  });

  // Current active resource data with specName tag
  const activeData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
  });

  const mockRepo = {
    ...createMockDataRepo(),
    findAllForModel: () => Promise.resolve([oldDeletedData, activeData]),
    iterateForModel: async function* () {
      yield* [oldDeletedData, activeData];
    },
    getContent: () => Promise.resolve(null),
  };

  const model: ModelDefinition = {
    type: ModelType.create("test/read-mixed-data"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      get: {
        description: "Get the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  // Should succeed — old deleted data without specName should not block read
  const result = await service.executeWorkflow(
    definition,
    model,
    "get",
    contextWithRepo,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - deletion markers only written for declared resource data, not untagged data", async () => {
  const service = new DefaultMethodExecutionService();

  // Declared resource data with specName tag — should get a deletion marker
  const resourceData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    version: 3,
  });

  // Untagged data (no specName) — should NOT get a deletion marker
  const untaggedData = Data.create({
    name: "some-old-data",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    version: 2,
  });

  const mockRepo = createMockDataRepoWithData([resourceData, untaggedData], {
    "my-resource": new TextEncoder().encode(JSON.stringify({ id: "res-1" })),
    "some-old-data": new TextEncoder().encode(JSON.stringify({ id: "old-1" })),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/delete-scoped-markers"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      delete: {
        description: "Delete the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await service.executeWorkflow(
    definition,
    model,
    "delete",
    contextWithRepo,
  );

  // Only the declared resource data should get a deletion marker
  assertEquals(mockRepo.savedData.length, 1);
  assertEquals(mockRepo.savedData[0].data.name, "my-resource");
  assertEquals(mockRepo.savedData[0].data.lifecycle, "deleted");
});

Deno.test("executeWorkflow - read blocked when all declared resource data is deleted", async () => {
  const service = new DefaultMethodExecutionService();

  // All declared resource data is deleted
  const deletedResource = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    lifecycle: "deleted",
  });

  const markerContent = new TextEncoder().encode(JSON.stringify({
    deletedAt: "2026-03-07T10:00:00.000Z",
    deletedByMethod: "delete",
  }));

  const mockRepo = {
    ...createMockDataRepo(),
    findAllForModel: () => Promise.resolve([deletedResource]),
    iterateForModel: async function* () {
      yield deletedResource;
    },
    getContent: () => Promise.resolve(markerContent),
  };

  const model: ModelDefinition = {
    type: ModelType.create("test/read-all-deleted"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      get: {
        description: "Get the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  // Should throw — all declared resource data is deleted
  await assertRejects(
    () => service.executeWorkflow(definition, model, "get", contextWithRepo),
    UserError,
    "was deleted at 2026-03-07T10:00:00.000Z",
  );
});

/** Declared resource data named `name`, deleted when `deleted` is set. */
function resourceData(name: string, deleted = false): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "my-resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    ...(deleted ? { lifecycle: "deleted" as const } : {}),
  });
}

/**
 * A repository serving `data` lazily that counts the items the
 * deleted-resource check pulls, and refuses the whole-model read.
 */
function createCountingDataRepo(data: Data[]) {
  const pulled = { count: 0 };
  const repo: UnifiedDataRepository = {
    ...createMockDataRepo(),
    findAllForModel: () => {
      throw new Error("findAllForModel must not be called");
    },
    iterateForModel: async function* () {
      for (const item of data) {
        pulled.count++;
        yield item;
      }
    },
    getContent: () => Promise.resolve(null),
  };
  return { repo, pulled };
}

function createUpdateModel(): ModelDefinition {
  return {
    type: ModelType.create("test/update-many-resources"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      touch: {
        description: "Update the resource",
        kind: "update",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };
}

Deno.test("executeWorkflow - deleted-resource check stops at the first live resource (swamp-club#3755)", async () => {
  const service = new DefaultMethodExecutionService();
  const data = Array.from(
    { length: 1000 },
    (_, i) => resourceData(`lease-${i}`),
  );
  const { repo, pulled } = createCountingDataRepo(data);
  const { context } = createTestContext({
    modelType: ModelType.create("test/update-many-resources"),
  });

  await service.executeWorkflow(
    Definition.create({ name: "test-definition", globalArguments: {} }),
    createUpdateModel(),
    "touch",
    { ...context, dataRepository: repo },
  );

  assertEquals(pulled.count, 1);
});

Deno.test("executeWorkflow - update passes when only the last declared resource is live", async () => {
  const service = new DefaultMethodExecutionService();
  const { repo, pulled } = createCountingDataRepo([
    resourceData("first", true),
    resourceData("second", true),
    resourceData("third"),
  ]);
  const { context } = createTestContext({
    modelType: ModelType.create("test/update-many-resources"),
  });

  await service.executeWorkflow(
    Definition.create({ name: "test-definition", globalArguments: {} }),
    createUpdateModel(),
    "touch",
    { ...context, dataRepository: repo },
  );

  assertEquals(pulled.count, 3);
});

Deno.test("executeWorkflow - update after every resource is deleted names the first deleted one", async () => {
  const service = new DefaultMethodExecutionService();
  const { repo } = createCountingDataRepo([
    resourceData("first", true),
    resourceData("second", true),
  ]);
  const { context } = createTestContext({
    modelType: ModelType.create("test/update-many-resources"),
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({ name: "test-definition", globalArguments: {} }),
        createUpdateModel(),
        "touch",
        { ...context, dataRepository: repo },
      ),
    UserError,
    "Resource 'first' was deleted at unknown",
  );
});

// ---------- Unresolved Expression Tests ----------

Deno.test("execute - Proxy throws for an unresolved swamp expression in globalArgs", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/unresolved-expr"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          // Access the unresolved field — should throw
          const _val = context.globalArgs.ssh_keys;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      ssh_keys:
        '${{ string(model["test-ssh-key"].resource.state.key.attributes.id) }}',
    },
    methods: { run: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.execute(definition, model.methods.run, context),
    Error,
    "Unresolved expression in globalArguments.ssh_keys",
  );
});

/** A run that could not read the `ticket` field's vault (swamp-club#3806). */
function unreadTicket(): { unread: RunSensitiveValues; reference: string } {
  const key = crypto.randomUUID();
  const reference = `\${{ vault.get('infra', '${key}') }}`;
  const unread = new RunSensitiveValues();
  unread.recordUnread({
    vaultName: "infra",
    key,
    text: reference,
    fieldPath: "ticket",
    reason: "op: command not found",
  });
  return { unread, reference };
}

/** A model whose `run` method reads `globalArgs.ticket` when `read` is set. */
function ticketModel(calls: unknown[]): ModelDefinition {
  return {
    type: ModelType.create("test/unread-ticket"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({
          read: z.boolean().optional(),
          token: z.string().optional(),
        }),
        execute: (args: { read?: boolean; token?: string }, context) => {
          calls.push(args.read ? context.globalArgs.ticket : args.token);
          return Promise.resolve({});
        },
      },
    },
  };
}

Deno.test("executeWorkflow - a global argument holding an unreadable stored reference fails naming the vault read (swamp-club#3806)", async () => {
  const service = new DefaultMethodExecutionService();
  const { unread, reference } = unreadTicket();
  const calls: unknown[] = [];
  const model = ticketModel(calls);
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { ticket: reference },
    methods: { run: { arguments: { read: true } } },
  });
  const { context } = createTestContext({ modelType: model.type });

  const error = await assertRejects(
    () =>
      service.executeWorkflow(definition, model, "run", context, {
        unreadReferences: unread,
      }),
    Error,
    "Could not read globalArguments.ticket",
  );
  assertStringIncludes(error.message, "vault 'infra'");
  assertStringIncludes(error.message, "op: command not found");
  assertEquals(error.message.includes("Unresolved expression"), false);
  assertEquals(calls, []);
});

Deno.test("executeWorkflow - a method that never reads the unreadable global argument still runs (swamp-club#3806)", async () => {
  const service = new DefaultMethodExecutionService();
  const { unread, reference } = unreadTicket();
  const calls: unknown[] = [];
  const model = ticketModel(calls);
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { ticket: reference },
    methods: { run: { arguments: { token: "plain" } } },
  });
  const { context } = createTestContext({ modelType: model.type });

  await service.executeWorkflow(definition, model, "run", context, {
    unreadReferences: unread,
  });
  assertEquals(calls, ["plain"]);
});

Deno.test("executeWorkflow - a method argument holding an unreadable stored reference fails before the method runs (swamp-club#3806)", async () => {
  const service = new DefaultMethodExecutionService();
  const { unread, reference } = unreadTicket();
  const calls: unknown[] = [];
  const model = ticketModel(calls);
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: { run: { arguments: { token: `Bearer ${reference}` } } },
  });
  const { context } = createTestContext({ modelType: model.type });

  const error = await assertRejects(
    () =>
      service.executeWorkflow(definition, model, "run", context, {
        unreadReferences: unread,
      }),
    Error,
    "Could not read methodArguments.token",
  );
  assertStringIncludes(error.message, "op: command not found");
  assertEquals(calls, []);
});

Deno.test("executeWorkflow - without the run's record an unreadable stored reference keeps the unresolved-expression error (swamp-club#3806)", async () => {
  const service = new DefaultMethodExecutionService();
  const { reference } = unreadTicket();
  const calls: unknown[] = [];
  const model = ticketModel(calls);
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { ticket: reference },
    methods: { run: { arguments: { read: true } } },
  });
  const { context } = createTestContext({ modelType: model.type });

  await assertRejects(
    () => service.executeWorkflow(definition, model, "run", context),
    Error,
    "Unresolved expression in globalArguments.ticket",
  );
});

Deno.test("execute - another templating system's ${{ }} text in globalArgs reaches the method as written (swamp-club#2491)", async () => {
  const service = new DefaultMethodExecutionService();

  let fromGlobalArgs: unknown;
  let fromArgs: unknown;
  const model: ModelDefinition = {
    type: ModelType.create("test/foreign-template-text"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({ message: z.string() }),
        execute: (args: Record<string, unknown>, context) => {
          fromArgs = args.message;
          fromGlobalArgs = context.globalArgs.message;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "deploy ${{ github.sha }}" },
    methods: { run: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.execute(definition, model.methods.run, context);
  assertEquals(fromGlobalArgs, "deploy ${{ github.sha }}");
  assertEquals(fromArgs, "deploy ${{ github.sha }}");
});

Deno.test("execute - Proxy still throws for text it cannot tell apart from swamp's", async () => {
  const cases = {
    // GitHub Actions text in a namespace swamp also owns.
    version: "${{ inputs.version }}",
    // A swamp expression with a }} inside its string literal.
    label: '${{ "a}}" + inputs.x }}',
    // A swamp input read with a computed key.
    region: "${{ inputs[env.STAGE] }}",
  };
  for (const [field, value] of Object.entries(cases)) {
    const service = new DefaultMethodExecutionService();
    const model: ModelDefinition = {
      type: ModelType.create("test/ambiguous-template-text"),
      version: "1",
      methods: {
        run: {
          description: "Test method",
          arguments: z.object({}),
          execute: (_args: Record<string, unknown>, context) => {
            const _val = context.globalArgs[field];
            return Promise.resolve({});
          },
        },
      },
    };
    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { [field]: value },
      methods: { run: { arguments: {} } },
    });

    const { context } = createTestContext({ modelType: model.type });
    await assertRejects(
      () => service.execute(definition, model.methods.run, context),
      Error,
      `Unresolved expression in globalArguments.${field}`,
    );
  }
});

Deno.test("execute - Proxy allows access to resolved globalArgs fields", async () => {
  const service = new DefaultMethodExecutionService();

  let receivedName = "";
  const model: ModelDefinition = {
    type: ModelType.create("test/resolved-expr"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedName = context.globalArgs.name as string;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      ssh_keys:
        '${{ string(model["test-ssh-key"].resource.state.key.attributes.id) }}',
    },
    methods: { run: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.execute(definition, model.methods.run, context);
  assertEquals(receivedName, "my-server");
});

Deno.test("executeWorkflow - skips validation for globalArgs with unresolved model resource expressions", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    name: z.string(),
    ssh_keys: z.array(z.string()),
  });

  let receivedName = "";
  const model: ModelDefinition = {
    type: ModelType.create("test/unresolved-resource-expr"),
    version: "1",
    globalArguments: schema,
    methods: {
      update: {
        description: "Update method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedName = context.globalArgs.name as string;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      ssh_keys:
        '${{ [string(model["test-ssh-key"].resource.state.key.attributes.id)] }}',
    },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "update",
    context,
  );
  assertEquals(result !== undefined, true);
  assertEquals(receivedName, "my-server");
});

// ---------- Pre-flight Check Tests ----------

function createCheckModel(
  checks: Record<
    string,
    {
      description: string;
      labels?: string[];
      appliesTo?: string[];
      execute: (
        context: MethodContext,
      ) => Promise<{ pass: boolean; errors?: string[] }>;
    }
  >,
): ModelDefinition {
  return {
    type: ModelType.create("test/check-model"),
    version: "1",
    methods: {
      create: {
        description: "Create resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
      delete: {
        description: "Delete resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
      get: {
        description: "Get resource",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
      list: {
        description: "List resources",
        kind: "list",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    checks,
  };
}

Deno.test("executeWorkflow - checks pass, method executes", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "valid-check": {
      description: "Always passes",
      execute: () => Promise.resolve({ pass: true }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - check fails, UserError thrown", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "bad-check": {
      description: "Always fails",
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Something is wrong"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
    "bad-check",
  );
});

Deno.test("executeWorkflow - multiple checks, all failures collected", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "check-a": {
      description: "Fails with error A",
      execute: () => Promise.resolve({ pass: false, errors: ["Error A"] }),
    },
    "check-b": {
      description: "Passes",
      execute: () => Promise.resolve({ pass: true }),
    },
    "check-c": {
      description: "Fails with error C",
      execute: () => Promise.resolve({ pass: false, errors: ["Error C"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  try {
    await service.executeWorkflow(definition, model, "create", context);
    throw new Error("Expected UserError");
  } catch (error) {
    assertEquals(error instanceof UserError, true);
    const msg = (error as UserError).message;
    assertEquals(msg.includes("check-a"), true);
    assertEquals(msg.includes("Error A"), true);
    assertEquals(msg.includes("check-c"), true);
    assertEquals(msg.includes("Error C"), true);
  }
});

Deno.test("executeWorkflow - read method skips checks", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "should-not-run": {
      description: "Should not run for read",
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Should not run"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "get",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - list method skips checks", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "should-not-run": {
      description: "Should not run for list",
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Should not run"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "list",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - skipAllChecks bypasses all checks", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "failing-check": {
      description: "Fails",
      execute: () => Promise.resolve({ pass: false, errors: ["Fail"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({
    modelType: model.type,
    skipAllChecks: true,
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - skipCheckNames skips named check", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "skip-me": {
      description: "Should be skipped",
      execute: () => Promise.resolve({ pass: false, errors: ["Fail"] }),
    },
    "run-me": {
      description: "Should run and pass",
      execute: () => Promise.resolve({ pass: true }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({
    modelType: model.type,
    skipCheckNames: ["skip-me"],
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - skipCheckLabels skips checks with matching label", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "slow-check": {
      description: "Slow check",
      labels: ["slow", "api"],
      execute: () => Promise.resolve({ pass: false, errors: ["Fail"] }),
    },
    "fast-check": {
      description: "Fast check",
      labels: ["offline"],
      execute: () => Promise.resolve({ pass: true }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({
    modelType: model.type,
    skipCheckLabels: ["slow"],
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - appliesTo filters check by method name", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "create-only": {
      description: "Only applies to create",
      appliesTo: ["create"],
      execute: () => Promise.resolve({ pass: false, errors: ["Fail"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  // Should not run for delete
  const { context: deleteCtx } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "delete",
    deleteCtx,
  );
  assertEquals(result !== undefined, true);

  // Should run and fail for create
  const { context: createCtx } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", createCtx),
    UserError,
    "create-only",
  );
});

Deno.test("executeWorkflow - no checks defined, method executes normally", async () => {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    type: ModelType.create("test/no-checks"),
    version: "1",
    methods: {
      create: {
        description: "Create",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - check throws exception, treated as failure", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "throwing-check": {
      description: "Throws an exception",
      execute: () => {
        throw new Error("Unexpected API error");
      },
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
    "Unexpected API error",
  );
});

// ---------- Definition-Level Check Selection Tests ----------

Deno.test("executeWorkflow - required check is immune to skipAllChecks", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "required-check": {
      description: "Must run",
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Required failed"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    checks: { require: ["required-check"] },
  });
  const { context } = createTestContext({
    modelType: model.type,
    skipAllChecks: true,
  });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
    "required-check",
  );
});

Deno.test("executeWorkflow - required check is immune to skipCheckNames", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "required-check": {
      description: "Must run",
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Required failed"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    checks: { require: ["required-check"] },
  });
  const { context } = createTestContext({
    modelType: model.type,
    skipCheckNames: ["required-check"],
  });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
    "required-check",
  );
});

Deno.test("executeWorkflow - definition-level skip always wins", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "skipped-check": {
      description: "Definition says skip",
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Should not run"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    checks: { skip: ["skipped-check"] },
  });
  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - definition-level skip wins over require", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "conflicted-check": {
      description: "Both required and skipped",
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Should not run"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    checks: { require: ["conflicted-check"], skip: ["conflicted-check"] },
  });
  const { context } = createTestContext({ modelType: model.type });
  // Skip wins, so check should not run, method should succeed
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - required check still respects appliesTo", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "create-only-required": {
      description: "Only applies to create",
      appliesTo: ["create"],
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Create check failed"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    checks: { require: ["create-only-required"] },
  });

  // Should not run for delete even though required
  const { context: deleteCtx } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "delete",
    deleteCtx,
  );
  assertEquals(result !== undefined, true);

  // Should run and fail for create
  const { context: createCtx } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", createCtx),
    UserError,
    "create-only-required",
  );
});

Deno.test("executeWorkflow - check returning invalid result treated as failure", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "bad-check": {
      description: "Returns garbage",
      execute: () => Promise.resolve(undefined as unknown as { pass: boolean }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
    "invalid result",
  );
});

Deno.test(
  "executeWorkflow: upgrade persists original vault expressions, not sentinel tokens",
  async () => {
    const service = new DefaultMethodExecutionService();

    // Model at version 2 with an upgrade from version 1
    const model: ModelDefinition = {
      type: ModelType.create("test/vault-upgrade"),
      version: "2026.04.12.2",
      globalArguments: z.object({ apiKey: z.string() }),
      resources: {
        status: {
          description: "Status",
          schema: z.object({ ok: z.boolean() }),
          lifetime: "infinite",
          garbageCollection: 5,
        },
      },
      methods: {
        check: {
          description: "Check",
          arguments: z.object({}),
          execute: async (_args, context) => {
            const handle = await context.writeResource!(
              "status",
              "main",
              { ok: true },
            );
            return { dataHandles: [handle] };
          },
        },
      },
      upgrades: [
        {
          toVersion: "2026.04.12.2",
          description: "No-op upgrade",
          upgradeAttributes: (old) => old,
        },
      ],
    };

    const vaultExpression = '${{ vault.get("myvault", "my-api-key") }}';

    // Simulate post-runtime-resolution: the in-memory definition has sentinel
    // tokens in place of vault expressions (as happens in run.ts after
    // resolveRuntimeExpressionsInDefinition).
    const secretBag = new VaultSecretBag(new SecretBagRegistry());
    const sentinel = secretBag.addSecret(
      { vaultName: "v", key: "my-api-key" },
      "globalArguments.apiKey",
    );

    const definition = Definition.create({
      name: "test-vault-def",
      type: "test/vault-upgrade",
      typeVersion: "2026.04.12.1",
      globalArguments: { apiKey: sentinel },
    });

    // The "on-disk" definition has the original vault expression.
    const originalDefinition = Definition.create({
      id: definition.id,
      name: "test-vault-def",
      type: "test/vault-upgrade",
      typeVersion: "2026.04.12.1",
      globalArguments: { apiKey: vaultExpression },
    });

    // Track what gets saved to the definition repository.
    let savedDefinition: Definition | null = null;
    const mockDefRepo: DefinitionRepository = {
      ...createMockDefinitionRepo(),
      findById: () => Promise.resolve(originalDefinition),
      save: (_type, def) => {
        savedDefinition = def;
        return Promise.resolve();
      },
    };

    const { context } = createTestContext({
      modelType: model.type,
      definitionRepository: mockDefRepo,
      vaultSecrets: secretBag,
    });

    await service.executeWorkflow(definition, model, "check", context, {
      secretLoader: mockLoader({ "my-api-key": "sk-test-secret-12345" })
        .loader,
    });

    // The persisted definition must have the original vault expression,
    // not the sentinel token.
    assertEquals(savedDefinition !== null, true);
    const saved = savedDefinition as unknown as Definition;
    assertEquals(saved.globalArguments.apiKey, vaultExpression);
    assertEquals(saved.typeVersion, "2026.04.12.2");
  },
);

// ---------- Unknown method input key rejection ----------

Deno.test("execute - accepts known method input key", async () => {
  const service = new DefaultMethodExecutionService();

  let received: Record<string, unknown> = {};
  const model: ModelDefinition = {
    type: ModelType.create("test/strict-inputs"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({ count: z.number() }),
        execute: (args) => {
          received = args as Record<string, unknown>;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: { run: { arguments: { count: "5" } } },
  });

  const { context } = createTestContext({
    modelType: model.type,
    methodName: "run",
  });

  await service.execute(definition, model.methods.run, context);
  assertEquals(received.count, 5);
});

Deno.test("executeWorkflow - rejects unknown global arg key", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/strict-global"),
    version: "1",
    globalArguments: z.object({ name: z.string() }),
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { name: "hello", unknownKey: "oops" },
  });

  const { context } = createTestContext({ modelType: model.type });

  await assertRejects(
    () => service.executeWorkflow(definition, model, "run", context),
    Error,
    "Global arguments validation failed",
  );
});

Deno.test("executeWorkflow - passes with required globalArgs schema when definition has empty globalArgs", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/required-globals-exec"),
    version: "1",
    globalArguments: z.object({
      Bucket: z.string(),
      PolicyDocument: z.string(),
    }),
    methods: {
      get: {
        description: "Get resource",
        arguments: z.object({ identifier: z.string() }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };

  const definition = Definition.create({
    name: "policy-lookup",
    globalArguments: {},
    methods: { get: { arguments: { identifier: "my-bucket" } } },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "get",
    context,
  );
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - still rejects invalid types on provided globalArgs", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/typed-globals-exec"),
    version: "1",
    globalArguments: z.object({ region: z.string(), count: z.number() }),
    methods: {
      run: {
        description: "Run",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-typed",
    globalArguments: { region: 12345 },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "run", context),
    Error,
    "Global arguments validation failed",
  );
});

// ---------- Nested Unresolved Expression Tests ----------

Deno.test("execute - Proxy throws for nested unresolved expression in globalArgs object", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/nested-unresolved"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          const _val = context.globalArgs.config;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      config: {
        nested_key:
          '${{ data.latest("other-model", "state").attributes.value }}',
      },
    },
    methods: { run: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.execute(definition, model.methods.run, context),
    Error,
    "Unresolved expression in globalArguments.config",
  );
});

Deno.test("execute - Proxy throws for unresolved expression in nested array", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/nested-array-unresolved"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          const _val = context.globalArgs.ssh_keys;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      ssh_keys: [
        '${{ data.latest("my-key", "state").attributes.fingerprint }}',
      ],
    },
    methods: { run: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.execute(definition, model.methods.run, context),
    Error,
    "Unresolved expression in globalArguments.ssh_keys",
  );
});

Deno.test("execute - Proxy allows access to fully resolved nested object", async () => {
  const service = new DefaultMethodExecutionService();

  let receivedConfig: Record<string, unknown> = {};
  const model: ModelDefinition = {
    type: ModelType.create("test/nested-resolved"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedConfig = context.globalArgs.config as Record<string, unknown>;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      config: {
        region: "us-east-1",
        keys: ["key-1", "key-2"],
      },
    },
    methods: { run: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.execute(definition, model.methods.run, context);
  assertEquals(receivedConfig.region, "us-east-1");
  assertEquals((receivedConfig.keys as string[])[0], "key-1");
});

Deno.test("executeWorkflow - detects nested unresolved expressions in globalArgs validation", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    name: z.string(),
    config: z.object({
      region: z.string(),
    }),
  });

  let receivedName = "";
  const model: ModelDefinition = {
    type: ModelType.create("test/nested-unresolved-validation"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedName = context.globalArgs.name as string;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      config: {
        region: "${{ inputs.region }}",
      },
    },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "run",
    context,
  );
  assertEquals(result !== undefined, true);
  assertEquals(receivedName, "my-server");
});

Deno.test("executeWorkflow - validates globalArgs holding another templating system's ${{ }} text (swamp-club#2491)", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/foreign-template-validation"),
    version: "1",
    globalArguments: z.object({ message: z.string(), count: z.number() }),
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  // The foreign text no longer counts as unresolved, so the whole set is
  // schema-checked and the bad count is caught.
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "deploy ${{ github.sha }}", count: "many" },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "run", context),
    Error,
    "Global arguments validation failed",
  );
});

Deno.test("executeWorkflow: check receives unresolvedMethodArgs with method arguments", async () => {
  const service = new DefaultMethodExecutionService();

  let capturedArgs: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    type: ModelType.create("test/check-args"),
    version: "1",
    methods: {
      forward: {
        description: "Forward ports",
        arguments: z.object({ spec: z.string() }),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "spec-valid": {
        description: "Validates spec arg is present",
        appliesTo: ["forward"],
        execute: (context: MethodContext) => {
          capturedArgs = context.unresolvedMethodArgs;
          if (!context.unresolvedMethodArgs?.spec) {
            return Promise.resolve({
              pass: false,
              errors: ["forward requires a `spec` argument"],
            });
          }
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-forward",
    globalArguments: {},
    methods: {
      forward: { arguments: { spec: "19090:localhost:22" } },
    },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "forward",
    context,
  );

  assertEquals(result !== undefined, true);
  assertEquals(capturedArgs?.spec, "19090:localhost:22");
});

Deno.test("executeWorkflow: check unresolvedMethodArgs merges global and method args, method wins", async () => {
  const service = new DefaultMethodExecutionService();

  let capturedArgs: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    type: ModelType.create("test/check-merge"),
    version: "1",
    globalArguments: z.object({
      region: z.string().optional(),
      timeout: z.number().optional(),
    }),
    methods: {
      create: {
        description: "Create resource",
        arguments: z.object({
          region: z.string().optional(),
          name: z.string().optional(),
        }),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "capture-args": {
        description: "Captures unresolvedMethodArgs",
        appliesTo: ["create"],
        execute: (context: MethodContext) => {
          capturedArgs = context.unresolvedMethodArgs;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-merge",
    globalArguments: { region: "us-east-1", timeout: 30 },
    methods: {
      create: { arguments: { region: "eu-west-1", name: "my-resource" } },
    },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.executeWorkflow(definition, model, "create", context);

  assertEquals(capturedArgs?.region, "eu-west-1");
  assertEquals(capturedArgs?.name, "my-resource");
  assertEquals(capturedArgs?.timeout, 30);
});

Deno.test("executeWorkflow: check unresolvedMethodArgs filters unresolved expressions from global args", async () => {
  const service = new DefaultMethodExecutionService();

  let capturedArgs: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    type: ModelType.create("test/check-filter"),
    version: "1",
    globalArguments: z.object({
      name: z.string().optional(),
      apiKey: z.string().optional(),
    }),
    methods: {
      create: {
        description: "Create resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "capture-args": {
        description: "Captures unresolvedMethodArgs",
        appliesTo: ["create"],
        execute: (context: MethodContext) => {
          capturedArgs = context.unresolvedMethodArgs;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-filter",
    globalArguments: {
      name: "my-server",
      apiKey: "${{ vault.secrets.api_key }}",
    },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.executeWorkflow(definition, model, "create", context);

  assertEquals(capturedArgs?.name, "my-server");
  assertEquals(capturedArgs?.apiKey, undefined);
});

Deno.test("executeWorkflow - remote placement skips pre-flight checks (swamp-club#1721)", async () => {
  const service = new DefaultMethodExecutionService();
  const checkExecuted = { value: false };
  const model = createCheckModel({
    "fs-check": {
      description: "Filesystem check that would fail on orchestrator",
      execute: () => {
        checkExecuted.value = true;
        return Promise.resolve({ pass: false, errors: ["Path not found"] });
      },
    },
  });

  const definition = Definition.create({
    name: "remote-def",
    globalArguments: {},
  });

  const written = Data.create({
    name: "data-out",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "data" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "remote-def" },
    version: 1,
    size: 2,
  });
  const baseRepo = createMockDataRepoWithData([written]);
  const repo: UnifiedDataRepository = {
    ...baseRepo,
    findByName: (_type, _modelId, dataName, version) =>
      Promise.resolve(
        dataName === "data-out" && version === 1 ? written : null,
      ),
    getContent: () => Promise.resolve(new TextEncoder().encode("{}")),
  };

  setRemoteStepDispatcher({
    executeRemote: () =>
      Promise.resolve({
        outputs: [{
          dataId: String(written.id),
          version: 1,
          name: "data-out",
          specName: "data",
          type: "resource" as const,
        }],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      }),
    releaseAffinity: () => {},
  });
  try {
    const { context } = createTestContext({
      modelType: model.type,
      dataRepository: repo,
      placement: { labels: { tier: "remote" } },
    });
    const result = await service.executeWorkflow(
      definition,
      model,
      "create",
      context,
    );
    assertEquals(result !== undefined, true);
    assertEquals(checkExecuted.value, false);
  } finally {
    setRemoteStepDispatcher(null);
  }
});

/** The lock holder each remote dispatch made inside `fn` carried. */
async function dispatchedLockHolders(
  inheritedTokens: string | undefined,
  fn: (run: () => Promise<unknown>) => Promise<void>,
): Promise<Array<RemoteLockHolder | undefined>> {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({});
  const definition = Definition.create({
    name: "remote-def",
    globalArguments: {},
  });
  const lockHolders: Array<RemoteLockHolder | undefined> = [];
  setRemoteStepDispatcher({
    executeRemote: async (request) => {
      const handOff = await request.beginLockHandOff?.();
      lockHolders.push(handOff?.lent);
      await handOff?.end();
      return {
        outputs: [],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      };
    },
    releaseAffinity: () => {},
  });
  try {
    await withMockedEnv(
      { [SWAMP_LOCK_HOLDER_TOKENS]: inheritedTokens },
      () =>
        fn(() => {
          const { context } = createTestContext({
            modelType: model.type,
            placement: { labels: { tier: "remote" } },
          });
          return service.executeWorkflow(definition, model, "create", context);
        }),
    );
  } finally {
    setRemoteStepDispatcher(null);
  }
  return lockHolders;
}

Deno.test("executeWorkflow - remote dispatch carries the locks held for the run (swamp-club#2983)", async () => {
  const lockHolders = await dispatchedLockHolders(undefined, async (run) => {
    await processLockHolderMarker.runHolding(["nonce-a"], run);
    // Outside any lock scope there is nothing to hand to the worker.
    await run();
  });

  assertEquals(lockHolders[0]?.pid, Deno.pid);
  assertEquals(lockHolders[0]?.lockIds, ["nonce-a"]);
  assertEquals(lockHolders[1], undefined);
});

Deno.test("executeWorkflow - remote dispatch also carries the locks handed down to this process (swamp-club#3096)", async () => {
  const lockHolders = await dispatchedLockHolders(
    "100:up-a,200:up-b",
    async (run) => {
      await processLockHolderMarker.runHolding(["nonce-a"], run);
      await run();
    },
  );

  assertEquals(lockHolders[0]?.lockIds, ["up-a", "up-b", "nonce-a"]);
  assertEquals(lockHolders[1]?.lockIds, ["up-a", "up-b"]);
});

Deno.test("executeWorkflow - remote dispatch sends no lock holder naming more locks than a worker accepts (swamp-club#3096)", async () => {
  const nonces = (count: number) =>
    Array.from({ length: count }, (_, i) => `n${i}`);
  const lockHolders = await dispatchedLockHolders(undefined, async (run) => {
    await processLockHolderMarker.runHolding(nonces(MAX_REMOTE_LOCK_IDS), run);
    await processLockHolderMarker.runHolding(
      nonces(MAX_REMOTE_LOCK_IDS + 1),
      run,
    );
  });

  assertEquals(lockHolders[0]?.lockIds.length, MAX_REMOTE_LOCK_IDS);
  assertEquals(lockHolders[1], undefined);
});

Deno.test("executeWorkflow - local execution still runs pre-flight checks", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "local-check": {
      description: "Check that runs locally",
      execute: () => Promise.resolve({ pass: false, errors: ["Check failed"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
    "local-check",
  );
});

Deno.test("executeWorkflow - empty placement still runs checks", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({
    "check-with-empty-placement": {
      description: "Should still run",
      execute: () => Promise.resolve({ pass: false, errors: ["Check failed"] }),
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({
    modelType: model.type,
    placement: {},
  });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
    "check-with-empty-placement",
  );
});

Deno.test("executeWorkflow - placed steps rebuild full handles from durable records (swamp-club#535)", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});
  const definition = Definition.create({
    name: "remote-def",
    methods: { start: { arguments: {} } },
  });

  // The record the data plane persisted while the worker ran the method.
  const written = Data.create({
    name: "data-out",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "data" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "remote-def" },
    version: 2,
    size: 17,
  });
  const baseRepo = createMockDataRepoWithData([written]);
  const repo: UnifiedDataRepository = {
    ...baseRepo,
    findByName: (_type, _modelId, dataName, version) =>
      Promise.resolve(
        dataName === "data-out" && version === 2 ? written : null,
      ),
    getContent: () =>
      Promise.resolve(new TextEncoder().encode('{"value":"remote"}')),
  };

  setRemoteStepDispatcher({
    executeRemote: () =>
      Promise.resolve({
        outputs: [{
          dataId: String(written.id),
          version: 2,
          name: "data-out",
          specName: "data",
          type: "resource" as const,
        }],
        logs: [],
        durationMs: 5,
        workerName: "gpu-box-1",
      }),
    releaseAffinity: () => {},
  });
  try {
    const { context } = createTestContext({
      modelType: model.type,
      dataRepository: repo,
      placement: { labels: { tier: "remote" } },
    });
    const result = await service.executeWorkflow(
      definition,
      model,
      "start",
      context,
    );

    // Telemetry attribution: the result names the worker that ran it.
    assertEquals(result.executor, "gpu-box-1");

    const handle = result.dataHandles![0];
    // Full metadata is rebuilt from the durable record — the wire-thin
    // dispatch output carries identities only.
    assertEquals(handle.metadata.ownerDefinition.ownerType, "model-method");
    assertEquals(handle.metadata.contentType, "application/json");
    assertEquals(handle.size, 17);

    // The exact consumer that crashed during manual testing: mapping the
    // handle into a DataRecord reads metadata.ownerDefinition.* fields.
    const record = await fromResourceHandle(
      handle,
      model.type,
      context.modelId,
      "remote-def",
      repo,
    );
    assertEquals(record.ownerType, "model-method");
    assertEquals(record.attributes, { value: "remote" });
  } finally {
    setRemoteStepDispatcher(null);
  }
});

Deno.test("executeWorkflow - placed step with a vanished output record fails loudly", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});
  const definition = Definition.create({
    name: "remote-def",
    methods: { start: { arguments: {} } },
  });
  setRemoteStepDispatcher({
    executeRemote: () =>
      Promise.resolve({
        outputs: [{
          dataId: crypto.randomUUID(),
          version: 9,
          name: "ghost",
          specName: "data",
          type: "resource" as const,
        }],
        logs: [],
        durationMs: 1,
      }),
    releaseAffinity: () => {},
  });
  try {
    const { context } = createTestContext({
      modelType: model.type,
      placement: { target: "w1" },
    });
    await assertRejects(
      () => service.executeWorkflow(definition, model, "start", context),
      Error,
      "was not found in the datastore",
    );
  } finally {
    setRemoteStepDispatcher(null);
  }
});

// ---------- Invocation Provenance Tests ----------

function createMockOutputRepo(): {
  repo: MethodContext["outputRepository"];
  saved: Array<{ type: ModelType; method: string; output: ModelOutput }>;
} {
  const saved: Array<{
    type: ModelType;
    method: string;
    output: ModelOutput;
  }> = [];
  return {
    repo: {
      findById: () => Promise.resolve(null),
      findByIds: () => Promise.resolve(new Map()),
      findByDefinition: () => Promise.resolve([]),
      findLatestByDefinition: () => Promise.resolve(null),
      findAll: () => Promise.resolve([]),
      findAllGlobal: () => Promise.resolve([]),
      findAllGlobalSince: () => Promise.resolve([]),
      save: (type: ModelType, method: string, output: ModelOutput) => {
        saved.push({ type, method, output });
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
      deleteOlderThan: () => Promise.resolve({ deleted: 0, bytesReclaimed: 0 }),
      deleteByMethodLifetime: () =>
        Promise.resolve({ deleted: 0, bytesReclaimed: 0 }),
      nextId: () => createModelOutputId(crypto.randomUUID()),
      getPath: () => "",
    },
    saved,
  };
}

Deno.test(
  "executeWorkflow: output has triggeredBy 'manual' for top-level execution",
  async () => {
    const service = new DefaultMethodExecutionService();
    const model = createTestModel({});
    const definition = Definition.create({
      name: "test-provenance-manual",
      globalArguments: { value: "test" },
    });

    const { repo, saved } = createMockOutputRepo();
    const { context } = createTestContext({
      modelType: model.type,
      outputRepository: repo,
    });

    await service.executeWorkflow(definition, model, "start", context);

    const lastSave = saved[saved.length - 1];
    assertEquals(lastSave.output.status, "succeeded");
    assertEquals(lastSave.output.provenance.triggeredBy, "manual");
    assertEquals(lastSave.output.provenance.parentOutputId, undefined);
    assertEquals(lastSave.output.provenance.callerExtension, undefined);
  },
);

Deno.test(
  "executeWorkflow: output uses _invocationProvenance when set",
  async () => {
    const service = new DefaultMethodExecutionService();
    const model = createTestModel({});
    const definition = Definition.create({
      name: "test-provenance-model",
      globalArguments: { value: "test" },
    });

    const { repo, saved } = createMockOutputRepo();
    const { context } = createTestContext({
      modelType: model.type,
      outputRepository: repo,
      _invocationProvenance: {
        triggeredBy: "model",
        parentOutputId: "aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee",
        callerExtension: "@test/caller-ext",
      },
    });

    await service.executeWorkflow(definition, model, "start", context);

    const lastSave = saved[saved.length - 1];
    assertEquals(lastSave.output.status, "succeeded");
    assertEquals(lastSave.output.provenance.triggeredBy, "model");
    assertEquals(
      lastSave.output.provenance.parentOutputId,
      "aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee",
    );
    assertEquals(
      lastSave.output.provenance.callerExtension,
      "@test/caller-ext",
    );
  },
);

Deno.test(
  "executeWorkflow: sets _currentOutputId on context before execution",
  async () => {
    const service = new DefaultMethodExecutionService();

    let capturedOutputId: string | undefined;
    const model: ModelDefinition = {
      type: ModelType.create("test/capture-output-id"),
      version: "2026.07.11.1",
      globalArguments: z.object({}),
      methods: {
        run: {
          description: "capture output id",
          arguments: z.object({}),
          execute: (_args: Record<string, unknown>, ctx: MethodContext) => {
            capturedOutputId = ctx._currentOutputId;
            return Promise.resolve({ dataHandles: [] });
          },
        },
      },
    };

    const definition = Definition.create({
      name: "test-capture-output-id",
      globalArguments: {},
    });

    const { repo } = createMockOutputRepo();
    const { context } = createTestContext({
      modelType: model.type,
      outputRepository: repo,
    });

    await service.executeWorkflow(definition, model, "run", context);

    assertEquals(typeof capturedOutputId, "string");
    assertEquals(capturedOutputId!.length > 0, true);
  },
);

Deno.test(
  "executeWorkflow: failed execution persists output with failed status",
  async () => {
    const service = new DefaultMethodExecutionService();
    const model: ModelDefinition = {
      type: ModelType.create("test/fail-output"),
      version: "2026.07.11.1",
      globalArguments: z.object({}),
      methods: {
        boom: {
          description: "always fails",
          arguments: z.object({}),
          execute: () => {
            throw new Error("intentional failure");
          },
        },
      },
    };

    const definition = Definition.create({
      name: "test-fail-output",
      globalArguments: {},
    });

    const { repo, saved } = createMockOutputRepo();
    const { context } = createTestContext({
      modelType: model.type,
      outputRepository: repo,
    });

    await assertRejects(
      () => service.executeWorkflow(definition, model, "boom", context),
      Error,
      "intentional failure",
    );

    const lastSave = saved[saved.length - 1];
    assertEquals(lastSave.output.status, "failed");
    assertEquals(lastSave.output.error?.message, "intentional failure");
  },
);

Deno.test(
  "execute: z.record() method args do not include globalArguments",
  async () => {
    const service = new DefaultMethodExecutionService();

    let capturedArgs: Record<string, unknown> = {};
    const recordModel: ModelDefinition = {
      type: ModelType.create("test/record-args"),
      version: "2026.07.24.1",
      globalArguments: z.object({
        baseUrl: z.string(),
        apiKey: z.string(),
      }),
      methods: {
        send: {
          description: "Send key-value pairs",
          arguments: z.record(z.string(), z.string()),
          execute: (
            args: Record<string, unknown>,
          ): Promise<MethodResult> => {
            capturedArgs = { ...args };
            return Promise.resolve({ dataHandles: [] });
          },
        },
      },
    };

    const definition = Definition.create({
      name: "record-test",
      globalArguments: {
        baseUrl: "https://api.example.com",
        apiKey: "secret-key",
      },
      methods: { send: { arguments: { someKey: "someValue" } } },
    });

    const { context } = createTestContext({
      modelType: recordModel.type,
      methodName: "send",
      globalArgs: {
        baseUrl: "https://api.example.com",
        apiKey: "secret-key",
      },
    });

    await service.execute(
      definition,
      recordModel.methods.send,
      context,
    );

    assertEquals(capturedArgs, { someKey: "someValue" });
  },
);

// ---------- Remote-Only Mode Exemption Tests (swamp-club#2307) ----------

Deno.test("executeWorkflow: internal model executes in-process in remote-only mode", async () => {
  const service = new DefaultMethodExecutionService();

  const internalType = ModelType.create("swamp/test-internal");
  modelRegistry.markInternal(internalType);
  setRemoteOnlyMode(true);
  try {
    let executed = false;
    const model: ModelDefinition = {
      type: internalType,
      version: "1",
      methods: {
        redeem: {
          description: "Control-plane method",
          kind: "action",
          arguments: z.object({}),
          execute: () => {
            executed = true;
            return Promise.resolve({});
          },
        },
      },
    };

    const definition = Definition.create({
      name: "test-internal-model",
      globalArguments: {},
    });

    const { context } = createTestContext({ modelType: internalType });
    const result = await service.executeWorkflow(
      definition,
      model,
      "redeem",
      context,
    );

    assertEquals(result !== undefined, true);
    assertEquals(executed, true);
  } finally {
    setRemoteOnlyMode(false);
  }
});

Deno.test("executeWorkflow: non-internal model without placement throws in remote-only mode", async () => {
  const service = new DefaultMethodExecutionService();

  setRemoteOnlyMode(true);
  try {
    const model: ModelDefinition = {
      type: ModelType.create("test/user-model"),
      version: "1",
      methods: {
        run: {
          description: "User method",
          arguments: z.object({}),
          execute: () => Promise.resolve({}),
        },
      },
    };

    const definition = Definition.create({
      name: "test-user-model",
      globalArguments: {},
    });

    const { context } = createTestContext({
      modelType: model.type,
    });

    await assertRejects(
      () => service.executeWorkflow(definition, model, "run", context),
      UserError,
      "remote-only mode",
    );
  } finally {
    setRemoteOnlyMode(false);
  }
});

// ---------------------------------------------------------------------------
// Stranded-instance warning (swamp-club#900)
// ---------------------------------------------------------------------------

/**
 * A logger stand-in that records calls at `level` (`warn` by default) and
 * swallows everything else. LogTape loggers are tagged-template callables, so
 * each level is returned as a function that reassembles the template.
 */
function captureWarnings(
  sink: string[],
  level = "warn",
): MethodContext["logger"] {
  const tag = (record: (message: string) => void) =>
  (
    strings: TemplateStringsArray | string,
    ...values: unknown[]
  ): void => {
    if (typeof strings === "string") {
      record(strings);
      return;
    }
    record(
      strings.reduce(
        (acc, part, i) =>
          acc + part + (i < values.length ? String(values[i]) : ""),
        "",
      ),
    );
  };

  return new Proxy({}, {
    get(_target, property) {
      if (property === level) return tag((message) => sink.push(message));
      if (property === "getChild") return () => captureWarnings(sink, level);
      return tag(() => {});
    },
  }) as unknown as MethodContext["logger"];
}

Deno.test("executeWorkflow - warns once when an instance is stranded", async () => {
  const service = new DefaultMethodExecutionService();
  // Installed model is ahead, and ships no upgrade entry covering the gap.
  const model: ModelDefinition = {
    ...createTestModel({}),
    version: "2026.06.01.1",
  };
  const definition = Definition.create({
    name: "stranded-definition",
    typeVersion: "2026.01.01.1",
    globalArguments: { value: "test" },
  });

  const warnings: string[] = [];
  const { context } = createTestContext({
    modelType: model.type,
    logger: captureWarnings(warnings),
  });

  await service.executeWorkflow(definition, model, "start", context);

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "no upgrade entry covers the gap");
  assertStringIncludes(warnings[0], "2026.01.01.1");
  assertStringIncludes(warnings[0], "2026.06.01.1");
});

Deno.test("executeWorkflow - does not warn when the instance is current", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});
  const definition = Definition.create({
    name: "current-definition",
    typeVersion: model.version,
    globalArguments: { value: "test" },
  });

  const warnings: string[] = [];
  const { context } = createTestContext({
    modelType: model.type,
    logger: captureWarnings(warnings),
  });

  await service.executeWorkflow(definition, model, "start", context);

  assertEquals(warnings, []);
});

Deno.test("executeWorkflow - does not warn for an unstamped definition when the type has no upgrade chain", async () => {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    ...createTestModel({}),
    version: "2026.06.01.1",
  };
  // No typeVersion recorded, and no chain that could have migrated it. There
  // is nothing to say, and saying it would fire on every run of every
  // hand-written definition (swamp-club#2412).
  const definition = Definition.create({
    name: "unstamped-definition",
    globalArguments: { value: "test" },
  });

  const warnings: string[] = [];
  const { context } = createTestContext({
    modelType: model.type,
    logger: captureWarnings(warnings),
  });

  await service.executeWorkflow(definition, model, "start", context);

  assertEquals(warnings, []);
});

Deno.test("executeWorkflow - warns once for an unstamped definition when the type has an upgrade chain", async () => {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    ...createTestModel({}),
    version: "2026.06.01.1",
    upgrades: [
      {
        toVersion: "2026.06.01.1",
        description: "Rename value to content",
        upgradeAttributes: (old: Record<string, unknown>) => {
          const { value, ...rest } = old;
          return { ...rest, content: value };
        },
      },
    ],
  };
  // The chain is declined rather than applied: the arguments are already in
  // the shape the current version expects, and applying it would rename
  // `value` away (swamp-club#2412). The warning is what makes the skip
  // visible, and it is actionable — record the version and the ambiguity is
  // gone.
  const definition = Definition.create({
    name: "unstamped-definition",
    globalArguments: { value: "test" },
  });

  const warnings: string[] = [];
  const { context } = createTestContext({
    modelType: model.type,
    logger: captureWarnings(warnings),
  });

  await service.executeWorkflow(definition, model, "start", context);

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "unstamped-definition");
  assertStringIncludes(warnings[0], "records no typeVersion");
  assertStringIncludes(warnings[0], "2026.06.01.1");
  // The arguments themselves are untouched.
  assertEquals(definition.globalArguments.value, "test");
  assertEquals(definition.globalArguments.content, undefined);
});

Deno.test("executeWorkflow - fails a run whose definition records a malformed typeVersion", async () => {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    ...createTestModel({}),
    version: "2026.06.01.1",
  };
  const definition = Definition.create({
    name: "hand-edited-definition",
    typeVersion: "1.0",
    globalArguments: { value: "test" },
  });

  const { context } = createTestContext({ modelType: model.type });

  const error = await assertRejects(
    () => service.executeWorkflow(definition, model, "start", context),
    UserError,
    '"1.0"',
  );
  assertEquals((error as UserError).code, MALFORMED_TYPE_VERSION_CODE);
});

Deno.test("recoveredDataHandles: returns the handles attached to a failed method's error", () => {
  const handles = [{ name: "state", dataId: "d-1", version: 1, tags: {} }];
  const error = Object.assign(new Error("boom"), { dataHandles: handles });

  assertEquals(recoveredDataHandles(error), handles);
});

Deno.test("recoveredDataHandles: returns [] when nothing usable is attached", () => {
  assertEquals(recoveredDataHandles(new Error("boom")), []);
  assertEquals(
    recoveredDataHandles(
      Object.assign(new Error("boom"), { dataHandles: "not-a-list" }),
    ),
    [],
  );
  assertEquals(recoveredDataHandles("boom"), []);
  assertEquals(recoveredDataHandles(null), []);
});

Deno.test("recoveredDataHandles: drops entries that are not shaped like a data handle", () => {
  const valid = { name: "state", dataId: "d-1", version: 1, tags: {} };
  const error = Object.assign(new Error("boom"), {
    dataHandles: [
      valid,
      null,
      "state",
      { name: "missing-id", version: 1, tags: {} },
      { name: "bad-version", dataId: "d-2", version: "1", tags: {} },
      { name: "no-tags", dataId: "d-3", version: 1 },
    ],
  });

  assertEquals(recoveredDataHandles(error), [valid]);
});

// ---------- Global argument defaults next to unresolved expressions (swamp-club#2766) ----------

function createGlobalArgsCaptureModel(
  globalArguments: z.ZodTypeAny,
  read: (globalArgs: Record<string, unknown>) => void,
): ModelDefinition {
  return {
    type: ModelType.create(`test/global-defaults-${crypto.randomUUID()}`),
    version: "1",
    globalArguments,
    methods: {
      show: {
        description: "Reads global arguments",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          read(context.globalArgs);
          return Promise.resolve({});
        },
      },
    },
  };
}

const UNRESOLVED_TOKEN =
  '${{ data.latest("missing", "current").attributes.token }}';

Deno.test("executeWorkflow: applies globalArguments defaults when a sibling holds an unresolved expression (swamp-club#2766)", async () => {
  const service = new DefaultMethodExecutionService();
  let received: unknown;
  const model = createGlobalArgsCaptureModel(
    z.object({
      top: z.number().default(6),
      tok: z.string().optional(),
      nested: z.object({
        list: z.array(z.string()).default([]),
        n: z.number().default(6),
      }),
    }),
    (g) => {
      received = { nested: g.nested, top: g.top };
    },
  );
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { nested: {}, tok: UNRESOLVED_TOKEN },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.executeWorkflow(definition, model, "show", context);

  assertEquals(received, { nested: { list: [], n: 6 }, top: 6 });
});

Deno.test("executeWorkflow: applies the same defaults whether or not a sibling is unresolved (swamp-club#2766)", async () => {
  const service = new DefaultMethodExecutionService();
  const schema = z.object({
    top: z.number().default(6),
    tok: z.string().optional(),
    nested: z.object({ list: z.array(z.string()).default([]) }),
  });
  const seen: unknown[] = [];
  for (const tok of ["resolved", UNRESOLVED_TOKEN]) {
    const model = createGlobalArgsCaptureModel(schema, (g) => {
      seen.push({ nested: g.nested, top: g.top });
    });
    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { nested: {}, tok },
    });
    const { context } = createTestContext({ modelType: model.type });
    await service.executeWorkflow(definition, model, "show", context);
  }
  assertEquals(seen[0], seen[1]);
});

Deno.test("executeWorkflow: rejects a wrongly typed global argument next to an unresolved expression (swamp-club#2766)", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createGlobalArgsCaptureModel(
    z.object({ top: z.number(), tok: z.string() }),
    () => {},
  );
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { top: "notanumber", tok: UNRESOLVED_TOKEN },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "show", context),
    Error,
    "Global arguments validation failed",
  );
});

Deno.test("executeWorkflow: rejects an unknown global argument next to an unresolved expression (swamp-club#2766)", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createGlobalArgsCaptureModel(
    z.object({ top: z.number(), tok: z.string() }),
    () => {},
  );
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { top: 1, bogus: 1, tok: UNRESOLVED_TOKEN },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "show", context),
    Error,
    "Unknown argument(s): bogus",
  );
});

Deno.test("executeWorkflow: coerces resolved global arguments next to an unresolved expression (swamp-club#2766)", async () => {
  const service = new DefaultMethodExecutionService();
  let received: unknown;
  const model = createGlobalArgsCaptureModel(
    z.object({ count: z.number(), tok: z.string() }),
    (g) => {
      received = g.count;
    },
  );
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { count: "3", tok: UNRESOLVED_TOKEN },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.executeWorkflow(definition, model, "show", context);

  assertEquals(received, 3);
});

Deno.test("executeWorkflow: keeps an unresolved global argument guarded even when its schema has a default (swamp-club#2766)", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createGlobalArgsCaptureModel(
    z.object({ tok: z.string().default("fallback") }),
    (g) => {
      const _tok = g.tok;
    },
  );
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { tok: UNRESOLVED_TOKEN },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "show", context),
    Error,
    "Unresolved expression in globalArguments.tok",
  );
});

Deno.test("executeWorkflow: runs a refined globalArguments schema instead of crashing on partial() (swamp-club#2766)", async () => {
  const service = new DefaultMethodExecutionService();
  const schema = z.object({
    top: z.number().default(6),
    tok: z.string().optional(),
    nested: z.object({ list: z.array(z.string()).default([]) }),
  }).refine((v) => (v.top ?? 1) > 0);
  const seen: unknown[] = [];
  for (const tok of ["resolved", UNRESOLVED_TOKEN]) {
    const model = createGlobalArgsCaptureModel(schema, (g) => {
      seen.push({ nested: g.nested, top: g.top });
    });
    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { nested: {}, tok },
    });
    const { context } = createTestContext({ modelType: model.type });
    await service.executeWorkflow(definition, model, "show", context);
  }
  assertEquals(seen, [
    { nested: { list: [] }, top: 6 },
    { nested: { list: [] }, top: 6 },
  ]);
});

Deno.test("executeWorkflow: rejects a wrongly typed field in a refined globalArguments schema (swamp-club#2766)", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createGlobalArgsCaptureModel(
    z.object({ top: z.number() }).refine(() => true),
    () => {},
  );
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { top: "notanumber" },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "show", context),
    Error,
    'Global arguments validation failed: Invalid input: expected number, received string at "top"',
  );
});

const credentialsSchema = z.object({
  apiKey: z.string().optional(),
  token: z.string().optional(),
}).superRefine((v, ctx) => {
  if (!v.apiKey && !v.token) {
    ctx.addIssue({ code: "custom", message: "apiKey or token required" });
  }
});

Deno.test("executeWorkflow: enforces an object-level globalArguments refinement (swamp-club#2783)", async () => {
  const service = new DefaultMethodExecutionService();
  let ran = false;
  const model = createGlobalArgsCaptureModel(credentialsSchema, () => {
    ran = true;
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "show", context),
    Error,
    "Global arguments validation failed: apiKey or token required",
  );
  assertEquals(ran, false);
});

Deno.test("executeWorkflow: runs when an object-level globalArguments refinement holds or a field is unresolved (swamp-club#2783)", async () => {
  const service = new DefaultMethodExecutionService();
  const seen: unknown[] = [];
  for (const token of ["t", UNRESOLVED_TOKEN]) {
    const model = createGlobalArgsCaptureModel(credentialsSchema, (g) => {
      seen.push(g.apiKey);
    });
    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { token },
    });
    const { context } = createTestContext({ modelType: model.type });
    await service.executeWorkflow(definition, model, "show", context);
  }
  assertEquals(seen, [undefined, undefined]);
});

Deno.test("executeWorkflow - a method's marked paths survive the in-process rethrow (swamp-club#2830)", async () => {
  const path = "/srv/Acme Corp/final report";
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    type: ModelType.create("test/marked-paths"),
    version: "1",
    methods: {
      create: {
        description: "Throws an error naming a marked path",
        arguments: z.object({}),
        execute: () => {
          throw markErrorPaths(new Error(`cannot read ${path}`), [path]);
        },
      },
    },
  };
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });

  const error = await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    Error,
    "cannot read",
  );
  assertEquals(errorPaths(error), [path]);
});

function throwingModel(name: string, thrown: Error): ModelDefinition {
  return {
    type: ModelType.create(`test/${name}`),
    version: "1",
    methods: {
      create: {
        description: "Throws the given error",
        arguments: z.object({}),
        execute: () => {
          throw thrown;
        },
      },
    },
  };
}

Deno.test("executeWorkflow - a coded UserError a method throws comes back as a UserError with its code, paths and data handles (swamp-club#3773)", async () => {
  const path = "/srv/Acme Corp/token";
  const service = new DefaultMethodExecutionService();
  const model = throwingModel(
    "coded-user-error",
    markErrorPaths(
      new UserError(`cannot authenticate with ${path}`, "auth_failed"),
      [path],
    ),
  );
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });

  const error = await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
    "cannot authenticate",
  );
  assertEquals(error.code, "auth_failed");
  assertEquals(errorPaths(error), [path]);
  assertEquals(
    Array.isArray((error as unknown as Record<string, unknown>).dataHandles),
    true,
  );
});

Deno.test("executeWorkflow - an uncoded UserError a method throws comes back as a plain Error, as before", async () => {
  const service = new DefaultMethodExecutionService();
  const model = throwingModel(
    "uncoded-user-error",
    new UserError("intentional failure"),
  );
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });
  const { context } = createTestContext({ modelType: model.type });

  const error = await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    Error,
    "intentional failure",
  );
  assertEquals(error instanceof UserError, false);
});

/** A remote request, with the frame a version 5 worker would receive. */
type CapturedRemoteRequest = RemoteStepRequest & {
  legacy?: LegacyStepDelivery;
};

async function captureRemoteRequest(
  secretBag: VaultSecretBag | undefined,
  methodArgs: Record<string, unknown>,
  secretLoader?: SecretLoader,
  globalArguments: Record<string, unknown> = {},
): Promise<CapturedRemoteRequest> {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});
  const definition = Definition.create({
    name: "remote-secret-def",
    globalArguments,
    methods: { start: { arguments: methodArgs } },
  });
  const captured: CapturedRemoteRequest[] = [];
  setRemoteStepDispatcher({
    executeRemote: async (request) => {
      // A version 6 worker is sent the request's own arguments; a version 5
      // one the frame its legacy delivery builds, as serve asks for it.
      captured.push({ ...request, legacy: await request.legacyDelivery?.() });
      return {
        outputs: [],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      };
    },
    releaseAffinity: () => {},
  });
  try {
    const { context } = createTestContext({
      modelType: model.type,
      placement: { labels: { tier: "remote" } },
      vaultSecrets: secretBag,
    });
    await service.executeWorkflow(definition, model, "start", context, {
      secretLoader,
    });
  } finally {
    setRemoteStepDispatcher(null);
  }
  assertEquals(captured.length, 1);
  return captured[0];
}

Deno.test("executeWorkflow - placed step ships its secret bag and unresolved args (swamp-club#2760)", async () => {
  const secretBag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = secretBag.addSecret(
    { vaultName: "v", key: "token" },
    "methods.start.arguments.value",
  );
  const { loader, reads } = mockLoader({ token: "s3cret-value" });

  const request = await captureRemoteRequest(secretBag, {
    value: `token ${sentinel}`,
  }, loader);

  // A version 6 worker is sent the sentinel and the reference behind it.
  assertEquals(request.methodArgs.value, `token ${sentinel}`);
  assertEquals(request.referenceBag, [{
    sentinel,
    reference: { vaultName: "v", key: "token" },
    encoding: "raw",
    dataOrigin: false,
    location: "methods.start.arguments.value",
  }]);
  // The orchestrator loads the bag for a version 5 worker only, once.
  assertEquals(reads, ["token"]);
  const legacy = request.legacy!;
  assertEquals(legacy.methodArgs.value, "token s3cret-value");
  assertEquals(legacy.unresolvedMethodArgs?.value, `token ${sentinel}`);
  assertEquals(legacy.secretBag, [{
    sentinel,
    value: "s3cret-value",
    dataOrigin: false,
  }]);
  assertEquals(legacy.secretValues?.includes("s3cret-value"), true);
  // The reference behind the shipped entry, for serve's allowlist and its
  // load route (swamp-club#3529).
  assertEquals(request.secretReferences, [{ vaultName: "v", key: "token" }]);
});

Deno.test("executeWorkflow - a placed step ships a JSON-value data reference with its mark, delivers the value in the resolved args and its text for redaction (swamp-club#3967)", async () => {
  const secretBag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = secretBag.addDataReference(
    { vaultName: "v", key: "port" },
    "data.latest of model 'app' record r1 version 1 (data.latest), field 'spec.services.0.port'",
    true,
  );
  const { loader } = mockLoader({ port: "8080" });

  const request = await captureRemoteRequest(secretBag, {
    counter: sentinel,
    value: `p-${sentinel}`,
  }, loader);

  assertEquals(request.methodArgs.counter, sentinel);
  assertEquals(request.referenceBag?.[0].jsonValue, true);
  const legacy = request.legacy!;
  assertEquals(legacy.methodArgs.counter, 8080);
  assertEquals(legacy.methodArgs.value, "p-8080");
  assertEquals(legacy.unresolvedMethodArgs?.counter, sentinel);
  assertEquals(legacy.secretBag, [{
    sentinel,
    value: "8080",
    dataOrigin: true,
    jsonValue: true,
  }]);
  assertEquals(legacy.secretValues?.includes("8080"), true);
});

Deno.test("executeWorkflow - placed step without secrets ships no bag fields", async () => {
  const request = await captureRemoteRequest(undefined, { value: "plain" });
  assertEquals(request.methodArgs.value, "plain");
  assertEquals(request.referenceBag, undefined);
  assertEquals(request.secretReferences, undefined);
  assertEquals(request.legacy?.methodArgs.value, "plain");
  assertEquals(request.legacy?.unresolvedMethodArgs, undefined);
  assertEquals(request.legacy?.secretBag, undefined);
});

Deno.test("executeWorkflow: a placed step retains references found only in global arguments", async () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const sentinel = bag.addSecret(
    { vaultName: "v", key: "token" },
    "globalArguments.value",
  );
  new VaultSecretBag(registry).addSecret(
    { vaultName: "v", key: "other-method" },
    "methods.other.arguments.value",
  );
  const { loader } = mockLoader({ token: "global-secret" });
  const request = await captureRemoteRequest(
    bag,
    {},
    loader,
    { value: sentinel },
  );
  assertEquals(request.globalArgs, { value: sentinel });
  assertEquals(request.legacy?.globalArgs, { value: "global-secret" });
  assertEquals(request.secretReferences, [{ vaultName: "v", key: "token" }]);
});

/**
 * Runs one remote dispatch whose worker streams `streamed`, and returns what
 * reached the run logger and the caller's onEvent.
 */
async function remoteOutputFor(
  streamed: unknown[],
  options?: { withOnEvent?: boolean },
): Promise<{ logged: Array<[string, string]>; forwarded: unknown[] }> {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({});
  const definition = Definition.create({
    name: "remote-def",
    globalArguments: {},
  });
  // The service logs its own progress through the same logger, so only what
  // arrives while the worker is streaming counts.
  let streaming = false;
  const logged: Array<[string, string]> = [];
  const record = (level: string) => (message: string) => {
    if (streaming) logged.push([level, message]);
  };
  const logger = {
    info: record("info"),
    warn: record("warning"),
    error: record("error"),
    debug: () => {},
  } as unknown as MethodContext["logger"];
  const forwarded: unknown[] = [];
  setRemoteStepDispatcher({
    executeRemote: (request) => {
      streaming = true;
      for (const event of streamed) {
        request.onEvent?.({ kind: "method_event", event });
      }
      streaming = false;
      return Promise.resolve({
        outputs: [],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      });
    },
    releaseAffinity: () => {},
  });
  try {
    const { context } = createTestContext({
      modelType: model.type,
      placement: { labels: { tier: "remote" } },
      logger,
      onEvent: options?.withOnEvent === false
        ? undefined
        : (event) => forwarded.push(event),
    });
    await service.executeWorkflow(definition, model, "create", context);
  } finally {
    setRemoteStepDispatcher(null);
  }
  return { logged, forwarded };
}

Deno.test("executeWorkflow - remote output is written to the run logger at its level (swamp-club#3080)", async () => {
  const { logged, forwarded } = await remoteOutputFor([
    { type: "output", line: "plain", stream: "stdout", level: "info" },
    { type: "output", line: "careful", stream: "stderr", level: "warning" },
    { type: "output", line: "broken", stream: "stderr", level: "error" },
  ]);

  assertEquals(logged, [
    ["info", "plain"],
    ["warning", "careful"],
    ["error", "broken"],
  ]);
  // Each event still reaches the caller, once.
  assertEquals(forwarded.length, 3);
});

Deno.test("executeWorkflow - remote output is logged when the caller passes no onEvent (swamp-club#3080)", async () => {
  const { logged } = await remoteOutputFor(
    [{ type: "output", line: "plain", stream: "stdout", level: "info" }],
    { withOnEvent: false },
  );

  assertEquals(logged, [["info", "plain"]]);
});

Deno.test("executeWorkflow - remote output without a recognised level falls back to its stream (swamp-club#3080)", async () => {
  const { logged } = await remoteOutputFor([
    { type: "output", line: "old out", stream: "stdout" },
    { type: "output", line: "old err", stream: "stderr" },
    { type: "output", line: "odd", stream: "stdout", level: "constructor" },
  ]);

  assertEquals(logged, [
    ["info", "old out"],
    ["warning", "old err"],
    ["info", "odd"],
  ]);
});

Deno.test("executeWorkflow - remote output is escaped and split so one event cannot forge records (swamp-club#3080)", async () => {
  const { logged } = await remoteOutputFor([
    {
      type: "output",
      line: '{"a":1}\n\n2026-01-01T00:00:00.000Z [INF] forged\n',
      stream: "stdout",
      level: "info",
    },
  ]);

  assertEquals(logged, [
    ["info", '{{"a":1}}'],
    // A blank line inside the text is kept; the trailing newline adds none.
    ["info", ""],
    ["info", "2026-01-01T00:00:00.000Z [INF] forged"],
  ]);
});

Deno.test("executeWorkflow - remote output is split on every line separator (swamp-club#3080)", async () => {
  const { logged } = await remoteOutputFor([
    {
      type: "output",
      line: "a\rb\r\nc\u2028d\u2029e\vf\fg\u0085h",
      stream: "stdout",
      level: "info",
    },
  ]);

  assertEquals(logged.map(([, message]) => message), [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
  ]);
});

Deno.test("executeWorkflow - a malformed remote event is not logged (swamp-club#3080)", async () => {
  const { logged } = await remoteOutputFor([
    null,
    "output",
    { type: "output", line: 42, stream: "stdout" },
    { type: "vault_single_quote_warning", message: "not output" },
  ]);

  assertEquals(logged, []);
});

// ---------- Bare-token vault.get global arguments (swamp-club#3360) ----------
// A definition reaches these guards with a vault.get still in place when the
// runtime pass did not resolve it. The bare-token form must be guarded exactly
// like the quoted one.

const VAULT_GET_FORMS = [
  "${{ vault.get(t, KEY) }}",
  '${{ vault.get("t", "KEY") }}',
];

Deno.test("execute - Proxy throws for an unresolved bare-token vault.get in globalArgs (swamp-club#3360)", async () => {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    type: ModelType.create("test/unresolved-bare-vault"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          const _val = context.globalArgs.apiKey;
          return Promise.resolve({});
        },
      },
    },
  };

  for (const apiKey of VAULT_GET_FORMS) {
    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { name: "my-server", apiKey },
      methods: { run: { arguments: {} } },
    });
    const { context } = createTestContext({ modelType: model.type });
    await assertRejects(
      () => service.execute(definition, model.methods.run, context),
      Error,
      "Unresolved expression in globalArguments.apiKey",
      apiKey,
    );
  }
});

Deno.test("execute - an unresolved bare-token vault.get in globalArgs is not merged into method arguments (swamp-club#3360)", async () => {
  const service = new DefaultMethodExecutionService();
  let received: Record<string, unknown> = {};
  const model: ModelDefinition = {
    type: ModelType.create("test/merge-bare-vault"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({
          name: z.string(),
          apiKey: z.string().optional(),
        }),
        execute: (args: Record<string, unknown>) => {
          received = args;
          return Promise.resolve({});
        },
      },
    },
  };

  for (const apiKey of VAULT_GET_FORMS) {
    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { name: "my-server", apiKey },
      methods: { run: { arguments: {} } },
    });
    const { context } = createTestContext({ modelType: model.type });
    await service.execute(definition, model.methods.run, context);
    assertEquals(received.name, "my-server", apiKey);
    assertEquals(received.apiKey, undefined, apiKey);
  }
});

Deno.test("executeWorkflow - skips validation for a non-string globalArg holding an unresolved bare-token vault.get (swamp-club#3360)", async () => {
  const service = new DefaultMethodExecutionService();
  let receivedName = "";
  const model: ModelDefinition = {
    type: ModelType.create("test/unresolved-bare-vault-number"),
    version: "1",
    globalArguments: z.object({ name: z.string(), port: z.number() }),
    methods: {
      update: {
        description: "Update method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedName = context.globalArgs.name as string;
          return Promise.resolve({});
        },
      },
    },
  };

  for (const port of VAULT_GET_FORMS) {
    receivedName = "";
    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { name: "my-server", port },
    });
    const { context } = createTestContext({ modelType: model.type });
    await service.executeWorkflow(definition, model, "update", context);
    assertEquals(receivedName, "my-server", port);
  }
});

Deno.test("executeWorkflow: check unresolvedMethodArgs filters a bare-token vault.get from global args (swamp-club#3360)", async () => {
  const service = new DefaultMethodExecutionService();
  const captured: Record<string, unknown>[] = [];
  const model: ModelDefinition = {
    type: ModelType.create("test/check-filter-bare-vault"),
    version: "1",
    globalArguments: z.object({
      name: z.string().optional(),
      apiKey: z.string().optional(),
    }),
    methods: {
      create: {
        description: "Create resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "capture-args": {
        description: "Captures unresolvedMethodArgs",
        appliesTo: ["create"],
        execute: (context: MethodContext) => {
          captured.push(context.unresolvedMethodArgs ?? {});
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  for (const apiKey of VAULT_GET_FORMS) {
    captured.length = 0;
    const definition = Definition.create({
      name: "test-filter",
      globalArguments: { name: "my-server", apiKey },
    });
    const { context } = createTestContext({ modelType: model.type });
    await service.executeWorkflow(definition, model, "create", context);
    assertEquals(captured[0]?.name, "my-server", apiKey);
    assertEquals(captured.length, 1, apiKey);
    assertEquals(captured[0]?.apiKey, undefined, apiKey);
  }
});

// ---------------------------------------------------------------------------
// Upgrade write-back logging (swamp-club#3502)
// ---------------------------------------------------------------------------

/** Runs an upgrading method against a repository whose path moves on save. */
async function runUpgradeWithPaths(
  pathBefore: string,
  pathAfter: string,
): Promise<string[]> {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    ...createTestModel({}),
    version: "2026.07.28.1",
    upgrades: [{
      toVersion: "2026.07.28.1",
      description: "No-op upgrade",
      upgradeAttributes: (old) => old,
    }],
  };
  const definition = Definition.create({
    name: "upgraded-definition",
    typeVersion: "2026.06.04.2",
    globalArguments: { value: "test" },
  });
  let path = pathBefore;
  const definitionRepository: DefinitionRepository = {
    ...createMockDefinitionRepo(),
    findById: () => Promise.resolve(definition),
    getPath: () => path,
    save: () => {
      path = pathAfter;
      return Promise.resolve();
    },
  };
  const infos: string[] = [];
  const { context } = createTestContext({
    modelType: model.type,
    definitionRepository,
    logger: captureWarnings(infos, "info"),
  });
  await service.executeWorkflow(definition, model, "start", context);
  return infos;
}

Deno.test("executeWorkflow - logs the upgrade and the file move when an upgraded definition is saved to a new path", async () => {
  const infos = await runUpgradeWithPaths(
    join("models", "test", "acd064be-261b-4a64-8142-42335cd04231.yaml"),
    join("models", "test", "upgraded-definition.yaml"),
  );

  const upgrade = infos.filter((m) => m.startsWith("Upgraded definition"));
  assertEquals(upgrade.length, 1);
  assertStringIncludes(upgrade[0], "upgraded-definition");
  assertStringIncludes(upgrade[0], "2026.06.04.2");
  assertStringIncludes(upgrade[0], "2026.07.28.1");
  const moved = infos.filter((m) => m.startsWith("Moved definition file"));
  assertEquals(moved, [
    "Moved definition file acd064be-261b-4a64-8142-42335cd04231.yaml to upgraded-definition.yaml",
  ]);
});

Deno.test("executeWorkflow - logs no file move when an upgraded definition is saved in place", async () => {
  const path = join("models", "test", "upgraded-definition.yaml");
  const infos = await runUpgradeWithPaths(path, path);

  assertEquals(
    infos.filter((m) => m.startsWith("Upgraded definition")).length,
    1,
  );
  assertEquals(
    infos.filter((m) => m.startsWith("Moved definition file")),
    [],
  );
});

Deno.test("execute - a sentinel an earlier pass issued resolves through a step bag that issued nothing", async () => {
  const service = new DefaultMethodExecutionService();
  const registry = new SecretBagRegistry();
  const early = new VaultSecretBag(registry).addDataSecret("early-s3cret", REF);
  const stepBag = new VaultSecretBag(registry);
  assertEquals(stepBag.isEmpty, true);

  let received: Record<string, unknown> = {};
  const model: ModelDefinition = {
    type: ModelType.create("test/earlier-pass-sentinel"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({ value: z.string() }),
        execute: (args) => {
          received = args as Record<string, unknown>;
          return Promise.resolve({});
        },
      },
    },
  };
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: { run: { arguments: { value: `token ${early}` } } },
  });
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "run",
    vaultSecrets: stepBag,
  });
  await service.execute(definition, model.methods.run, context);
  assertEquals(received.value, "token early-s3cret");
});

Deno.test("executeWorkflow - a placed step ships the run's entries its arguments carry, and nothing else", async () => {
  const registry = new SecretBagRegistry();
  const runStart = new VaultSecretBag(registry);
  const early = runStart.addDataSecret("early-s3cret", REF);
  runStart.addSecret({ vaultName: "v", key: "unrelated" }, "loc");
  const stepBag = new VaultSecretBag(registry);
  const { loader, reads } = mockLoader({ unrelated: "unrelated-s3cret" });

  const request = await captureRemoteRequest(stepBag, {
    value: `token ${early}`,
  }, loader);

  // A reference the step's arguments do not carry is never loaded.
  assertEquals(reads, []);
  // A version 6 worker loads the data entry by its reference.
  assertEquals(request.referenceBag?.map((entry) => entry.reference), [REF]);
  const legacy = request.legacy!;
  assertEquals(legacy.methodArgs.value, "token early-s3cret");
  assertEquals(legacy.unresolvedMethodArgs?.value, `token ${early}`);
  assertEquals(legacy.secretBag, [{
    sentinel: early,
    value: "early-s3cret",
    dataOrigin: true,
  }]);
  assertEquals(legacy.secretValues?.includes("early-s3cret"), true);
  assertEquals(legacy.secretValues?.includes("unrelated-s3cret"), false);
});

// ---------- Loading vault references at delivery (typed-secrets 2.3) ----------

/** What a delivery reached: the check's context and the method's inputs. */
interface Delivered {
  check?: MethodContext;
  args?: Record<string, unknown>;
  globalArgs?: Record<string, unknown>;
}

/** A model whose pre-flight check and `create` method record what they get. */
function createDeliveryModel(delivered: Delivered): ModelDefinition {
  const schema = z.object({
    token: z.string().optional(),
    note: z.string().optional(),
  });
  return {
    type: ModelType.create("test/delivery"),
    version: "1",
    globalArguments: schema,
    methods: {
      create: {
        description: "Records its arguments",
        arguments: schema,
        execute: (args, context) => {
          delivered.args = args as Record<string, unknown>;
          delivered.globalArgs = { ...context.globalArgs };
          return Promise.resolve({});
        },
      },
    },
    checks: {
      recorder: {
        description: "Records its context",
        execute: (context) => {
          delivered.check = context;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };
}

/** A definition whose global and method arguments carry `sentinel`. */
const deliveryDefinition = (sentinel: string) =>
  Definition.create({
    name: "delivery-def",
    globalArguments: { token: sentinel },
    methods: { create: { arguments: { note: `uses ${sentinel}` } } },
  });

Deno.test("executeWorkflow - loads a vault reference once per attempt, before pre-flight checks, and the checks and the method share the loaded view", async () => {
  const service = new DefaultMethodExecutionService();
  const delivered: Delivered = {};
  const model = createDeliveryModel(delivered);
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret(
    { vaultName: "v", key: "token" },
    "globalArguments.token",
  );
  const { loader, reads } = mockLoader({ token: "s3cret-value" });
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: bag,
  });

  await service.executeWorkflow(
    deliveryDefinition(sentinel),
    model,
    "create",
    context,
    { secretLoader: loader },
  );

  // One read for a reference carried by two arguments.
  assertEquals(reads, ["token"]);
  assertEquals(delivered.globalArgs?.token, "s3cret-value");
  assertEquals(delivered.args?.note, "uses s3cret-value");
  // The check sees the method arguments with sentinels, and the loaded bag.
  assertEquals(delivered.check?.unresolvedMethodArgs?.note, `uses ${sentinel}`);
  assertEquals(
    delivered.check?.vaultSecrets?.resolveRaw(sentinel),
    "s3cret-value",
  );
  // The step's own bag still holds no value.
  assertEquals(
    (() => {
      try {
        return bag.resolveRaw(sentinel);
      } catch (error) {
        return (error as Error).message;
      }
    })().includes("was not loaded"),
    true,
  );

  // A retry is a new attempt, from a freshly evaluated definition: it loads
  // again.
  await service.executeWorkflow(
    deliveryDefinition(sentinel),
    model,
    "create",
    context,
    { secretLoader: loader },
  );
  assertEquals(reads, ["token", "token"]);
});

Deno.test("executeWorkflow - a load failure fails the step before any check or method runs, naming no value", async () => {
  const service = new DefaultMethodExecutionService();
  const delivered: Delivered = {};
  const model = createDeliveryModel(delivered);
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret(
    { vaultName: "v", key: "missing" },
    "globalArguments.token",
  );
  const { loader } = mockLoader({ other: "other-s3cret" });
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: bag,
  });

  const error = await assertRejects(
    () =>
      service.executeWorkflow(
        deliveryDefinition(sentinel),
        model,
        "create",
        context,
        { secretLoader: loader },
      ),
    Error,
    "Failed to load secret 'missing' from vault 'v' (at globalArguments.token)",
  );
  assertEquals(error.message.includes("other-s3cret"), false);
  assertEquals(delivered.check, undefined);
  assertEquals(delivered.args, undefined);
});

Deno.test("executeWorkflow - a vault reference with no loader fails closed instead of delivering its sentinel", async () => {
  const service = new DefaultMethodExecutionService();
  const delivered: Delivered = {};
  const model = createDeliveryModel(delivered);
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret(
    { vaultName: "v", key: "token" },
    "methods.create.arguments.note",
  );
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: bag,
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({
          name: "delivery-def",
          methods: { create: { arguments: { note: sentinel } } },
        }),
        model,
        "create",
        context,
      ),
    Error,
    "was not loaded before delivery",
  );
  assertEquals(delivered.args, undefined);
});

// ---------- typed-secrets 3.4: destination refusals before the load ----------

/**
 * A type whose `workingDir` refuses secrets, with a recording check, method
 * and destination hook, and no globalArguments schema.
 */
function destinationModel(
  hook?: (args: SecretDestinationArgs) => void,
): {
  model: ModelDefinition;
  seen: {
    check: number;
    method: Record<string, unknown>[];
    hook: SecretDestinationArgs[];
  };
} {
  const seen = {
    check: 0,
    method: [] as Record<string, unknown>[],
    hook: [] as SecretDestinationArgs[],
  };
  const model: ModelDefinition = {
    type: ModelType.create("test/destinations"),
    version: "2026.10.20.1",
    methods: {
      create: {
        description: "Records what it receives",
        arguments: z.object({
          workingDir: z.string().meta({ secrets: "refuse" }).optional(),
          command: z.string().optional(),
        }),
        execute: (args) => {
          seen.method.push(args as Record<string, unknown>);
          return Promise.resolve({});
        },
        refuseSecretDestinations: (args) => {
          seen.hook.push(args);
          hook?.(args);
        },
      },
    },
    checks: {
      record: {
        description: "Counts its runs",
        execute: () => {
          seen.check++;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };
  return { model, seen };
}

/** A typed run that issued one vault.get() reference to key `token`. */
function typedToken(): { bag: VaultSecretBag; sentinel: string } {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  return {
    bag,
    sentinel: bag.addSecret(
      { vaultName: "v", key: "token" },
      "methods.create.arguments.workingDir",
    ),
  };
}

Deno.test("executeWorkflow: a secret in a refusing method field is refused before any load, check or method (typed-secrets 3.4)", async () => {
  const service = new DefaultMethodExecutionService();
  const { model, seen } = destinationModel();
  const { bag, sentinel } = typedToken();
  const definition = Definition.create({
    name: "d",
    globalArguments: {},
    methods: { create: { arguments: { workingDir: sentinel } } },
  });
  const { loader, reads } = mockLoader({ token: "s3cret-value" });
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: bag,
  });
  const error = await assertRejects(
    () =>
      service.executeWorkflow(definition, model, "create", context, {
        secretLoader: loader,
      }),
    SecretDestinationRefusedError,
  );
  assertEquals(error.destination, "method argument 'workingDir'");
  assertEquals(error.code, "secret_destination_refused");
  assertEquals(error.message.includes(sentinel), false);
  assertEquals(reads, []);
  assertEquals(seen.check, 0);
  assertEquals(seen.method, []);
  assertEquals(seen.hook, []);
});

Deno.test("executeWorkflow: a refusing field authored under globalArguments of a type with no global schema is refused through the merged arguments", async () => {
  const service = new DefaultMethodExecutionService();
  const { model, seen } = destinationModel();
  const { bag, sentinel } = typedToken();
  const definition = Definition.create({
    name: "d",
    globalArguments: { workingDir: sentinel },
    methods: { create: { arguments: {} } },
  });
  const { loader, reads } = mockLoader({ token: "s3cret-value" });
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: bag,
  });
  const error = await assertRejects(
    () =>
      service.executeWorkflow(definition, model, "create", context, {
        secretLoader: loader,
      }),
    SecretDestinationRefusedError,
  );
  assertEquals(error.destination, "method argument 'workingDir'");
  assertEquals(reads, []);
  assertEquals(seen.method, []);
});

Deno.test("executeWorkflow: the method hook receives the merged arguments before the load, for local placement only, and its refusal reaches the caller", async () => {
  const service = new DefaultMethodExecutionService();
  const { model, seen } = destinationModel();
  const { bag, sentinel } = typedToken();
  const definition = Definition.create({
    name: "d",
    globalArguments: { command: `echo ${sentinel}` },
    methods: { create: { arguments: {} } },
  });
  const { loader, reads } = mockLoader({ token: "s3cret-value" });
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: bag,
  });
  await service.executeWorkflow(definition, model, "create", context, {
    secretLoader: loader,
  });
  assertEquals(seen.hook.length, 1);
  assertEquals(seen.hook[0].arguments, { command: `echo ${sentinel}` });
  const [occurrence] = seen.hook[0].secrets.occurrencesIn(`echo ${sentinel}`);
  assertEquals(occurrence.reference, { vaultName: "v", key: "token" });
  assertEquals("value" in occurrence, false);
  // The load came after the hook, once, and the method got the value.
  assertEquals(reads, ["token"]);
  assertEquals(seen.method, [{ command: "echo s3cret-value" }]);
  assertEquals(seen.check, 1);

  // A remotely placed step runs its body on a worker, whose shell may
  // differ: the hook is not asked; the refusing fields still are.
  const remote = destinationModel();
  const { context: remoteContext } = createTestContext({
    modelType: remote.model.type,
    methodName: "create",
    vaultSecrets: bag,
    placement: { target: "worker-1" },
  });
  const remoteError = await assertRejects(() =>
    service.executeWorkflow(definition, remote.model, "create", remoteContext, {
      secretLoader: loader,
    })
  );
  assertEquals(remoteError instanceof SecretDestinationRefusedError, false);
  assertEquals(remote.seen.hook, []);

  // A hook refusal propagates as it is, before any load.
  const refusing = destinationModel(() => {
    throw new SecretDestinationRefusedError(
      "the shell command inside a here-document with a quoted delimiter",
      { vaultName: "v", key: "token" },
      undefined,
      "test",
    );
  });
  const fresh = mockLoader({ token: "s3cret-value" });
  const { context: refusingContext } = createTestContext({
    modelType: refusing.model.type,
    methodName: "create",
    vaultSecrets: bag,
  });
  await assertRejects(
    () =>
      service.executeWorkflow(
        definition,
        refusing.model,
        "create",
        refusingContext,
        { secretLoader: fresh.loader },
      ),
    SecretDestinationRefusedError,
    "the shell command",
  );
  assertEquals(fresh.reads, []);
  assertEquals(refusing.seen.method, []);
});

Deno.test("executeWorkflow: a failed method's output record holds its error with values and sentinels masked", async () => {
  const service = new DefaultMethodExecutionService();
  const saved: ModelOutput[] = [];
  const outputRepository = {
    save: (_type: ModelType, _method: string, output: ModelOutput) => {
      saved.push(output);
      return Promise.resolve();
    },
  } as unknown as OutputRepository;
  const redactor = new SecretRedactor();
  // The run's loader registers each value it loads; this mock loader does
  // not take a redactor, so the value is registered here.
  redactor.addSecret("s3cret-value");
  const registry = new SecretBagRegistry();
  // The run's sensitive values attach the redactor to the typed registry.
  new RunSensitiveValues(redactor, registry);
  const bag = new VaultSecretBag(registry);
  const sentinel = bag.addSecret(
    { vaultName: "v", key: "token" },
    "methods.create.arguments.command",
  );
  const model: ModelDefinition = {
    type: ModelType.create("test/leaky"),
    version: "2026.10.20.1",
    methods: {
      create: {
        description: "Echoes what it was given into its error",
        arguments: z.object({ command: z.string() }),
        execute: (args) => {
          throw new Error(
            `leaked ${(args as { command: string }).command} and ${sentinel}`,
          );
        },
      },
    },
  };
  const definition = Definition.create({
    name: "d",
    globalArguments: {},
    methods: { create: { arguments: { command: sentinel } } },
  });
  const { loader } = mockLoader({ token: "s3cret-value" });
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: bag,
    redactor,
    outputRepository,
  });
  await assertRejects(
    () =>
      service.executeWorkflow(definition, model, "create", context, {
        secretLoader: loader,
      }),
    Error,
    "leaked",
  );
  const failed = saved.find((output) => output.status === "failed");
  assertEquals(failed?.error?.message, "leaked *** and ***");
  assertEquals(failed?.error?.message.includes("s3cret-value"), false);
});

Deno.test("executeWorkflow: the checks and the method receive the global arguments in unresolvedMethodArgs with their sentinels, as the shell needs", async () => {
  const service = new DefaultMethodExecutionService();
  const seen: {
    method?: Record<string, unknown>;
    check?: Record<string, unknown>;
    args?: Record<string, unknown>;
  } = {};
  const model: ModelDefinition = {
    type: ModelType.create("test/unresolved-merge"),
    version: "2026.10.20.1",
    globalArguments: z.object({
      command: z.string().optional(),
      retries: z.number().default(3),
      port: z.coerce.number().optional(),
    }),
    methods: {
      create: {
        description: "Records the unresolved merge",
        arguments: z.object({
          command: z.string().optional(),
          retries: z.number().optional(),
          port: z.number().optional(),
        }),
        execute: (args, context) => {
          seen.method = { ...context.unresolvedMethodArgs };
          seen.args = { ...(args as Record<string, unknown>) };
          return Promise.resolve({});
        },
      },
    },
    checks: {
      record: {
        description: "Records the unresolved merge",
        execute: (context) => {
          seen.check = { ...context.unresolvedMethodArgs };
          return Promise.resolve({ pass: true });
        },
      },
    },
  };
  {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const sentinel = bag.addSecret(
      { vaultName: "v", key: "token" },
      "globalArguments.command",
    );
    // `command` is authored under globalArguments, not the method.
    const definition = Definition.create({
      name: "d",
      globalArguments: { command: `echo ${sentinel}`, port: "8080" },
      methods: { create: { arguments: {} } },
    });
    const { loader } = mockLoader({ token: "s3cret-value" });
    const { context } = createTestContext({
      modelType: model.type,
      methodName: "create",
      vaultSecrets: bag,
    });
    await service.executeWorkflow(definition, model, "create", context, {
      secretLoader: loader,
    });
    // The merge is built before the boundary writes values into the global
    // arguments, including a shell run under globalArguments (swamp-club#3627).
    const expected = `echo ${sentinel}`;
    for (const merge of [seen.method, seen.check]) {
      assertEquals(merge?.command, expected);
      // A non-secret global carries its parsed defaults and coerced numbers.
      assertEquals(merge?.retries, 3);
      assertEquals(merge?.port, 8080);
    }
    // The method's validated arguments hold the value either way.
    assertEquals(seen.args?.command, "echo s3cret-value");
  }
});

Deno.test("executeWorkflow: delivering one Definition instance twice keeps the caller's sentinels, so the second attempt loads again and the merge the shell fills from still holds them", async () => {
  const service = new DefaultMethodExecutionService();
  const seen: {
    method?: Record<string, unknown>;
    check?: Record<string, unknown>;
    args?: Record<string, unknown>;
  } = {};
  const model: ModelDefinition = {
    type: ModelType.create("test/twice-delivered"),
    version: "2026.10.20.1",
    globalArguments: z.object({ command: z.string().optional() }),
    methods: {
      create: {
        description: "Records the unresolved merge",
        arguments: z.object({ command: z.string().optional() }),
        execute: (args, context) => {
          seen.method = { ...context.unresolvedMethodArgs };
          seen.args = { ...(args as Record<string, unknown>) };
          return Promise.resolve({});
        },
      },
    },
    checks: {
      record: {
        description: "Records the unresolved merge",
        execute: (context) => {
          seen.check = { ...context.unresolvedMethodArgs };
          return Promise.resolve({ pass: true });
        },
      },
    },
  };
  {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const sentinel = bag.addSecret(
      { vaultName: "v", key: "token" },
      "globalArguments.command",
    );
    // `command` is authored under globalArguments, not the method.
    const definition = Definition.create({
      name: "d",
      globalArguments: { command: `echo ${sentinel}` },
      methods: { create: { arguments: {} } },
    });
    const { loader, reads } = mockLoader({ token: "s3cret-value" });
    for (const attempt of [1, 2]) {
      const where = `attempt ${attempt}`;
      const { context } = createTestContext({
        modelType: model.type,
        methodName: "create",
        vaultSecrets: bag,
      });
      await service.executeWorkflow(definition, model, "create", context, {
        secretLoader: loader,
      });
      // The values go into a copy, so the object the caller holds keeps its
      // sentinel after the attempt (swamp-club#3627)...
      assertEquals(
        definition.globalArguments.command,
        `echo ${sentinel}`,
        where,
      );
      // ...and a second delivery loads again and fills from the sentinel,
      // while the validated arguments hold the value as before.
      assertEquals(reads, Array(attempt).fill("token"), where);
      for (const merge of [seen.method, seen.check]) {
        assertEquals(merge?.command, `echo ${sentinel}`, where);
      }
      assertEquals(seen.args?.command, "echo s3cret-value", where);
    }
  }
});

Deno.test("executeWorkflow: in a typed run an env authored as a JSON string with a secret as a key is refused, and the shell refuses it itself when reached without the boundary", async () => {
  const service = new DefaultMethodExecutionService();
  const { bag, sentinel } = typedToken();
  const definition = Definition.create({
    name: "d",
    globalArguments: {},
    methods: {
      execute: {
        arguments: {
          run: "printenv",
          env: JSON.stringify({ [sentinel]: "1" }),
        },
      },
    },
  });
  const { loader, reads } = mockLoader({ token: "s3cret-value" });
  const { context } = createTestContext({
    modelType: shellModel.type,
    methodName: "execute",
    vaultSecrets: bag,
  });
  const error = await assertRejects(
    () =>
      service.executeWorkflow(definition, shellModel, "execute", context, {
        secretLoader: loader,
      }),
    SecretDestinationRefusedError,
  );
  assertEquals(error.destination, "an environment variable name");
  assertEquals(reads, []);
  // Reached without the boundary, the shell applies the same policy over the
  // unresolved arguments, coerced as validation coerces them.
  const loaded = bag.withLoaded(new Map([[sentinel, "s3cret-value"]]));
  const { context: direct } = createTestContext({
    modelType: shellModel.type,
    methodName: "execute",
    vaultSecrets: loaded,
    unresolvedMethodArgs: {
      run: "printenv",
      env: JSON.stringify({ [sentinel]: "1" }),
    },
  });
  const directError = await assertRejects(
    () =>
      shellModel.methods.execute.execute(
        { run: "printenv", env: { "s3cret-value": "1" } },
        direct,
      ),
    SecretDestinationRefusedError,
  );
  assertEquals(directError.destination, "an environment variable name");
});

Deno.test("executeWorkflow: the merge keeps a sentinel leaf authored inside a global while its siblings are parsed, and leaves out a global whose value reads as an expression", async () => {
  const service = new DefaultMethodExecutionService();
  /** The merge the method received, one per mode. */
  const seen: Record<string, unknown>[] = [];
  const model: ModelDefinition = {
    type: ModelType.create("test/leaf-overlay"),
    version: "2026.10.20.1",
    globalArguments: z.object({
      config: z.object({
        token: z.string(),
        retries: z.coerce.number().default(3),
        verbose: z.boolean().default(false),
      }),
      shaped: z.string().optional(),
    }),
    methods: {
      create: {
        description: "Records the unresolved merge",
        arguments: z.object({}),
        execute: (_args, context) => {
          seen.push({ ...context.unresolvedMethodArgs });
          return Promise.resolve({});
        },
      },
    },
  };
  {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const sentinel = bag.addSecret({ vaultName: "v", key: "token" }, "loc");
    const shaped = bag.addSecret({ vaultName: "v", key: "shaped" }, "loc2");
    const definition = Definition.create({
      name: "d",
      globalArguments: {
        config: { token: sentinel, retries: "5" },
        shaped,
      },
      methods: { create: { arguments: {} } },
    });
    // The second value resolves to text that reads as an expression, which
    // every merge leaves out.
    const { loader } = mockLoader({
      token: "s3cret-value",
      shaped: "${{ vault.get('v', 'k') }}",
    });
    const { context } = createTestContext({
      modelType: model.type,
      methodName: "create",
      vaultSecrets: bag,
    });
    await service.executeWorkflow(definition, model, "create", context, {
      secretLoader: loader,
    });
    const merge = seen[0];
    assertEquals(seen.length, 1);
    assertEquals(
      merge?.config,
      { token: sentinel, retries: 5, verbose: false },
    );
    assertEquals(Object.hasOwn(merge ?? {}, "shaped"), false);
  }
});

// ---------- deliverStepSecrets: the shared refuse-then-load step ----------

function deliveryFixture() {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const sentinel = bag.addSecret(
    { vaultName: "v", key: "k" },
    "methods.run.arguments.token",
  );
  const loads: string[] = [];
  const vaultService = new class extends VaultService {
    override get(vaultName: string, key: string) {
      loads.push(`${vaultName}/${key}`);
      return Promise.resolve("hunter2-value");
    }
  }();
  const loader = new SecretLoader(() => Promise.resolve(vaultService));
  const model = (refuse: boolean): ModelDefinition => ({
    type: ModelType.create("test/delivery"),
    version: "2026.02.09.1",
    globalArguments: z.object({
      region: z.string().optional().meta(refuse ? { secrets: "refuse" } : {}),
    }),
    methods: {
      run: {
        description: "Run",
        arguments: z.object({ token: z.string() }),
        execute: () => Promise.resolve({}),
      },
    },
  });
  return { registry, bag, sentinel, loads, loader, model };
}

Deno.test("deliverStepSecrets: builds the sentinel merge, loads once for the attempt, and leaves the step's own bag unloaded", async () => {
  const { bag, sentinel, loads, loader, model } = deliveryFixture();
  const definition = Definition.create({
    name: "d",
    globalArguments: { region: "us-east-1", templated: "${{ inputs.x }}" },
    methods: { run: { arguments: { token: sentinel } } },
  });
  const modelDef = model(false);
  const delivery = await deliverStepSecrets({
    definition,
    modelDef,
    method: modelDef.methods.run,
    methodName: "run",
    vaultSecrets: bag,
    secretLoader: loader,
    localPlacement: true,
  });
  assertEquals(delivery.sentinelArguments, {
    region: "us-east-1",
    token: sentinel,
  });
  assertEquals(delivery.secrets?.occurrencesIn(sentinel).length, 1);
  assertEquals(loads, ["v/k"]);
  assertEquals(delivery.vaultSecrets?.resolveRaw(sentinel), "hunter2-value");
  // The step's own bag still holds only the reference, so resolving through
  // it fails as an unloaded delivery does.
  assertThrows(() => bag.resolveRaw(sentinel), Error, "not loaded");
  // A second attempt loads again.
  await deliverStepSecrets({
    definition,
    modelDef,
    method: modelDef.methods.run,
    methodName: "run",
    vaultSecrets: bag,
    secretLoader: loader,
    localPlacement: true,
  });
  assertEquals(loads, ["v/k", "v/k"]);
});

Deno.test("deliverStepSecrets: refuses a secret at a refusing destination before any load", async () => {
  {
    const { bag, sentinel, loads, loader, model } = deliveryFixture();
    const definition = Definition.create({
      name: "d",
      globalArguments: { region: sentinel },
      methods: { run: { arguments: { token: "plain" } } },
    });
    const modelDef = model(true);
    const deliver = () =>
      deliverStepSecrets({
        definition,
        modelDef,
        method: modelDef.methods.run,
        methodName: "run",
        vaultSecrets: bag,
        secretLoader: loader,
        localPlacement: true,
      });
    await assertRejects(deliver, SecretDestinationRefusedError);
    assertEquals(loads, []);
  }
});

Deno.test("deliverStepSecrets: with no method named only the global arguments are checked, and a step with no secret delivers its own bag untouched", async () => {
  const { bag, sentinel, loads, loader, model } = deliveryFixture();
  const modelDef = model(true);
  // A secret in a refusing global argument is refused even with no method.
  await assertRejects(
    () =>
      deliverStepSecrets({
        definition: Definition.create({
          name: "d",
          globalArguments: { region: sentinel },
        }),
        modelDef,
        method: undefined,
        methodName: "",
        vaultSecrets: bag,
        secretLoader: loader,
        localPlacement: true,
      }),
    SecretDestinationRefusedError,
  );
  assertEquals(loads, []);
  // A secret elsewhere loads with no method-level policy to apply.
  const delivered = await deliverStepSecrets({
    definition: Definition.create({
      name: "d",
      globalArguments: { other: sentinel },
    }),
    modelDef,
    method: undefined,
    methodName: "",
    vaultSecrets: bag,
    secretLoader: loader,
    localPlacement: true,
  });
  assertEquals(loads, ["v/k"]);
  assertEquals(delivered.vaultSecrets?.resolveRaw(sentinel), "hunter2-value");
  // No secret in the arguments: nothing is built or loaded.
  const plain = await deliverStepSecrets({
    definition: Definition.create({
      name: "d",
      globalArguments: { region: "us-east-1" },
      methods: { run: { arguments: { token: "plain" } } },
    }),
    modelDef,
    method: modelDef.methods.run,
    methodName: "run",
    vaultSecrets: new VaultSecretBag(
      new SecretBagRegistry(),
    ),
    secretLoader: loader,
    localPlacement: true,
  });
  assertEquals(plain.sentinelArguments, undefined);
  assertEquals(plain.secrets, undefined);
  assertEquals(loads, ["v/k"]);
});

Deno.test("executeWorkflow: onArgumentsValidated runs once the arguments pass their schema and before the method, and not at all when they fail (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const order: string[] = [];
  const recorder: ModelDefinition = {
    type: ModelType.create("test/validated-hook"),
    version: "2026.10.21.1",
    globalArguments: z.object({}),
    methods: {
      write: {
        description: "Records when it runs",
        arguments: z.object({ message: z.string().min(1) }),
        execute: () => {
          order.push("method");
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };
  const { context } = createTestContext();
  const hook = () => {
    order.push("validated");
    return Promise.resolve();
  };

  await service.executeWorkflow(
    Definition.create({
      name: "valid",
      methods: { write: { arguments: { message: "hello" } } },
    }),
    recorder,
    "write",
    context,
    { onArgumentsValidated: hook },
  );
  assertEquals(order, ["validated", "method"]);

  order.length = 0;
  await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({
          name: "invalid",
          methods: { write: { arguments: { message: { nested: true } } } },
        }),
        recorder,
        "write",
        context,
        { onArgumentsValidated: hook },
      ),
    Error,
    "Method arguments validation failed",
  );
  assertEquals(order, []);
});

Deno.test("executeWorkflow: the arguments are parsed once, so a schema transform runs once and the method receives what that parse produced, with or without onArgumentsValidated (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  let transforms = 0;
  const received: unknown[] = [];
  const counting: ModelDefinition = {
    type: ModelType.create("test/transform-once"),
    version: "2026.10.21.1",
    globalArguments: z.object({}),
    methods: {
      write: {
        description: "Counts its transform",
        arguments: z.object({
          message: z.string().transform((text) => `${text}#${++transforms}`),
        }),
        execute: (args: Record<string, unknown>) => {
          received.push(args);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };
  const { context } = createTestContext();
  const definition = Definition.create({
    name: "once",
    methods: { write: { arguments: { message: "hello" } } },
  });

  await service.executeWorkflow(definition, counting, "write", context, {
    onArgumentsValidated: () => Promise.resolve(),
  });
  assertEquals(transforms, 1);
  assertEquals(received, [{ message: "hello#1" }]);

  // A replay, which keeps no record, parses the same once.
  await service.executeWorkflow(definition, counting, "write", context);
  assertEquals(transforms, 2);
  assertEquals(received, [{ message: "hello#1" }, { message: "hello#2" }]);
});

Deno.test("executeWorkflow: a placed step calls onArgumentsValidated once its arguments pass their schema and before the dispatch, and neither calls it nor dispatches when they fail (swamp-club#3745)", async () => {
  const service = new DefaultMethodExecutionService();
  const order: string[] = [];
  const recorder: ModelDefinition = {
    type: ModelType.create("test/validated-hook-placed"),
    version: "2026.10.21.1",
    globalArguments: z.object({}),
    methods: {
      write: {
        description: "Runs on a worker",
        arguments: z.object({ message: z.string().min(1) }),
        execute: () => {
          order.push("in-process");
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };
  const hook = () => {
    order.push("validated");
    return Promise.resolve();
  };
  setRemoteStepDispatcher({
    executeRemote: async (request) => {
      // As serve dispatches to a version 5 worker.
      await request.legacyDelivery?.();
      order.push("dispatched");
      return {
        outputs: [],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      };
    },
    releaseAffinity: () => {},
  });
  try {
    const { context } = createTestContext({
      modelType: recorder.type,
      placement: { labels: { tier: "remote" } },
    });

    await service.executeWorkflow(
      Definition.create({
        name: "valid",
        methods: { write: { arguments: { message: "hello" } } },
      }),
      recorder,
      "write",
      context,
      { onArgumentsValidated: hook },
    );
    assertEquals(order, ["validated", "dispatched"]);

    order.length = 0;
    await assertRejects(
      () =>
        service.executeWorkflow(
          Definition.create({
            name: "invalid",
            methods: { write: { arguments: { message: { nested: true } } } },
          }),
          recorder,
          "write",
          context,
          { onArgumentsValidated: hook },
        ),
      Error,
      "Method arguments validation failed",
    );
    assertEquals(order, []);
  } finally {
    setRemoteStepDispatcher(null);
  }
});

Deno.test("execute: what a schema transform produces for a sensitive argument, and a sensitive number, are registered with the context's redactor as the method receives them (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const redactor = new SecretRedactor();
  const transforming: ModelDefinition = {
    type: ModelType.create("test/delivered-secrets"),
    version: "2026.10.21.1",
    globalArguments: z.object({}),
    methods: {
      write: {
        description: "Receives a transformed secret and a numeric one",
        arguments: z.object({
          token: z.string().meta({ sensitive: true }).transform((text) =>
            text.toUpperCase()
          ),
          pin: z.number().meta({ sensitive: true }),
          label: z.string().transform((text) => text.toUpperCase()),
        }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  const { context } = createTestContext({ redactor });
  await service.execute(
    Definition.create({
      name: "delivered",
      methods: {
        write: {
          arguments: { token: "hunter2-long", pin: 73816542, label: "shown" },
        },
      },
    }),
    transforming.methods.write,
    context,
  );
  assertEquals(
    redactor.redact("got HUNTER2-LONG, 73816542 and SHOWN"),
    "got ***, *** and SHOWN",
  );
});

Deno.test("execute: a parse the schema refuses under a transform registers what the transform made of a sensitive argument, and the refusal, described in Zod's words, shows nothing of it (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const sensitive = z.string().meta({ sensitive: true });
  const refusing: Record<string, MethodDefinition> = {
    refined: {
      description: "Refuses what its transform made",
      arguments: z.object({
        token: sensitive.transform((text) => text.toUpperCase()).refine(
          () => false,
          {
            error: (issue) =>
              `normalized credential rejected: ${String(issue.input)}`,
          },
        ),
      }),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
    piped: {
      description: "Refuses in a pipeline's output",
      arguments: z.object({ raw: z.string() }).transform((x) => ({
        token: x.raw.toUpperCase(),
      })).pipe(
        z.object({
          token: sensitive.refine(() => false, {
            error: (issue) =>
              `pipeline credential rejected: ${String(issue.input)}`,
          }),
        }),
      ),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  };
  for (
    const [method, args] of [
      ["refined", { token: "hunter2-long" }],
      ["piped", { raw: "hunter2-long" }],
    ] as const
  ) {
    const redactor = new SecretRedactor();
    redactor.addSecret("hunter2-long");
    const { context } = createTestContext({ redactor, methodName: method });
    const error = await assertRejects(
      () =>
        service.execute(
          Definition.create({
            name: "refused",
            methods: { [method]: { arguments: { ...args } } },
          }),
          refusing[method],
          context,
        ),
      Error,
    );
    assertEquals(error.message.includes("HUNTER2-LONG"), false);
    assertEquals(error.message.includes("credential rejected"), false);
    assertStringIncludes(
      error.message,
      'Method arguments validation failed: Invalid input at "token"',
    );
    assertEquals(redactor.redact("made HUNTER2-LONG"), "made ***");
  }
});

Deno.test("execute: a schema that throws while parsing a sensitive argument has its message withheld, so nothing of the value reaches the error; a schema marking nothing has its throw reported as it is (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const throwing = (sensitive: boolean): MethodDefinition => ({
    description: "Throws from a transform",
    arguments: z.object({
      token: (sensitive ? z.string().meta({ sensitive: true }) : z.string())
        .transform((text): string => {
          throw new TypeError(
            `normalized credential rejected: ${text.toUpperCase()}`,
          );
        }),
    }),
    execute: () => Promise.resolve({ dataHandles: [] }),
  });
  const definition = Definition.create({
    name: "thrown",
    methods: { write: { arguments: { token: "hunter2-long" } } },
  });
  const { context } = createTestContext({ redactor: new SecretRedactor() });
  const withheld = await assertRejects(
    () => service.execute(definition, throwing(true), context),
    Error,
  );
  assertEquals(withheld.message.includes("HUNTER2-LONG"), false);
  assertEquals(withheld.message.includes("hunter2-long"), false);
  assertStringIncludes(
    withheld.message,
    "Method arguments validation failed: the schema threw TypeError while parsing them, and its message is withheld",
  );
  assertEquals((withheld.stack ?? "").includes("HUNTER2-LONG"), false);
  const shown = await assertRejects(
    () => service.execute(definition, throwing(false), context),
    TypeError,
  );
  assertEquals(shown.message, "normalized credential rejected: HUNTER2-LONG");
});

Deno.test("execute: a key a schema transform derives from an argument is registered as the method receives it, while a key the arguments spelled is not (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const redactor = new SecretRedactor();
  const keyed: MethodDefinition = {
    description: "Makes a record keyed by what it was given",
    arguments: z.object({
      raw: z.string(),
      spelled: z.record(z.string(), z.unknown()),
    }).transform((x) => ({
      tokens: { [x.raw.toUpperCase()]: null, ...x.spelled },
    })).pipe(
      z.object({
        tokens: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
      }),
    ),
    execute: (args) =>
      Promise.reject(
        new Error(
          `keys ${Object.keys((args as { tokens: object }).tokens).join(",")}`,
        ),
      ),
  };
  const { context } = createTestContext({ redactor });
  const error = await assertRejects(
    () =>
      service.execute(
        Definition.create({
          name: "keyed",
          methods: {
            write: {
              arguments: {
                raw: "hunter2-long",
                spelled: { Authorization: null },
              },
            },
          },
        }),
        keyed,
        context,
      ),
    Error,
  );
  // The method's own error is the run's to redact: the redactor now holds
  // the made key and not the spelled one.
  assertEquals(redactor.redact(error.message), "keys ***,Authorization");
});

Deno.test("executeWorkflow: a global argument the schema refuses under a transform registers what the transform made of it, and the refusal, described in Zod's words, shows nothing of it; a schema that throws while parsing a sensitive global has its message withheld (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const sensitive = z.string().meta({ sensitive: true });
  const method: MethodDefinition = {
    description: "Test method",
    arguments: z.object({}),
    execute: () => Promise.resolve({ dataHandles: [] }),
  };
  const refusing: ModelDefinition = {
    type: ModelType.create("test/global-refused-secrets"),
    version: "1",
    globalArguments: z.object({
      apiKey: sensitive.transform((text) => text.toUpperCase()).refine(
        () => false,
        { error: (issue) => `normalized key rejected: ${String(issue.input)}` },
      ),
    }),
    methods: { run: method },
  };
  const definition = Definition.create({
    name: "refused-global",
    globalArguments: { apiKey: "hunter2-long" },
  });
  const redactor = new SecretRedactor();
  const refused = await assertRejects(
    () =>
      service.executeWorkflow(
        definition,
        refusing,
        "run",
        createTestContext({ modelType: refusing.type, redactor }).context,
      ),
    Error,
  );
  assertEquals(refused.message.includes("HUNTER2-LONG"), false);
  assertEquals(refused.message.includes("key rejected"), false);
  assertStringIncludes(
    refused.message,
    'Global arguments validation failed: Invalid input at "apiKey"',
  );
  assertEquals(redactor.redact("made HUNTER2-LONG"), "made ***");

  const throwing: ModelDefinition = {
    ...refusing,
    globalArguments: z.object({
      apiKey: sensitive.transform((text): string => {
        throw new TypeError(`normalized key rejected: ${text.toUpperCase()}`);
      }),
    }),
  };
  const withheld = await assertRejects(
    () =>
      service.executeWorkflow(
        definition,
        throwing,
        "run",
        createTestContext({ modelType: throwing.type }).context,
      ),
    Error,
  );
  assertEquals(withheld.message.includes("HUNTER2-LONG"), false);
  assertStringIncludes(
    withheld.message,
    "Global arguments validation failed: the schema threw TypeError while parsing them, and its message is withheld",
  );
});

Deno.test("executeWorkflow: what a schema transform produces for a sensitive global argument is registered with the run's redactor as the method receives it (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const transforming: ModelDefinition = {
    type: ModelType.create("test/global-delivered-secrets"),
    version: "1",
    globalArguments: z.object({
      apiKey: z.string().meta({ sensitive: true }).transform((text) =>
        text.toUpperCase()
      ).optional(),
    }),
    methods: {
      run: {
        description: "Echoes the global it reads into its error",
        arguments: z.object({}),
        execute: (_args, context) =>
          Promise.reject(
            new Error(`global echoed ${context.globalArgs.apiKey}`),
          ),
      },
    },
  };
  const redactor = new SecretRedactor();
  const { context } = createTestContext({
    modelType: transforming.type,
    redactor,
  });
  const error = await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({
          name: "delivered-global",
          globalArguments: { apiKey: "hunter2-long" },
        }),
        transforming,
        "run",
        context,
      ),
    Error,
    "global echoed",
  );
  assertEquals(redactor.redact(error.message), "global echoed ***");
  assertEquals(redactor.redact("made HUNTER2-LONG"), "made ***");
});

Deno.test("execute: a sensitive array or scalar a schema delivers in place of a record is registered with the context's redactor as the method receives it (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const sensitive = z.string().meta({ sensitive: true });
  const delivering: Record<string, MethodDefinition> = {
    array: {
      description: "Delivers an array of secrets",
      arguments: z.object({ raw: z.string() }).transform((x) => [
        x.raw.toUpperCase(),
      ]).pipe(z.array(sensitive)),
      execute: (args) =>
        Promise.reject(new Error(`array value ${(args as string[])[0]}`)),
    },
    scalar: {
      description: "Delivers one secret",
      arguments: z.object({ raw: z.string() }).transform((x) =>
        x.raw.toUpperCase()
      ).pipe(sensitive),
      execute: (args) => Promise.reject(new Error(`scalar value ${args}`)),
    },
  };
  for (const method of ["array", "scalar"] as const) {
    const redactor = new SecretRedactor();
    const { context } = createTestContext({ redactor, methodName: method });
    const error = await assertRejects(
      () =>
        service.execute(
          Definition.create({
            name: "delivered",
            methods: { [method]: { arguments: { raw: "hunter2-long" } } },
          }),
          delivering[method],
          context,
        ),
      Error,
      `${method} value`,
    );
    assertEquals(redactor.redact(error.message), `${method} value ***`);
  }
});

Deno.test("execute: a refusal the schema's own code writes at a sensitive position is described in Zod's words with a path segment it introduced masked, a throw's name is reported only when standard, an issue beside the position keeps its message, and an issue above it, or one an enclosing refinement writes beside it, is described too (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const sensitive = z.string().meta({ sensitive: true });
  const cases: Record<
    string,
    { schema: z.ZodTypeAny; args: Record<string, unknown>; expected: string }
  > = {
    issue: {
      schema: z.object({
        token: sensitive.transform((text, ctx) => {
          ctx.addIssue({
            code: "custom",
            message: `derived credential ${text.toUpperCase()}`,
          });
          return z.NEVER;
        }),
      }),
      args: { token: "hunter2-long" },
      expected: 'Method arguments validation failed: Invalid input at "token"',
    },
    issuePath: {
      schema: z.object({
        token: sensitive.transform((text, ctx) => {
          ctx.addIssue({
            code: "custom",
            message: "bad credential",
            path: [text.toUpperCase()],
          });
          return z.NEVER;
        }),
      }),
      args: { token: "hunter2-long" },
      expected:
        'Method arguments validation failed: Invalid input at "token.***"',
    },
    refined: {
      schema: z.object({
        token: sensitive.min(32, "token is too short to be a credential"),
      }),
      args: { token: "hunter2-long" },
      expected: "Method arguments validation failed: Too small: expected " +
        'string to have >=32 characters at "token"',
    },
    errorName: {
      schema: z.object({
        token: sensitive.transform((text): string => {
          const error = new Error("withheld message");
          error.name = `CredentialError:${text.toUpperCase()}`;
          throw error;
        }),
      }),
      args: { token: "hunter2-long" },
      expected: "Method arguments validation failed: the schema threw an " +
        "error while parsing them, and its message is withheld",
    },
    beside: {
      schema: z.object({
        token: sensitive,
        count: z.number().min(1, "count must be positive"),
      }),
      args: { token: "hunter2-long", count: 0 },
      expected:
        'Method arguments validation failed: count must be positive at "count"',
    },
    above: {
      schema: z.object({ token: sensitive, other: z.string() }).refine(
        () => false,
        "exactly one of token or other",
      ),
      args: { token: "hunter2-long", other: "x" },
      expected: "Method arguments validation failed: Invalid input",
    },
    sibling: {
      schema: z.object({ token: sensitive, confirm: z.string() }).superRefine(
        (value, ctx) => {
          ctx.addIssue({
            code: "custom",
            path: ["confirm"],
            message: `confirm must equal ${value.token}`,
          });
        },
      ),
      args: { token: "hunter2-long", confirm: "x" },
      expected:
        'Method arguments validation failed: Invalid input at "confirm"',
    },
    derivedRoot: {
      schema: z.object({ token: sensitive, other: z.string() }).superRefine(
        (value, ctx) => {
          ctx.addIssue({
            code: "custom",
            message: `derived credential ${value.token.toUpperCase()}`,
          });
        },
      ),
      args: { token: "hunter2-long", other: "x" },
      expected: "Method arguments validation failed: Invalid input",
    },
  };
  for (const [method, { schema, args, expected }] of Object.entries(cases)) {
    const redactor = new SecretRedactor();
    redactor.addSecret("hunter2-long");
    const { context } = createTestContext({ redactor, methodName: method });
    const error = await assertRejects(
      () =>
        service.execute(
          Definition.create({
            name: "refused",
            methods: { [method]: { arguments: { ...args } } },
          }),
          {
            description: method,
            arguments: schema,
            execute: () => Promise.resolve({ dataHandles: [] }),
          },
          context,
        ),
      Error,
    );
    assertEquals(error.message.includes("HUNTER2-LONG"), false, method);
    assertEquals(error.message.includes("hunter2-long"), false, method);
    assertStringIncludes(error.message, expected, method);
  }
});

Deno.test("executeWorkflow: a refusal the schema's own code writes at a sensitive global argument is described in Zod's words (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const refusing: ModelDefinition = {
    type: ModelType.create("test/global-issue-secrets"),
    version: "1",
    globalArguments: z.object({
      apiKey: z.string().meta({ sensitive: true }).transform((text, ctx) => {
        ctx.addIssue({
          code: "custom",
          message: `global issue ${text.toUpperCase()}`,
        });
        return z.NEVER;
      }).optional(),
    }),
    methods: {
      run: {
        description: "Never reached",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  const redactor = new SecretRedactor();
  const error = await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({
          name: "refused-global",
          globalArguments: { apiKey: "hunter2-long" },
        }),
        refusing,
        "run",
        createTestContext({ modelType: refusing.type, redactor }).context,
      ),
    Error,
  );
  assertEquals(error.message.includes("HUNTER2-LONG"), false);
  assertEquals(error.message.includes("global issue"), false);
  assertStringIncludes(
    error.message,
    'Global arguments validation failed: Invalid input at "apiKey"',
  );
});

Deno.test("execute: what a transform enclosing a sensitive field delivers is registered with the context's redactor whole, under any key and in any container (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const sensitive = z.string().meta({ sensitive: true });
  const delivering: Record<string, MethodDefinition> = {
    renamed: {
      description: "Delivers the secret under another key",
      arguments: z.object({ secret: sensitive, label: z.string() }).transform(
        ({ secret, label }) => ({ token: secret.toUpperCase(), label }),
      ),
      execute: (args) =>
        Promise.reject(
          new Error(`renamed value ${(args as { token: string }).token}`),
        ),
    },
    nested: {
      description: "Delivers the secret under another key of a nested field",
      arguments: z.object({
        creds: z.object({ secret: sensitive }).transform((o) => ({
          k: `${o.secret.toUpperCase()}-x`,
        })),
        label: z.string(),
      }),
      execute: (args) =>
        Promise.reject(
          new Error(
            `nested value ${(args as { creds: { k: string } }).creds.k}`,
          ),
        ),
    },
    mapped: {
      description: "Delivers the secret in a Map",
      arguments: z.object({ secret: sensitive, label: z.string() }).transform(
        ({ secret }) => new Map([["k", secret.toUpperCase()]]),
      ),
      execute: (args) =>
        Promise.reject(
          new Error(`mapped value ${(args as Map<string, string>).get("k")}`),
        ),
    },
  };
  const argumentsFor: Record<string, Record<string, unknown>> = {
    renamed: { secret: "hunter2-long", label: "prod" },
    nested: { creds: { secret: "hunter2-long" }, label: "prod" },
    mapped: { secret: "hunter2-long", label: "prod" },
  };
  for (const method of Object.keys(delivering)) {
    const redactor = new SecretRedactor();
    const { context } = createTestContext({ redactor, methodName: method });
    const error = await assertRejects(
      () =>
        service.execute(
          Definition.create({
            name: "delivered-under",
            methods: { [method]: { arguments: argumentsFor[method] } },
          }),
          delivering[method],
          context,
        ),
      Error,
      `${method} value`,
    );
    assertEquals(redactor.redact(error.message), `${method} value ***`, method);
    // The label the input holds at a plain position is not a secret.
    assertEquals(redactor.redact("label prod"), "label prod", method);
  }
});

Deno.test("execute: the literal keys a transform enclosing a sensitive field writes are not redactor secrets, while the value it moved under them is (swamp-club#3754)", async () => {
  const service = new DefaultMethodExecutionService();
  const redactor = new SecretRedactor();
  const sensitive = z.string().meta({ sensitive: true });
  const headers: MethodDefinition = {
    description: "Builds request headers from a secret",
    arguments: z.object({ apiKey: sensitive, region: z.string() }).transform(
      ({ apiKey, region }) => ({
        headers: { Authorization: `Bearer ${apiKey.toUpperCase()}` },
        region,
      }),
    ),
    execute: (args) =>
      Promise.reject(
        new Error(
          `headers ${
            JSON.stringify((args as { headers: unknown }).headers)
          } for ${(args as { region: string }).region}`,
        ),
      ),
  };
  const { context } = createTestContext({ redactor, methodName: "send" });
  const error = await assertRejects(
    () =>
      service.execute(
        Definition.create({
          name: "headers",
          methods: {
            send: {
              arguments: { apiKey: "hunter2-long", region: "eu-west-1" },
            },
          },
        }),
        headers,
        context,
      ),
    Error,
    "headers",
  );
  assertEquals(
    redactor.redact(error.message),
    'headers {"Authorization":"***"} for eu-west-1',
  );
  // The identifiers the transform's code wrote stay readable everywhere else.
  assertEquals(
    redactor.redact("request headers: Authorization required"),
    "request headers: Authorization required",
  );
});

Deno.test("executeWorkflow: what a transform enclosing a sensitive global argument delivers is registered with the run's redactor as the method receives it, under any key, and a delivery that is not a record is refused without the value (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const sensitive = z.string().meta({ sensitive: true });
  const renaming: ModelDefinition = {
    type: ModelType.create("test/global-delivered-under"),
    version: "1",
    globalArguments: z.object({ apiKey: sensitive, region: z.string() })
      .transform(({ apiKey, region }) => ({
        key: apiKey.toUpperCase(),
        region,
      })),
    methods: {
      run: {
        description: "Echoes the global it reads into its error",
        arguments: z.object({}),
        execute: (_args, context) =>
          Promise.reject(new Error(`global echoed ${context.globalArgs.key}`)),
      },
    },
  };
  const redactor = new SecretRedactor();
  const error = await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({
          name: "delivered-global-under",
          globalArguments: { apiKey: "hunter2-long", region: "eu-west-1" },
        }),
        renaming,
        "run",
        createTestContext({ modelType: renaming.type, redactor }).context,
      ),
    Error,
    "global echoed",
  );
  assertEquals(redactor.redact(error.message), "global echoed ***");

  const scalar: ModelDefinition = {
    ...renaming,
    type: ModelType.create("test/global-delivered-scalar"),
    globalArguments: z.object({ apiKey: sensitive }).transform(({ apiKey }) =>
      apiKey
    ),
  };
  const refused = await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({
          name: "delivered-global-scalar",
          globalArguments: { apiKey: "hunter2-long" },
        }),
        scalar,
        "run",
        createTestContext({
          modelType: scalar.type,
          redactor: new SecretRedactor(),
        }).context,
      ),
    Error,
    "Global arguments validation failed",
  );
  assertEquals(refused.message.includes("hunter2-long"), false);
  assertEquals(refused.message.includes("HUNTER2-LONG"), false);
});

Deno.test("executeWorkflow: a placed step ships what a transform enclosing a sensitive global argument delivered among its secret values (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    type: ModelType.create("test/remote-delivered-global"),
    version: "1",
    globalArguments: z.object({
      apiKey: z.string().meta({ sensitive: true }),
      region: z.string(),
    }).transform(({ apiKey, region }) => ({
      key: apiKey.toUpperCase(),
      region,
    })),
    methods: {
      start: {
        description: "Runs remotely",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  const captured: RemoteStepRequest[] = [];
  setRemoteStepDispatcher({
    executeRemote: (request) => {
      captured.push(request);
      return Promise.resolve({
        outputs: [],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      });
    },
    releaseAffinity: () => {},
  });
  try {
    const { context } = createTestContext({
      modelType: model.type,
      placement: { labels: { tier: "remote" } },
    });
    await service.executeWorkflow(
      Definition.create({
        name: "remote-delivered",
        globalArguments: { apiKey: "hunter2-long", region: "eu-west-1" },
      }),
      model,
      "start",
      context,
    );
  } finally {
    setRemoteStepDispatcher(null);
  }
  assertEquals(captured.length, 1);
  const { secretValues } = await captured[0].legacyDelivery!();
  assertEquals(secretValues?.includes("HUNTER2-LONG"), true);
  assertEquals(secretValues?.includes("hunter2-long"), true);
  // The plain region the transform passed through is not a worker secret,
  // as it is not a local one (swamp-club#3754).
  assertEquals(secretValues?.includes("eu-west-1"), false);
  // Serve's own redactor masks the authored literal for a version 6 worker.
  assertEquals(captured[0].redactorSeeds, ["hunter2-long"]);
});

Deno.test("execute: a refused parse registers the sensitive value with the run's redactor and leaves the plain values beside it out, for method and global arguments alike (swamp-club#3753)", async () => {
  const service = new DefaultMethodExecutionService();
  const sensitive = z.string().meta({ sensitive: true });
  const schema = z.object({
    token: sensitive.transform((text) => text.toUpperCase()),
    env: z.string(),
    region: z.string(),
  }).refine(
    (v) => v.env !== "prod" || v.region !== "eu-west-1",
    "region not allowed in prod",
  );
  const args = { token: "hunter2-long", env: "prod", region: "eu-west-1" };

  const methodRedactor = new SecretRedactor();
  const { context } = createTestContext({ redactor: methodRedactor });
  const methodError = await assertRejects(
    () =>
      service.execute(
        Definition.create({
          name: "refused",
          methods: { write: { arguments: { ...args } } },
        }),
        {
          description: "Refuses at the root",
          arguments: schema,
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
        context,
      ),
    Error,
  );
  assertStringIncludes(
    methodError.message,
    "Method arguments validation failed: Invalid input",
  );

  const globalRedactor = new SecretRedactor();
  const refusing: ModelDefinition = {
    type: ModelType.create("test/global-refused-plain"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Never reached",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  const globalError = await assertRejects(
    () =>
      service.executeWorkflow(
        Definition.create({ name: "refused-global", globalArguments: args }),
        refusing,
        "run",
        createTestContext({
          modelType: refusing.type,
          redactor: globalRedactor,
        }).context,
      ),
    Error,
  );
  assertStringIncludes(
    globalError.message,
    "Global arguments validation failed: Invalid input",
  );

  for (const redactor of [methodRedactor, globalRedactor]) {
    // What the transform made of the value is the run's secret; the plain
    // values beside it stay readable in every later step's logs and data.
    assertEquals(redactor.redact("made HUNTER2-LONG"), "made ***");
    assertEquals(
      redactor.redact("deployed to prod in eu-west-1"),
      "deployed to prod in eu-west-1",
    );
  }
});

Deno.test("executeWorkflow - a remote-placed step with no worker dispatcher names --server, which runs the workflow on serve (swamp-club#3985)", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createCheckModel({});
  const definition = Definition.create({
    name: "remote-def",
    globalArguments: {},
  });
  setRemoteStepDispatcher(null);
  const { context } = createTestContext({
    modelType: model.type,
    dataRepository: createMockDataRepoWithData([]),
    placement: { labels: { tier: "remote" } },
  });
  const error = await assertRejects(
    () => service.executeWorkflow(definition, model, "create", context),
    UserError,
  );
  assertStringIncludes(error.message, "no worker dispatcher is active");
  assertStringIncludes(error.message, "pass --server <url>");
});

// ── Serve's untrusted argument policy (swamp-club#3862) ─────────────────

async function withUntrustedArguments(fn: () => Promise<void>): Promise<void> {
  const restore = setProcessArgumentParsePolicy("untrusted");
  try {
    await fn();
  } finally {
    restore();
  }
}

function listMethod(): MethodDefinition {
  return {
    description: "Takes a list of names",
    arguments: z.object({ names: z.array(z.string()) }),
    execute: () => Promise.resolve({ dataHandles: [] }),
  };
}

function listDefinition(count: number): Definition {
  return Definition.create({
    name: "names",
    methods: { run: { arguments: { names: Array(count).fill({}) } } },
  });
}

Deno.test("execute: a method argument refusal names every failing element under the trusted policy", async () => {
  const service = new DefaultMethodExecutionService();
  const { context } = createTestContext({ methodName: "run" });
  const error = await assertRejects(
    () => service.execute(listDefinition(3), listMethod(), context),
    Error,
  );
  assertStringIncludes(error.message, "names.0");
  assertStringIncludes(error.message, "names.2");
});

Deno.test("execute: under the untrusted policy a method argument refusal names only the first failing element", async () => {
  await withUntrustedArguments(async () => {
    const service = new DefaultMethodExecutionService();
    const { context } = createTestContext({ methodName: "run" });
    const error = await assertRejects(
      () => service.execute(listDefinition(100_000), listMethod(), context),
      Error,
    );
    assertStringIncludes(error.message, "names.0");
    assertEquals(error.message.includes("names.1"), false);
  });
});

// A refusing check that echoes its input at a sensitive position, in each
// shape a schema can deliver: a record, an array, a scalar.
function refusingShapes(): Record<string, z.ZodTypeAny> {
  const refusing = z.string().meta({ sensitive: true }).refine(() => false, {
    error: (issue) => `credential rejected: ${String(issue.input)}`,
  });
  return {
    record: z.object({ token: refusing }),
    array: z.object({ raw: z.string() }).transform((x) => [x.raw]).pipe(
      z.array(refusing),
    ),
    scalar: z.object({ raw: z.string() }).transform((x) => x.raw).pipe(
      refusing,
    ),
  };
}

function shapeArgs(shape: string): Record<string, unknown> {
  return shape === "record"
    ? { token: "hunter2-long" }
    : { raw: "hunter2-long" };
}

Deno.test("execute: under the untrusted policy a sensitive method argument refusal shows nothing of the value, for a record, an array and a scalar", async () => {
  await withUntrustedArguments(async () => {
    const service = new DefaultMethodExecutionService();
    for (const [shape, schema] of Object.entries(refusingShapes())) {
      const { context } = createTestContext({ methodName: shape });
      const error = await assertRejects(
        () =>
          service.execute(
            Definition.create({
              name: "refused",
              methods: { [shape]: { arguments: shapeArgs(shape) } },
            }),
            {
              description: "Refuses a sensitive value",
              arguments: schema,
              execute: () => Promise.resolve({ dataHandles: [] }),
            },
            context,
          ),
        Error,
      );
      assertEquals(error.message.includes("hunter2-long"), false, shape);
      assertEquals(error.message.includes("credential rejected"), false, shape);
      assertStringIncludes(error.message, "Method arguments validation failed");
    }
  });
});

Deno.test("executeWorkflow: under the untrusted policy a sensitive global argument refusal shows nothing of the value, for a record, an array and a scalar", async () => {
  await withUntrustedArguments(async () => {
    const service = new DefaultMethodExecutionService();
    for (const [shape, schema] of Object.entries(refusingShapes())) {
      const model: ModelDefinition = {
        type: ModelType.create(`test/untrusted-global-${shape}`),
        version: "1",
        globalArguments: schema,
        methods: {
          run: {
            description: "Test method",
            arguments: z.object({}),
            execute: () => Promise.resolve({ dataHandles: [] }),
          },
        },
      };
      const error = await assertRejects(
        () =>
          service.executeWorkflow(
            Definition.create({
              name: "refused-global",
              globalArguments: shapeArgs(shape),
            }),
            model,
            "run",
            createTestContext({ modelType: model.type }).context,
          ),
        Error,
      );
      assertEquals(error.message.includes("hunter2-long"), false, shape);
      assertEquals(error.message.includes("credential rejected"), false, shape);
      assertStringIncludes(error.message, "Global arguments validation failed");
    }
  });
});

// ---------- Protocol version 6 delivery (typed-secrets 5.2) ----------

/** A model whose method records its arguments and the shell's merge. */
function dispatchedModel(): {
  model: ModelDefinition;
  seen: {
    args: Record<string, unknown>[];
    unresolved: (Record<string, unknown> | undefined)[];
    hook: number;
  };
} {
  const seen = {
    args: [] as Record<string, unknown>[],
    unresolved: [] as (Record<string, unknown> | undefined)[],
    hook: 0,
  };
  const model: ModelDefinition = {
    type: ModelType.create("test/dispatched"),
    version: "2026.10.28.1",
    globalArguments: z.object({
      endpoint: z.string().url(),
      command: z.string(),
    }),
    methods: {
      create: {
        description: "Records what it receives",
        arguments: z.object({
          workingDir: z.string().meta({ secrets: "refuse" }).optional(),
        }),
        execute: (args, context) => {
          seen.args.push({ ...(args as object), ...context.globalArgs });
          seen.unresolved.push(context.unresolvedMethodArgs);
          return Promise.resolve({});
        },
        refuseSecretDestinations: () => {
          seen.hook++;
        },
      },
    },
  };
  return { model, seen };
}

Deno.test("executeDispatched: a version 6 runner loads through its own loader, validates the globals, places a global secret through the merge and runs no refusal serve already ran (typed-secrets 5.2)", async () => {
  const service = new DefaultMethodExecutionService();
  const { model, seen } = dispatchedModel();
  // The worker rebuilds the bag from the shipped references.
  const serveBag = new VaultSecretBag(new SecretBagRegistry());
  const endpoint = serveBag.addSecret(
    { vaultName: "v", key: "endpoint" },
    "globalArguments.endpoint",
  );
  const token = serveBag.addSecret(
    { vaultName: "v", key: "token" },
    "globalArguments.command",
  );
  const dir = serveBag.addSecret(
    { vaultName: "v", key: "dir" },
    "methods.create.arguments.workingDir",
  );
  const globalArguments = { endpoint, command: `deploy ${token}` };
  const methodArguments = { workingDir: dir };
  const bag = VaultSecretBag.fromReferenceEntries(
    serveBag.referenceEntriesFor({ globalArguments, methodArguments }),
  );
  const { loader, reads } = mockLoader({
    endpoint: "https://api.example.com",
    token: "s3cret-token",
    dir: "/srv",
  });
  let validated = 0;
  const { context } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: bag,
  });
  await service.executeDispatched(
    Definition.create({
      name: "d",
      globalArguments,
      methods: { create: { arguments: methodArguments } },
    }),
    model,
    "create",
    context,
    {
      secretLoader: loader,
      onArgumentsValidated: () => {
        validated++;
        return Promise.resolve();
      },
    },
  );
  assertEquals(reads.toSorted(), ["dir", "endpoint", "token"]);
  assertEquals(seen.args, [{
    workingDir: "/srv",
    endpoint: "https://api.example.com",
    command: "deploy s3cret-token",
  }]);
  // A secret authored under globalArguments reaches the shell's merge as its
  // sentinel, so it is placed through the environment (swamp-club#3627).
  assertEquals(seen.unresolved[0]?.command, `deploy ${token}`);
  assertEquals(validated, 1);
  // Serve refused before dispatch; the runner does not ask again.
  assertEquals(seen.hook, 0);

  // A global the schema refuses fails on the worker, before the method.
  const { context: refused } = createTestContext({
    modelType: model.type,
    methodName: "create",
    vaultSecrets: VaultSecretBag.fromReferenceEntries([]),
  });
  await assertRejects(
    () =>
      service.executeDispatched(
        Definition.create({
          name: "d",
          globalArguments: { endpoint: "not a url", command: "x" },
          methods: { create: { arguments: {} } },
        }),
        model,
        "create",
        refused,
        { secretLoader: mockLoader({}).loader },
      ),
    Error,
    "Global arguments validation failed",
  );
  assertEquals(seen.args.length, 1);
});

Deno.test("executeWorkflow: a remotely placed step loads nothing before dispatch, and its definition hash is the same on every run (typed-secrets 5.2)", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});
  const hashes: string[] = [];
  const outputRepository = {
    save: (_type: ModelType, _method: string, output: ModelOutput) => {
      if (output.status === "running") {
        hashes.push(output.provenance.definitionHash);
      }
      return Promise.resolve();
    },
  } as unknown as OutputRepository;
  setRemoteStepDispatcher({
    executeRemote: () =>
      Promise.resolve({
        outputs: [],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      }),
    releaseAffinity: () => {},
  });
  const { loader, reads } = mockLoader({ token: "s3cret-value" });
  // One definition, evaluated on two runs.
  const base = Definition.create({ name: "remote-hash", globalArguments: {} });
  try {
    for (let run = 0; run < 2; run++) {
      // Each run issues its own sentinel for the same reference.
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = bag.addSecret(
        { vaultName: "v", key: "token" },
        "methods.start.arguments.value",
      );
      const { context } = createTestContext({
        modelType: model.type,
        placement: { labels: { tier: "remote" } },
        vaultSecrets: bag,
        outputRepository,
      });
      await service.executeWorkflow(
        Definition.fromData({
          ...base.toData(),
          methods: { start: { arguments: { value: `t ${sentinel}` } } },
        }),
        model,
        "start",
        context,
        { secretLoader: loader },
      );
    }
  } finally {
    setRemoteStepDispatcher(null);
  }
  assertEquals(reads, []);
  assertEquals(hashes.length, 2);
  assertEquals(hashes[0], hashes[1]);
});

Deno.test("executeWorkflow: a remote attempt calls onArgumentsValidated once, whichever workers report it (swamp-club#3681)", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});
  let calls = 0;
  setRemoteStepDispatcher({
    executeRemote: async (request) => {
      // A version 5 worker's frame, then two version 6 workers after it.
      await request.legacyDelivery?.();
      await request.onArgumentsValidated?.();
      await request.onArgumentsValidated?.();
      return { outputs: [], logs: [], durationMs: 1, workerName: "w1" };
    },
    releaseAffinity: () => {},
  });
  try {
    const { context } = createTestContext({
      modelType: model.type,
      placement: { labels: { tier: "remote" } },
    });
    await service.executeWorkflow(
      Definition.create({
        name: "once",
        methods: { start: { arguments: { value: "x" } } },
      }),
      model,
      "start",
      context,
      {
        onArgumentsValidated: () => {
          calls++;
          return Promise.resolve();
        },
      },
    );
  } finally {
    setRemoteStepDispatcher(null);
  }
  assertEquals(calls, 1);
});

Deno.test("executeWorkflow: a remotely placed step whose arguments hold no secret is refused before it is scheduled, and the dispatcher is never asked for a worker", async () => {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    type: ModelType.create("test/fail-fast-placed"),
    version: "2026.10.28.1",
    globalArguments: z.object({ region: z.enum(["us", "eu"]).optional() }),
    methods: {
      write: {
        description: "Runs on a worker",
        arguments: z.object({ message: z.string().min(1) }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  let scheduled = 0;
  let validated = 0;
  setRemoteStepDispatcher({
    // As serve schedules for a version 6 worker: no legacy delivery.
    executeRemote: () => {
      scheduled++;
      return Promise.resolve({
        outputs: [],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      });
    },
    releaseAffinity: () => {},
  });
  const hook = () => {
    validated++;
    return Promise.resolve();
  };
  try {
    const { context } = createTestContext({
      modelType: model.type,
      placement: { labels: { tier: "remote" } },
    });
    await assertRejects(
      () =>
        service.executeWorkflow(
          Definition.create({
            name: "bad-method-arg",
            methods: { write: { arguments: { message: "" } } },
          }),
          model,
          "write",
          context,
          { onArgumentsValidated: hook },
        ),
      Error,
      "Method arguments validation failed",
    );
    await assertRejects(
      () =>
        service.executeWorkflow(
          Definition.create({
            name: "bad-global-arg",
            globalArguments: { region: "mars" },
            methods: { write: { arguments: { message: "hi" } } },
          }),
          model,
          "write",
          context,
          { onArgumentsValidated: hook },
        ),
      Error,
      "Global arguments validation failed",
    );
    assertEquals(scheduled, 0);
    assertEquals(validated, 0);

    // A valid step is validated before it is scheduled, as before.
    await service.executeWorkflow(
      Definition.create({
        name: "valid",
        globalArguments: { region: "eu" },
        methods: { write: { arguments: { message: "hi" } } },
      }),
      model,
      "write",
      context,
      { onArgumentsValidated: hook },
    );
    assertEquals(scheduled, 1);
    assertEquals(validated, 1);
  } finally {
    setRemoteStepDispatcher(null);
  }
});

Deno.test("executeWorkflow: a remotely placed step holding a secret has its other arguments checked before it is scheduled, reading no vault, and leaves the secret's field to the worker", async () => {
  const service = new DefaultMethodExecutionService();
  const model: ModelDefinition = {
    type: ModelType.create("test/fail-fast-placed-secret"),
    version: "2026.10.28.1",
    globalArguments: z.object({
      // A sentinel is not a URL, so this field can only be checked once
      // its value is loaded.
      endpoint: z.string().url().optional(),
      region: z.enum(["us", "eu"]).optional(),
    }),
    methods: {
      write: {
        description: "Runs on a worker",
        arguments: z.object({
          token: z.string().startsWith("tok-"),
          count: z.number(),
        }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  let scheduled = 0;
  let validatedBeforeScheduling = 0;
  let validated = 0;
  setRemoteStepDispatcher({
    executeRemote: () => {
      scheduled++;
      validatedBeforeScheduling += validated;
      return Promise.resolve({
        outputs: [],
        logs: [],
        durationMs: 1,
        workerName: "w1",
      });
    },
    releaseAffinity: () => {},
  });
  const { loader, reads } = mockLoader({
    endpoint: "https://api.example.com",
    token: "tok-123",
  });
  const run = (
    globalArguments: Record<string, unknown>,
    methodArguments: (token: string) => Record<string, unknown>,
  ) => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const endpoint = bag.addSecret(
      { vaultName: "v", key: "endpoint" },
      "globalArguments.endpoint",
    );
    const token = bag.addSecret(
      { vaultName: "v", key: "token" },
      "methods.write.arguments.token",
    );
    const { context } = createTestContext({
      modelType: model.type,
      placement: { labels: { tier: "remote" } },
      vaultSecrets: bag,
    });
    return service.executeWorkflow(
      Definition.create({
        name: "placed",
        globalArguments: { endpoint, ...globalArguments },
        methods: { write: { arguments: methodArguments(token) } },
      }),
      model,
      "write",
      context,
      {
        secretLoader: loader,
        onArgumentsValidated: () => {
          validated++;
          return Promise.resolve();
        },
      },
    );
  };
  try {
    await assertRejects(
      () => run({}, (token) => ({ token, count: { nested: true } })),
      Error,
      "Method arguments validation failed",
    );
    await assertRejects(
      () => run({ region: "mars" }, (token) => ({ token, count: 1 })),
      Error,
      "Global arguments validation failed",
    );
    assertEquals(scheduled, 0);

    // The fields holding sentinels pass to the worker unchecked, and the
    // hook waits for the parse that reads their values.
    await run({ region: "us" }, (token) => ({ token, count: 1 }));
    assertEquals(scheduled, 1);
    assertEquals(validatedBeforeScheduling, 0);
    assertEquals(reads, []);
  } finally {
    setRemoteStepDispatcher(null);
  }
});
