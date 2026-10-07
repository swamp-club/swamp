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
import type {
  OAuthAccessTokenRecoveryDeps,
  TokenSecretMigrationDeps,
} from "./token_secret_migration.ts";
import {
  migrateTokenSecrets,
  OAUTH_ACCESS_TOKENS_RECOVERED_KEY,
  recoverOAuthAccessTokens,
} from "./token_secret_migration.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import { lookupOAuthAccessToken } from "./oauth_access_token_lookup.ts";
import { oauthAccessTokenKey } from "./device_auth_handler.ts";

await initializeLogging({});

/**
 * An in-memory vault. Each fault set names a call that rejects: `vault/key`
 * for get and put, the vault name for list. `calls` records every call.
 */
function createMockVault(): {
  secrets: Map<string, Map<string, string>>;
  vaultService: TokenSecretMigrationDeps["vaultService"];
  faults: { get: Set<string>; put: Set<string>; list: Set<string> };
  calls: string[];
} {
  const secrets = new Map<string, Map<string, string>>();
  const faults = {
    get: new Set<string>(),
    put: new Set<string>(),
    list: new Set<string>(),
  };
  const calls: string[] = [];
  return {
    secrets,
    faults,
    calls,
    vaultService: {
      get(
        vaultName: string,
        key: string,
        _caller?: string,
      ): Promise<string> {
        calls.push(`get:${vaultName}/${key}`);
        if (faults.get.has(`${vaultName}/${key}`)) {
          return Promise.reject(new Error("vault unavailable"));
        }
        const vault = secrets.get(vaultName);
        if (!vault || !vault.has(key)) {
          return Promise.reject(
            new Error(`Secret '${key}' not found in vault '${vaultName}'`),
          );
        }
        return Promise.resolve(vault.get(key)!);
      },
      put(vaultName: string, key: string, value: string): Promise<void> {
        calls.push(`put:${vaultName}/${key}`);
        if (faults.put.has(`${vaultName}/${key}`)) {
          return Promise.reject(new Error("vault unavailable"));
        }
        if (!secrets.has(vaultName)) secrets.set(vaultName, new Map());
        secrets.get(vaultName)!.set(key, value);
        return Promise.resolve();
      },
      list(vaultName: string): Promise<string[]> {
        calls.push(`list:${vaultName}`);
        if (faults.list.has(vaultName)) {
          return Promise.reject(new Error("vault unavailable"));
        }
        return Promise.resolve([...(secrets.get(vaultName)?.keys() ?? [])]);
      },
      supportsDelete(_vaultName: string): boolean {
        return true;
      },
      delete(vaultName: string, key: string): Promise<void> {
        calls.push(`delete:${vaultName}/${key}`);
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

/** A legacy token holding both secrets in the user vault. */
function oauthLegacyVault() {
  const mock = createMockVault();
  mock.secrets.set(
    "user-vault",
    new Map([
      ["server-token-legacy", "server-secret"],
      ["oauth-access-token-legacy", "access-token"],
    ]),
  );
  return mock;
}

Deno.test("migrateTokenSecrets: keeps a token on its vault when copying its OAuth access token fails", async () => {
  for (
    const fault of [
      { get: "user-vault/oauth-access-token-legacy" },
      { put: `${TOKEN_SECRETS_VAULT_NAME}/oauth-access-token-legacy` },
      { list: "user-vault" },
    ]
  ) {
    const { secrets, vaultService, faults } = oauthLegacyVault();
    if (fault.get) faults.get.add(fault.get);
    if (fault.put) faults.put.add(fault.put);
    if (fault.list) faults.list.add(fault.list);
    const records = [legacyRecord()];
    let updates = 0;
    const deps = {
      tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
      vaultService,
      dataQueryService: createMockDataQuery(records),
      ...unchangedRecordLockDeps(records),
      updateTokenVaultName: () => {
        updates++;
        return Promise.resolve();
      },
    };

    const result = await migrateTokenSecrets(deps);

    assertEquals(result, { migrated: 0, skipped: 0, failed: 1 });
    assertEquals(updates, 0);
    assertEquals(
      secrets.get(TOKEN_SECRETS_VAULT_NAME)?.has("oauth-access-token-legacy") ??
        false,
      false,
    );
    assertEquals(
      secrets.get("user-vault")?.get("server-token-legacy"),
      "server-secret",
    );
    assertEquals(
      secrets.get("user-vault")?.get("oauth-access-token-legacy"),
      "access-token",
    );

    // The next start, with the vault healthy again, moves both keys.
    faults.get.clear();
    faults.put.clear();
    faults.list.clear();
    assertEquals(await migrateTokenSecrets(deps), {
      migrated: 1,
      skipped: 0,
      failed: 0,
    });
    assertEquals(updates, 1);
    assertEquals(
      secrets.get(TOKEN_SECRETS_VAULT_NAME)?.get("oauth-access-token-legacy"),
      "access-token",
    );
  }
});

Deno.test("migrateTokenSecrets: still skips a token whose server secret cannot be read, without listing its vault", async () => {
  const { vaultService, faults, calls } = createMockVault();
  faults.list.add("user-vault");
  const records = [legacyRecord()];

  const result = await migrateTokenSecrets({
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery(records),
    ...unchangedRecordLockDeps(records),
    updateTokenVaultName: () => Promise.resolve(),
  });

  assertEquals(result, { migrated: 0, skipped: 1, failed: 0 });
  assertEquals(calls.includes("list:user-vault"), false);
});

/** A record an older migration repointed without its OAuth access token. */
function halfMigratedRecord(overrides: Record<string, unknown> = {}) {
  return legacyRecord({ vaultName: TOKEN_SECRETS_VAULT_NAME, ...overrides });
}

function recoveryDeps(
  vaultService: TokenSecretMigrationDeps["vaultService"],
  records: { attributes: Record<string, unknown> }[],
): OAuthAccessTokenRecoveryDeps {
  return {
    tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
    vaultService,
    dataQueryService: createMockDataQuery(records),
    userVaultName: "user-vault",
    ...unchangedRecordLockDeps(records),
  };
}

Deno.test("recoverOAuthAccessTokens: copies an access token left in the user vault and records the marker", async () => {
  const { secrets, vaultService } = createMockVault();
  secrets.set(
    "user-vault",
    new Map([["oauth-access-token-legacy", "access-token"]]),
  );
  const record = halfMigratedRecord();
  const token = { name: "legacy", vaultName: TOKEN_SECRETS_VAULT_NAME };
  assertEquals(await lookupOAuthAccessToken(vaultService, token), null);

  const result = await recoverOAuthAccessTokens(
    recoveryDeps(vaultService, [record]),
  );

  assertEquals(result, { recovered: 1, failed: 0 });
  assertEquals(
    await lookupOAuthAccessToken(vaultService, token),
    "access-token",
  );
  assertEquals(
    secrets.get("user-vault")?.has("oauth-access-token-legacy"),
    false,
  );
  assertEquals(
    secrets.get(TOKEN_SECRETS_VAULT_NAME)?.has(
      OAUTH_ACCESS_TOKENS_RECOVERED_KEY,
    ),
    true,
  );
});

Deno.test("recoverOAuthAccessTokens: once the marker is recorded, never lists the user vault", async () => {
  const { secrets, vaultService, calls } = createMockVault();
  secrets.set(
    "user-vault",
    new Map([["oauth-access-token-legacy", "access-token"]]),
  );
  secrets.set(
    TOKEN_SECRETS_VAULT_NAME,
    new Map([[OAUTH_ACCESS_TOKENS_RECOVERED_KEY, "2026-10-07T00:00:00.000Z"]]),
  );

  const result = await recoverOAuthAccessTokens(
    recoveryDeps(vaultService, [halfMigratedRecord()]),
  );

  assertEquals(result, { recovered: 0, failed: 0 });
  assertEquals(calls.some((c) => c.includes("user-vault")), false);
});

Deno.test("recoverOAuthAccessTokens: with no active record in _token-secrets, records the marker without listing", async () => {
  const { secrets, vaultService, calls } = createMockVault();
  secrets.set(
    "user-vault",
    new Map([
      ["oauth-access-token-legacy", "a"],
      ["oauth-access-token-gone", "b"],
    ]),
  );
  const records = [
    legacyRecord(),
    halfMigratedRecord({ name: "gone", state: "revoked" }),
  ];

  const result = await recoverOAuthAccessTokens(
    recoveryDeps(vaultService, records),
  );

  assertEquals(result, { recovered: 0, failed: 0 });
  assertEquals(calls.some((c) => c.includes("user-vault")), false);
  assertEquals(secrets.get("user-vault")?.size, 2);
  assertEquals(
    secrets.get(TOKEN_SECRETS_VAULT_NAME)?.has(
      OAUTH_ACCESS_TOKENS_RECOVERED_KEY,
    ),
    true,
  );
});

Deno.test("recoverOAuthAccessTokens: a listing or copy failure leaves the marker unset for the next start", async () => {
  for (
    const fault of [
      { list: "user-vault" },
      { get: "user-vault/oauth-access-token-legacy" },
      { put: `${TOKEN_SECRETS_VAULT_NAME}/oauth-access-token-legacy` },
    ]
  ) {
    const { secrets, vaultService, faults } = createMockVault();
    secrets.set(
      "user-vault",
      new Map([["oauth-access-token-legacy", "access-token"]]),
    );
    if (fault.get) faults.get.add(fault.get);
    if (fault.put) faults.put.add(fault.put);
    if (fault.list) faults.list.add(fault.list);
    const deps = recoveryDeps(vaultService, [halfMigratedRecord()]);

    const result = await recoverOAuthAccessTokens(deps);

    assertEquals(result, { recovered: 0, failed: fault.list ? 0 : 1 });
    assertEquals(
      secrets.get(TOKEN_SECRETS_VAULT_NAME)?.has(
        OAUTH_ACCESS_TOKENS_RECOVERED_KEY,
      ) ?? false,
      false,
    );
    assertEquals(
      secrets.get("user-vault")?.get("oauth-access-token-legacy"),
      "access-token",
    );

    faults.get.clear();
    faults.put.clear();
    faults.list.clear();
    assertEquals(await recoverOAuthAccessTokens(deps), {
      recovered: 1,
      failed: 0,
    });
  }
});

Deno.test("recoverOAuthAccessTokens: leaves keys alone unless the record still lacks them under the lock", async () => {
  const { secrets, vaultService } = createMockVault();
  secrets.set(
    "user-vault",
    new Map([
      ["oauth-access-token-present", "old"],
      ["oauth-access-token-rotated", "old"],
      ["oauth-access-token-gone", "old"],
      ["oauth-access-token-revoked", "old"],
      ["oauth-access-token-stray", "old"],
    ]),
  );
  secrets.set(
    TOKEN_SECRETS_VAULT_NAME,
    new Map([["oauth-access-token-present", "current"]]),
  );
  const records = [
    halfMigratedRecord({ name: "present" }),
    halfMigratedRecord({ name: "rotated" }),
    halfMigratedRecord({ name: "gone" }),
    halfMigratedRecord({ name: "revoked" }),
  ];
  const underLock: Record<string, Record<string, unknown> | null> = {
    present: records[0].attributes,
    rotated: halfMigratedRecord({
      name: "rotated",
      createdAt: "2026-01-15T00:00:00.000Z",
    }).attributes,
    gone: null,
    revoked: halfMigratedRecord({ name: "revoked", state: "revoked" })
      .attributes,
  };
  const locked: string[] = [];

  const result = await recoverOAuthAccessTokens({
    ...recoveryDeps(vaultService, records),
    withTokenLock: (name, fn) => {
      locked.push(name);
      return fn();
    },
    readTokenRecord: (name) => Promise.resolve(underLock[name]),
  });

  assertEquals(result, { recovered: 0, failed: 0 });
  assertEquals(locked, ["present", "rotated", "gone", "revoked"]);
  assertEquals(
    secrets.get(TOKEN_SECRETS_VAULT_NAME)?.get("oauth-access-token-present"),
    "current",
  );
  for (const name of ["rotated", "gone", "revoked", "stray"]) {
    assertEquals(
      secrets.get(TOKEN_SECRETS_VAULT_NAME)?.has(`oauth-access-token-${name}`),
      false,
    );
  }
  assertEquals(secrets.get("user-vault")?.size, 5);
});

Deno.test("recoverOAuthAccessTokens: without a user vault, does nothing and records no marker", async () => {
  const { secrets, vaultService, calls } = createMockVault();

  const result = await recoverOAuthAccessTokens({
    ...recoveryDeps(vaultService, [halfMigratedRecord()]),
    userVaultName: undefined,
  });

  assertEquals(result, { recovered: 0, failed: 0 });
  assertEquals(calls.some((c) => c.startsWith("list:")), false);
  assertEquals(secrets.has(TOKEN_SECRETS_VAULT_NAME), false);
});

Deno.test("recoverOAuthAccessTokens: the marker is not a per-token access token key", () => {
  assertEquals(
    OAUTH_ACCESS_TOKENS_RECOVERED_KEY.startsWith(oauthAccessTokenKey("")),
    false,
  );
});
