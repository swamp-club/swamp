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
import { registerClientWithApiKey } from "./oauth_client_registration.ts";

interface StubResponse {
  url: string;
  status: number;
  body: string;
}

function stubFetch(
  responses: StubResponse[],
): {
  [Symbol.dispose]: () => void;
  calls: { url: string; init?: RequestInit }[];
} {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    calls.push({ url, init });
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
    calls,
    [Symbol.dispose]: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

Deno.test("registerClientWithApiKey: registers client and returns credentials without accessToken", async () => {
  using stub = stubFetch([
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
    "swamp-serve-myrepo-myhost",
    AbortSignal.timeout(5000),
  );
  assertEquals(result.clientId, "headless-client-id");
  assertEquals(result.clientSecret, "headless-client-secret");
  assertEquals("accessToken" in result, false);
  const registerBody = JSON.parse(stub.calls[1].init?.body as string);
  assertEquals(registerBody.client_name, "swamp-serve-myrepo-myhost");
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
        "swamp-serve-myrepo-myhost",
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
        "swamp-serve-myrepo-myhost",
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
        "swamp-serve-myrepo-myhost",
        AbortSignal.timeout(5000),
      ),
    Error,
    "OAuth client registration via API key failed: 403",
  );
});
