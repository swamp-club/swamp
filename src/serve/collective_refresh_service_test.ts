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

import { assert, assertEquals } from "@std/assert";
import { type Span, trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type ActiveTokenInfo,
  type CollectiveRefreshDeps,
  CollectiveRefreshService,
} from "./collective_refresh_service.ts";
import type { OAuthUserInfo } from "./oauth_client.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import { withCapturedSpans } from "../infrastructure/tracing/span_test_helpers.ts";

function makeMockDeps(
  overrides: Partial<CollectiveRefreshDeps> = {},
): CollectiveRefreshDeps & {
  updatedTokens: Map<string, string[]>;
  revokedTokens: string[];
  updatedConnections: Map<string, readonly string[]>;
  closedPrincipals: string[];
} {
  const updatedTokens = new Map<string, string[]>();
  const revokedTokens: string[] = [];
  const updatedConnections = new Map<string, readonly string[]>();
  const closedPrincipals: string[] = [];

  return {
    intervalMs: 100,
    oauthProvider: "https://auth.example.com",
    groupsField: "collectives",

    getUserInfo: (
      _providerUrl: string,
      _accessToken: string,
      _groupsField: string,
      _signal: AbortSignal,
    ): Promise<OAuthUserInfo> =>
      Promise.resolve({
        sub: "user-1",
        email: "user@example.com",
        collectives: ["team-a"],
        groups: [],
      }),

    listActiveTokens: (): Promise<ActiveTokenInfo[]> => Promise.resolve([]),

    getAccessToken: (_tokenName: string): Promise<string | null> =>
      Promise.resolve("stored-access-token"),

    updateTokenCollectives: (
      tokenName: string,
      collectives: string[],
      _groups: string[],
    ): Promise<void> => {
      updatedTokens.set(tokenName, collectives);
      return Promise.resolve();
    },

    revokeToken: (tokenName: string): Promise<void> => {
      revokedTokens.push(tokenName);
      return Promise.resolve();
    },

    updateConnectionCollectives: (
      principalId: string,
      collectives: readonly string[],
      _groups: readonly string[],
    ): void => {
      updatedConnections.set(principalId, collectives);
    },

    closeConnectionsForPrincipal: (principalId: string): void => {
      closedPrincipals.push(principalId);
    },

    updatedTokens,
    revokedTokens,
    updatedConnections,
    closedPrincipals,
    ...overrides,
  };
}

/**
 * Wraps a listActiveTokens fake to count refresh cycles. Ticks run strictly
 * one after another, so a second cycle starting proves the first finished.
 */
function countCycles(
  listActiveTokens: () => Promise<ActiveTokenInfo[]>,
): {
  listActiveTokens: () => Promise<ActiveTokenInfo[]>;
  firstCycleDone: () => Promise<void>;
} {
  let cycles = 0;
  return {
    listActiveTokens: () => {
      cycles++;
      return listActiveTokens();
    },
    firstCycleDone: () =>
      waitFor(() => cycles >= 2, "the first refresh cycle to complete"),
  };
}

