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
  const original = Deno.env.get("SWAMP_TEST_DS_EXPR_TOKEN");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_TOKEN", "my-secret-token");
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_TOKEN }}" };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { token: "my-secret-token" });
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_EXPR_TOKEN", original);
    } else Deno.env.delete("SWAMP_TEST_DS_EXPR_TOKEN");
  }
});

Deno.test("resolveDatastoreExpressions: resolves env expression in nested config", async () => {
  const original = Deno.env.get("SWAMP_TEST_DS_EXPR_NESTED");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_NESTED", "secret-val");
    const config = {
      connection: { token: "${{ env.SWAMP_TEST_DS_EXPR_NESTED }}" },
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { connection: { token: "secret-val" } });
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_EXPR_NESTED", original);
    } else Deno.env.delete("SWAMP_TEST_DS_EXPR_NESTED");
  }
});

Deno.test("resolveDatastoreExpressions: resolves env expressions in arrays", async () => {
  const origA = Deno.env.get("SWAMP_TEST_DS_EXPR_A");
  const origB = Deno.env.get("SWAMP_TEST_DS_EXPR_B");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_A", "host-a");
    Deno.env.set("SWAMP_TEST_DS_EXPR_B", "host-b");
    const config = {
      hosts: [
        "${{ env.SWAMP_TEST_DS_EXPR_A }}",
        "${{ env.SWAMP_TEST_DS_EXPR_B }}",
      ],
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { hosts: ["host-a", "host-b"] });
  } finally {
    if (origA !== undefined) Deno.env.set("SWAMP_TEST_DS_EXPR_A", origA);
    else Deno.env.delete("SWAMP_TEST_DS_EXPR_A");
    if (origB !== undefined) Deno.env.set("SWAMP_TEST_DS_EXPR_B", origB);
    else Deno.env.delete("SWAMP_TEST_DS_EXPR_B");
  }
});

Deno.test("resolveDatastoreExpressions: interpolates multiple expressions in one string", async () => {
  const origH = Deno.env.get("SWAMP_TEST_DS_EXPR_HOST");
  const origP = Deno.env.get("SWAMP_TEST_DS_EXPR_PORT");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_HOST", "db.example.com");
    Deno.env.set("SWAMP_TEST_DS_EXPR_PORT", "5432");
    const config = {
      url:
        "https://${{ env.SWAMP_TEST_DS_EXPR_HOST }}:${{ env.SWAMP_TEST_DS_EXPR_PORT }}/db",
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { url: "https://db.example.com:5432/db" });
  } finally {
    if (origH !== undefined) Deno.env.set("SWAMP_TEST_DS_EXPR_HOST", origH);
    else Deno.env.delete("SWAMP_TEST_DS_EXPR_HOST");
    if (origP !== undefined) Deno.env.set("SWAMP_TEST_DS_EXPR_PORT", origP);
    else Deno.env.delete("SWAMP_TEST_DS_EXPR_PORT");
  }
});

Deno.test("resolveDatastoreExpressions: trims whitespace inside expression delimiters", async () => {
  const original = Deno.env.get("SWAMP_TEST_DS_EXPR_WS");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_WS", "trimmed");
    const config = { val: "${{  env.SWAMP_TEST_DS_EXPR_WS  }}" };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { val: "trimmed" });
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_TEST_DS_EXPR_WS", original);
    else Deno.env.delete("SWAMP_TEST_DS_EXPR_WS");
  }
});

Deno.test("resolveDatastoreExpressions: throws UserError for missing env var", async () => {
  Deno.env.delete("SWAMP_TEST_DS_EXPR_MISSING");
  const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_MISSING }}" };
  await assertRejects(
    () => resolveDatastoreExpressions(config, baseContext()),
    UserError,
    "SWAMP_TEST_DS_EXPR_MISSING",
  );
});

Deno.test("resolveDatastoreExpressions: throws UserError for empty env var", async () => {
  const original = Deno.env.get("SWAMP_TEST_DS_EXPR_EMPTY");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_EMPTY", "");
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_EMPTY }}" };
    await assertRejects(
      () => resolveDatastoreExpressions(config, baseContext()),
      UserError,
      "not set or empty",
    );
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_EXPR_EMPTY", original);
    } else Deno.env.delete("SWAMP_TEST_DS_EXPR_EMPTY");
  }
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
  const original = Deno.env.get("SWAMP_TEST_DS_EXPR_MIX");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_MIX", "env-val");
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
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_EXPR_MIX", original);
    } else Deno.env.delete("SWAMP_TEST_DS_EXPR_MIX");
  }
});

Deno.test("resolveDatastoreExpressions: interpolates env and vault in one string", async () => {
  const original = Deno.env.get("SWAMP_TEST_DS_EXPR_PREFIX");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_PREFIX", "prod");
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
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_EXPR_PREFIX", original);
    } else Deno.env.delete("SWAMP_TEST_DS_EXPR_PREFIX");
  }
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
  const original = Deno.env.get("SWAMP_TEST_DS_EXPR_MC");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_MC", "allowed");
    const ctx = baseContext({ managedConfig: true });
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_MC }}" };
    const result = await resolveDatastoreExpressions(config, ctx);
    assertEquals(result, { token: "allowed" });
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_EXPR_MC", original);
    } else Deno.env.delete("SWAMP_TEST_DS_EXPR_MC");
  }
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
  const original = Deno.env.get("SWAMP_TEST_DS_EXPR_DEEP");
  try {
    Deno.env.set("SWAMP_TEST_DS_EXPR_DEEP", "deep-val");
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
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_TEST_DS_EXPR_DEEP", original);
    } else Deno.env.delete("SWAMP_TEST_DS_EXPR_DEEP");
  }
});
