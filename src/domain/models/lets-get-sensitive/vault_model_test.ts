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
import type { MethodContext } from "../model.ts";
import type { UnifiedDataRepository } from "../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../definitions/repositories.ts";
import { generateDataId } from "../../data/data_id.ts";

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
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
function createTestContext(repoDir: string): MethodContext {
  return {
    repoDir,
    modelType: VAULT_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
  };
}

/**
 * Helper to get attributes from a DataOutput.
 */
function getDataOutputAttributes(
  dataOutputs: { content: Uint8Array }[] | undefined,
  index = 0,
): Record<string, unknown> | undefined {
  if (!dataOutputs || dataOutputs.length <= index) {
    return undefined;
  }
  const content = new TextDecoder().decode(dataOutputs[index].content);
  return JSON.parse(content);
}

Deno.test("VAULT_MODEL_TYPE has correct normalized type", () => {
  assertEquals(VAULT_MODEL_TYPE.normalized, "swamp/lets-get-sensitive");
});

Deno.test("vaultModel has correct version", () => {
  assertEquals(vaultModel.version, 1);
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
      attributes: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        secretValue: "test-secret-value",
        operation: "put",
      },
    });

    const context = createTestContext(repoDir);
    await vaultModel.methods.put.execute(putDefinition, context);

    // Now test getting the secret
    const getDefinition = Definition.create({
      name: "test-vault-get",
      attributes: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        operation: "get",
      },
    });

    const result = await vaultModel.methods.get.execute(getDefinition, context);

    const attrs = getDataOutputAttributes(result.dataOutputs);
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
      attributes: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        secretValue: "test-secret-value",
        operation: "put",
      },
    });

    const context = createTestContext(repoDir);
    const result = await vaultModel.methods.put.execute(definition, context);

    const attrs = getDataOutputAttributes(result.dataOutputs);
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
    attributes: {
      vaultName: "aws",
      secretKey: "test-secret-key",
      operation: "put", // Wrong operation for get method
    },
  });

  const context = createTestContext("/tmp/test");

  try {
    await vaultModel.methods.get.execute(definition, context);
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
    attributes: {
      vaultName: "aws",
      secretKey: "test-secret-key",
      operation: "put",
      // Missing secretValue
    },
  });

  const context = createTestContext("/tmp/test");

  try {
    await vaultModel.methods.put.execute(definition, context);
    assertEquals(true, false, "Expected error for missing secretValue");
  } catch (error) {
    assertStringIncludes(
      (error as Error).message,
      "Put method requires secretValue to be provided",
    );
  }
});
