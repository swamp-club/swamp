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
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import {
  hasOAuthAccessToken,
  lookupOAuthAccessToken,
} from "./oauth_access_token_lookup.ts";
import { oauthAccessTokenKey } from "./device_auth_handler.ts";

const USER_VAULT = "default";

function createFakeVault(secrets: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    vaultService: {
      get(vaultName: string, key: string): Promise<string> {
        const path = `${vaultName}/${key}`;
        reads.push(path);
        const value = secrets[path];
        return value === undefined
          ? Promise.reject(new Error(`Secret '${key}' not found`))
          : Promise.resolve(value);
      },
    },
  };
}

Deno.test("lookupOAuthAccessToken: returns the token stored in _token-secrets", async () => {
  const fake = createFakeVault({
    [`${TOKEN_SECRETS_VAULT_NAME}/oauth-access-token-tok-1`]: "access-1",
  });

  const result = await lookupOAuthAccessToken(fake.vaultService, {
    name: "tok-1",
    vaultName: TOKEN_SECRETS_VAULT_NAME,
  });

  assertEquals(result, "access-1");
  assertEquals(fake.reads, [
    `${TOKEN_SECRETS_VAULT_NAME}/oauth-access-token-tok-1`,
  ]);
});

Deno.test("lookupOAuthAccessToken: never reads a user vault for a token without an OAuth login", async () => {
  // The user vault holding the key proves the read is skipped, not missed.
  const fake = createFakeVault({
    [`${USER_VAULT}/oauth-access-token-worker-server`]: "stale",
  });

  const result = await lookupOAuthAccessToken(fake.vaultService, {
    name: "worker-server",
    vaultName: TOKEN_SECRETS_VAULT_NAME,
  });

  assertEquals(result, null);
  assertEquals(fake.reads, [
    `${TOKEN_SECRETS_VAULT_NAME}/oauth-access-token-worker-server`,
  ]);
});

Deno.test("lookupOAuthAccessToken: falls back to the vault an unmigrated token names", async () => {
  const fake = createFakeVault({
    "prod-secrets/oauth-access-token-tok-old": "access-old",
  });

  const result = await lookupOAuthAccessToken(fake.vaultService, {
    name: "tok-old",
    vaultName: "prod-secrets",
  });

  assertEquals(result, "access-old");
  assertEquals(fake.reads, [
    `${TOKEN_SECRETS_VAULT_NAME}/oauth-access-token-tok-old`,
    "prod-secrets/oauth-access-token-tok-old",
  ]);
});

Deno.test("lookupOAuthAccessToken: returns null when an unmigrated token has no access token", async () => {
  const fake = createFakeVault({});

  const result = await lookupOAuthAccessToken(fake.vaultService, {
    name: "tok-old",
    vaultName: USER_VAULT,
  });

  assertEquals(result, null);
});

function presenceVault(
  vaults: Record<string, readonly string[] | "down">,
) {
  return {
    getVaultNames: () => Object.keys(vaults),
    has(vaultName: string, key: string): Promise<boolean> {
      const keys = vaults[vaultName];
      if (keys === "down") return Promise.reject(new Error("vault offline"));
      return Promise.resolve(keys.includes(key));
    },
  };
}

Deno.test("hasOAuthAccessToken: finds a login's token in the token-secrets vault", async () => {
  const key = oauthAccessTokenKey("tok-1");
  const vault = presenceVault({ [TOKEN_SECRETS_VAULT_NAME]: [key] });
  assertEquals(
    await hasOAuthAccessToken(vault, { name: "tok-1", vaultName: USER_VAULT }),
    true,
  );
});

Deno.test("hasOAuthAccessToken: falls back to the token's own vault", async () => {
  const key = oauthAccessTokenKey("tok-1");
  const vault = presenceVault({
    [TOKEN_SECRETS_VAULT_NAME]: [],
    [USER_VAULT]: [key],
  });
  assertEquals(
    await hasOAuthAccessToken(vault, { name: "tok-1", vaultName: USER_VAULT }),
    true,
  );
});

Deno.test("hasOAuthAccessToken: a manual token has none, and a missing vault is not an error", async () => {
  const vault = presenceVault({ [USER_VAULT]: [] });
  assertEquals(
    await hasOAuthAccessToken(vault, { name: "tok-1", vaultName: USER_VAULT }),
    false,
  );
});

Deno.test("hasOAuthAccessToken: a vault that cannot answer throws", async () => {
  const vault = presenceVault({ [TOKEN_SECRETS_VAULT_NAME]: "down" });
  let threw = false;
  try {
    await hasOAuthAccessToken(vault, { name: "tok-1", vaultName: USER_VAULT });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
