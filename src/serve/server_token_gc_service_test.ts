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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type ServerTokenGcDeps,
  ServerTokenGcService,
  type TokenGcInfo,
} from "./server_token_gc_service.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { ControlPlaneVaultProvider } from "../domain/vaults/control_plane_vault_provider.ts";
import { serverTokenSecretKey } from "../domain/models/access/server_token_model.ts";
import { oauthAccessTokenKey } from "./device_auth_handler.ts";

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
  deletedRecords: Array<{ definitionId: string; tokenName: string }>;
} {
  const deletedSecrets: string[] = [];
  const deletedOAuthTokens: string[] = [];
  const deletedRecords: Array<{ definitionId: string; tokenName: string }> = [];

  return {
    intervalMs: 100,
    gracePeriodMs: ONE_HOUR,
    listTokens: () => Promise.resolve(tokens),
    deleteTokenSecret: (token) => {
      deletedSecrets.push(token.name);
      return Promise.resolve();
    },
    deleteOAuthAccessToken: (name) => {
      deletedOAuthTokens.push(name);
      return Promise.resolve();
    },
    deleteTokenRecord: (definitionId, tokenName) => {
      deletedRecords.push({ definitionId, tokenName });
      return Promise.resolve();
    },
    deletedSecrets,
    deletedOAuthTokens,
    deletedRecords,
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
  assertEquals(deps.deletedRecords.length, 0);
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

Deno.test("runOnce: deletes expired tokens past the grace period across all layers", async () => {
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
  assertEquals(deps.deletedRecords, [
    { definitionId: "def-oauth-old", tokenName: "oauth-old" },
  ]);
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
  assertEquals(deps.deletedRecords, [
    { definitionId: "def-oauth-revoked", tokenName: "oauth-revoked" },
  ]);
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

Deno.test("runOnce: a record deletion failure skips that token and continues", async () => {
  const token1 = makeToken({ name: "oauth-fail", state: "revoked" });
  const token2 = makeToken({ name: "oauth-ok", state: "revoked" });
  const deletedRecords: string[] = [];
  const deps = makeMockDeps([token1, token2], {
    deleteTokenRecord: (_definitionId, tokenName) => {
      if (tokenName === "oauth-fail") {
        return Promise.reject(new Error("data store unavailable"));
      }
      deletedRecords.push(tokenName);
      return Promise.resolve();
    },
  });
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deps.deletedSecrets, ["oauth-fail", "oauth-ok"]);
  assertEquals(deletedRecords, ["oauth-ok"]);
});

Deno.test("runOnce: a secret deletion failure keeps the token's records for the next sweep", async () => {
  const token = makeToken({ name: "oauth-nosecret", state: "revoked" });
  const deps = makeMockDeps([token], {
    deleteTokenSecret: () => Promise.reject(new Error("vault unavailable")),
  });
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 0);
  assertEquals(deps.deletedOAuthTokens, []);
  assertEquals(deps.deletedRecords, []);
});

Deno.test("runOnce: an OAuth access token deletion failure still collects the token", async () => {
  const token = makeToken({ name: "oauth-nooauth", state: "revoked" });
  const deps = makeMockDeps([token], {
    deleteOAuthAccessToken: () => Promise.reject(new Error("store down")),
  });
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deps.deletedRecords, [
    { definitionId: "def-oauth-nooauth", tokenName: "oauth-nooauth" },
  ]);
});

Deno.test("start: runs the first sweep straight away, not after the interval", async () => {
  const token = makeToken({ name: "oauth-revoked", state: "revoked" });
  let listCalls = 0;
  const deps = makeMockDeps([], {
    intervalMs: ONE_HOUR,
    listTokens: () => {
      listCalls++;
      return Promise.resolve([token]);
    },
  });
  const service = new ServerTokenGcService(deps);

  try {
    service.start();
    await waitFor(
      () => deps.deletedRecords.length === 1,
      "first sweep to collect the revoked token",
    );
    assertEquals(listCalls, 1);
  } finally {
    await service.dispose();
  }
});

Deno.test("start: sweeps again after each interval", async () => {
  let listCalls = 0;
  const deps = makeMockDeps([], {
    intervalMs: 10,
    listTokens: () => {
      listCalls++;
      return Promise.resolve([]);
    },
  });
  const service = new ServerTokenGcService(deps);

  try {
    service.start();
    await waitFor(() => listCalls >= 3, "three sweeps");
  } finally {
    await service.dispose();
  }
});

Deno.test("dispose: stops the loop, and a disposed service cannot restart", async () => {
  let listCalls = 0;
  const deps = makeMockDeps([], {
    // A zero interval makes a loop that survived dispose sweep on every
    // event-loop turn, so the yields below would observe it.
    intervalMs: 0,
    listTokens: () => {
      listCalls++;
      return Promise.resolve([]);
    },
  });
  const service = new ServerTokenGcService(deps);
  service.start();
  await waitFor(() => listCalls >= 2, "the loop to sweep twice");

  await service.dispose();
  service.start();
  const callsAtDispose = listCalls;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }

  assertEquals(listCalls, callsAtDispose);
});

