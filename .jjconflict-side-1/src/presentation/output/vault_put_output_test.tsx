// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderVaultPut,
  renderVaultPutCancelled,
  VaultPutCancelledDisplay,
  type VaultPutData,
  VaultPutDisplay,
} from "./vault_put_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: VaultPutData = {
  vaultName: "test-vault",
  secretKey: "api-key",
  vaultType: "local_encryption",
  overwritten: false,
  timestamp: "2025-01-31T12:00:00.000Z",
};

const testDataOverwritten: VaultPutData = {
  vaultName: "test-vault",
  secretKey: "api-key",
  vaultType: "local_encryption",
  overwritten: true,
  timestamp: "2025-01-31T12:00:00.000Z",
};

Deno.test({
  name: "VaultPutDisplay renders all fields",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<VaultPutDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-vault");
    assertStringIncludes(output, "api-key");
    assertStringIncludes(output, "local_encryption");
  },
});

Deno.test({
  name: "VaultPutDisplay shows 'Stored' message for new secrets",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<VaultPutDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Stored secret");
  },
});

Deno.test({
  name: "VaultPutDisplay shows 'Updated' message for overwritten secrets",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <VaultPutDisplay data={testDataOverwritten} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Updated secret");
  },
});

Deno.test("renderVaultPut with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVaultPut(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.vaultName, testData.vaultName);
    assertEquals(parsed.secretKey, testData.secretKey);
    assertEquals(parsed.vaultType, testData.vaultType);
    assertEquals(parsed.overwritten, false);
    assertEquals(parsed.timestamp, testData.timestamp);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderVaultPut with json mode includes overwritten flag", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVaultPut(testDataOverwritten, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.overwritten, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test({
  name: "VaultPutCancelledDisplay shows cancellation message",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<VaultPutCancelledDisplay />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Operation cancelled");
  },
});

Deno.test("renderVaultPutCancelled outputs JSON in json mode", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVaultPutCancelled("json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.cancelled, true);
  } finally {
    console.log = originalLog;
  }
});
