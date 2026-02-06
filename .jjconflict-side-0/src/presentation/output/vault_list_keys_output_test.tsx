// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderVaultListKeys,
  type VaultListKeysData,
  VaultListKeysDisplay,
} from "./vault_list_keys_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testDataWithSecrets: VaultListKeysData = {
  vaultName: "test-vault",
  vaultType: "local_encryption",
  secretKeys: ["api-key", "database-password", "jwt-secret"],
  count: 3,
};

const testDataEmpty: VaultListKeysData = {
  vaultName: "empty-vault",
  vaultType: "aws",
  secretKeys: [],
  count: 0,
};

Deno.test({
  name: "VaultListKeysDisplay renders vault name",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <VaultListKeysDisplay data={testDataWithSecrets} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-vault");
  },
});

Deno.test({
  name: "VaultListKeysDisplay renders vault type",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <VaultListKeysDisplay data={testDataWithSecrets} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "local_encryption");
  },
});

Deno.test({
  name: "VaultListKeysDisplay renders secret count",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <VaultListKeysDisplay data={testDataWithSecrets} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "3");
  },
});

Deno.test({
  name: "VaultListKeysDisplay renders all secret keys",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <VaultListKeysDisplay data={testDataWithSecrets} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "api-key");
    assertStringIncludes(output, "database-password");
    assertStringIncludes(output, "jwt-secret");
  },
});

Deno.test({
  name: "VaultListKeysDisplay shows 'no secret keys' message when empty",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<VaultListKeysDisplay data={testDataEmpty} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "no secret keys stored");
  },
});

Deno.test("renderVaultListKeys with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVaultListKeys(testDataWithSecrets, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.vaultName, "test-vault");
    assertEquals(parsed.vaultType, "local_encryption");
    assertEquals(parsed.secretKeys.length, 3);
    assertEquals(parsed.count, 3);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderVaultListKeys with json mode handles empty secrets", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVaultListKeys(testDataEmpty, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.vaultName, "empty-vault");
    assertEquals(parsed.secretKeys.length, 0);
    assertEquals(parsed.count, 0);
  } finally {
    console.log = originalLog;
  }
});
