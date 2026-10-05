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
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import type { TokenSecretMigrationDeps } from "./token_secret_migration.ts";
import { migrateTokenSecrets } from "./token_secret_migration.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";

await initializeLogging({});

function createMockVault(): {
  secrets: Map<string, Map<string, string>>;
  vaultService: TokenSecretMigrationDeps["vaultService"];
} {
  const secrets = new Map<string, Map<string, string>>();
  return {
    secrets,
    vaultService: {
      get(
        vaultName: string,
        key: string,
        _caller?: string,
      ): Promise<string> {
        const vault = secrets.get(vaultName);
        if (!vault || !vault.has(key)) {
          return Promise.reject(
            new Error(`Secret '${key}' not found in vault '${vaultName}'`),
          );
        }
        return Promise.resolve(vault.get(key)!);
      },
      put(vaultName: string, key: string, value: string): Promise<void> {
        if (!secrets.has(vaultName)) secrets.set(vaultName, new Map());
        secrets.get(vaultName)!.set(key, value);
        return Promise.resolve();
      },
      supportsDelete(_vaultName: string): boolean {
        return true;
      },
      delete(vaultName: string, key: string): Promise<void> {
        secrets.get(vaultName)?.delete(key);
        return Promise.resolve();
      },
    } as TokenSecretMigrationDeps["vaultService"],
  };
}

function createMockDataQuery(
  records: Record<string, unknown>[],
): TokenSecretMigrationDeps["dataQueryService"] {
  return {
    query(
      _predicate: string,
      _options?: Record<string, unknown>,
    ): Promise<unknown[]> {
      return Promise.resolve(records);
    },
  } as TokenSecretMigrationDeps["dataQueryService"];
}

/**
 * Lock deps that take no lock and re-read from the same records the query
 * returned, so the record under the lock is the one that was listed.
 */
function unchangedRecordLockDeps(
  records: { attributes: Record<string, unknown> }[],
): Pick<TokenSecretMigrationDeps, "withTokenLock" | "readTokenRecord"> {
  return {
    withTokenLock: (_name, fn) => fn(),
    readTokenRecord: (name) =>
      Promise.resolve(
        records.find((r) => r.attributes.name === name)?.attributes ?? null,
      ),
  };
}

Deno.test("migrateTokenSecrets: migrates a vault-backed token to _token-secrets", async () => {
  const { secrets, vaultService } = createMockVault();
  secrets.set(
    "user-vault",
    new Map([
      ["server-token-oauth-abc", "secret-value"],
      ["oauth-access-token-oauth-abc", "oauth-token-value"],
    ]),
  );

  const records = [{
    attributes: {
      name: "oauth-abc",
      state: "active",
      vaultName: "user-vault",
      secretKey: "server-token-oauth-abc",
      principalId: "user:123",
      principalEmail: "u@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
    },
  }];

  const updatedRecords: { name: string; vault: string }[] = [];

  const result = await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery(records),
    ...unchangedRecordLockDeps(records),
    updateTokenVaultName: (name, vault, _attrs) => {
      updatedRecords.push({ name, vault });
      return Promise.resolve();
    },
  });

  assertEquals(result.migrated, 1);
  assertEquals(result.skipped, 0);
  assertEquals(result.failed, 0);

  assertEquals(
    secrets.get(TOKEN_SECRETS_VAULT_NAME)?.get("server-token-oauth-abc"),
    "secret-value",
  );
  assertEquals(
    secrets.get(TOKEN_SECRETS_VAULT_NAME)?.get(
      "oauth-access-token-oauth-abc",
    ),
    "oauth-token-value",
  );

  assertEquals(updatedRecords.length, 1);
  assertEquals(updatedRecords[0].name, "oauth-abc");
  assertEquals(updatedRecords[0].vault, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(secrets.get("user-vault")?.has("server-token-oauth-abc"), false);
  assertEquals(
    secrets.get("user-vault")?.has("oauth-access-token-oauth-abc"),
    false,
  );
});

Deno.test("migrateTokenSecrets: skips tokens already in _token-secrets", async () => {
  const { vaultService } = createMockVault();
  const records = [{
    attributes: {
      name: "oauth-abc",
      state: "active",
      vaultName: TOKEN_SECRETS_VAULT_NAME,
      secretKey: "server-token-oauth-abc",
      principalId: "user:123",
      principalEmail: "u@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
    },
  }];

  const result = await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery(records),
    ...unchangedRecordLockDeps(records),
    updateTokenVaultName: () => Promise.resolve(),
  });

  assertEquals(result.migrated, 0);
  assertEquals(result.skipped, 1);
});

Deno.test("migrateTokenSecrets: skips token when vault secret is missing", async () => {
  const { vaultService } = createMockVault();
  const records = [{
    attributes: {
      name: "oauth-abc",
      state: "active",
      vaultName: "user-vault",
      secretKey: "server-token-oauth-abc",
      principalId: "user:123",
      principalEmail: "u@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
    },
  }];

  const result = await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery(records),
    ...unchangedRecordLockDeps(records),
    updateTokenVaultName: () => Promise.resolve(),
  });

  assertEquals(result.migrated, 0);
  assertEquals(result.skipped, 1);
});

