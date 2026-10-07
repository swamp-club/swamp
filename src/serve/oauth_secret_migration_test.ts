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
import {
  createOAuthSecretReader,
  migrateOAuthSecrets,
  OAUTH_SECRETS_MIGRATED_KEY,
  type OAuthSecretMigrationVaults,
} from "./oauth_secret_migration.ts";
import {
  OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY,
  OAUTH_CLIENT_ID_KEY,
  OAUTH_CLIENT_SECRET_KEY,
  OAUTH_RESOLVED_ADMINS_KEY,
} from "./oauth_registration.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";

await initializeLogging({});

const USER_VAULT = "default";

interface FakeVaults {
  secrets: Map<string, Map<string, string>>;
  /** Every user-vault call, as `method:key` (`list` has no key). */
  userVaultCalls: string[];
  failList: boolean;
  failGetKeys: Set<string>;
  failPutKeys: Set<string>;
  deleteSupported: boolean;
  vaultService: OAuthSecretMigrationVaults;
}

function createFakeVaults(
  options: { userVault?: string | null } = {},
): FakeVaults {
  const userVault = options.userVault === undefined
    ? USER_VAULT
    : options.userVault;
  const secrets = new Map<string, Map<string, string>>();
  secrets.set(TOKEN_SECRETS_VAULT_NAME, new Map());
  if (userVault) secrets.set(userVault, new Map());
  const fake: FakeVaults = {
    secrets,
    userVaultCalls: [],
    failList: false,
    failGetKeys: new Set(),
    failPutKeys: new Set(),
    deleteSupported: true,
    vaultService: {
      get(vaultName: string, key: string): Promise<string> {
        if (vaultName === userVault) fake.userVaultCalls.push(`get:${key}`);
        if (fake.failGetKeys.has(key)) {
          return Promise.reject(new Error(`vault unavailable: ${key}`));
        }
        const value = secrets.get(vaultName)?.get(key);
        if (value === undefined) {
          return Promise.reject(
            new Error(`Secret '${key}' not found in vault '${vaultName}'`),
          );
        }
        return Promise.resolve(value);
      },
      put(vaultName: string, key: string, value: string): Promise<void> {
        if (vaultName === userVault) fake.userVaultCalls.push(`put:${key}`);
        if (fake.failPutKeys.has(key)) {
          return Promise.reject(new Error(`store unavailable: ${key}`));
        }
        secrets.get(vaultName)!.set(key, value);
        return Promise.resolve();
      },
      delete(vaultName: string, key: string): Promise<void> {
        if (vaultName === userVault) fake.userVaultCalls.push(`delete:${key}`);
        secrets.get(vaultName)?.delete(key);
        return Promise.resolve();
      },
      list(vaultName: string): Promise<string[]> {
        if (vaultName === userVault) fake.userVaultCalls.push("list");
        if (fake.failList) {
          return Promise.reject(new Error("vault unavailable"));
        }
        return Promise.resolve([...(secrets.get(vaultName)?.keys() ?? [])]);
      },
      supportsDelete(_vaultName: string): boolean {
        return fake.deleteSupported;
      },
      getDefaultVaultName(): string | undefined {
        return userVault ?? undefined;
      },
      getVaultNames(): string[] {
        return [...secrets.keys()];
      },
    },
  };
  return fake;
}

function tokenSecrets(fake: FakeVaults): Map<string, string> {
  return fake.secrets.get(TOKEN_SECRETS_VAULT_NAME)!;
}

function userSecrets(fake: FakeVaults): Map<string, string> {
  return fake.secrets.get(USER_VAULT)!;
}

/** A serve registered with SWAMP_API_KEY: no bootstrap access token stored. */
function seedApiKeyRegisteredServe(fake: FakeVaults): void {
  tokenSecrets(fake).set(OAUTH_CLIENT_ID_KEY, "client-id");
  tokenSecrets(fake).set(OAUTH_CLIENT_SECRET_KEY, "client-secret");
  tokenSecrets(fake).set(OAUTH_RESOLVED_ADMINS_KEY, "{}");
}

