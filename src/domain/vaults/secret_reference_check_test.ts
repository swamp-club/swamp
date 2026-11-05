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

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createVaultTestContext,
  type VaultTestContextOptions,
  type VaultTestContextResult,
} from "@swamp-club/swamp-testing";
import { UserError } from "../errors.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
  VaultAccessDeniedError,
} from "./run_vault_access.ts";
import { SecretBagRegistry } from "./secret_bag_registry.ts";
import {
  isSecretNotFoundError,
  SECRET_NOT_FOUND_CODE,
  SecretNotFoundError,
} from "./secret_not_found_error.ts";
import { checkSecretReference } from "./secret_reference_check.ts";
import {
  SecretReferenceUnavailableError,
  SecretReferenceUncheckedError,
} from "./secret_reference_errors.ts";
import { VaultService } from "./vault_service.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";

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

Deno.test("checkSecretReference: a probe read of a missing key keeps the secret_not_found code an extension store raised", async () => {
  await withTestVault("erp", { secrets: {} }, async (service) => {
    const error = await assertRejects(
      () => check(service, new SecretBagRegistry(), "token"),
      SecretNotFoundError,
      `Failed to resolve vault expression ${CALL} (at ${LOCATION}): `,
    );
    assertEquals(error.code, SECRET_NOT_FOUND_CODE);
    assertEquals(error.vaultName, "erp");
    assertEquals(error.key, "token");
    assertEquals(isSecretNotFoundError(error.cause), true);
  });
});

Deno.test("checkSecretReference: a store's other failure does not read as secret_not_found", async () => {
  await withTestVault(
    "erp",
    { unauthorizedKeys: ["token"] },
    async (service) => {
      const error = await assertRejects(() =>
        check(service, new SecretBagRegistry(), "token")
      );
      assertEquals(isSecretNotFoundError(error), false);
    },
  );
});

Deno.test("checkSecretReference: a refusal by the run's vault access keeps its code and reaches no provider, even for a confirmed reference", async () => {
  await withTestVault(
    "erp",
    { withExistence: true, secrets: { token: "s3cret" } },
    async (service, ctx) => {
      const registry = new SecretBagRegistry();
      await check(service, registry, "token");
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
        assertInstanceOf(error, SecretReferenceUncheckedError);
        assertEquals(error.reference, { vaultName: "erp", key: "token" });
        assertEquals(error.location, LOCATION);
        assertEquals(
          error.reason,
          "Access denied to secret 'token' in test vault 'erp'",
        );
        assertEquals(error.message.includes("s3cret"), false);
      },
    );
  }
});

Deno.test("checkSecretReference: a provider that cannot answer is unchecked with its reason on one line, and is asked again next time", async () => {
  for (const withExistence of [true, false]) {
    await withTestVault(
      "erp",
      { withExistence, secrets: { token: "s3cret" } },
      async (service, ctx) => {
        const fail = () =>
          Promise.reject(new Error("op is not installed\n  Install it"));
        if (withExistence) {
          (ctx.vault as unknown as { has: unknown }).has = fail;
        } else {
          ctx.vault.get = fail;
        }
        const registry = new SecretBagRegistry();
        const error = await assertRejects(
          () => check(service, registry, "token"),
          SecretReferenceUncheckedError,
          `Failed to resolve vault expression ${CALL} (at ${LOCATION}): op is not installed — Install it`,
        );
        assertEquals(error.reason, "op is not installed — Install it");
        await assertRejects(
          () => check(service, registry, "token"),
          SecretReferenceUncheckedError,
        );
      },
    );
  }
});

Deno.test("checkSecretReference: a missing key is never unchecked: a get-only store's secret_not_found and a has() provider's false both fail", async () => {
  await withTestVault("erp", { secrets: {} }, async (service) => {
    const error = await assertRejects(
      () => check(service, new SecretBagRegistry(), "token"),
      UserError,
    );
    assertEquals(error.code, "secret_not_found");
    assertEquals(error instanceof SecretReferenceUncheckedError, false);
  });
  await withTestVault(
    "erp",
    { withExistence: true, secrets: {} },
    async (service) => {
      await assertRejects(
        () => check(service, new SecretBagRegistry(), "token"),
        SecretReferenceUnavailableError,
      );
    },
  );
});

Deno.test("checkSecretReference: a refusal by the run's vault access inside the provider call is never unchecked", async () => {
  await withTestVault(
    "erp",
    { withExistence: true, secrets: { token: "s3cret" } },
    async (service, ctx) => {
      (ctx.vault as unknown as { has: unknown }).has = () =>
        Promise.reject(
          new VaultAccessDeniedError({
            vaultName: "erp",
            action: "read",
            secretKey: "token",
            reason: "revoked",
          }),
        );
      const error = await assertRejects(
        () => check(service, new SecretBagRegistry(), "token"),
        UserError,
      );
      assertEquals(error.code, "vault_access_denied");
      assertEquals(error instanceof SecretReferenceUncheckedError, false);
    },
  );
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
  assertEquals(error instanceof SecretReferenceUncheckedError, false);
});
