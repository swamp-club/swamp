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

import { assertEquals, assertRejects } from "@std/assert";
import {
  type DatastoreExpressionContext,
  resolveDatastoreExpressions,
} from "./datastore_expression_resolver.ts";
import { UserError } from "../domain/errors.ts";
import type { VaultService } from "../domain/vaults/vault_service.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";

function baseContext(
  overrides?: Partial<DatastoreExpressionContext>,
): DatastoreExpressionContext {
  return { repoDir: "/tmp/test-repo", ...overrides };
}

function mockVaultFactory(
  secrets: Record<string, Record<string, string>>,
): (repoDir: string) => Promise<VaultService> {
  return (_repoDir: string) =>
    Promise.resolve({
      get: (
        vaultName: string,
        secretKey: string,
        _auditSource: string,
      ): Promise<string> => {
        const vault = secrets[vaultName];
        if (!vault) {
          return Promise.reject(
            new Error(
              `Vault "${vaultName}" not found. Available vaults: ${
                Object.keys(secrets).join(", ")
              }`,
            ),
          );
        }
        const value = vault[secretKey];
        if (value === undefined) {
          return Promise.reject(
            new Error(
              `Secret "${secretKey}" not found in vault "${vaultName}"`,
            ),
          );
        }
        return Promise.resolve(value);
      },
    } as unknown as VaultService);
}

// ============================================================================
// No-op cases
// ============================================================================

Deno.test("resolveDatastoreExpressions: config with no expressions passes through unchanged", async () => {
  const config = { host: "localhost", port: 5432, ssl: true };
  const result = await resolveDatastoreExpressions(config, baseContext());
  assertEquals(result, { host: "localhost", port: 5432, ssl: true });
});

Deno.test("resolveDatastoreExpressions: empty config returns empty object", async () => {
  const result = await resolveDatastoreExpressions({}, baseContext());
  assertEquals(result, {});
});

Deno.test("resolveDatastoreExpressions: config with only primitives passes through", async () => {
  const config = { count: 42, enabled: false, label: null as unknown };
  const result = await resolveDatastoreExpressions(config, baseContext());
  assertEquals(result, { count: 42, enabled: false, label: null });
});

// ============================================================================
// env.VAR resolution
// ============================================================================

Deno.test("resolveDatastoreExpressions: resolves env expression in flat config", async () => {
  await withMockedEnv(
    { SWAMP_TEST_DS_EXPR_TOKEN: "my-secret-token" },
    async () => {
      const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_TOKEN }}" };
      const result = await resolveDatastoreExpressions(config, baseContext());
      assertEquals(result, { token: "my-secret-token" });
    },
  );
});

Deno.test("resolveDatastoreExpressions: resolves env expression in nested config", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_NESTED: "secret-val" }, async () => {
    const config = {
      connection: { token: "${{ env.SWAMP_TEST_DS_EXPR_NESTED }}" },
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { connection: { token: "secret-val" } });
  });
});

Deno.test("resolveDatastoreExpressions: resolves env expressions in arrays", async () => {
  await withMockedEnv({
    SWAMP_TEST_DS_EXPR_A: "host-a",
    SWAMP_TEST_DS_EXPR_B: "host-b",
  }, async () => {
    const config = {
      hosts: [
        "${{ env.SWAMP_TEST_DS_EXPR_A }}",
        "${{ env.SWAMP_TEST_DS_EXPR_B }}",
      ],
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { hosts: ["host-a", "host-b"] });
  });
});

Deno.test("resolveDatastoreExpressions: interpolates multiple expressions in one string", async () => {
  await withMockedEnv({
    SWAMP_TEST_DS_EXPR_HOST: "db.example.com",
    SWAMP_TEST_DS_EXPR_PORT: "5432",
  }, async () => {
    const config = {
      url:
        "https://${{ env.SWAMP_TEST_DS_EXPR_HOST }}:${{ env.SWAMP_TEST_DS_EXPR_PORT }}/db",
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { url: "https://db.example.com:5432/db" });
  });
});

Deno.test("resolveDatastoreExpressions: trims whitespace inside expression delimiters", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_WS: "trimmed" }, async () => {
    const config = { val: "${{  env.SWAMP_TEST_DS_EXPR_WS  }}" };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { val: "trimmed" });
  });
});

Deno.test("resolveDatastoreExpressions: throws UserError for missing env var", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_MISSING: undefined }, async () => {
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_MISSING }}" };
    await assertRejects(
      () => resolveDatastoreExpressions(config, baseContext()),
      UserError,
      "SWAMP_TEST_DS_EXPR_MISSING",
    );
  });
});

Deno.test("resolveDatastoreExpressions: throws UserError for empty env var", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_EMPTY: "" }, async () => {
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_EMPTY }}" };
    await assertRejects(
      () => resolveDatastoreExpressions(config, baseContext()),
      UserError,
      "not set or empty",
    );
  });
});

// ============================================================================
// vault.get() resolution
// ============================================================================

