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
  type ServerTokenGcDeps,
  ServerTokenGcService,
  type TokenGcInfo,
} from "./server_token_gc_service.ts";

const ONE_HOUR = 60 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * ONE_HOUR;

function makeToken(
  overrides: Partial<TokenGcInfo> & { name: string },
): TokenGcInfo {
  return {
    definitionId: `def-${overrides.name}`,
    state: "active",
    expiresAt: new Date(Date.now() + THIRTY_DAYS).toISOString(),
    ...overrides,
  };
}

function makeMockDeps(
  tokens: TokenGcInfo[] = [],
  overrides: Partial<ServerTokenGcDeps> = {},
): ServerTokenGcDeps & {
  deletedSecrets: string[];
  deletedOAuthTokens: string[];
  deletedData: Array<{ definitionId: string; tokenName: string }>;
  deletedDefinitions: string[];
} {
  const deletedSecrets: string[] = [];
  const deletedOAuthTokens: string[] = [];
  const deletedData: Array<{ definitionId: string; tokenName: string }> = [];
  const deletedDefinitions: string[] = [];

  return {
    intervalMs: 100,
    gracePeriodMs: ONE_HOUR,
    listTokens: () => Promise.resolve(tokens),
    deleteTokenSecret: (name) => {
      deletedSecrets.push(name);
      return Promise.resolve();
    },
    deleteOAuthAccessToken: (name) => {
      deletedOAuthTokens.push(name);
      return Promise.resolve();
    },
    deleteTokenData: (definitionId, tokenName) => {
      deletedData.push({ definitionId, tokenName });
      return Promise.resolve();
    },
    deleteDefinition: (definitionId) => {
      deletedDefinitions.push(definitionId);
      return Promise.resolve();
    },
    deletedSecrets,
    deletedOAuthTokens,
    deletedData,
    deletedDefinitions,
    ...overrides,
  };
}

Deno.test("runOnce: skips active tokens that have not expired", async () => {
  const token = makeToken({ name: "oauth-active1" });
  const deps = makeMockDeps([token]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 0);
  assertEquals(deps.deletedSecrets.length, 0);
  assertEquals(deps.deletedDefinitions.length, 0);
});

Deno.test("runOnce: skips expired tokens within the grace period", async () => {
  const token = makeToken({
    name: "oauth-recent",
    state: "expired",
    expiresAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
  });
  const deps = makeMockDeps([token]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 0);
  assertEquals(deps.deletedSecrets.length, 0);
});

Deno.test("runOnce: deletes expired tokens past the grace period across all 4 layers", async () => {
  const token = makeToken({
    name: "oauth-old",
    state: "expired",
    expiresAt: new Date(Date.now() - 2 * ONE_HOUR).toISOString(), // 2 hours ago
  });
  const deps = makeMockDeps([token]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deps.deletedSecrets, ["oauth-old"]);
  assertEquals(deps.deletedOAuthTokens, ["oauth-old"]);
  assertEquals(deps.deletedData, [
    { definitionId: "def-oauth-old", tokenName: "oauth-old" },
  ]);
  assertEquals(deps.deletedDefinitions, ["def-oauth-old"]);
});

Deno.test("runOnce: deletes revoked tokens immediately without grace period", async () => {
  const token = makeToken({
    name: "oauth-revoked",
    state: "revoked",
    expiresAt: new Date(Date.now() + THIRTY_DAYS).toISOString(), // not yet expired
    revokedAt: new Date().toISOString(),
  });
  const deps = makeMockDeps([token]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deps.deletedSecrets, ["oauth-revoked"]);
  assertEquals(deps.deletedOAuthTokens, ["oauth-revoked"]);
  assertEquals(deps.deletedData, [
    { definitionId: "def-oauth-revoked", tokenName: "oauth-revoked" },
  ]);
  assertEquals(deps.deletedDefinitions, ["def-oauth-revoked"]);
});

Deno.test("runOnce: GC's active tokens that are past expiresAt plus grace period", async () => {
  const token = makeToken({
    name: "oauth-stale",
    state: "active",
    expiresAt: new Date(Date.now() - 2 * ONE_HOUR).toISOString(),
  });
  const deps = makeMockDeps([token]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deps.deletedSecrets, ["oauth-stale"]);
});

Deno.test("runOnce: partial deletion failure logs warning and continues", async () => {
  const token1 = makeToken({
    name: "oauth-fail",
    state: "revoked",
  });
  const token2 = makeToken({
    name: "oauth-ok",
    state: "revoked",
  });
  let callCount = 0;
  const deps = makeMockDeps([token1, token2], {
    deleteTokenData: (_defId, _name) => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("data store unavailable"));
      }
      return Promise.resolve();
    },
  });
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  // First token fails at deleteTokenData (after secrets succeed), second succeeds fully
  assertEquals(count, 1);
  assertEquals(deps.deletedSecrets, ["oauth-fail", "oauth-ok"]);
  assertEquals(deps.deletedOAuthTokens, ["oauth-fail", "oauth-ok"]);
});

Deno.test("dispose: prevents further ticks from running", async () => {
  const token = makeToken({
    name: "oauth-disposed",
    state: "revoked",
  });
  let listCalls = 0;
  const deps = makeMockDeps([], {
    listTokens: () => {
      listCalls++;
      return Promise.resolve([token]);
    },
  });
  const service = new ServerTokenGcService(deps);
  service.start();

  await service.dispose();

  const callsAtDispose = listCalls;
  await new Promise((r) => setTimeout(r, 250));
  assertEquals(listCalls, callsAtDispose);
});

Deno.test("runOnce: returns zero and does not log when no tokens are eligible", async () => {
  const deps = makeMockDeps([]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 0);
  assertEquals(deps.deletedSecrets.length, 0);
  assertEquals(deps.deletedOAuthTokens.length, 0);
  assertEquals(deps.deletedData.length, 0);
  assertEquals(deps.deletedDefinitions.length, 0);
});

Deno.test("runOnce: handles mix of eligible and ineligible tokens", async () => {
  const active = makeToken({ name: "oauth-active" });
  const recentExpired = makeToken({
    name: "oauth-recent",
    state: "expired",
    expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
  });
  const oldExpired = makeToken({
    name: "oauth-old",
    state: "expired",
    expiresAt: new Date(Date.now() - 2 * ONE_HOUR).toISOString(),
  });
  const revoked = makeToken({
    name: "oauth-revoked",
    state: "revoked",
  });

  const deps = makeMockDeps([active, recentExpired, oldExpired, revoked]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 2);
  assertEquals(deps.deletedSecrets, ["oauth-old", "oauth-revoked"]);
  assertEquals(deps.deletedDefinitions, [
    "def-oauth-old",
    "def-oauth-revoked",
  ]);
});

Deno.test("runOnce: secret deletion failure does not prevent data and definition cleanup", async () => {
  const token = makeToken({
    name: "oauth-nosecret",
    state: "revoked",
  });
  const deps = makeMockDeps([token], {
    deleteTokenSecret: () => Promise.reject(new Error("secret already gone")),
  });
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deps.deletedOAuthTokens, ["oauth-nosecret"]);
  assertEquals(deps.deletedData, [
    { definitionId: "def-oauth-nosecret", tokenName: "oauth-nosecret" },
  ]);
  assertEquals(deps.deletedDefinitions, ["def-oauth-nosecret"]);
});
