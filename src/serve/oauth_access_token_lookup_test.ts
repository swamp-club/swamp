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

function tokenSecrets(keys: readonly string[] | "down") {
  return {
    holdsSecret(key: string): Promise<boolean> {
      if (keys === "down") return Promise.reject(new Error("store offline"));
      return Promise.resolve(keys.includes(key));
    },
  };
}

function lazy<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

type FakeVault =
  | { readonly kind: "presence"; readonly keys: readonly string[] | "down" }
  | { readonly kind: "listing"; readonly keys: readonly string[] | "down" };

function userVaults(vaults: Record<string, FakeVault>) {
  const reads: string[] = [];
  return {
    reads,
    getVaultNames: () => [TOKEN_SECRETS_VAULT_NAME, ...Object.keys(vaults)],
    supportsExistenceCheck: (vaultName: string) =>
      vaults[vaultName]?.kind === "presence",
    has(vaultName: string, key: string): Promise<boolean> {
      const vault = vaults[vaultName];
      if (vault?.kind !== "presence") {
        return Promise.reject(new Error("does not support existence checks"));
      }
      if (vault.keys === "down") {
        return Promise.reject(new Error("vault offline"));
      }
      return Promise.resolve(vault.keys.includes(key));
    },
    list(vaultName: string): Promise<string[]> {
      reads.push(vaultName);
      const keys = vaults[vaultName]?.keys;
      if (keys === "down") return Promise.reject(new Error("vault offline"));
      return Promise.resolve([...(keys ?? [])]);
    },
  };
}

Deno.test("hasOAuthAccessToken: finds a login's token in the token-secrets vault", async () => {
  const key = oauthAccessTokenKey("tok-1");
  assertEquals(
    await hasOAuthAccessToken({
      tokenSecrets: tokenSecrets([key]),
      vaults: lazy(userVaults({})),
    }, { name: "tok-1", vaultName: TOKEN_SECRETS_VAULT_NAME }),
    true,
  );
});

Deno.test("hasOAuthAccessToken: a token with none in token-secrets reads no other vault", async () => {
  const vaults = userVaults({
    [USER_VAULT]: { kind: "listing", keys: [oauthAccessTokenKey("tok-1")] },
  });
  assertEquals(
    await hasOAuthAccessToken({
      tokenSecrets: tokenSecrets([]),
      vaults: lazy(vaults),
    }, {
      name: "tok-1",
      vaultName: TOKEN_SECRETS_VAULT_NAME,
    }),
    false,
  );
  assertEquals(vaults.reads, []);
});

Deno.test("hasOAuthAccessToken: a record naming the token-secrets vault never builds the user vaults", async () => {
  const unbuildable = () => Promise.reject(new Error("vault config broken"));
  assertEquals(
    await hasOAuthAccessToken({
      tokenSecrets: tokenSecrets([]),
      vaults: unbuildable,
    }, {
      name: "tok-1",
      vaultName: TOKEN_SECRETS_VAULT_NAME,
    }),
    false,
  );
});

Deno.test("hasOAuthAccessToken: falls back to the token's own vault through its existence check", async () => {
  const vaults = userVaults({
    [USER_VAULT]: { kind: "presence", keys: [oauthAccessTokenKey("tok-1")] },
  });
  assertEquals(
    await hasOAuthAccessToken({
      tokenSecrets: tokenSecrets([]),
      vaults: lazy(vaults),
    }, {
      name: "tok-1",
      vaultName: USER_VAULT,
    }),
    true,
  );
  assertEquals(vaults.reads, []);
});

Deno.test("hasOAuthAccessToken: lists a token vault without an existence check", async () => {
  const key = oauthAccessTokenKey("tok-1");
  const holding = userVaults({
    [USER_VAULT]: { kind: "listing", keys: [key] },
  });
  assertEquals(
    await hasOAuthAccessToken({
      tokenSecrets: tokenSecrets([]),
      vaults: lazy(holding),
    }, { name: "tok-1", vaultName: USER_VAULT }),
    true,
  );
  const empty = userVaults({ [USER_VAULT]: { kind: "listing", keys: [] } });
  assertEquals(
    await hasOAuthAccessToken({
      tokenSecrets: tokenSecrets([]),
      vaults: lazy(empty),
    }, {
      name: "tok-1",
      vaultName: USER_VAULT,
    }),
    false,
  );
});

Deno.test("hasOAuthAccessToken: a token vault that is not configured is not an error", async () => {
  assertEquals(
    await hasOAuthAccessToken({
      tokenSecrets: tokenSecrets([]),
      vaults: lazy(userVaults({})),
    }, { name: "tok-1", vaultName: USER_VAULT }),
    false,
  );
});

Deno.test("hasOAuthAccessToken: throws when token-secrets cannot answer", async () => {
  await assertRejects(
    () =>
      hasOAuthAccessToken({
        tokenSecrets: tokenSecrets("down"),
        vaults: lazy(userVaults({})),
      }, { name: "tok-1", vaultName: TOKEN_SECRETS_VAULT_NAME }),
    Error,
    "store offline",
  );
});

Deno.test("hasOAuthAccessToken: throws when the token's own vault cannot answer", async () => {
  for (const kind of ["presence", "listing"] as const) {
    await assertRejects(
      () =>
        hasOAuthAccessToken({
          tokenSecrets: tokenSecrets([]),
          vaults: lazy(userVaults({ [USER_VAULT]: { kind, keys: "down" } })),
        }, { name: "tok-1", vaultName: USER_VAULT }),
      Error,
      "vault offline",
    );
  }
});
