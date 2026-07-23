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
import type { CreateCollectiveTokenResponse } from "../../infrastructure/http/swamp_club_client.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  authTokenCreate,
  type AuthTokenCreateDeps,
  type AuthTokenCreateEvent,
} from "./token_create.ts";

const testCredentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "adam",
};

const testTokenResponse: CreateCollectiveTokenResponse = {
  token: {
    id: "tok-1",
    name: "cli-testhost-1700000000",
    keyPrefix: "swamp_org_ab",
    enabled: true,
    expiresAt: null,
    createdAt: "2026-07-23T00:00:00Z",
    lastUsedAt: null,
    scopes: ["extensions:push"],
  },
  key:
    "swamp_org_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
};

function makeDeps(
  overrides: Partial<AuthTokenCreateDeps> = {},
): AuthTokenCreateDeps {
  return {
    loadCredentials: () => Promise.resolve(testCredentials),
    createToken: () => Promise.resolve(testTokenResponse),
    getHostname: () => "testhost",
    getTimestamp: () => 1700000000,
    isCollectiveToken: () => false,
    ...overrides,
  };
}

Deno.test("authTokenCreate: yields creating -> completed on success", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: ["extensions:push"],
    }),
  );

  assertEquals(events, [
    { kind: "creating", collective: "myorg", name: "cli-testhost-1700000000" },
    {
      kind: "completed",
      data: {
        key: testTokenResponse.key,
        id: "tok-1",
        name: "cli-testhost-1700000000",
        collective: "myorg",
        scopes: ["extensions:push"],
      },
    },
  ]);
});

Deno.test("authTokenCreate: uses provided name instead of generating one", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: ["extensions:push"],
      name: "ci-deploy",
    }),
  );

  assertEquals(events[0], {
    kind: "creating",
    collective: "myorg",
    name: "ci-deploy",
  });
});

Deno.test("authTokenCreate: rejects collective tokens", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ isCollectiveToken: () => true });

  const events = await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: ["extensions:push"],
    }),
  );

  assertEquals(events.length, 1);
  const err = events[0] as Extract<AuthTokenCreateEvent, { kind: "error" }>;
  assertEquals(err.kind, "error");
  assertEquals(err.error.code, "validation_failed");
});

Deno.test("authTokenCreate: rejects empty scopes", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: [],
    }),
  );

  assertEquals(events.length, 1);
  const err = events[0] as Extract<AuthTokenCreateEvent, { kind: "error" }>;
  assertEquals(err.kind, "error");
  assertEquals(err.error.code, "validation_failed");
});

Deno.test("authTokenCreate: yields not_authenticated when no credentials", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ loadCredentials: () => Promise.resolve(null) });

  const events = await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: ["extensions:push"],
    }),
  );

  assertEquals(events.length, 1);
  const err = events[0] as Extract<AuthTokenCreateEvent, { kind: "error" }>;
  assertEquals(err.kind, "error");
  assertEquals(err.error.code, "not_authenticated");
});

Deno.test("authTokenCreate: uses serverUrlOverride when provided", async () => {
  const ctx = createLibSwampContext();
  const calledUrls: string[] = [];
  const deps = makeDeps({
    createToken: (serverUrl, _apiKey, _collective, _input, _signal) => {
      calledUrls.push(serverUrl);
      return Promise.resolve(testTokenResponse);
    },
    serverUrlOverride: "https://custom.server",
  });

  await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: ["extensions:push"],
    }),
  );

  assertEquals(calledUrls, ["https://custom.server"]);
});

Deno.test("authTokenCreate: truncates hostname to 14 chars", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    getHostname: () => "a-very-long-hostname-that-exceeds-fourteen-chars",
  });

  const events = await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: ["extensions:push"],
    }),
  );

  const creating = events[0] as Extract<
    AuthTokenCreateEvent,
    { kind: "creating" }
  >;
  assertEquals(creating.name, "cli-a-very-long-ho-1700000000");
});

Deno.test("authTokenCreate: yields cancelled error on abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const deps = makeDeps({
    createToken: (_serverUrl, _apiKey, _collective, _input, signal) => {
      signal.throwIfAborted();
      return Promise.resolve(testTokenResponse);
    },
  });

  const events = await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: ["extensions:push"],
    }),
  );

  const last = events[events.length - 1] as Extract<
    AuthTokenCreateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "cancelled");
});

Deno.test("authTokenCreate: passes correct input to createToken", async () => {
  const ctx = createLibSwampContext();
  let capturedInput: { name: string; scopes: string[] } | undefined;
  let capturedCollective: string | undefined;
  const deps = makeDeps({
    createToken: (_serverUrl, _apiKey, collective, input, _signal) => {
      capturedCollective = collective;
      capturedInput = input;
      return Promise.resolve(testTokenResponse);
    },
  });

  await collect<AuthTokenCreateEvent>(
    authTokenCreate(ctx, deps, {
      collective: "myorg",
      scopes: ["extensions:push", "serve:*"],
      name: "my-token",
    }),
  );

  assertEquals(capturedCollective, "myorg");
  assertEquals(capturedInput, {
    name: "my-token",
    scopes: ["extensions:push", "serve:*"],
  });
});
