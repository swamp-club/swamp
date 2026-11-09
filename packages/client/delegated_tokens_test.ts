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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { DelegatedTokens, type TokenEvent } from "./delegated_tokens.ts";
import type { DelegatedTokenSet } from "./integration_client.ts";
import { SwampIntegrationClient } from "./integration_client.ts";
import { SwampHttpError } from "./http_errors.ts";
import { memoryTokenStore, type TokenStore } from "./token_store.ts";
import { FAST, scriptedFetch, type Sent, SERVE } from "./http_test_helpers.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 0, 1, 12);

function tokenSet(over: Partial<DelegatedTokenSet> = {}): DelegatedTokenSet {
  return {
    delegationId: "d1",
    accessToken: "access-0",
    accessTokenExpiresAt: new Date(NOW + HOUR).toISOString(),
    accessTokenDeadlineMs: NOW + HOUR,
    accessTokenLifetimeMs: HOUR,
    refreshToken: "refresh-0",
    ...over,
  };
}

/** a refresh route that mints access-1, access-2, ... */
function refreshRoute(options: { rotate?: boolean; delayMs?: number } = {}) {
  let n = 0;
  const answer = (sent: Sent) => {
    n++;
    return {
      status: 200,
      body: {
        status: "refreshed",
        accessToken: `access-${n}`,
        accessTokenExpiresAt: new Date(Date.now() + HOUR).toISOString(),
        expiresIn: 3600,
        ...(options.rotate
          ? { refreshToken: `${sent.body.refreshToken}+` }
          : {}),
      },
    };
  };
  return scriptedFetch(answer);
}

function holder(
  store: TokenStore,
  fetch: typeof globalThis.fetch,
  now: () => number = () => NOW,
  onTokenEvent?: (e: TokenEvent) => void,
) {
  return new DelegatedTokens({
    integration: new SwampIntegrationClient(SERVE, {
      credential: "swi1.app.x",
      fetch,
      ...FAST,
    }),
    store,
    delegationId: "d1",
    now,
    ...(onTokenEvent ? { onTokenEvent } : {}),
  });
}

Deno.test("DelegatedTokens.accessToken: uses the stored token until five minutes before it ends", async () => {
  const store = memoryTokenStore();
  await store.save("d1", tokenSet());
  const route = refreshRoute();
  assertEquals(await holder(store, route.fetch).accessToken(), "access-0");
  assertEquals(route.sent.length, 0);
  const late = holder(store, route.fetch, () => NOW + HOUR - 4 * 60_000);
  assertEquals(await late.accessToken(), "access-1");
  assertEquals((await store.load("d1"))?.accessToken, "access-1");
  assertEquals((await store.load("d1"))?.refreshToken, "refresh-0");
});

Deno.test("DelegatedTokens: racing calls in one process share one refresh", async () => {
  const store = memoryTokenStore();
  await store.save("d1", tokenSet({ accessTokenDeadlineMs: NOW }));
  const route = refreshRoute();
  const h = holder(store, route.fetch);
  const tokens = await Promise.all([
    h.accessToken(),
    h.accessToken(),
    h.accessToken(),
  ]);
  assertEquals(tokens, ["access-1", "access-1", "access-1"]);
  assertEquals(route.sent.length, 1);
});

Deno.test("DelegatedTokens: two copies of an app on one shared store both refresh, always with the stored refresh token", async () => {
  const backing = memoryTokenStore();
  await backing.save("d1", tokenSet({ accessTokenDeadlineMs: NOW }));
  // separate objects, as two processes would have
  const copyA: TokenStore = {
    load: (id) => backing.load(id),
    save: (id, t) => backing.save(id, t),
  };
  const copyB: TokenStore = {
    load: (id) => backing.load(id),
    save: (id, t) => backing.save(id, t),
  };
  const route = refreshRoute();
  const [a, b] = await Promise.all([
    holder(copyA, route.fetch).accessToken(),
    holder(copyB, route.fetch).accessToken(),
  ]);
  assert(a.startsWith("access-") && b.startsWith("access-"));
  assertEquals(route.sent.map((s) => s.body.refreshToken), [
    "refresh-0",
    "refresh-0",
  ]);
});

Deno.test("DelegatedTokens: against an older serve that rotates, the rotated refresh token is stored and the old one never sent again", async () => {
  const store = memoryTokenStore();
  await store.save("d1", tokenSet({ accessTokenDeadlineMs: NOW }));
  const route = refreshRoute({ rotate: true });
  let offset = 0;
  const h = holder(store, route.fetch, () => Date.now() + offset);
  await h.accessToken();
  offset = 2 * HOUR;
  await h.accessToken();
  assertEquals(route.sent.map((s) => s.body.refreshToken), [
    "refresh-0",
    "refresh-0+",
  ]);
});

Deno.test("DelegatedTokens.unauthorized: takes a token another call already refreshed, else refreshes", async () => {
  const store = memoryTokenStore();
  await store.save("d1", tokenSet({ accessToken: "access-new" }));
  const route = refreshRoute();
  const h = holder(store, route.fetch);
  assertEquals(await h.unauthorized("access-old"), "access-new");
  assertEquals(route.sent.length, 0);
  assertEquals(await h.unauthorized("access-new"), "access-1");
});

Deno.test("DelegatedTokens: a refused refresh throws link_ended or not_admitted", async () => {
  for (
    const [reason, code] of [["expired", "link_ended"], [
      "not_admitted",
      "not_admitted",
    ]]
  ) {
    const store = memoryTokenStore();
    await store.save("d1", tokenSet({ accessTokenDeadlineMs: NOW }));
    const { fetch } = scriptedFetch([
      { status: 401, body: { code: "invalid_grant", message: "m", reason } },
    ]);
    const error = await assertRejects(
      () => holder(store, fetch).accessToken(),
      SwampHttpError,
    );
    assertEquals(error.code, code);
    assertEquals(error.reason, reason);
  }
});

Deno.test("DelegatedTokens: a store that fails to save is reported, and the new token is still used", async () => {
  const backing = memoryTokenStore();
  await backing.save("d1", tokenSet({ accessTokenDeadlineMs: NOW }));
  const broken: TokenStore = {
    load: (id) => backing.load(id),
    save: () => Promise.reject(new Error("disk full")),
  };
  const events: TokenEvent[] = [];
  const route = refreshRoute();
  const h = holder(broken, route.fetch, () => NOW, (e) => events.push(e));
  assertEquals(await h.accessToken(), "access-1");
  assertEquals(events.map((e) => e.kind), ["save_failed"]);
  assertEquals(await h.accessToken(), "access-1");
  assertEquals(route.sent.length, 1);
});

Deno.test("DelegatedTokens: nothing stored throws not_linked; printed form holds no token", async () => {
  const h = holder(memoryTokenStore(), refreshRoute().fetch);
  const error = await assertRejects(() => h.accessToken(), SwampHttpError);
  assertEquals(error.code, "not_linked");
  assert(!Deno.inspect(h).includes("access-"));
  assert(!JSON.stringify(h).includes("access-"));
});
