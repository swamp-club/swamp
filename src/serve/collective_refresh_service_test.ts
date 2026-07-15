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
  type ActiveTokenInfo,
  type CollectiveRefreshDeps,
  CollectiveRefreshService,
} from "./collective_refresh_service.ts";
import type { OAuthUserInfo } from "./oauth_client.ts";

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
  await new Promise((r) => setTimeout(r, 200));
  await svc.dispose();

  assertEquals(deps.updatedTokens.get("tok-1"), ["new-group"]);
  assertEquals(deps.updatedConnections.get("user:u1"), ["new-group"]);
});

Deno.test("CollectiveRefreshService: skips update when collectives unchanged", async () => {
  const deps = makeMockDeps({
    listActiveTokens: () =>
      Promise.resolve([
        {
          name: "tok-1",
          principalId: "user:u1",
          collectives: ["team-a"],
          groups: [],
        },
      ]),
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
  await new Promise((r) => setTimeout(r, 200));
  await svc.dispose();

  assertEquals(deps.updatedTokens.size, 0);
  assertEquals(deps.updatedConnections.size, 0);
});

Deno.test("CollectiveRefreshService: revokes token on 401 from userinfo", async () => {
  const deps = makeMockDeps({
    listActiveTokens: () =>
      Promise.resolve([
        { name: "tok-1", principalId: "user:u1", collectives: [], groups: [] },
      ]),
    getUserInfo: () =>
      Promise.reject(new Error("Userinfo request failed: 401 Unauthorized")),
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await new Promise((r) => setTimeout(r, 200));
  await svc.dispose();

  assertEquals(deps.revokedTokens, ["tok-1"]);
  assertEquals(deps.closedPrincipals, ["user:u1"]);
});

Deno.test("CollectiveRefreshService: keeps snapshot on network error", async () => {
  const deps = makeMockDeps({
    listActiveTokens: () =>
      Promise.resolve([
        {
          name: "tok-1",
          principalId: "user:u1",
          collectives: ["existing"],
          groups: [],
        },
      ]),
    getUserInfo: () => Promise.reject(new Error("Connection refused")),
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await new Promise((r) => setTimeout(r, 200));
  await svc.dispose();

  assertEquals(deps.revokedTokens.length, 0);
  assertEquals(deps.updatedTokens.size, 0);
});

Deno.test("CollectiveRefreshService: skips token without stored access token", async () => {
  const deps = makeMockDeps({
    listActiveTokens: () =>
      Promise.resolve([
        { name: "tok-1", principalId: "user:u1", collectives: [], groups: [] },
      ]),
    getAccessToken: () => Promise.resolve(null),
    getUserInfo: () => {
      throw new Error("should not be called");
    },
  });

  const svc = new CollectiveRefreshService(deps);
  svc.start();
  await new Promise((r) => setTimeout(r, 200));
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
  await new Promise((r) => setTimeout(r, 120));
  await svc.dispose();
  const countAtDispose = refreshCallCount;
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
  await new Promise((r) => setTimeout(r, 200));
  await svc.dispose();

  assertEquals(storedCollectives, ["coll-a", "coll-b"]);
  assertEquals(storedGroups, ["group-x", "group-y"]);
});