Deno.test("migrateOAuthSecrets: a serve registered without a bootstrap token reads nothing from the user vault on later boots", async () => {
  const fake = createFakeVaults();
  seedApiKeyRegisteredServe(fake);

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);
  fake.userVaultCalls.length = 0;
  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(fake.userVaultCalls, []);
});

Deno.test("migrateOAuthSecrets: keys missing from the user vault listing are never read", async () => {
  const fake = createFakeVaults();
  seedApiKeyRegisteredServe(fake);

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(fake.userVaultCalls, ["list"]);
  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), true);
});

Deno.test("migrateOAuthSecrets: moves every legacy key out of the user vault and records the migration", async () => {
  const fake = createFakeVaults();
  userSecrets(fake).set(OAUTH_CLIENT_ID_KEY, "client-id");
  userSecrets(fake).set(OAUTH_CLIENT_SECRET_KEY, "client-secret");
  userSecrets(fake).set(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY, "access-token");
  userSecrets(fake).set(OAUTH_RESOLVED_ADMINS_KEY, "{}");
  userSecrets(fake).set("unrelated", "kept");

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(tokenSecrets(fake).get(OAUTH_CLIENT_ID_KEY), "client-id");
  assertEquals(
    tokenSecrets(fake).get(OAUTH_CLIENT_SECRET_KEY),
    "client-secret",
  );
  assertEquals(
    tokenSecrets(fake).get(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY),
    "access-token",
  );
  assertEquals(tokenSecrets(fake).get(OAUTH_RESOLVED_ADMINS_KEY), "{}");
  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), true);
  assertEquals([...userSecrets(fake).keys()], ["unrelated"]);
});

Deno.test("migrateOAuthSecrets: a user vault that cannot be listed leaves no marker, and the next boot migrates", async () => {
  const fake = createFakeVaults();
  seedApiKeyRegisteredServe(fake);
  tokenSecrets(fake).delete(OAUTH_RESOLVED_ADMINS_KEY);
  userSecrets(fake).set(OAUTH_RESOLVED_ADMINS_KEY, "{}");
  fake.failList = true;

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(fake.userVaultCalls, ["list"]);
  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), false);
  assertEquals(tokenSecrets(fake).has(OAUTH_RESOLVED_ADMINS_KEY), false);

  fake.failList = false;
  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(tokenSecrets(fake).get(OAUTH_RESOLVED_ADMINS_KEY), "{}");
  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), true);
});

Deno.test("migrateOAuthSecrets: a key that fails to move leaves no marker, and the other keys still move", async () => {
  const fake = createFakeVaults();
  userSecrets(fake).set(OAUTH_CLIENT_ID_KEY, "client-id");
  userSecrets(fake).set(OAUTH_CLIENT_SECRET_KEY, "client-secret");
  fake.failGetKeys.add(OAUTH_CLIENT_ID_KEY);

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(tokenSecrets(fake).has(OAUTH_CLIENT_ID_KEY), false);
  assertEquals(
    tokenSecrets(fake).get(OAUTH_CLIENT_SECRET_KEY),
    "client-secret",
  );
  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), false);

  fake.failGetKeys.clear();
  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(tokenSecrets(fake).get(OAUTH_CLIENT_ID_KEY), "client-id");
  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), true);
});

Deno.test("migrateOAuthSecrets: once recorded, oauth keys added to the user vault later are left alone", async () => {
  const fake = createFakeVaults();
  tokenSecrets(fake).set(OAUTH_SECRETS_MIGRATED_KEY, "true");
  userSecrets(fake).set(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY, "added-later");

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(fake.userVaultCalls, []);
  assertEquals(
    userSecrets(fake).get(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY),
    "added-later",
  );
  assertEquals(
    tokenSecrets(fake).has(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY),
    false,
  );
});

Deno.test("migrateOAuthSecrets: a user vault without delete support keeps the key and still records the migration", async () => {
  const fake = createFakeVaults();
  fake.deleteSupported = false;
  userSecrets(fake).set(OAUTH_CLIENT_ID_KEY, "client-id");

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(tokenSecrets(fake).get(OAUTH_CLIENT_ID_KEY), "client-id");
  assertEquals(userSecrets(fake).get(OAUTH_CLIENT_ID_KEY), "client-id");
  assertEquals(
    fake.userVaultCalls.some((c) => c.startsWith("delete:")),
    false,
  );
  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), true);
});

