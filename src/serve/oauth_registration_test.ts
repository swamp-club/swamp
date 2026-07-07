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
import {
  OAUTH_CLIENT_ID_KEY,
  OAUTH_CLIENT_SECRET_KEY,
  OAUTH_RESOLVED_ADMINS_KEY,
  type OAuthRegistrationDeps,
  resolveOAuthClientCredentials,
  storeResolvedAdmins,
} from "./oauth_registration.ts";

function createMockDeps(
  overrides: Partial<OAuthRegistrationDeps> = {},
): OAuthRegistrationDeps {
  return {
    getVaultSecret: () => Promise.resolve(null),
    putVaultSecret: () => Promise.resolve(),
    registerClient: () =>
      Promise.resolve({
        clientId: "new-client-id",
        clientSecret: "new-client-secret",
        accessToken: "new-access-token",
      }),
    ...overrides,
  };
}

Deno.test("resolveOAuthClientCredentials: uses stored credentials when both exist", async () => {
  const deps = createMockDeps({
    getVaultSecret: (_, key) => {
      if (key === OAUTH_CLIENT_ID_KEY) return Promise.resolve("stored-id");
      if (key === OAUTH_CLIENT_SECRET_KEY) {
        return Promise.resolve("stored-secret");
      }
      return Promise.resolve(null);
    },
  });
  const result = await resolveOAuthClientCredentials(
    deps,
    "https://swamp-club.com",
    "default",
    undefined,
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "stored-id");
  assertEquals(result.clientSecret, "stored-secret");
  assertEquals(result.accessToken, null);
});

Deno.test("resolveOAuthClientCredentials: returns cached resolved admins on subsequent boot", async () => {
  const adminsJson = JSON.stringify({ swampadmin: "6a4d-sub-id" });
  const deps = createMockDeps({
    getVaultSecret: (_, key) => {
      if (key === OAUTH_CLIENT_ID_KEY) return Promise.resolve("stored-id");
      if (key === OAUTH_CLIENT_SECRET_KEY) {
        return Promise.resolve("stored-secret");
      }
      if (key === OAUTH_RESOLVED_ADMINS_KEY) return Promise.resolve(adminsJson);
      return Promise.resolve(null);
    },
  });
  const result = await resolveOAuthClientCredentials(
    deps,
    "https://swamp-club.com",
    "default",
    undefined,
    AbortSignal.timeout(5000),
  );
  assertEquals(result.resolvedAdmins, { swampadmin: "6a4d-sub-id" });
});

Deno.test("resolveOAuthClientCredentials: bootstrap registers and returns access token", async () => {
  const storedSecrets = new Map<string, string>();
  const deps = createMockDeps({
    putVaultSecret: (_, key, value) => {
      storedSecrets.set(key, value);
      return Promise.resolve();
    },
  });
  const result = await resolveOAuthClientCredentials(
    deps,
    "https://swamp-club.com",
    "default",
    undefined,
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "new-client-id");
  assertEquals(result.clientSecret, "new-client-secret");
  assertEquals(result.accessToken, "new-access-token");
  assertEquals(storedSecrets.get(OAUTH_CLIENT_ID_KEY), "new-client-id");
  assertEquals(
    storedSecrets.get(OAUTH_CLIENT_SECRET_KEY),
    "new-client-secret",
  );
  assertEquals(storedSecrets.has("oauth-access-token"), false);
});

Deno.test("storeResolvedAdmins: stores admin mapping in vault", async () => {
  const stored = new Map<string, string>();
  await storeResolvedAdmins(
    { putVaultSecret: (_, k, v) => (stored.set(k, v), Promise.resolve()) },
    "default",
    { swampadmin: "6a4d-sub-id", alice: "abc-123" },
  );
  const parsed = JSON.parse(stored.get(OAUTH_RESOLVED_ADMINS_KEY)!);
  assertEquals(parsed, { swampadmin: "6a4d-sub-id", alice: "abc-123" });
});
