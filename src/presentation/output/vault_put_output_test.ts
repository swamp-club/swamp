// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
