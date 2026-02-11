import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDefinitionId,
  Definition,
} from "../../definitions/definition.ts";
import {
  VAULT_MODEL_TYPE,
  VaultInputAttributesSchema,
  vaultModel,
} from "./vault_model.ts";
import type { DataHandle, DataWriter, MethodContext } from "../model.ts";
import type { UnifiedDataRepository } from "../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../definitions/repositories.ts";
import { type DataId, generateDataId } from "../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

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
        contentType: "text/plain",
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
 * Helper to get parsed JSON content from the first mock result.
 */
function getResultAttributes(
  results: MockWriterResult[],
  index = 0,
): Record<string, unknown> | undefined {
  if (results.length <= index) return undefined;
  return JSON.parse(new TextDecoder().decode(results[index].content));
}

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
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
function createTestContext(repoDir: string): {
  context: MethodContext;
  getResults: () => MockWriterResult[];
} {
  const { writeResource, createFileWriter, getResults } = createMockWriters();
  const context: MethodContext = {
    repoDir,
    modelType: VAULT_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    globalArgs: {},
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    methodName: "get",
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    writeResource,
    createFileWriter,
  };
  return { context, getResults };
}

Deno.test("VAULT_MODEL_TYPE has correct normalized type", () => {
  assertEquals(VAULT_MODEL_TYPE.normalized, "swamp/lets-get-sensitive");
});

Deno.test("vaultModel has correct version", () => {
  assertEquals(vaultModel.version, "2026.02.09.1");
});

Deno.test("vaultModel.type equals VAULT_MODEL_TYPE", () => {
  assertEquals(vaultModel.type.equals(VAULT_MODEL_TYPE), true);
});

Deno.test("VaultInputAttributesSchema validates get operation", () => {
  const result = VaultInputAttributesSchema.safeParse({
    vaultName: "aws",
    secretKey: "test-key",
    operation: "get",
  });
  assertEquals(result.success, true);
});

Deno.test("VaultInputAttributesSchema validates put operation", () => {
  const result = VaultInputAttributesSchema.safeParse({
    vaultName: "aws",
    secretKey: "test-key",
    secretValue: "secret-value",
    operation: "put",
  });
  assertEquals(result.success, true);
});

async function withTestRepo<T>(
  fn: (repoDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await Deno.makeTempDir();
  try {
    // Create a test vault configuration in .swamp/vault/
    const vaultDir = `${tempDir}/.swamp/vault/local_encryption`;
    await Deno.mkdir(vaultDir, { recursive: true });
    await Deno.writeTextFile(
      `${vaultDir}/test-vault-id.yaml`,
      `id: test-vault-id
name: test-vault
type: local_encryption
config:
  auto_generate: true
createdAt: "2024-01-01T00:00:00.000Z"
`,
    );

    return await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("Vault Model - Get Operation", async () => {
  await withTestRepo(async (repoDir) => {
    // First store a secret
    const putDefinition = Definition.create({
      name: "test-vault-put-setup",
      globalArguments: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        secretValue: "test-secret-value",
        operation: "put",
      },
    });

    const { context: putContext } = createTestContext(repoDir);
    await vaultModel.methods.put.execute(
      putDefinition.globalArguments,
      putContext,
    );

    // Now test getting the secret
    const getDefinition = Definition.create({
      name: "test-vault-get",
      globalArguments: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        operation: "get",
      },
    });

    const { context, getResults } = createTestContext(repoDir);
    await vaultModel.methods.get.execute(
      getDefinition.globalArguments,
      context,
    );

    const attrs = getResultAttributes(getResults());
    assertEquals(attrs !== undefined, true);
    assertEquals(attrs?.vaultName, "test-vault");
    assertEquals(attrs?.secretKey, "test-secret-key");
    assertEquals(attrs?.operation, "get");
    assertEquals(attrs?.success, true);
    assertEquals(attrs?.secretLength, "test-secret-value".length);
  });
});

Deno.test("Vault Model - Put Operation", async () => {
  await withTestRepo(async (repoDir) => {
    const definition = Definition.create({
      name: "test-vault-put",
      globalArguments: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        secretValue: "test-secret-value",
        operation: "put",
      },
    });

    const { context, getResults } = createTestContext(repoDir);
    await vaultModel.methods.put.execute(definition.globalArguments, context);

    const attrs = getResultAttributes(getResults());
    assertEquals(attrs !== undefined, true);
    assertEquals(attrs?.vaultName, "test-vault");
    assertEquals(attrs?.secretKey, "test-secret-key");
    assertEquals(attrs?.operation, "put");
    assertEquals(attrs?.success, true);
    assertEquals(attrs?.storedKey, "test-secret-key");
  });
});

Deno.test("Vault Model - Get with wrong operation fails", async () => {
  const definition = Definition.create({
    name: "test-vault-wrong-op",
    globalArguments: {
      vaultName: "aws",
      secretKey: "test-secret-key",
      operation: "put", // Wrong operation for get method
    },
  });

  const { context } = createTestContext("/tmp/test");

  try {
    await vaultModel.methods.get.execute(definition.globalArguments, context);
    assertEquals(true, false, "Expected error for wrong operation");
  } catch (error) {
    assertStringIncludes(
      (error as Error).message,
      "Get method requires operation to be 'get'",
    );
  }
});

Deno.test("Vault Model - Put without secretValue fails", async () => {
  const definition = Definition.create({
    name: "test-vault-no-value",
    globalArguments: {
      vaultName: "aws",
      secretKey: "test-secret-key",
      operation: "put",
      // Missing secretValue
    },
  });

  const { context } = createTestContext("/tmp/test");

  try {
    await vaultModel.methods.put.execute(definition.globalArguments, context);
    assertEquals(true, false, "Expected error for missing secretValue");
  } catch (error) {
    assertStringIncludes(
      (error as Error).message,
      "Put method requires secretValue to be provided",
    );
  }
});
