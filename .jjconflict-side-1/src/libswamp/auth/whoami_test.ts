// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import type { WhoamiResponse } from "../../infrastructure/http/swamp_club_client.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { type AuthDeps, type AuthWhoamiEvent, whoami } from "./whoami.ts";

function makeDeps(overrides: {
  credentials?: AuthCredentials | null;
  whoamiResponse?: WhoamiResponse;
  serverUrlOverride?: string;
}): AuthDeps {
  return {
    loadCredentials: () => Promise.resolve(overrides.credentials ?? null),
    saveCredentials: () => Promise.resolve(),
    fetchWhoami: (
      _serverUrl: string,
      _apiKey: string,
      _signal: AbortSignal,
    ) =>
      Promise.resolve(
        overrides.whoamiResponse ?? { authenticated: false },
      ),
    serverUrlOverride: overrides.serverUrlOverride,
  };
}

const testCredentials: AuthCredentials = {
  serverUrl: "https://swamp.club",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "adam",
};

const testWhoamiResponse: WhoamiResponse = {
  authenticated: true,
  id: "user-1",
  username: "adam",
  email: "adam@example.com",
  name: "Adam",
  organizations: [
    { slug: "si", name: "System Initiative", role: "admin", personal: false },
  ],
};

Deno.test("whoami yields loading_credentials -> contacting_server -> completed on success", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    credentials: testCredentials,
    whoamiResponse: testWhoamiResponse,
  });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(events, [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://swamp.club" },
    {
      kind: "completed",
      identity: {
        serverUrl: "https://swamp.club",
        id: "user-1",
        username: "adam",
        email: "adam@example.com",
        name: "Adam",
        collectives: ["si"],
      },
    },
  ]);
});

Deno.test("whoami yields not_authenticated error when no credentials", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ credentials: null });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "loading_credentials" });
  const last = events[1] as Extract<AuthWhoamiEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_authenticated");
});

Deno.test("whoami yields invalid_api_key error when server says not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    credentials: testCredentials,
    whoamiResponse: { authenticated: false },
  });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(events.length, 3);
  assertEquals(events[0], { kind: "loading_credentials" });
  assertEquals(events[1], {
    kind: "contacting_server",
    serverUrl: "https://swamp.club",
  });
  const last = events[2] as Extract<AuthWhoamiEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "invalid_api_key");
});

Deno.test("whoami uses serverUrlOverride when provided", async () => {
  const ctx = createLibSwampContext();
  const fetchedUrls: string[] = [];
  const deps: AuthDeps = {
    loadCredentials: () => Promise.resolve(testCredentials),
    saveCredentials: () => Promise.resolve(),
    fetchWhoami: (serverUrl, _apiKey, _signal) => {
      fetchedUrls.push(serverUrl);
      return Promise.resolve(testWhoamiResponse);
    },
    serverUrlOverride: "https://custom.server",
  };

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(fetchedUrls, ["https://custom.server"]);
  assertEquals(events[1], {
    kind: "contacting_server",
    serverUrl: "https://custom.server",
  });
});

Deno.test("whoami excludes collectives when response has no organizations", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    credentials: testCredentials,
    whoamiResponse: {
      authenticated: true,
      id: "user-1",
      username: "adam",
      email: "adam@example.com",
      name: "Adam",
    },
  });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  const completed = events[2] as Extract<
    AuthWhoamiEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.identity.collectives, undefined);
});

Deno.test("whoami yields cancelled error when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const deps: AuthDeps = {
    loadCredentials: () => Promise.resolve(testCredentials),
    saveCredentials: () => Promise.resolve(),
    fetchWhoami: (_serverUrl, _apiKey, signal) => {
      signal.throwIfAborted();
      return Promise.resolve(testWhoamiResponse);
    },
    serverUrlOverride: undefined,
  };

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  const last = events[events.length - 1] as Extract<
    AuthWhoamiEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "cancelled");
});
