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
  OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY,
  OAUTH_CLIENT_ID_KEY,
  OAUTH_CLIENT_SECRET_KEY,
  OAUTH_RESOLVED_ADMINS_KEY,
  type OAuthRegistrationDeps,
  registerClientWithApiKey,
  resolveOAuthClientCredentials,
  storeResolvedAdmins,
} from "./oauth_registration.ts";

interface StubResponse {
  url: string;
  status: number;
  body: string;
}

function stubFetch(
  responses: StubResponse[],
): { [Symbol.dispose]: () => void } {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const stub = responses[callIndex++];
    if (!stub) {
      throw new Error(`stubFetch: unexpected call #${callIndex} to ${url}`);
    }
    if (url !== stub.url) {
      throw new Error(
        `stubFetch: call #${callIndex} expected ${stub.url} but got ${url}`,
      );
    }
    return Promise.resolve(
      new Response(stub.body, {
        status: stub.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

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
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "api-key-client");
  assertEquals(result.clientSecret, "api-key-secret");
  assertEquals(result.accessToken, null);
  assertEquals(storedSecrets.get(OAUTH_CLIENT_ID_KEY), "api-key-client");
  assertEquals(storedSecrets.get(OAUTH_CLIENT_SECRET_KEY), "api-key-secret");
  assertEquals(storedSecrets.has(OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY), false);
});

Deno.test("registerClientWithApiKey: registers client and returns credentials without accessToken", async () => {
  using _fetch = stubFetch([
    {
      url: "https://swamp-club.com/api/whoami",
      status: 200,
      body: JSON.stringify({ scopes: ["oauth:manage", "serve:*"] }),
    },
    {
      url: "https://swamp-club.com/api/auth/oauth2/register",
      status: 200,
      body: JSON.stringify({
        client_id: "headless-client-id",
        client_secret: "headless-client-secret",
      }),
    },
  ]);
  const result = await registerClientWithApiKey(
    "https://swamp-club.com",
    "test-api-key",
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "headless-client-id");
  assertEquals(result.clientSecret, "headless-client-secret");
  assertEquals("accessToken" in result, false);
});

Deno.test("registerClientWithApiKey: throws on invalid API key", async () => {
  using _fetch = stubFetch([
    {
      url: "https://swamp-club.com/api/whoami",
      status: 401,
      body: "Unauthorized",
    },
  ]);
  await assertRejects(
    () =>
      registerClientWithApiKey(
        "https://swamp-club.com",
        "bad-key",
        AbortSignal.timeout(5000),
      ),
    Error,
    "SWAMP_API_KEY validation failed: 401",
  );
});

Deno.test("registerClientWithApiKey: throws when token is missing oauth:manage scope", async () => {
  using _fetch = stubFetch([
    {
      url: "https://swamp-club.com/api/whoami",
      status: 200,
      body: JSON.stringify({ scopes: ["serve:*", "extensions:*"] }),
    },
  ]);
  await assertRejects(
    () =>
      registerClientWithApiKey(
        "https://swamp-club.com",
        "no-oauth-scope-key",
        AbortSignal.timeout(5000),
      ),
    Error,
    'SWAMP_API_KEY is missing the "oauth:manage" scope',
  );
});

Deno.test("registerClientWithApiKey: throws on registration failure", async () => {
  using _fetch = stubFetch([
    {
      url: "https://swamp-club.com/api/whoami",
      status: 200,
      body: JSON.stringify({ scopes: ["oauth:manage"] }),
    },
    {
      url: "https://swamp-club.com/api/auth/oauth2/register",
      status: 403,
      body: "Forbidden — missing serve:* scope",
    },
  ]);
  await assertRejects(
    () =>
      registerClientWithApiKey(
        "https://swamp-club.com",
        "test-api-key",
        AbortSignal.timeout(5000),
      ),
    Error,
    "OAuth client registration via API key failed: 403",
  );
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
