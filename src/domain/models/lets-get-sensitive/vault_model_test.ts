import { assertEquals, assertStringIncludes } from "@std/assert";
import { ModelInput } from "../model_input.ts";
import {
  VAULT_MODEL_TYPE,
  VaultInputAttributesSchema,
  vaultModel,
} from "./vault_model.ts";

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
    // Create a test vault configuration in .data/vault/
    const vaultDir = `${tempDir}/.data/vault/local_encryption`;
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
    const putInput = ModelInput.create({
      name: "test-vault-put-setup",
      version: 1,
      attributes: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        secretValue: "test-secret-value",
        operation: "put",
      },
    });

    await vaultModel.methods.put.execute(putInput, { repoDir });

    // Now test getting the secret
    const getInput = ModelInput.create({
      name: "test-vault-get",
      version: 1,
      attributes: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        operation: "get",
      },
    });

    const result = await vaultModel.methods.get.execute(getInput, { repoDir });

    assertEquals(result.data !== undefined, true);
    if (result.data) {
      assertEquals(result.data.attributes.vaultName, "test-vault");
      assertEquals(result.data.attributes.secretKey, "test-secret-key");
      assertEquals(result.data.attributes.operation, "get");
      assertEquals(result.data.attributes.success, true);
      assertEquals(
        result.data.attributes.secretLength,
        "test-secret-value".length,
      );
    }
  });
});

Deno.test("Vault Model - Put Operation", async () => {
  await withTestRepo(async (repoDir) => {
    const input = ModelInput.create({
      name: "test-vault-put",
      version: 1,
      attributes: {
        vaultName: "test-vault",
        secretKey: "test-secret-key",
        secretValue: "test-secret-value",
        operation: "put",
      },
    });

    const result = await vaultModel.methods.put.execute(input, { repoDir });

    assertEquals(result.data !== undefined, true);
    if (result.data) {
      assertEquals(result.data.attributes.vaultName, "test-vault");
      assertEquals(result.data.attributes.secretKey, "test-secret-key");
      assertEquals(result.data.attributes.operation, "put");
      assertEquals(result.data.attributes.success, true);
      assertEquals(result.data.attributes.storedKey, "test-secret-key");
    }
  });
});

Deno.test("Vault Model - Get with wrong operation fails", async () => {
  const input = ModelInput.create({
    name: "test-vault-wrong-op",
    version: 1,
    attributes: {
      vaultName: "aws",
      secretKey: "test-secret-key",
      operation: "put", // Wrong operation for get method
    },
  });

  const context = {
    repoDir: "/tmp/test",
  };

  try {
    await vaultModel.methods.get.execute(input, context);
    assertEquals(true, false, "Expected error for wrong operation");
  } catch (error) {
    assertStringIncludes(
      (error as Error).message,
      "Get method requires operation to be 'get'",
    );
  }
});

Deno.test("Vault Model - Put without secretValue fails", async () => {
  const input = ModelInput.create({
    name: "test-vault-no-value",
    version: 1,
    attributes: {
      vaultName: "aws",
      secretKey: "test-secret-key",
      operation: "put",
      // Missing secretValue
    },
  });

  const context = {
    repoDir: "/tmp/test",
  };

  try {
    await vaultModel.methods.put.execute(input, context);
    assertEquals(true, false, "Expected error for missing secretValue");
  } catch (error) {
    assertStringIncludes(
      (error as Error).message,
      "Put method requires secretValue to be provided",
    );
  }
});
