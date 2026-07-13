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
import { JsonlVaultAuditRepository } from "./jsonl_vault_audit_repository.ts";
import type { VaultAuditEntry } from "../../domain/vaults/vault_audit_entry.ts";

function withTempDir(
  fn: (dir: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = await Deno.makeTempDir({ prefix: "vault-audit-test-" });
    try {
      await fn(dir);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  };
}

function makeEntry(overrides: Partial<VaultAuditEntry> = {}): VaultAuditEntry {
  return {
    timestamp: "2026-07-10T12:00:00.000Z",
    vaultName: "my-vault",
    vaultType: "local_encryption",
    secretKey: "API_KEY",
    callerContext: "cli:vault-read-secret",
    ...overrides,
  };
}

Deno.test(
  "JsonlVaultAuditRepository: append and findByTimeRange round-trip",
  withTempDir(async (dir) => {
    const repo = new JsonlVaultAuditRepository("", dir);
    const entry = makeEntry();

    await repo.append(entry);

    const results = await repo.findByTimeRange(
      new Date("2026-07-10T00:00:00Z"),
      new Date("2026-07-10T23:59:59Z"),
    );

    assertEquals(results.length, 1);
    assertEquals(results[0].vaultName, "my-vault");
    assertEquals(results[0].secretKey, "API_KEY");
    assertEquals(results[0].callerContext, "cli:vault-read-secret");
  }),
);

Deno.test(
  "JsonlVaultAuditRepository: filters by vaultName",
  withTempDir(async (dir) => {
    const repo = new JsonlVaultAuditRepository("", dir);

    await repo.append(makeEntry({ vaultName: "vault-a" }));
    await repo.append(makeEntry({ vaultName: "vault-b" }));

    const results = await repo.findByTimeRange(
      new Date("2026-07-10T00:00:00Z"),
      new Date("2026-07-10T23:59:59Z"),
      { vaultName: "vault-a" },
    );

    assertEquals(results.length, 1);
    assertEquals(results[0].vaultName, "vault-a");
  }),
);

Deno.test(
  "JsonlVaultAuditRepository: filters by secretKey",
  withTempDir(async (dir) => {
    const repo = new JsonlVaultAuditRepository("", dir);

    await repo.append(makeEntry({ secretKey: "KEY_A" }));
    await repo.append(makeEntry({ secretKey: "KEY_B" }));

    const results = await repo.findByTimeRange(
      new Date("2026-07-10T00:00:00Z"),
      new Date("2026-07-10T23:59:59Z"),
      { secretKey: "KEY_B" },
    );

    assertEquals(results.length, 1);
    assertEquals(results[0].secretKey, "KEY_B");
  }),
);

Deno.test(
  "JsonlVaultAuditRepository: respects limit",
  withTempDir(async (dir) => {
    const repo = new JsonlVaultAuditRepository("", dir);

    await repo.append(makeEntry({ secretKey: "KEY_1" }));
    await repo.append(makeEntry({ secretKey: "KEY_2" }));
    await repo.append(makeEntry({ secretKey: "KEY_3" }));

    const results = await repo.findByTimeRange(
      new Date("2026-07-10T00:00:00Z"),
      new Date("2026-07-10T23:59:59Z"),
      { limit: 2 },
    );

    assertEquals(results.length, 2);
  }),
);

Deno.test(
  "JsonlVaultAuditRepository: returns empty array for no matching data",
  withTempDir(async (dir) => {
    const repo = new JsonlVaultAuditRepository("", dir);

    const results = await repo.findByTimeRange(
      new Date("2026-07-10T00:00:00Z"),
      new Date("2026-07-10T23:59:59Z"),
    );

    assertEquals(results.length, 0);
  }),
);

Deno.test(
  "JsonlVaultAuditRepository: filters by time range",
  withTempDir(async (dir) => {
    const repo = new JsonlVaultAuditRepository("", dir);

    await repo.append(
      makeEntry({ timestamp: "2026-07-10T08:00:00.000Z", secretKey: "EARLY" }),
    );
    await repo.append(
      makeEntry({ timestamp: "2026-07-10T16:00:00.000Z", secretKey: "LATE" }),
    );

    const results = await repo.findByTimeRange(
      new Date("2026-07-10T12:00:00Z"),
      new Date("2026-07-10T23:59:59Z"),
    );

    assertEquals(results.length, 1);
    assertEquals(results[0].secretKey, "LATE");
  }),
);