Deno.test("dispose: waits for an in-flight sweep and schedules no further sweep", async () => {
  let listCalls = 0;
  let releaseSweep!: () => void;
  const sweepHeld = new Promise<void>((resolve) => {
    releaseSweep = resolve;
  });
  const deps = makeMockDeps([], {
    intervalMs: 0,
    listTokens: async () => {
      listCalls++;
      await sweepHeld;
      return [];
    },
  });
  const service = new ServerTokenGcService(deps);
  service.start();
  await waitFor(() => listCalls === 1, "the first sweep to start");

  let disposeDone = false;
  const disposed = service.dispose().then(() => {
    disposeDone = true;
  });
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assertEquals(disposeDone, false, "dispose must wait for the running sweep");
  releaseSweep();
  await disposed;
  const callsAtDispose = listCalls;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }

  assertEquals(listCalls, callsAtDispose);
});

Deno.test("runOnce: returns zero and does not log when no tokens are eligible", async () => {
  const deps = makeMockDeps([]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 0);
  assertEquals(deps.deletedSecrets.length, 0);
  assertEquals(deps.deletedOAuthTokens.length, 0);
  assertEquals(deps.deletedRecords.length, 0);
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
  assertEquals(deps.deletedRecords.map((r) => r.definitionId), [
    "def-oauth-old",
    "def-oauth-revoked",
  ]);
});

function createInMemoryControlPlaneStore(): ControlPlaneStore & {
  data: Map<string, Uint8Array>;
} {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put: (key: string, value: Uint8Array) => {
      data.set(key, value);
      return Promise.resolve();
    },
    get: (key: string) => Promise.resolve(data.get(key) ?? null),
    delete: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix: string) =>
      Promise.resolve([...data.keys()].filter((k) => k.startsWith(prefix))),
  };
}

Deno.test("runOnce: deletes control plane vault entries for token secrets and OAuth access tokens", async () => {
  const store = createInMemoryControlPlaneStore();
  const provider = new ControlPlaneVaultProvider(store);
  await provider.initialize();

  const tokenName = "oauth-test123";
  await provider.put(serverTokenSecretKey(tokenName), "secret-value");
  await provider.put(oauthAccessTokenKey(tokenName), "oauth-token-value");

  const secretsBefore = await provider.list();
  assertEquals(secretsBefore.length, 2);

  const token = makeToken({
    name: tokenName,
    state: "revoked",
  });
  const deletedRecords: string[] = [];

  const service = new ServerTokenGcService({
    intervalMs: 100,
    gracePeriodMs: ONE_HOUR,
    listTokens: () => Promise.resolve([token]),
    deleteTokenSecret: async (t) => {
      await provider.delete(serverTokenSecretKey(t.name));
    },
    deleteOAuthAccessToken: async (name) => {
      await provider.delete(oauthAccessTokenKey(name));
    },
    deleteTokenRecord: (definitionId) => {
      deletedRecords.push(definitionId);
      return Promise.resolve();
    },
  });

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deletedRecords, [`def-${tokenName}`]);
  const secretsAfter = await provider.list();
  assertEquals(secretsAfter.length, 0);
  assertEquals(store.data.size, 1); // only the encryption key remains
});