Deno.test("resolveDatastoreExpressions: resolves vault.get with quoted args", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({
      infra: { "db-password": "s3cret" },
    }),
  });
  const config = { password: '${{ vault.get("infra", "db-password") }}' };
  const result = await resolveDatastoreExpressions(config, ctx);
  assertEquals(result, { password: "s3cret" });
});

Deno.test("resolveDatastoreExpressions: resolves vault.get with unquoted args", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({
      myVault: { token: "vault-token" },
    }),
  });
  const config = { token: "${{ vault.get(myVault, token) }}" };
  const result = await resolveDatastoreExpressions(config, ctx);
  assertEquals(result, { token: "vault-token" });
});

Deno.test("resolveDatastoreExpressions: resolves vault.get with single-quoted args", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({
      v: { k: "single-quoted-val" },
    }),
  });
  const config = { secret: "${{ vault.get('v', 'k') }}" };
  const result = await resolveDatastoreExpressions(config, ctx);
  assertEquals(result, { secret: "single-quoted-val" });
});

Deno.test("resolveDatastoreExpressions: throws UserError when vault not found", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({}),
  });
  const config = { token: '${{ vault.get("missing", "key") }}' };
  await assertRejects(
    () => resolveDatastoreExpressions(config, ctx),
    UserError,
    "Failed to resolve vault expression",
  );
});

Deno.test("resolveDatastoreExpressions: throws UserError when secret not found", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({
      infra: { "other-key": "val" },
    }),
  });
  const config = { token: '${{ vault.get("infra", "missing-key") }}' };
  await assertRejects(
    () => resolveDatastoreExpressions(config, ctx),
    UserError,
    "Failed to resolve vault expression",
  );
});

// ============================================================================
// Mixed expressions
// ============================================================================

Deno.test("resolveDatastoreExpressions: resolves both env and vault in different fields", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_MIX: "env-val" }, async () => {
    const ctx = baseContext({
      vaultServiceFactory: mockVaultFactory({
        v: { k: "vault-val" },
      }),
    });
    const config = {
      host: "${{ env.SWAMP_TEST_DS_EXPR_MIX }}",
      token: "${{ vault.get(v, k) }}",
    };
    const result = await resolveDatastoreExpressions(config, ctx);
    assertEquals(result, { host: "env-val", token: "vault-val" });
  });
});

Deno.test("resolveDatastoreExpressions: interpolates env and vault in one string", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_PREFIX: "prod" }, async () => {
    const ctx = baseContext({
      vaultServiceFactory: mockVaultFactory({
        v: { k: "abc123" },
      }),
    });
    const config = {
      url: "${{ env.SWAMP_TEST_DS_EXPR_PREFIX }}-${{ vault.get(v, k) }}",
    };
    const result = await resolveDatastoreExpressions(config, ctx);
    assertEquals(result, { url: "prod-abc123" });
  });
});

// ============================================================================
// Error cases
// ============================================================================

Deno.test("resolveDatastoreExpressions: throws UserError for unsupported expression", async () => {
  const config = { val: "${{ foo.bar }}" };
  await assertRejects(
    () => resolveDatastoreExpressions(config, baseContext()),
    UserError,
    "Unsupported expression",
  );
});

Deno.test("resolveDatastoreExpressions: managedConfig blocks vault expressions", async () => {
  const ctx = baseContext({
    managedConfig: true,
    vaultServiceFactory: mockVaultFactory({ v: { k: "val" } }),
  });
  const config = { token: "${{ vault.get(v, k) }}" };
  await assertRejects(
    () => resolveDatastoreExpressions(config, ctx),
    UserError,
    "managedConfig",
  );
});

Deno.test("resolveDatastoreExpressions: managedConfig allows env expressions", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_MC: "allowed" }, async () => {
    const ctx = baseContext({ managedConfig: true });
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_MC }}" };
    const result = await resolveDatastoreExpressions(config, ctx);
    assertEquals(result, { token: "allowed" });
  });
});

// ============================================================================
// Edge cases
// ============================================================================

Deno.test("resolveDatastoreExpressions: partial expression syntax passes through", async () => {
  const config = { val: "token-${{ env.X" };
  const result = await resolveDatastoreExpressions(config, baseContext());
  assertEquals(result, { val: "token-${{ env.X" });
});

Deno.test("resolveDatastoreExpressions: non-string config values pass through", async () => {
  const config = { port: 5432, ssl: true, timeout: null as unknown };
  const result = await resolveDatastoreExpressions(config, baseContext());
  assertEquals(result, { port: 5432, ssl: true, timeout: null });
});

Deno.test("resolveDatastoreExpressions: deeply nested config resolves at all levels", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_DEEP: "deep-val" }, async () => {
    const config = {
      level1: {
        level2: {
          level3: { secret: "${{ env.SWAMP_TEST_DS_EXPR_DEEP }}" },
        },
      },
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, {
      level1: { level2: { level3: { secret: "deep-val" } } },
    });
  });
});
