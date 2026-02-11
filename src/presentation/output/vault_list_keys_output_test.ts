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
  renderVaultListKeys,
  type VaultListKeysData,
} from "./vault_list_keys_output.ts";

await initializeLogging({});

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

Deno.test("renderVaultListKeys with log mode does not throw", () => {
  renderVaultListKeys(testDataWithSecrets, "log");
});
