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
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import { UserError } from "../../domain/errors.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  authTokenDelete,
  type AuthTokenDeleteDeps,
  type AuthTokenDeleteEvent,
} from "./token_delete.ts";

const testCredentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "adam",
};

function makeDeps(
  overrides: Partial<AuthTokenDeleteDeps> = {},
): AuthTokenDeleteDeps {
  return {
    loadCredentials: () => Promise.resolve(testCredentials),
    deleteToken: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("authTokenDelete: yields deleting -> completed on success", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenDeleteEvent>(
    authTokenDelete(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(events, [
    { kind: "deleting", collective: "myorg", tokenId: "tok-1" },
    {
      kind: "completed",
      data: {
        id: "tok-1",
        collective: "myorg",
      },
    },
  ]);
});

Deno.test("authTokenDelete: completed data has no key field", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<AuthTokenDeleteEvent>(
    authTokenDelete(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  const completed = events[1] as Extract<
    AuthTokenDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals("key" in completed.data, false);
  assertEquals("secret" in completed.data, false);
  assertEquals("keyPrefix" in completed.data, false);
});

Deno.test("authTokenDelete: a collective-token login reaches the server", async () => {
  const ctx = createLibSwampContext();
  let presented: string | undefined;
  const deps = makeDeps({
    loadCredentials: () =>
      Promise.resolve({ ...testCredentials, apiKey: "swamp_org_minting" }),
    deleteToken: (_serverUrl, apiKey) => {
      presented = apiKey;
      return Promise.resolve();
    },
  });

  const events = await collect<AuthTokenDeleteEvent>(
    authTokenDelete(ctx, deps, { collective: "myorg", tokenId: "tok-child" }),
  );

  assertEquals(presented, "swamp_org_minting");
  assertEquals(events.map((e) => e.kind), ["deleting", "completed"]);
});

Deno.test("authTokenDelete: yields not_authenticated when no credentials", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ loadCredentials: () => Promise.resolve(null) });

  const events = await collect<AuthTokenDeleteEvent>(
    authTokenDelete(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(events.length, 1);
  const err = events[0] as Extract<AuthTokenDeleteEvent, { kind: "error" }>;
  assertEquals(err.kind, "error");
  assertEquals(err.error.code, "not_authenticated");
});

Deno.test("authTokenDelete: uses serverUrlOverride when provided", async () => {
  const ctx = createLibSwampContext();
  const calledUrls: string[] = [];
  const deps = makeDeps({
    deleteToken: (serverUrl, _apiKey, _collective, _tokenId, _signal) => {
      calledUrls.push(serverUrl);
      return Promise.resolve();
    },
    serverUrlOverride: "https://custom.server",
  });

  await collect<AuthTokenDeleteEvent>(
    authTokenDelete(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(calledUrls, ["https://custom.server"]);
});

Deno.test("authTokenDelete: passes correct args to deleteToken", async () => {
  const ctx = createLibSwampContext();
  let capturedCollective: string | undefined;
  let capturedTokenId: string | undefined;
  const deps = makeDeps({
    deleteToken: (_serverUrl, _apiKey, collective, tokenId, _signal) => {
      capturedCollective = collective;
      capturedTokenId = tokenId;
      return Promise.resolve();
    },
  });

  await collect<AuthTokenDeleteEvent>(
    authTokenDelete(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  assertEquals(capturedCollective, "myorg");
  assertEquals(capturedTokenId, "tok-1");
});

Deno.test("authTokenDelete: yields cancelled error on abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const deps = makeDeps({
    deleteToken: (_serverUrl, _apiKey, _collective, _tokenId, signal) => {
      signal.throwIfAborted();
      return Promise.resolve();
    },
  });

  const events = await collect<AuthTokenDeleteEvent>(
    authTokenDelete(ctx, deps, { collective: "myorg", tokenId: "tok-1" }),
  );

  const last = events[events.length - 1] as Extract<
    AuthTokenDeleteEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "cancelled");
});

Deno.test("authTokenDelete: propagates a UserError from deleteToken", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    deleteToken: () =>
      Promise.reject(
        new UserError(
          'Failed to delete collective token (HTTP 422): {"error":"Token not found"}',
        ),
      ),
  });

  const events: AuthTokenDeleteEvent[] = [];
  const err = await assertRejects(
    async () => {
      for await (
        const event of authTokenDelete(ctx, deps, {
          collective: "myorg",
          tokenId: "tok-1",
        })
      ) {
        events.push(event);
      }
    },
    UserError,
  );
  assertEquals(err.message.includes("Token not found"), true);
  assertEquals(events.map((e) => e.kind), ["deleting"]);
});
