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
import { UserError } from "../domain/errors.ts";
import {
  OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY,
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
  assertEquals(
    storedSecrets.get(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY),
    "new-access-token",
  );
});

Deno.test("resolveOAuthClientCredentials: returns stored access token when no cached resolutions exist", async () => {
  const deps = createMockDeps({
    getVaultSecret: (_, key) => {
      if (key === OAUTH_CLIENT_ID_KEY) return Promise.resolve("stored-id");
      if (key === OAUTH_CLIENT_SECRET_KEY) {
        return Promise.resolve("stored-secret");
      }
      if (key === OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY) {
        return Promise.resolve("stored-bootstrap-token");
      }
      return Promise.resolve(null);
    },
  });
  const result = await resolveOAuthClientCredentials(
    deps,
    "https://swamp-club.com",
    "default",
    undefined,
    undefined,
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "stored-id");
  assertEquals(result.clientSecret, "stored-secret");
  assertEquals(result.accessToken, "stored-bootstrap-token");
  assertEquals(result.resolvedAdmins, null);
});

Deno.test("resolveOAuthClientCredentials: prefers cached resolutions over stored access token", async () => {
  const adminsJson = JSON.stringify({ swampadmin: "6a4d-sub-id" });
  const deps = createMockDeps({
    getVaultSecret: (_, key) => {
      if (key === OAUTH_CLIENT_ID_KEY) return Promise.resolve("stored-id");
      if (key === OAUTH_CLIENT_SECRET_KEY) {
        return Promise.resolve("stored-secret");
      }
      if (key === OAUTH_RESOLVED_ADMINS_KEY) return Promise.resolve(adminsJson);
      if (key === OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY) {
        return Promise.resolve("stored-bootstrap-token");
      }
      return Promise.resolve(null);
    },
  });
  const result = await resolveOAuthClientCredentials(
    deps,
    "https://swamp-club.com",
    "default",
    undefined,
    undefined,
    AbortSignal.timeout(5000),
  );
  assertEquals(result.accessToken, null);
  assertEquals(result.resolvedAdmins, { swampadmin: "6a4d-sub-id" });
});

Deno.test("resolveOAuthClientCredentials: does not store null access token in vault", async () => {
  const storedSecrets = new Map<string, string>();
  const deps = createMockDeps({
    registerClient: () =>
      Promise.resolve({
        clientId: "api-key-client",
        clientSecret: "api-key-secret",
        accessToken: null,
      }),
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
    undefined,
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "api-key-client");
  assertEquals(result.clientSecret, "api-key-secret");
  assertEquals(result.accessToken, null);
  assertEquals(storedSecrets.get(OAUTH_CLIENT_ID_KEY), "api-key-client");
  assertEquals(storedSecrets.get(OAUTH_CLIENT_SECRET_KEY), "api-key-secret");
  assertEquals(storedSecrets.has(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY), false);
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

function storeWith(
  values: Record<string, string>,
): { deps: OAuthRegistrationDeps; reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  const deps = createMockDeps({
    getVaultSecret: (_, key) => {
      reads.push(key);
      return Promise.resolve(values[key] ?? null);
    },
    putVaultSecret: (_, key) => {
      writes.push(key);
      return Promise.resolve();
    },
    registerClient: () => Promise.reject(new Error("must not register")),
  });
  return { deps, reads, writes };
}

Deno.test("resolveOAuthClientCredentials: an explicit id with a supplied secret is used for the run and never touches the stored client", async () => {
  const { deps, reads, writes } = storeWith({
    [OAUTH_CLIENT_ID_KEY]: "stored-id",
    [OAUTH_CLIENT_SECRET_KEY]: "stored-secret",
  });
  const result = await resolveOAuthClientCredentials(
    deps,
    "https://swamp-club.com",
    "default",
    "explicit-id",
    "supplied-secret",
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "explicit-id");
  assertEquals(result.clientSecret, "supplied-secret");
  assertEquals(reads.includes(OAUTH_CLIENT_ID_KEY), false);
  assertEquals(reads.includes(OAUTH_CLIENT_SECRET_KEY), false);
  assertEquals(writes, []);
});

Deno.test("resolveOAuthClientCredentials: a supplied secret keeps the cached admins and bootstrap token reads", async () => {
  const { deps } = storeWith({
    [OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY]: "bootstrap-token",
  });
  const result = await resolveOAuthClientCredentials(
    deps,
    "https://swamp-club.com",
    "default",
    "explicit-id",
    "supplied-secret",
    AbortSignal.timeout(5000),
  );
  assertEquals(result.accessToken, "bootstrap-token");
  assertEquals(result.resolvedAdmins, null);
});

Deno.test("resolveOAuthClientCredentials: an explicit id matching the stored client uses the stored secret", async () => {
  const { deps, writes } = storeWith({
    [OAUTH_CLIENT_ID_KEY]: "explicit-id",
    [OAUTH_CLIENT_SECRET_KEY]: "stored-secret",
  });
  const result = await resolveOAuthClientCredentials(
    deps,
    "https://swamp-club.com",
    "default",
    "explicit-id",
    undefined,
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "explicit-id");
  assertEquals(result.clientSecret, "stored-secret");
  assertEquals(writes, []);
});

Deno.test("resolveOAuthClientCredentials: an explicit id with a different stored client is refused, not registered", async () => {
  const { deps, writes } = storeWith({
    [OAUTH_CLIENT_ID_KEY]: "other-id",
    [OAUTH_CLIENT_SECRET_KEY]: "other-secret",
  });
  await assertRejects(
    () =>
      resolveOAuthClientCredentials(
        deps,
        "https://swamp-club.com",
        "default",
        "explicit-id",
        undefined,
        AbortSignal.timeout(5000),
      ),
    UserError,
    "No client secret for OAuth client explicit-id",
  );
  assertEquals(writes, []);
});

Deno.test("resolveOAuthClientCredentials: an explicit id with an empty store is refused, not registered", async () => {
  const { deps, writes } = storeWith({});
  const error = await assertRejects(
    () =>
      resolveOAuthClientCredentials(
        deps,
        "https://swamp-club.com",
        "default",
        "explicit-id",
        undefined,
        AbortSignal.timeout(5000),
      ),
    UserError,
  );
  assertEquals(error.message.includes("SWAMP_OAUTH_CLIENT_SECRET_FILE"), true);
  assertEquals(writes, []);
});

Deno.test("resolveOAuthClientCredentials: a supplied secret without a client id is refused", async () => {
  const { deps, reads, writes } = storeWith({
    [OAUTH_CLIENT_ID_KEY]: "stored-id",
    [OAUTH_CLIENT_SECRET_KEY]: "stored-secret",
  });
  await assertRejects(
    () =>
      resolveOAuthClientCredentials(
        deps,
        "https://swamp-club.com",
        "default",
        undefined,
        "supplied-secret",
        AbortSignal.timeout(5000),
      ),
    UserError,
    "supplied without a client id",
  );
  assertEquals(reads, []);
  assertEquals(writes, []);
});
