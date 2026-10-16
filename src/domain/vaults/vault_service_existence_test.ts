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

/**
 * VaultService.has() and supportsExistenceCheck(): the existence capability
 * behind the run vault access scope, with no refresh, no audit and no value
 * read.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  createVaultTestContext,
  type VaultTestContextOptions,
  type VaultTestContextResult,
} from "@swamp-club/swamp-testing";
import { VaultService } from "./vault_service.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
  VaultAccessDeniedError,
} from "./run_vault_access.ts";
import type { VaultAuditEntry } from "./vault_audit_entry.ts";
import type {
  VaultAuditQueryOptions,
  VaultAuditRepository,
} from "./vault_audit_repository.ts";

/**
 * Registers a per-run vault type backed by the testing package's in-memory
 * vault and binds it under `vaultName`. Both built-in types implement has(),
 * so a provider without it has to come from here (withExistence unset).
 */
async function withTestVault(
  vaultName: string,
  options: VaultTestContextOptions,
  fn: (service: VaultService, ctx: VaultTestContextResult) => Promise<void>,
): Promise<void> {
  const type = `@test/existence-${crypto.randomUUID()}`;
  const ctx = createVaultTestContext({ name: vaultName, ...options });
  vaultTypeRegistry.register({
    type,
    name: "Existence test vault",
    description: "In-memory vault for VaultService existence tests",
    isBuiltIn: false,
    createProvider: () => ctx.vault,
  });
  try {
    const service = new VaultService();
    service.registerVault({ name: vaultName, type, config: {} });
    await fn(service, ctx);
  } finally {
    vaultTypeRegistry.invalidateType(type);
  }
}

class InMemoryVaultAuditRepository implements VaultAuditRepository {
  entries: VaultAuditEntry[] = [];

  async append(entry: VaultAuditEntry): Promise<void> {
    this.entries.push(entry);
    await Promise.resolve();
  }

  async findByTimeRange(
    _startTime: Date,
    _endTime: Date,
    _options?: VaultAuditQueryOptions,
  ): Promise<VaultAuditEntry[]> {
    return await Promise.resolve(this.entries);
  }
}

Deno.test("supportsExistenceCheck: true for a provider with has()", () => {
  const service = new VaultService();
  service.registerVault({ name: "mock-vault", type: "mock", config: {} });
  assertEquals(service.supportsExistenceCheck("mock-vault"), true);
});

Deno.test("supportsExistenceCheck: false for a provider without has()", async () => {
  await withTestVault("plain", {}, (service) => {
    assertEquals(service.supportsExistenceCheck("plain"), false);
    return Promise.resolve();
  });
});

Deno.test("supportsExistenceCheck: false for an unknown vault", () => {
  const service = new VaultService();
  assertEquals(service.supportsExistenceCheck("nowhere"), false);
});

Deno.test("has: delegates to the provider and reads no value", async () => {
  await withTestVault(
    "erp",
    { withExistence: true, secrets: { present: "v" } },
    async (service, ctx) => {
      assertEquals(await service.has("erp", "present"), true);
      assertEquals(await service.has("erp", "absent"), false);
      assertEquals(ctx.getOperationsByMethod("has").length, 2);
      assertEquals(ctx.getOperationsByMethod("get").length, 0);
    },
  );
});

Deno.test("has: rejects for a provider without the capability", async () => {
  await withTestVault("plain", { secrets: { k: "v" } }, async (service) => {
    const error = await assertRejects(() => service.has("plain", "k"), Error);
    assertStringIncludes(error.message, "'plain'");
    assertStringIncludes(error.message, "does not support existence checks");
  });
});

Deno.test("has: rejects for an unknown vault", async () => {
  const service = new VaultService();
  const error = await assertRejects(() => service.has("nowhere", "k"), Error);
  assertStringIncludes(error.message, "Vault 'nowhere' not found");
});

Deno.test("has: is held to the run vault access scope as a read, before the provider is touched", async () => {
  await withTestVault(
    "erp",
    { withExistence: true, secrets: { k: "v" } },
    async (service, ctx) => {
      const decided: string[] = [];
      const denying = RunVaultAccess.create({
        policy: {
          principal: "bot:reporter",
          decide: (vaultName, action) => {
            decided.push(`${vaultName}:${action}`);
            return { allowed: false, reason: "no grant allows it" };
          },
        },
      });
      const error = await runWithVaultAccess(
        denying,
        () =>
          assertRejects(() => service.has("erp", "k"), VaultAccessDeniedError),
      );
      assertStringIncludes(error.message, "'erp'");
      assertEquals(decided, ["erp:read"]);
      assertEquals(ctx.getOperations().length, 0);

      const allowing = RunVaultAccess.create({ allowedVaults: ["erp"] });
      assertEquals(
        await runWithVaultAccess(allowing, () => service.has("erp", "k")),
        true,
      );
    },
  );
});

Deno.test("has: records no audit entry even when reads are audited", async () => {
  const service = new VaultService();
  const auditRepo = new InMemoryVaultAuditRepository();
  service.setAuditRepository(auditRepo);
  service.registerVault({
    name: "audited",
    type: "mock",
    config: { k: "v" },
    auditReads: true,
  });

  assertEquals(await service.has("audited", "k"), true);
  assertEquals(await service.has("audited", "missing"), false);
  assertEquals(auditRepo.entries.length, 0);

  // Control: a read of the same key is audited.
  await service.get("audited", "k", "test-caller");
  assertEquals(auditRepo.entries.length, 1);
  assertEquals(auditRepo.entries[0].action, "get");
});
