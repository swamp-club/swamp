// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import {
  createVaultAuditEntry,
  vaultAuditEntryFromData,
  vaultAuditEntryToData,
} from "./vault_audit_entry.ts";

Deno.test("createVaultAuditEntry: creates entry with all fields", () => {
  const entry = createVaultAuditEntry(
    "my-vault",
    "local_encryption",
    "API_KEY",
    "cli:vault-read-secret",
  );

  assertEquals(entry.vaultName, "my-vault");
  assertEquals(entry.vaultType, "local_encryption");
  assertEquals(entry.secretKey, "API_KEY");
  assertEquals(entry.callerContext, "cli:vault-read-secret");
  assertEquals(typeof entry.timestamp, "string");
  assertEquals(new Date(entry.timestamp).toISOString(), entry.timestamp);
});

Deno.test("vaultAuditEntryToData: serializes entry to data", () => {
  const entry = createVaultAuditEntry(
    "my-vault",
    "local_encryption",
    "DB_PASS",
    "model:mytype/myid:exec",
  );

  const data = vaultAuditEntryToData(entry);

  assertEquals(data.vaultName, "my-vault");
  assertEquals(data.vaultType, "local_encryption");
  assertEquals(data.secretKey, "DB_PASS");
  assertEquals(data.callerContext, "model:mytype/myid:exec");
  assertEquals(data.timestamp, entry.timestamp);
});

Deno.test("vaultAuditEntryFromData: deserializes data to entry", () => {
  const data = {
    timestamp: "2026-07-10T12:00:00.000Z",
    vaultName: "prod-vault",
    vaultType: "@swamp/aws-sm",
    secretKey: "TOKEN",
    callerContext: "unknown",
  };

  const entry = vaultAuditEntryFromData(data);

  assertEquals(entry.timestamp, "2026-07-10T12:00:00.000Z");
  assertEquals(entry.vaultName, "prod-vault");
  assertEquals(entry.vaultType, "@swamp/aws-sm");
  assertEquals(entry.secretKey, "TOKEN");
  assertEquals(entry.callerContext, "unknown");
});

Deno.test("vaultAuditEntry: round-trip preserves all fields", () => {
  const original = createVaultAuditEntry(
    "test-vault",
    "local_encryption",
    "MY_SECRET",
    "cli:vault-inspect",
  );

  const data = vaultAuditEntryToData(original);
  const restored = vaultAuditEntryFromData(data);

  assertEquals(restored.timestamp, original.timestamp);
  assertEquals(restored.vaultName, original.vaultName);
  assertEquals(restored.vaultType, original.vaultType);
  assertEquals(restored.secretKey, original.secretKey);
  assertEquals(restored.callerContext, original.callerContext);
});
