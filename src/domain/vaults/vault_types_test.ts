import { assertEquals, assertExists } from "@std/assert";
import { getVaultType, getVaultTypes, VAULT_TYPES } from "./vault_types.ts";

Deno.test("VAULT_TYPES contains expected types", () => {
  const types = VAULT_TYPES.map((v) => v.type);
  assertEquals(types.includes("aws"), true);
  assertEquals(types.includes("local_encryption"), true);
  // mock vault is excluded from public listing (internal testing only)
  assertEquals(types.includes("mock"), false);
});

Deno.test("getVaultTypes returns all vault types", () => {
  const types = getVaultTypes();
  assertEquals(types.length, 2);
  assertEquals(types, VAULT_TYPES);
});

Deno.test("getVaultType returns vault type by identifier", () => {
  const aws = getVaultType("aws");
  assertExists(aws);
  assertEquals(aws.type, "aws");
  assertEquals(aws.name, "AWS Secrets Manager");

  const local = getVaultType("local_encryption");
  assertExists(local);
  assertEquals(local.type, "local_encryption");
});

Deno.test("getVaultType is case-insensitive", () => {
  const aws = getVaultType("AWS");
  assertExists(aws);
  assertEquals(aws.type, "aws");

  const local = getVaultType("LOCAL_ENCRYPTION");
  assertExists(local);
  assertEquals(local.type, "local_encryption");
});

Deno.test("getVaultType returns undefined for unknown type", () => {
  const unknown = getVaultType("unknown");
  assertEquals(unknown, undefined);

  const empty = getVaultType("");
  assertEquals(empty, undefined);
});

Deno.test("all vault types have required fields", () => {
  for (const vaultType of VAULT_TYPES) {
    assertExists(vaultType.type);
    assertExists(vaultType.name);
    assertExists(vaultType.description);
    assertEquals(vaultType.type.length > 0, true);
    assertEquals(vaultType.name.length > 0, true);
    assertEquals(vaultType.description.length > 0, true);
  }
});
