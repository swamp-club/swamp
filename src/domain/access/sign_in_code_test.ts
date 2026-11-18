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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { RESERVED_TOKEN_NAMES } from "./delegated_token.ts";
import {
  SIGN_IN_CODE_PREFIX,
  SIGN_IN_CODE_TTL_MS,
  SignInCodeStore,
  type SignInGrant,
} from "./sign_in_code.ts";

const T0 = Date.parse("2026-11-18T12:00:00.000Z");

function grant(overrides: Partial<SignInGrant> = {}): SignInGrant {
  return {
    principal: "user:sub-alice",
    username: "alice",
    email: "alice@example.com",
    collectives: ["acme"],
    groups: [],
    expiresAt: new Date(T0 + 86_400_000).toISOString(),
    ...overrides,
  };
}

function clock(
  start = T0,
): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => at += ms };
}

async function issued(
  store: SignInCodeStore,
  workspace: string,
  g = grant(),
): Promise<string> {
  const result = await store.issue(workspace, g);
  assert(result.ok, "issue refused");
  return result.code;
}

Deno.test("SignInCodeStore.issue: a code carries its prefix, a random part and the TTL as its expiry", async () => {
  const time = clock();
  const store = new SignInCodeStore({ now: time.now });
  const result = await store.issue("edge-dns", grant());
  assert(result.ok);
  assert(result.code.startsWith(`${SIGN_IN_CODE_PREFIX}.`));
  assert(/^[0-9a-f]{64}$/.test(result.code.split(".")[1]));
  assertEquals(
    result.expiresAt,
    new Date(T0 + SIGN_IN_CODE_TTL_MS).toISOString(),
  );
  const other = await store.issue("edge-dns", grant());
  assert(other.ok);
  assertNotEquals(other.code, result.code);
});

Deno.test("SignInCodeStore: the code's prefix is a reserved token name", () => {
  assert(RESERVED_TOKEN_NAMES.includes(SIGN_IN_CODE_PREFIX));
});

Deno.test("SignInCodeStore.redeem: answers the grant once, for the workspace it names", async () => {
  const store = new SignInCodeStore({ now: clock().now });
  const code = await issued(store, "edge-dns");
  assertEquals(await store.redeem(code, "edge-dns"), grant());
  assertEquals(await store.redeem(code, "edge-dns"), null);
});

Deno.test("SignInCodeStore.redeem: a code taken to another workspace is refused and spent", async () => {
  const store = new SignInCodeStore({ now: clock().now });
  const code = await issued(store, "edge-dns");
  assertEquals(await store.redeem(code, "billing"), null);
  assertEquals(await store.redeem(code, "edge-dns"), null);
});

Deno.test("SignInCodeStore.redeem: refuses a code at its expiry and after", async () => {
  const time = clock();
  const store = new SignInCodeStore({ now: time.now });
  const early = await issued(store, "edge-dns");
  const late = await issued(store, "edge-dns");
  time.advance(SIGN_IN_CODE_TTL_MS - 1);
  assertEquals(await store.redeem(early, "edge-dns"), grant());
  time.advance(1);
  assertEquals(await store.redeem(late, "edge-dns"), null);
});

Deno.test("SignInCodeStore.redeem: refuses a code whose root token has expired", async () => {
  const time = clock();
  const store = new SignInCodeStore({ now: time.now });
  const code = await issued(
    store,
    "edge-dns",
    grant({ expiresAt: new Date(T0 + 1_000).toISOString() }),
  );
  time.advance(1_000);
  assertEquals(await store.redeem(code, "edge-dns"), null);
});

Deno.test("SignInCodeStore.redeem: an unknown code is refused", async () => {
  const store = new SignInCodeStore({ now: clock().now });
  await issued(store, "edge-dns");
  assertEquals(
    await store.redeem(`${SIGN_IN_CODE_PREFIX}.${"0".repeat(64)}`, "edge-dns"),
    null,
  );
});

Deno.test("SignInCodeStore: an unredeemed code is swept once it expires", async () => {
  const time = clock();
  const store = new SignInCodeStore({ now: time.now });
  await issued(store, "edge-dns");
  await issued(store, "billing");
  assertEquals(store.size, 2);
  time.advance(SIGN_IN_CODE_TTL_MS);
  await store.redeem("anything", "edge-dns");
  assertEquals(store.size, 0);
});

Deno.test("SignInCodeStore.issue: refuses past the per-principal cap, and not another principal", async () => {
  const time = clock();
  const store = new SignInCodeStore({ now: time.now, maxPerPrincipal: 2 });
  await issued(store, "edge-dns");
  await issued(store, "edge-dns");
  assertEquals(await store.issue("edge-dns", grant()), {
    ok: false,
    reason: "principal_limit",
  });
  assert(
    (await store.issue("edge-dns", grant({ principal: "user:sub-bob" }))).ok,
  );
  time.advance(SIGN_IN_CODE_TTL_MS);
  assert(
    (await store.issue("edge-dns", grant())).ok,
    "expired codes free the cap",
  );
});

Deno.test("SignInCodeStore.issue: refuses once the store is full", async () => {
  const store = new SignInCodeStore({ now: clock().now, maxCodes: 1 });
  await issued(store, "edge-dns");
  assertEquals(
    await store.issue("edge-dns", grant({ principal: "user:sub-bob" })),
    { ok: false, reason: "store_full" },
  );
});

Deno.test("SignInCodeStore.issue: a caller changing its grant afterwards changes nothing stored", async () => {
  const store = new SignInCodeStore({ now: clock().now });
  const collectives = ["acme"];
  const code = await issued(store, "edge-dns", grant({ collectives }));
  collectives.push("intruders");
  assertEquals((await store.redeem(code, "edge-dns"))?.collectives, ["acme"]);
});

Deno.test("SignInCodeStore.redeem: of two concurrent redeems, exactly one gets the grant", async () => {
  const store = new SignInCodeStore({ now: clock().now });
  const code = await issued(store, "edge-dns");
  const results = await Promise.all([
    store.redeem(code, "edge-dns"),
    store.redeem(code, "edge-dns"),
  ]);
  assertEquals(results.filter((r) => r !== null).length, 1);
});
