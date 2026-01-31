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

Deno.test("Vault Model - Get Operation", async () => {
  const input = ModelInput.create({
    name: "test-vault-get",
    version: 1,
    attributes: {
      vaultName: "aws",
      secretKey: "test-secret-key",
      operation: "get",
    },
  });

  const context = {
    repoDir: "/tmp/test",
  };

  const result = await vaultModel.methods.get.execute(input, context);

  assertEquals(result.data !== undefined, true);
  if (result.data) {
    assertEquals(result.data.attributes.vaultName, "aws");
    assertEquals(result.data.attributes.secretKey, "test-secret-key");
    assertEquals(result.data.attributes.operation, "get");
    // Success depends on AWS credentials and secret existence
    assertEquals(typeof result.data.attributes.success, "boolean");
    if (result.data.attributes.success) {
      assertEquals(typeof result.data.attributes.retrievedValue, "string");
    } else {
      assertEquals(typeof result.data.attributes.error, "string");
    }
  }
});

Deno.test("Vault Model - Put Operation", async () => {
  const input = ModelInput.create({
    name: "test-vault-put",
    version: 1,
    attributes: {
      vaultName: "aws",
      secretKey: "test-secret-key",
      secretValue: "sensitive-data-value",
      operation: "put",
    },
  });

  const context = {
    repoDir: "/tmp/test",
  };

  const result = await vaultModel.methods.put.execute(input, context);

  assertEquals(result.data !== undefined, true);
  if (result.data) {
    assertEquals(result.data.attributes.vaultName, "aws");
    assertEquals(result.data.attributes.secretKey, "test-secret-key");
    assertEquals(result.data.attributes.operation, "put");
    // Success depends on AWS credentials and permissions
    assertEquals(typeof result.data.attributes.success, "boolean");
    if (result.data.attributes.success) {
      assertEquals(result.data.attributes.storedKey, "test-secret-key");
    } else {
      assertEquals(typeof result.data.attributes.error, "string");
    }
  }
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
