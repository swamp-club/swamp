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
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import type { ListCollectiveTokensResponse } from "../../infrastructure/http/swamp_club_client.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  authTokenList,
  type AuthTokenListDeps,
  type AuthTokenListEvent,
} from "./token_list.ts";

const testCredentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "adam",
};

const testListResponse: ListCollectiveTokensResponse = {
  tokens: [
    {
      id: "tok-1",
      name: "ci-deploy",
      keyPrefix: "swamp_org_ab",
      enabled: true,
      expiresAt: null,
      createdAt: "2026-07-23T00:00:00Z",
      lastUsedAt: "2026-08-15T12:00:00Z",
      scopes: ["extensions:push"],
    },
    {
      id: "tok-2",
      name: "staging-runner",
      keyPrefix: "swamp_org_cd",
      enabled: true,
      expiresAt: "2027-01-01T00:00:00Z",
      createdAt: "2026-08-01T00:00:00Z",
      lastUsedAt: null,
      scopes: ["serve:*"],
    },
  ],
};

function makeDeps(
  overrides: Partial<AuthTokenListDeps> = {},
): AuthTokenListDeps {
  return {
    loadCredentials: () => Promise.resolve(testCredentials),
    listTokens: () => Promise.resolve(testListResponse),
    isCollectiveToken: () => false,
    ...overrides,
  };
}

Deno.test("authTokenList: yields listing -> completed on success", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenListEvent>(
    authTokenList(ctx, deps, { collective: "myorg" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "listing", collective: "myorg" });
  const completed = events[1] as Extract<
    AuthTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.collective, "myorg");
  assertEquals(completed.data.tokens.length, 2);
  assertEquals(completed.data.tokens[0].name, "ci-deploy");
  assertEquals(completed.data.tokens[1].name, "staging-runner");
});

Deno.test("authTokenList: completed data has no key field", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenListEvent>(
    authTokenList(ctx, deps, { collective: "myorg" }),
  );

  const completed = events[1] as Extract<
    AuthTokenListEvent,
    { kind: "completed" }
  >;
  for (const token of completed.data.tokens) {
    assertEquals("key" in token, false);
    assertEquals("secret" in token, false);
  }
});

Deno.test("authTokenList: rejects collective tokens", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ isCollectiveToken: () => true });

  const events = await collect<AuthTokenListEvent>(
    authTokenList(ctx, deps, { collective: "myorg" }),
  );

  assertEquals(events.length, 1);
  const err = events[0] as Extract<AuthTokenListEvent, { kind: "error" }>;
  assertEquals(err.kind, "error");
  assertEquals(err.error.code, "validation_failed");
});

Deno.test("authTokenList: yields not_authenticated when no credentials", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ loadCredentials: () => Promise.resolve(null) });

  const events = await collect<AuthTokenListEvent>(
    authTokenList(ctx, deps, { collective: "myorg" }),
  );

  assertEquals(events.length, 1);
  const err = events[0] as Extract<AuthTokenListEvent, { kind: "error" }>;
  assertEquals(err.kind, "error");
  assertEquals(err.error.code, "not_authenticated");
});

Deno.test("authTokenList: uses serverUrlOverride when provided", async () => {
  const ctx = createLibSwampContext();
  const calledUrls: string[] = [];
  const deps = makeDeps({
    listTokens: (serverUrl, _apiKey, _collective, _signal) => {
      calledUrls.push(serverUrl);
      return Promise.resolve(testListResponse);
    },
    serverUrlOverride: "https://custom.server",
  });

  await collect<AuthTokenListEvent>(
    authTokenList(ctx, deps, { collective: "myorg" }),
  );

  assertEquals(calledUrls, ["https://custom.server"]);
});

Deno.test("authTokenList: passes correct collective to listTokens", async () => {
  const ctx = createLibSwampContext();
  let capturedCollective: string | undefined;
  const deps = makeDeps({
    listTokens: (_serverUrl, _apiKey, collective, _signal) => {
      capturedCollective = collective;
      return Promise.resolve(testListResponse);
    },
  });

  await collect<AuthTokenListEvent>(
    authTokenList(ctx, deps, { collective: "myorg" }),
  );

  assertEquals(capturedCollective, "myorg");
});

Deno.test("authTokenList: yields cancelled error on abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const deps = makeDeps({
    listTokens: (_serverUrl, _apiKey, _collective, signal) => {
      signal.throwIfAborted();
      return Promise.resolve(testListResponse);
    },
  });

  const events = await collect<AuthTokenListEvent>(
    authTokenList(ctx, deps, { collective: "myorg" }),
  );

  const last = events[events.length - 1] as Extract<
    AuthTokenListEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "cancelled");
});

Deno.test("authTokenList: handles empty token list", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    listTokens: () => Promise.resolve({ tokens: [] }),
  });

  const events = await collect<AuthTokenListEvent>(
    authTokenList(ctx, deps, { collective: "myorg" }),
  );

  const completed = events[1] as Extract<
    AuthTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.tokens, []);
});
