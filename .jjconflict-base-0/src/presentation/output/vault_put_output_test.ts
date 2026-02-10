import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderVaultPut,
  renderVaultPutCancelled,
  type VaultPutData,
} from "./vault_put_output.ts";

await initializeLogging({});

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

Deno.test("renderVaultPut with log mode does not throw", () => {
  renderVaultPut(testData, "log");
});