Deno.test("CollectiveRefreshService: updates collectives when groups change", async () => {
  const deps = makeMockDeps({
    listActiveTokens: () =>
      Promise.resolve([
        {
          name: "tok-1",
          principalId: "user:u1",
          collectives: ["old-group"],
          groups: [],
        },
      ]),
    getUserInfo: () =>
      Promise.resolve({
        sub: "u1",
        email: "u1@example.com",
        collectives: ["new-group"],
        groups: ["idp-group-1"],
      }),
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await waitFor(
    () => deps.updatedConnections.has("user:u1"),
    "the connection collectives update",
  );
  await svc.dispose();

  assertEquals(deps.updatedTokens.get("tok-1"), ["new-group"]);
  assertEquals(deps.updatedConnections.get("user:u1"), ["new-group"]);
});

Deno.test("CollectiveRefreshService: skips update when collectives unchanged", async () => {
  const cycles = countCycles(() =>
    Promise.resolve([
      {
        name: "tok-1",
        principalId: "user:u1",
        collectives: ["team-a"],
        groups: [],
      },
    ])
  );
  const deps = makeMockDeps({
    listActiveTokens: cycles.listActiveTokens,
    getUserInfo: () =>
      Promise.resolve({
        sub: "u1",
        email: "u1@example.com",
        collectives: ["team-a"],
        groups: [],
      }),
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await cycles.firstCycleDone();
  await svc.dispose();

  assertEquals(deps.updatedTokens.size, 0);
  assertEquals(deps.updatedConnections.size, 0);
});

Deno.test("CollectiveRefreshService: revokes token on 401 from userinfo", async () => {
  const deps = makeMockDeps({
    // A revoked token is no longer active, as in the real token store.
    listActiveTokens: () =>
      Promise.resolve(
        deps.revokedTokens.includes("tok-1") ? [] : [
          {
            name: "tok-1",
            principalId: "user:u1",
            collectives: [],
            groups: [],
          },
        ],
      ),
    getUserInfo: () =>
      Promise.reject(new Error("Userinfo request failed: 401 Unauthorized")),
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await waitFor(
    () => deps.closedPrincipals.length > 0,
    "the principal's connections to close",
  );
  await svc.dispose();

  assertEquals(deps.revokedTokens, ["tok-1"]);
  assertEquals(deps.closedPrincipals, ["user:u1"]);
});

Deno.test("CollectiveRefreshService: keeps snapshot on network error", async () => {
  const cycles = countCycles(() =>
    Promise.resolve([
      {
        name: "tok-1",
        principalId: "user:u1",
        collectives: ["existing"],
        groups: [],
      },
    ])
  );
  const deps = makeMockDeps({
    listActiveTokens: cycles.listActiveTokens,
    getUserInfo: () => Promise.reject(new Error("Connection refused")),
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await cycles.firstCycleDone();
  await svc.dispose();

  assertEquals(deps.revokedTokens.length, 0);
  assertEquals(deps.updatedTokens.size, 0);
});

Deno.test("CollectiveRefreshService: skips token without stored access token", async () => {
  const cycles = countCycles(() =>
    Promise.resolve([
      { name: "tok-1", principalId: "user:u1", collectives: [], groups: [] },
    ])
  );
  const deps = makeMockDeps({
    listActiveTokens: cycles.listActiveTokens,
    getAccessToken: () => Promise.resolve(null),
    getUserInfo: () => {
      throw new Error("should not be called");
    },
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await cycles.firstCycleDone();
  await svc.dispose();

  assertEquals(deps.updatedTokens.size, 0);
});

Deno.test("CollectiveRefreshService: dispose stops the timer", async () => {
  let refreshCallCount = 0;
  const deps = makeMockDeps({
    intervalMs: 50,
    listActiveTokens: () => {
      refreshCallCount++;
      return Promise.resolve([]);
    },
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await waitFor(() => refreshCallCount > 0, "the first refresh cycle");
  await svc.dispose();
  const countAtDispose = refreshCallCount;
  // Proving no further ticks run has no event to poll for, so this waits
  // several intervals; it can only pass wrongly, never flake.
  await new Promise((r) => setTimeout(r, 150));
  assertEquals(refreshCallCount, countAtDispose);
});

Deno.test("CollectiveRefreshService: keeps collectives and groups separate", async () => {
  let storedCollectives: string[] = [];
  let storedGroups: string[] = [];
  const deps = makeMockDeps({
    listActiveTokens: () =>
      Promise.resolve([
        { name: "tok-1", principalId: "user:u1", collectives: [], groups: [] },
      ]),
    getUserInfo: () =>
      Promise.resolve({
        sub: "u1",
        email: "u1@example.com",
        collectives: ["coll-a", "coll-b"],
        groups: ["group-x", "group-y"],
      }),
    updateTokenCollectives: (
      _tokenName: string,
      collectives: string[],
      groups: string[],
    ) => {
      storedCollectives = collectives;
      storedGroups = groups;
      return Promise.resolve();
    },
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await waitFor(
    () => storedGroups.length > 0,
    "the token collectives and groups update",
  );
  await svc.dispose();

  assertEquals(storedCollectives, ["coll-a", "coll-b"]);
  assertEquals(storedGroups, ["group-x", "group-y"]);
});

Deno.test("CollectiveRefreshService: works with fallback getAccessToken (simulates _token-secrets → user vault fallback)", async () => {
  const accessTokenNames: string[] = [];
  const deps = makeMockDeps({
    listActiveTokens: () =>
      Promise.resolve([
        {
          name: "tok-migrated",
          principalId: "user:u1",
          collectives: ["old"],
          groups: [],
        },
      ]),
    getAccessToken: (tokenName: string): Promise<string | null> => {
      accessTokenNames.push(tokenName);
      return Promise.resolve("fallback-access-token");
    },
    getUserInfo: () =>
      Promise.resolve({
        sub: "u1",
        email: "u1@example.com",
        collectives: ["new"],
        groups: [],
      }),
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await waitFor(
    () => deps.updatedTokens.has("tok-migrated"),
    "the migrated token's collectives update",
  );
  await svc.dispose();

  // Refresh cycles repeat every intervalMs, so assert which token was read
  // rather than how many cycles fit before dispose.
  assertEquals(new Set(accessTokenNames), new Set(["tok-migrated"]));
  assertEquals(deps.updatedTokens.get("tok-migrated"), ["new"]);
});

Deno.test("CollectiveRefreshService: skips token when getAccessToken returns null", async () => {
  const cycles = countCycles(() =>
    Promise.resolve([
      {
        name: "tok-no-access",
        principalId: "user:u1",
        collectives: ["existing"],
        groups: [],
      },
    ])
  );
  const deps = makeMockDeps({
    listActiveTokens: cycles.listActiveTokens,
    getAccessToken: (): Promise<string | null> => Promise.resolve(null),
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await cycles.firstCycleDone();
  await svc.dispose();

  assertEquals(deps.updatedTokens.size, 0);
  assertEquals(deps.revokedTokens.length, 0);
});

Deno.test("CollectiveRefreshService: a tick runs with no active span when started under one", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    const service = new CollectiveRefreshService(makeMockDeps({
      intervalMs: 10,
      listActiveTokens: () => {
        seen.push(trace.getActiveSpan());
        return Promise.resolve([]);
      },
    }));
    await withSpan("swamp.cli", {}, async () => {
      service.start();
      try {
        await waitFor(() => seen.length >= 2, "two refresh cycles");
      } finally {
        await service.dispose();
      }
    });
    assert(seen.length >= 2);
    for (const span of seen) assertEquals(span, undefined);
  });
});