Deno.test("migrateTokenSecrets: migrates server token even when OAuth access token is missing", async () => {
  const { secrets, vaultService } = createMockVault();
  secrets.set(
    "user-vault",
    new Map([["server-token-oauth-abc", "secret-value"]]),
  );

  const records = [{
    attributes: {
      name: "oauth-abc",
      state: "active",
      vaultName: "user-vault",
      secretKey: "server-token-oauth-abc",
      principalId: "user:123",
      principalEmail: "u@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
    },
  }];

  const result = await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery(records),
    ...unchangedRecordLockDeps(records),
    updateTokenVaultName: () => Promise.resolve(),
  });

  assertEquals(result.migrated, 1);
  assertEquals(
    secrets.get(TOKEN_SECRETS_VAULT_NAME)?.get("server-token-oauth-abc"),
    "secret-value",
  );
});

Deno.test("migrateTokenSecrets: continues on per-token failure", async () => {
  const { secrets, vaultService } = createMockVault();
  secrets.set(
    "user-vault",
    new Map([
      ["server-token-oauth-good", "good-secret"],
    ]),
  );

  const records = [
    {
      attributes: {
        name: "oauth-bad",
        state: "active",
        vaultName: "user-vault",
        secretKey: "server-token-oauth-bad",
        principalId: "user:123",
        principalEmail: "u@example.com",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z",
      },
    },
    {
      attributes: {
        name: "oauth-good",
        state: "active",
        vaultName: "user-vault",
        secretKey: "server-token-oauth-good",
        principalId: "user:456",
        principalEmail: "u2@example.com",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z",
      },
    },
  ];

  const result = await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery(records),
    ...unchangedRecordLockDeps(records),
    updateTokenVaultName: () => Promise.resolve(),
  });

  assertEquals(result.migrated, 1);
  assertEquals(result.skipped, 1);
});

function legacyRecord(overrides: Record<string, unknown> = {}) {
  return {
    attributes: {
      name: "legacy",
      state: "active",
      vaultName: "user-vault",
      secretKey: "server-token-legacy",
      principalId: "user:123",
      principalEmail: "u@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

Deno.test("migrateTokenSecrets: leaves a token rotated after it was listed untouched", async () => {
  const { secrets, vaultService } = createMockVault();
  secrets.set("user-vault", new Map([["server-token-legacy", "old-secret"]]));
  const listed = legacyRecord();
  // The rotation lands between the query and the migration's turn under the
  // lock: a new secret in the same vault and a record with a new createdAt.
  const rotated = legacyRecord({ createdAt: "2026-01-15T00:00:00.000Z" });
  let updates = 0;

  const result = await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery([listed]),
    updateTokenVaultName: () => {
      updates++;
      return Promise.resolve();
    },
    withTokenLock: (_name, fn) => {
      secrets.get("user-vault")!.set("server-token-legacy", "new-secret");
      return fn();
    },
    readTokenRecord: () => Promise.resolve(rotated.attributes),
  });

  assertEquals(result, { migrated: 0, skipped: 1, failed: 0 });
  assertEquals(updates, 0);
  assertEquals(
    secrets.get("user-vault")?.get("server-token-legacy"),
    "new-secret",
  );
  assertEquals(secrets.has(TOKEN_SECRETS_VAULT_NAME), false);
});

Deno.test("migrateTokenSecrets: reads the record and secret under the lock", async () => {
  const { secrets, vaultService } = createMockVault();
  secrets.set("user-vault", new Map([["server-token-legacy", "secret"]]));
  const record = legacyRecord();
  const events: string[] = [];

  await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery([record]),
    updateTokenVaultName: () => {
      events.push("write");
      return Promise.resolve();
    },
    withTokenLock: async (name, fn) => {
      events.push(`lock:${name}`);
      const result = await fn();
      events.push("unlock");
      return result;
    },
    readTokenRecord: () => {
      events.push("read");
      return Promise.resolve(record.attributes);
    },
  });

  assertEquals(events, ["lock:legacy", "read", "write", "unlock"]);
});

Deno.test("migrateTokenSecrets: skips a token whose record is gone or already migrated under the lock", async () => {
  for (
    const current of [
      null,
      legacyRecord({ vaultName: TOKEN_SECRETS_VAULT_NAME }).attributes,
    ]
  ) {
    const { secrets, vaultService } = createMockVault();
    secrets.set("user-vault", new Map([["server-token-legacy", "secret"]]));
    let updates = 0;

    const result = await migrateTokenSecrets({
      tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
      vaultService,
      dataQueryService: createMockDataQuery([legacyRecord()]),
      updateTokenVaultName: () => {
        updates++;
        return Promise.resolve();
      },
      withTokenLock: (_name, fn) => fn(),
      readTokenRecord: () => Promise.resolve(current),
    });

    assertEquals(result, { migrated: 0, skipped: 1, failed: 0 });
    assertEquals(updates, 0);
  }
});

Deno.test("migrateTokenSecrets: a token whose lock cannot be taken fails alone", async () => {
  const { secrets, vaultService } = createMockVault();
  secrets.set(
    "user-vault",
    new Map([["server-token-legacy", "a"], ["server-token-other", "b"]]),
  );
  const records = [
    legacyRecord(),
    legacyRecord({ name: "other", secretKey: "server-token-other" }),
  ];

  const result = await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery(records),
    updateTokenVaultName: () => Promise.resolve(),
    ...unchangedRecordLockDeps(records),
    withTokenLock: (name, fn) =>
      name === "legacy" ? Promise.reject(new Error("lock timed out")) : fn(),
  });

  assertEquals(result, { migrated: 1, skipped: 0, failed: 1 });
  assertEquals(secrets.get("user-vault")?.has("server-token-legacy"), true);
});
