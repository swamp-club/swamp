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
import type { RevokeCollectiveTokenResponse } from "../../infrastructure/http/swamp_club_client.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  authTokenRevoke,
  type AuthTokenRevokeDeps,
  type AuthTokenRevokeEvent,
} from "./token_revoke.ts";

const testCredentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "adam",
};

const testRevokeResponse: RevokeCollectiveTokenResponse = {
  token: {
    id: "tok-1",
    name: "ci-deploy",
    keyPrefix: "swamp_org_ab",
    enabled: false,
    expiresAt: null,
    createdAt: "2026-07-23T00:00:00Z",
    lastUsedAt: "2026-08-15T12:00:00Z",
    scopes: ["extensions:push"],
  },
};

function makeDeps(
  overrides: Partial<AuthTokenRevokeDeps> = {},
): AuthTokenRevokeDeps {
  return {
    loadCredentials: () => Promise.resolve(testCredentials),
    revokeToken: () => Promise.resolve(testRevokeResponse),
    isCollectiveToken: () => false,
    ...overrides,
  };
}

Deno.test("authTokenRevoke: yields revoking -> completed on success", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenRevokeEvent>(
    authTokenRevoke(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(events, [
    { kind: "revoking", collective: "myorg", tokenId: "tok-1" },
    {
      kind: "completed",
      data: {
        id: "tok-1",
        name: "ci-deploy",
        collective: "myorg",
      },
    },
  ]);
});

Deno.test("authTokenRevoke: completed data has no key field", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenRevokeEvent>(
    authTokenRevoke(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  const completed = events[1] as Extract<
    AuthTokenRevokeEvent,
    { kind: "completed" }
  >;
  assertEquals("key" in completed.data, false);
  assertEquals("secret" in completed.data, false);
  assertEquals("keyPrefix" in completed.data, false);
});

Deno.test("authTokenRevoke: rejects collective tokens", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ isCollectiveToken: () => true });

  const events = await collect<AuthTokenRevokeEvent>(
    authTokenRevoke(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(events.length, 1);
  const err = events[0] as Extract<AuthTokenRevokeEvent, { kind: "error" }>;
  assertEquals(err.kind, "error");
  assertEquals(err.error.code, "validation_failed");
});

Deno.test("authTokenRevoke: yields not_authenticated when no credentials", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ loadCredentials: () => Promise.resolve(null) });

  const events = await collect<AuthTokenRevokeEvent>(
    authTokenRevoke(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(events.length, 1);
  const err = events[0] as Extract<AuthTokenRevokeEvent, { kind: "error" }>;
  assertEquals(err.kind, "error");
  assertEquals(err.error.code, "not_authenticated");
});

Deno.test("authTokenRevoke: uses serverUrlOverride when provided", async () => {
  const ctx = createLibSwampContext();
  const calledUrls: string[] = [];
  const deps = makeDeps({
    revokeToken: (serverUrl, _apiKey, _collective, _tokenId, _signal) => {
      calledUrls.push(serverUrl);
      return Promise.resolve(testRevokeResponse);
    },
    serverUrlOverride: "https://custom.server",
  });

  await collect<AuthTokenRevokeEvent>(
    authTokenRevoke(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(calledUrls, ["https://custom.server"]);
});

Deno.test("authTokenRevoke: passes correct args to revokeToken", async () => {
  const ctx = createLibSwampContext();
  let capturedCollective: string | undefined;
  let capturedTokenId: string | undefined;
  const deps = makeDeps({
    revokeToken: (_serverUrl, _apiKey, collective, tokenId, _signal) => {
      capturedCollective = collective;
      capturedTokenId = tokenId;
      return Promise.resolve(testRevokeResponse);
    },
  });

  await collect<AuthTokenRevokeEvent>(
    authTokenRevoke(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(capturedCollective, "myorg");
  assertEquals(capturedTokenId, "tok-1");
});

Deno.test("authTokenRevoke: yields cancelled error on abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const deps = makeDeps({
    revokeToken: (_serverUrl, _apiKey, _collective, _tokenId, signal) => {
      signal.throwIfAborted();
      return Promise.resolve(testRevokeResponse);
    },
  });

  const events = await collect<AuthTokenRevokeEvent>(
    authTokenRevoke(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  const last = events[events.length - 1] as Extract<
    AuthTokenRevokeEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "cancelled");
});