Deno.test("migrateOAuthSecrets: with no user vault there is nothing to read and no marker", async () => {
  const fake = createFakeVaults({ userVault: null });

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(fake.userVaultCalls, []);
  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), false);
});

Deno.test("migrateOAuthSecrets: a marker that cannot be written does not fail the start, and the next start retries", async () => {
  const fake = createFakeVaults();
  seedApiKeyRegisteredServe(fake);
  fake.failPutKeys.add(OAUTH_SECRETS_MIGRATED_KEY);

  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), false);

  fake.failPutKeys.clear();
  await migrateOAuthSecrets(fake.vaultService, TOKEN_SECRETS_VAULT_NAME);

  assertEquals(tokenSecrets(fake).has(OAUTH_SECRETS_MIGRATED_KEY), true);
});

Deno.test("createOAuthSecretReader: returns a key held in _token-secrets without reading the user vault", async () => {
  const fake = createFakeVaults();
  seedApiKeyRegisteredServe(fake);
  const read = createOAuthSecretReader(
    fake.vaultService,
    TOKEN_SECRETS_VAULT_NAME,
  );

  assertEquals(await read(OAUTH_CLIENT_ID_KEY), "client-id");
  assertEquals(fake.userVaultCalls, []);
});

Deno.test("createOAuthSecretReader: once the migration is recorded, an absent key is not read from the user vault", async () => {
  const fake = createFakeVaults();
  seedApiKeyRegisteredServe(fake);
  tokenSecrets(fake).set(OAUTH_SECRETS_MIGRATED_KEY, "2026-10-07T00:00:00Z");
  // The user vault holding the key proves the read is skipped, not missed.
  userSecrets(fake).set(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY, "late-addition");
  const read = createOAuthSecretReader(
    fake.vaultService,
    TOKEN_SECRETS_VAULT_NAME,
  );

  assertEquals(await read(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY), null);
  assertEquals(fake.userVaultCalls, []);
});

Deno.test("createOAuthSecretReader: before the migration is recorded, falls back to the user vault", async () => {
  const fake = createFakeVaults();
  userSecrets(fake).set(OAUTH_CLIENT_SECRET_KEY, "legacy-secret");
  const read = createOAuthSecretReader(
    fake.vaultService,
    TOKEN_SECRETS_VAULT_NAME,
  );

  assertEquals(await read(OAUTH_CLIENT_SECRET_KEY), "legacy-secret");
  assertEquals(await read(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY), null);
  assertEquals(fake.userVaultCalls, [
    `get:${OAUTH_CLIENT_SECRET_KEY}`,
    `get:${OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY}`,
  ]);
});

Deno.test("createOAuthSecretReader: with no user vault an absent key is null", async () => {
  const fake = createFakeVaults({ userVault: null });
  const read = createOAuthSecretReader(
    fake.vaultService,
    TOKEN_SECRETS_VAULT_NAME,
  );

  assertEquals(await read(OAUTH_CLIENT_ID_KEY), null);
});

Deno.test("createOAuthSecretReader: looks the migration marker up once across keys", async () => {
  const fake = createFakeVaults();
  tokenSecrets(fake).set(OAUTH_SECRETS_MIGRATED_KEY, "2026-10-07T00:00:00Z");
  let markerReads = 0;
  const read = createOAuthSecretReader(
    {
      ...fake.vaultService,
      get(vaultName: string, key: string): Promise<string> {
        if (key === OAUTH_SECRETS_MIGRATED_KEY) markerReads++;
        return fake.vaultService.get(vaultName, key);
      },
    },
    TOKEN_SECRETS_VAULT_NAME,
  );

  await read(OAUTH_CLIENT_ID_KEY);
  await read(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY);
  await read(OAUTH_RESOLVED_ADMINS_KEY);

  assertEquals(markerReads, 1);
});
