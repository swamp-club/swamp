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
): ServerTokenGcDeps & { collected: string[] } {
  const collected: string[] = [];
  return {
    intervalMs: 100,
    gracePeriodMs: ONE_HOUR,
    listTokens: () => Promise.resolve(tokens),
    collectToken: (token) => {
      collected.push(token.name);
      return Promise.resolve("collected");
    },
    collected,
    ...overrides,
  };
}

Deno.test("runOnce: skips active tokens that have not expired", async () => {
  const deps = makeMockDeps([makeToken({ name: "oauth-active1" })]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 0);
  assertEquals(deps.collected, []);
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
  assertEquals(deps.collected, []);
});

Deno.test("runOnce: collects expired tokens past the grace period", async () => {
  const token = makeToken({
    name: "oauth-old",
    state: "expired",
    expiresAt: new Date(Date.now() - 2 * ONE_HOUR).toISOString(), // 2 hours ago
  });
  const deps = makeMockDeps([token]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deps.collected, ["oauth-old"]);
});

Deno.test("runOnce: collects revoked tokens immediately without grace period", async () => {
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
  assertEquals(deps.collected, ["oauth-revoked"]);
});

Deno.test("runOnce: collects active tokens that are past expiresAt plus grace period", async () => {
  const token = makeToken({
    name: "oauth-stale",
    state: "active",
    expiresAt: new Date(Date.now() - 2 * ONE_HOUR).toISOString(),
  });
  const deps = makeMockDeps([token]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(deps.collected, ["oauth-stale"]);
});

Deno.test("runOnce: re-checks each token against the same policy when collecting it", async () => {
  const listed = makeToken({ name: "oauth-revoked", state: "revoked" });
  const verdicts: boolean[] = [];
  const deps = makeMockDeps([listed], {
    collectToken: (_token, isEligible) => {
      // Rotated since the listing: active again, with a fresh expiry.
      verdicts.push(isEligible(makeToken({ name: "oauth-revoked" })));
      verdicts.push(isEligible(listed));
      verdicts.push(
        isEligible(
          makeToken({
            name: "oauth-revoked",
            state: "expired",
            expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          }),
        ),
      );
      return Promise.resolve("skipped");
    },
  });
  const service = new ServerTokenGcService(deps);

  await service.runOnce();

  assertEquals(verdicts, [false, true, false]);
});

Deno.test("runOnce: a skipped token is not counted", async () => {
  const deps = makeMockDeps([
    makeToken({ name: "oauth-a", state: "revoked" }),
    makeToken({ name: "oauth-b", state: "revoked" }),
  ], {
    collectToken: (token) =>
      Promise.resolve(token.name === "oauth-a" ? "skipped" : "collected"),
  });
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
});

Deno.test("runOnce: a collection failure skips that token and continues", async () => {
  const collected: string[] = [];
  const deps = makeMockDeps([
    makeToken({ name: "oauth-fail", state: "revoked" }),
    makeToken({ name: "oauth-ok", state: "revoked" }),
  ], {
    collectToken: (token) => {
      if (token.name === "oauth-fail") {
        return Promise.reject(new Error("data store unavailable"));
      }
      collected.push(token.name);
      return Promise.resolve("collected");
    },
  });
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 1);
  assertEquals(collected, ["oauth-ok"]);
});

Deno.test("runOnce: handles mix of eligible and ineligible tokens", async () => {
  const deps = makeMockDeps([
    makeToken({ name: "oauth-active" }),
    makeToken({
      name: "oauth-recent",
      state: "expired",
      expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    }),
    makeToken({
      name: "oauth-old",
      state: "expired",
      expiresAt: new Date(Date.now() - 2 * ONE_HOUR).toISOString(),
    }),
    makeToken({ name: "oauth-revoked", state: "revoked" }),
  ]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 2);
  assertEquals(deps.collected, ["oauth-old", "oauth-revoked"]);
});

Deno.test("runOnce: returns zero when no tokens are eligible", async () => {
  const deps = makeMockDeps([]);
  const service = new ServerTokenGcService(deps);

  const count = await service.runOnce();

  assertEquals(count, 0);
  assertEquals(deps.collected, []);
});

Deno.test("start: runs the first sweep straight away, not after the interval", async () => {
  let listCalls = 0;
  const deps = makeMockDeps([], {
    intervalMs: ONE_HOUR,
    listTokens: () => {
      listCalls++;
      return Promise.resolve([
        makeToken({ name: "oauth-revoked", state: "revoked" }),
      ]);
    },
  });
  const service = new ServerTokenGcService(deps);

  try {
    service.start();
    await waitFor(
      () => deps.collected.length === 1,
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
