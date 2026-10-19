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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  createVaultTestContext,
  type VaultTestContextOptions,
  type VaultTestContextResult,
} from "@swamp-club/swamp-testing";
import { UserError } from "../errors.ts";
import { RunVaultAccess, runWithVaultAccess } from "./run_vault_access.ts";
import { SecretBagRegistry } from "./secret_bag_registry.ts";
import { checkSecretReference } from "./secret_reference_check.ts";
import { SecretReferenceUnavailableError } from "./secret_reference_errors.ts";
import { VaultService } from "./vault_service.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";

/**
 * Registers a per-run vault type backed by the testing package's in-memory
 * vault and binds it under `vaultName`: with `withExistence` it answers
 * has(), and without it every check is a probe read.
 */
async function withTestVault(
  vaultName: string,
  options: VaultTestContextOptions,
  fn: (service: VaultService, ctx: VaultTestContextResult) => Promise<void>,
): Promise<void> {
  const type = `@test/reference-check-${crypto.randomUUID()}`;
  const ctx = createVaultTestContext({ name: vaultName, ...options });
  vaultTypeRegistry.register({
    type,
    name: "Reference check test vault",
    description: "In-memory vault for existence check tests",
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

const CALL = "vault.get('erp', 'token')";
const LOCATION = "methods.run.arguments.cmd";

/** Checks `key` of vault `erp` in `registry`, with `redacted` as redactor. */
function check(
  service: VaultService,
  registry: SecretBagRegistry,
  key: string,
  redacted: string[] = [],
): Promise<void> {
  return checkSecretReference(service, { vaultName: "erp", key }, {
    registry,
    redactor: { addSecret: (value) => redacted.push(value) },
    call: CALL,
    location: LOCATION,
  });
}

Deno.test("checkSecretReference: a provider with has() is asked once per run, and no value is read", async () => {
  await withTestVault(
    "erp",
    { withExistence: true, secrets: { token: "s3cret" } },
    async (service, ctx) => {
      const registry = new SecretBagRegistry();
      const redacted: string[] = [];
      await check(service, registry, "token", redacted);
      await check(service, registry, "token", redacted);
      assertEquals(ctx.getOperationsByMethod("has").length, 1);
      assertEquals(ctx.getOperationsByMethod("get").length, 0);
      assertEquals(redacted, []);
    },
  );
});

Deno.test("checkSecretReference: a provider without has() gets one probe read per run, whose value only the redactor sees", async () => {
  await withTestVault(
    "erp",
    { secrets: { token: "s3cret" } },
    async (service, ctx) => {
      const registry = new SecretBagRegistry();
      const redacted: string[] = [];
      await Promise.all([
        check(service, registry, "token", redacted),
        check(service, registry, "token", redacted),
      ]);
      await check(service, registry, "token", redacted);
      assertEquals(ctx.getOperationsByMethod("get").length, 1);
      assertEquals(redacted, ["s3cret"]);
      // Another run asks again.
      await check(service, new SecretBagRegistry(), "token");
      assertEquals(ctx.getOperationsByMethod("get").length, 2);
    },
  );
});

Deno.test("checkSecretReference: a key has() denies fails with secret_reference_unavailable, and is asked again next time", async () => {
  await withTestVault(
    "erp",
    { withExistence: true, secrets: {} },
    async (service, ctx) => {
      const registry = new SecretBagRegistry();
      const error = await assertRejects(
        () => check(service, registry, "token"),
        SecretReferenceUnavailableError,
      );
      assertEquals(error.code, "secret_reference_unavailable");
      assertEquals(
        error.message,
        `Failed to resolve vault expression ${CALL} (at ${LOCATION}): Secret 'token' not found in vault 'erp'`,
      );
      await assertRejects(() => check(service, registry, "token"));
      assertEquals(ctx.getOperationsByMethod("has").length, 2);
    },
  );
});

Deno.test("checkSecretReference: a refusal by the run's vault access keeps its code and reaches no provider, even for a confirmed reference", async () => {
  await withTestVault(
    "erp",
    { withExistence: true, secrets: { token: "s3cret" } },
    async (service, ctx) => {
      const registry = new SecretBagRegistry();
      // Confirmed while the run could read it.
      await check(service, registry, "token");
      // Then the grant is revoked: the next check is refused.
      const revoked = RunVaultAccess.create({
        allowedVaults: ["other"],
        allowListSource: "deploy",
      });
      await runWithVaultAccess(revoked, async () => {
        const error = await assertRejects(
          () => check(service, registry, "token"),
          UserError,
        );
        assertEquals(error.code, "vault_access_denied");
        assertStringIncludes(
          error.message,
          `Failed to resolve vault expression ${CALL} (at ${LOCATION}): Reading vault 'erp' is refused`,
        );
      });
      assertEquals(ctx.getOperationsByMethod("has").length, 1);
    },
  );
});

Deno.test("checkSecretReference: a provider that refuses its own credentials fails with its error, on either path", async () => {
  for (const withExistence of [true, false]) {
    await withTestVault(
      "erp",
      {
        withExistence,
        secrets: { token: "s3cret" },
        unauthorizedKeys: ["token"],
      },
      async (service) => {
        const error = await assertRejects(
          () => check(service, new SecretBagRegistry(), "token"),
          Error,
          `Failed to resolve vault expression ${CALL} (at ${LOCATION}): Access denied to secret 'token'`,
        );
        assertEquals(error instanceof SecretReferenceUnavailableError, false);
        assertEquals(error.message.includes("s3cret"), false);
      },
    );
  }
});

Deno.test("checkSecretReference: an unknown vault fails with the vault service's error on one line", async () => {
  const error = await assertRejects(
    () => check(new VaultService(), new SecretBagRegistry(), "token"),
    Error,
    "Vault 'erp' not found",
  );
  assertStringIncludes(
    error.message,
    `Failed to resolve vault expression ${CALL} (at ${LOCATION}): `,
  );
  assertEquals(error.message.includes("\n"), false);
});
