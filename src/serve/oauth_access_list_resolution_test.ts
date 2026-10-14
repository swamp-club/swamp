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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { UserError } from "../domain/errors.ts";
import {
  UsernameLookupRefusedError,
  UsernameNotFoundError,
} from "./oauth_client.ts";
import {
  type AccessListResolution,
  assertAccessListsUsable,
  checkAccessLists,
  chooseResolutionMode,
  listUncachedNames,
  type ResolutionMode,
  resolveAccessLists,
  unresolvedCacheKey,
  type UsernameResolver,
} from "./oauth_access_list_resolution.ts";

const PROVIDER = "https://provider.test";
const NOW = "2026-09-23T12:00:00.000Z";
const EARLIER = "2026-09-01T00:00:00.000Z";

/**
 * Fake provider: known names resolve to `sub-<name>`, names in `failing`
 * throw a transient error, everything else is not found. Records calls.
 */
function fakeResolver(
  known: readonly string[],
  failing: readonly string[] = [],
): { resolve: UsernameResolver; calls: string[] } {
  const calls: string[] = [];
  const resolve: UsernameResolver = (username) => {
    calls.push(username);
    if (failing.includes(username)) {
      return Promise.reject(
        new Error(`Failed to resolve username '${username}': 503`),
      );
    }
    if (known.includes(username)) {
      return Promise.resolve(`sub-${username}`);
    }
    return Promise.reject(new UsernameNotFoundError(username, PROVIDER));
  };
  return { resolve, calls };
}

function run(
  opts: {
    admins?: string[];
    allowedUsers?: string[];
    cache?: Record<string, string>;
    mode: ResolutionMode;
    resolve?: UsernameResolver | null;
  },
): Promise<AccessListResolution> {
  return resolveAccessLists({
    admins: opts.admins ?? [],
    allowedUsers: opts.allowedUsers ?? [],
    cache: opts.cache ?? {},
    mode: opts.mode,
    resolve: opts.resolve ?? null,
    providerUrl: PROVIDER,
    now: () => NOW,
  });
}

// ── chooseResolutionMode ───────────────────────────────────────────────

Deno.test("chooseResolutionMode: full when a name is not cached at all", () => {
  assertEquals(
    chooseResolutionMode(["alice", "bob"], [], { alice: "sub-alice" }),
    "full",
  );
});

Deno.test("chooseResolutionMode: cached when every name is resolved in the cache", () => {
  assertEquals(
    chooseResolutionMode(
      ["user:alice"],
      ["bob"],
      { alice: "sub-alice", "allowed:bob": "sub-bob" },
    ),
    "cached",
  );
});

Deno.test("chooseResolutionMode: a not-found marker never triggers a lookup on its own", () => {
  const cache = {
    alice: "sub-alice",
    [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
  };
  assertEquals(
    chooseResolutionMode(["alice", "alic_e"], [], cache),
    "cached",
  );
});

Deno.test("chooseResolutionMode: admin and allowed-user markers are separate", () => {
  const cache = { [unresolvedCacheKey("admin", "bob")]: EARLIER };
  assertEquals(chooseResolutionMode([], ["bob"], cache), "full");
});

Deno.test("listUncachedNames: lists names with neither a sub nor a marker", () => {
  const cache = {
    alice: "sub-alice",
    [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
  };
  assertEquals(
    listUncachedNames(["alice", "alic_e", "carol"], ["dave"], cache),
    ["carol", "allowed:dave"],
  );
});

// ── resolveAccessLists: full mode ──────────────────────────────────────

Deno.test("resolveAccessLists: full mode rewrites admins and allowed-users", async () => {
  const { resolve } = fakeResolver(["alice", "bob"]);
  const result = await run({
    admins: ["user:alice"],
    allowedUsers: ["alice", "bob"],
    mode: "full",
    resolve,
  });
  assertEquals(result.admins, ["user:sub-alice"]);
  assertEquals(result.allowedUsers, ["sub-alice", "sub-bob"]);
  assertEquals(result.usernamesBySub, {
    "sub-alice": "alice",
    "sub-bob": "bob",
  });
  assertEquals(result.cache, {
    alice: "sub-alice",
    "allowed:alice": "sub-alice",
    "allowed:bob": "sub-bob",
  });
  assertEquals(result.unresolved, []);
  assert(result.cacheChanged);
});

Deno.test("resolveAccessLists: full mode skips an admin the provider does not know", async () => {
  const { resolve } = fakeResolver(["alice", "bob"]);
  const result = await run({
    admins: ["alice", "bob", "alic_e"],
    allowedUsers: ["alice"],
    mode: "full",
    resolve,
  });
  assertEquals(result.admins, ["user:sub-alice", "user:sub-bob"]);
  assertEquals(result.unresolved.length, 1);
  assertEquals(result.unresolved[0].kind, "admin");
  assertEquals(result.unresolved[0].entry, "alic_e");
  assertEquals(result.unresolved[0].notFoundSince, NOW);
  assertStringIncludes(result.unresolved[0].reason ?? "", "not found");
  assertEquals(result.cache[unresolvedCacheKey("admin", "alic_e")], NOW);
  assertEquals(result.usernamesBySub["alic_e"], undefined);
});

Deno.test("resolveAccessLists: full mode skips an allowed-user the provider does not know", async () => {
  const { resolve } = fakeResolver(["alice"]);
  const result = await run({
    admins: ["alice"],
    allowedUsers: ["alice", "ghost"],
    mode: "full",
    resolve,
  });
  assertEquals(result.allowedUsers, ["sub-alice"]);
  assertEquals(result.unresolved.map((u) => [u.kind, u.entry]), [
    ["allowed-user", "ghost"],
  ]);
  assertEquals(
    result.cache[unresolvedCacheKey("allowed-user", "ghost")],
    NOW,
  );
});

Deno.test("resolveAccessLists: full mode keeps the first not-found time", async () => {
  const { resolve } = fakeResolver(["alice"]);
  const result = await run({
    admins: ["alice", "alic_e"],
    cache: { [unresolvedCacheKey("admin", "alic_e")]: EARLIER },
    mode: "full",
    resolve,
  });
  assertEquals(result.unresolved[0].notFoundSince, EARLIER);
  assertEquals(result.cache[unresolvedCacheKey("admin", "alic_e")], EARLIER);
});

Deno.test("resolveAccessLists: full mode aborts on an admin lookup error other than not-found", async () => {
  const { resolve } = fakeResolver(["alice"], ["bob"]);
  const err = await assertRejects(
    () => run({ admins: ["alice", "bob"], mode: "full", resolve }),
    UserError,
  );
  assertEquals(
    err.message,
    `Failed to resolve admin 'bob': Failed to resolve username 'bob': 503. Check that ${PROVIDER} is reachable and that the credential can look up users, then retry.`,
  );
});

Deno.test("resolveAccessLists: full mode aborts on an allowed-user lookup error other than not-found", async () => {
  const { resolve } = fakeResolver(["alice"], ["bob"]);
  await assertRejects(
    () =>
      run({
        admins: ["alice"],
        allowedUsers: ["user:bob"],
        mode: "full",
        resolve,
      }),
    UserError,
    "Failed to resolve allowed-user 'user:bob'",
  );
});

Deno.test("resolveAccessLists: full mode looks up only names the cache does not have", async () => {
  const cache = { alice: "sub-alice", bob: "sub-bob" };
  const admins = ["alice", "bob", "carol"];
  const { resolve, calls } = fakeResolver(["alice", "bob", "carol"]);
  const result = await run({
    admins,
    cache,
    mode: chooseResolutionMode(admins, [], cache),
    resolve,
  });
  assertEquals(calls, ["carol"]);
  assertEquals(result.admins, [
    "user:sub-alice",
    "user:sub-bob",
    "user:sub-carol",
  ]);
  assertEquals(
    result.resolved.map((r) => [r.username, r.fromCache]),
    [["alice", true], ["bob", true], ["carol", false]],
  );
});

Deno.test("resolveAccessLists: a credential that cannot look users up fails on the added name", async () => {
  // swamp-club#3435: adding carol with a collective token that lacks
  // oauth:manage must not look the cached alice up and blame her.
  const cache = { alice: "sub-alice", bob: "sub-bob" };
  const admins = ["alice", "bob", "carol"];
  const calls: string[] = [];
  const err = await assertRejects(
    () =>
      run({
        admins,
        cache,
        mode: chooseResolutionMode(admins, [], cache),
        resolve: (username) => {
          calls.push(username);
          return Promise.reject(
            new UsernameLookupRefusedError(
              username,
              PROVIDER,
              403,
              "Forbidden",
            ),
          );
        },
      }),
    UserError,
    "Failed to resolve admin 'carol': Failed to resolve username 'carol': 403 Forbidden.",
  );
  assertEquals(calls, ["carol"]);
  assertStringIncludes(err.message, "oauth:manage");
  assert(!err.message.includes("is reachable"));
});

Deno.test("resolveAccessLists: a cached name is never looked up, so a 404 for it cannot drop it", async () => {
  // A resolved name is pinned: adding carol must not look alice up, so
  // neither a spurious 404 nor a re-registered name can change her grant.
  const cache = { alice: "sub-alice", "allowed:alice": "sub-alice" };
  const { resolve, calls } = fakeResolver(["carol"]);
  const result = await run({
    admins: ["alice", "carol"],
    allowedUsers: ["alice"],
    cache,
    mode: chooseResolutionMode(["alice", "carol"], ["alice"], cache),
    resolve,
  });
  assertEquals(calls, ["carol"]);
  assertEquals(result.admins, ["user:sub-alice", "user:sub-carol"]);
  assertEquals(result.allowedUsers, ["sub-alice"]);
  assertEquals(result.unresolved, []);
  assertEquals(result.cache["alice"], "sub-alice");
});

Deno.test("resolveAccessLists: a cached name is never looked up, so a transient error for it cannot abort", async () => {
  const cache = { alice: "sub-alice" };
  const { resolve, calls } = fakeResolver(["carol"], ["alice"]);
  const result = await run({
    admins: ["alice", "carol"],
    cache,
    mode: "full",
    resolve,
  });
  assertEquals(calls, ["carol"]);
  assertEquals(result.admins, ["user:sub-alice", "user:sub-carol"]);
});

Deno.test("resolveAccessLists: full mode keeps a previously missing name skipped", async () => {
  // Adding carol triggers full mode, but alic_e was recorded as not found:
  // an unrelated edit must not look it up, or a squatted typo would be
  // promoted.
  const { resolve, calls } = fakeResolver(["alice", "alic_e", "carol"]);
  const result = await run({
    admins: ["alice", "alic_e", "carol"],
    cache: {
      alice: "sub-alice",
      [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
    },
    mode: "full",
    resolve,
  });
  assertEquals(calls, ["carol"]);
  assertEquals(result.admins, ["user:sub-alice", "user:sub-carol"]);
  assertEquals(result.unresolved.map((u) => [u.entry, u.notFoundSince]), [
    ["alic_e", EARLIER],
  ]);
  assertEquals(result.cache[unresolvedCacheKey("admin", "alic_e")], EARLIER);
});

Deno.test("resolveAccessLists: removing a skipped name drops its record", async () => {
  const cache = {
    alice: "sub-alice",
    [unresolvedCacheKey("admin", "bob")]: EARLIER,
  };
  const result = await run({
    admins: ["alice"],
    cache,
    mode: chooseResolutionMode(["alice"], [], cache),
  });
  assert(result.cacheChanged);
  assertEquals({ ...result.cache }, { alice: "sub-alice" });
});

Deno.test("resolveAccessLists: a name added back after removal is looked up fresh", async () => {
  // The cache after removing bob no longer has his record, so adding him
  // back is a new name and triggers a lookup.
  const cache = { alice: "sub-alice" };
  const admins = ["alice", "bob"];
  const { resolve, calls } = fakeResolver(["alice", "bob"]);
  const result = await run({
    admins,
    cache,
    mode: chooseResolutionMode(admins, [], cache),
    resolve,
  });
  assertEquals(calls, ["bob"]);
  assertEquals(result.admins, ["user:sub-alice", "user:sub-bob"]);
});

Deno.test("resolveAccessLists: names that shadow Object.prototype are not treated as cached", async () => {
  const admins = ["constructor", "toString"];
  const cache = JSON.parse("{}") as Record<string, string>;
  assertEquals(chooseResolutionMode(admins, [], cache), "full");
  const { resolve, calls } = fakeResolver(["constructor"]);
  const result = await run({ admins, cache, mode: "full", resolve });
  assertEquals(calls, ["constructor", "toString"]);
  assertEquals(result.admins, ["user:sub-constructor"]);
  assertEquals(result.unresolved.map((u) => u.entry), ["toString"]);
});

// ── resolveAccessLists: entries that are not plain usernames ──────────

for (
  const [label, admins] of [
    ["cached mode", ["alice", "allowed:bob"]],
    ["full mode", ["alice", "allowed:bob", "carol"]],
    ["a user: prefix", ["alice", "user:allowed:bob"]],
  ] as const
) {
  Deno.test(`resolveAccessLists: an admin entry naming an allowed-user cache key is skipped (${label})`, async () => {
    // Admin alice is cached under "alice" and allowed-user bob under
    // "allowed:bob", so an admin entry "allowed:bob" would read bob's sub
    // and make him an admin without any lookup.
    const cache = { alice: "sub-alice", "allowed:bob": "sub-bob" };
    const { resolve, calls } = fakeResolver(["alice", "bob", "carol"]);
    const result = await run({
      admins: [...admins],
      allowedUsers: ["bob"],
      cache,
      mode: chooseResolutionMode(admins, ["bob"], cache),
      resolve,
    });
    assert(!result.admins.includes("user:sub-bob"));
    assert(!calls.some((c) => c.includes(":")));
    assertEquals(result.allowedUsers, ["sub-bob"]);
    assertEquals(result.cache["allowed:bob"], "sub-bob");
    const skipped = result.unresolved.find((u) => u.kind === "admin");
    assertEquals(skipped?.entry, admins[1]);
    assertEquals(skipped?.notFoundSince, undefined);
    assertStringIncludes(skipped?.reason ?? "", "not a plain username");
  });
}

Deno.test("resolveAccessLists: an entry naming a not-found marker is skipped and records nothing", async () => {
  const cache = {
    alice: "sub-alice",
    [unresolvedCacheKey("admin", "ghost")]: EARLIER,
    [unresolvedCacheKey("allowed-user", "ghost")]: EARLIER,
  };
  const admins = ["alice", "unresolved:ghost"];
  const allowedUsers = ["unresolved:allowed:ghost"];
  const { resolve, calls } = fakeResolver(["alice"]);
  const result = await run({
    admins,
    allowedUsers,
    cache,
    mode: chooseResolutionMode(admins, allowedUsers, cache),
    resolve,
  });
  assertEquals(calls, []);
  assertEquals(result.admins, ["user:sub-alice"]);
  assertEquals(result.allowedUsers, []);
  assertEquals(
    result.unresolved.map((u) => [u.kind, u.entry, u.notFoundSince]),
    [
      ["admin", "unresolved:ghost", undefined],
      ["allowed-user", "unresolved:allowed:ghost", undefined],
    ],
  );
  assertEquals({ ...result.cache }, { alice: "sub-alice" });
});

Deno.test("resolveAccessLists: an entry that is not a plain username never forces a lookup", () => {
  const cache = { alice: "sub-alice" };
  assertEquals(chooseResolutionMode(["alice", "a:b"], [], cache), "cached");
  assertEquals(listUncachedNames(["alice", "a:b"], ["c:d"], cache), []);
});

for (const entry of ["group:eng", "idp-group:eng", "user:group:eng"]) {
  Deno.test(`resolveAccessLists: ${entry} is skipped as a group`, async () => {
    const { resolve, calls } = fakeResolver(["alice"]);
    const result = await run({
      admins: ["alice", entry],
      allowedUsers: [entry],
      mode: "full",
      resolve,
    });
    assertEquals(calls, ["alice"]);
    assertEquals(result.admins, ["user:sub-alice"]);
    assertEquals(result.unresolved.length, 2);
    for (const u of result.unresolved) {
      assertStringIncludes(u.reason ?? "", "groups are not supported");
      assert(!(u.reason ?? "").includes("not a plain username"));
    }
  });
}

// ── resolveAccessLists: cached mode ────────────────────────────────────

Deno.test("resolveAccessLists: a restart never promotes a skipped name", async () => {
  // Even if the account now exists, an unchanged config must not turn a
  // skipped name into a grant: anyone who registered a typo'd admin name
  // would become an admin.
  const cache = {
    alice: "sub-alice",
    [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
  };
  const { resolve, calls } = fakeResolver(["alice", "alic_e"]);
  const result = await run({
    admins: ["alice", "alic_e"],
    cache,
    mode: chooseResolutionMode(["alice", "alic_e"], [], cache),
    resolve,
  });
  assertEquals(calls, []);
  assertEquals(result.admins, ["user:sub-alice"]);
  assertEquals(result.unresolved.map((u) => u.entry), ["alic_e"]);
});

Deno.test("resolveAccessLists: cached mode uses the cache and skips markers", async () => {
  const result = await run({
    admins: ["user:alice", "alic_e"],
    allowedUsers: ["alice"],
    cache: {
      alice: "sub-alice",
      "allowed:alice": "sub-alice",
      [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
    },
    mode: "cached",
  });
  assertEquals(result.admins, ["user:sub-alice"]);
  assertEquals(result.allowedUsers, ["sub-alice"]);
  assertEquals(result.usernamesBySub, { "sub-alice": "alice" });
  assertEquals(result.unresolved, [{
    kind: "admin",
    entry: "alic_e",
    username: "alic_e",
    notFoundSince: EARLIER,
  }]);
  assertEquals(result.cacheChanged, false);
});

Deno.test("resolveAccessLists: a resolver is required outside cached mode", async () => {
  await assertRejects(
    () => run({ admins: ["alice"], mode: "full" }),
    Error,
    "A resolver is required in full mode",
  );
});

// ── assertAccessListsUsable ────────────────────────────────────────────

Deno.test("assertAccessListsUsable: refuses when no admin resolved", async () => {
  const result = await run({
    admins: ["ghost", "user:phantom"],
    allowedUsers: [],
    mode: "full",
    resolve: fakeResolver([]).resolve,
  });
  const err = assertThrows(
    () =>
      assertAccessListsUsable(
        {
          admins: ["ghost", "user:phantom"],
          allowedUsers: [],
          allowedCollectives: ["eng"],
        },
        result,
        PROVIDER,
      ),
    UserError,
  );
  assertStringIncludes(
    err.message,
    "Failed to resolve admin 'ghost', 'user:phantom'",
  );
});

Deno.test("assertAccessListsUsable: refuses on a cached result with no admin", async () => {
  const result = await run({
    admins: ["ghost"],
    cache: { [unresolvedCacheKey("admin", "ghost")]: EARLIER },
    mode: "cached",
  });
  assertThrows(
    () =>
      assertAccessListsUsable(
        { admins: ["ghost"], allowedUsers: [], allowedCollectives: ["eng"] },
        result,
        PROVIDER,
      ),
    UserError,
    "Failed to resolve admin 'ghost'",
  );
});

Deno.test("assertAccessListsUsable: refuses when admission would become unrestricted", async () => {
  const configured = {
    admins: ["alice"],
    allowedUsers: ["ghost"],
    allowedCollectives: [],
  };
  const result = await run({
    ...configured,
    mode: "full",
    resolve: fakeResolver(["alice"]).resolve,
  });
  assertThrows(
    () => assertAccessListsUsable(configured, result, PROVIDER),
    UserError,
    "admission would be open to every user",
  );
});

Deno.test("assertAccessListsUsable: allows losing every allowed-user when collectives restrict admission", async () => {
  const configured = {
    admins: ["alice"],
    allowedUsers: ["ghost"],
    allowedCollectives: ["eng"],
  };
  const result = await run({
    ...configured,
    mode: "full",
    resolve: fakeResolver(["alice"]).resolve,
  });
  assertAccessListsUsable(configured, result, PROVIDER);
  assertEquals(result.allowedUsers, []);
});

Deno.test("assertAccessListsUsable: allows a partial skip", async () => {
  const configured = {
    admins: ["alice", "alic_e"],
    allowedUsers: ["alice", "ghost"],
    allowedCollectives: [],
  };
  const result = await run({
    ...configured,
    mode: "full",
    resolve: fakeResolver(["alice"]).resolve,
  });
  assertAccessListsUsable(configured, result, PROVIDER);
  assertEquals(result.unresolved.length, 2);
});

// ── checkAccessLists ───────────────────────────────────────────────────

Deno.test("checkAccessLists: reports each entry and that serve would start", async () => {
  const check = await checkAccessLists(
    {
      admins: ["alice", "alic_e"],
      allowedUsers: ["alice"],
      allowedCollectives: [],
    },
    fakeResolver(["alice"]).resolve,
    PROVIDER,
  );
  assertEquals(check.wouldStart, true);
  assertEquals(check.refusal, undefined);
  assertEquals(
    check.entries.map((e) => [e.kind, e.entry, e.status, e.sub]),
    [
      ["admin", "alice", "resolved", "sub-alice"],
      ["admin", "alic_e", "not-found", undefined],
      ["allowed-user", "alice", "resolved", "sub-alice"],
    ],
  );
});

Deno.test("checkAccessLists: reports why serve would refuse to start", async () => {
  const check = await checkAccessLists(
    { admins: ["ghost"], allowedUsers: [], allowedCollectives: ["eng"] },
    fakeResolver([]).resolve,
    PROVIDER,
  );
  assertEquals(check.wouldStart, false);
  assertStringIncludes(check.refusal ?? "", "Failed to resolve admin 'ghost'");
});

Deno.test("checkAccessLists: reports an entry that is not a plain username as not found", async () => {
  const { resolve, calls } = fakeResolver(["bob"]);
  const check = await checkAccessLists(
    {
      admins: ["allowed:bob"],
      allowedUsers: ["bob"],
      allowedCollectives: [],
    },
    resolve,
    PROVIDER,
  );
  assertEquals(calls, ["bob"]);
  assertEquals(
    check.entries.map((e) => [e.kind, e.entry, e.status, e.sub]),
    [
      ["admin", "allowed:bob", "not-found", undefined],
      ["allowed-user", "bob", "resolved", "sub-bob"],
    ],
  );
  assertEquals(check.wouldStart, false);
  assertStringIncludes(
    check.refusal ?? "",
    "Failed to resolve admin 'allowed:bob'",
  );
});

Deno.test("checkAccessLists: a lookup error other than not-found throws", async () => {
  await assertRejects(
    () =>
      checkAccessLists(
        { admins: ["alice"], allowedUsers: [], allowedCollectives: ["eng"] },
        fakeResolver([], ["alice"]).resolve,
        PROVIDER,
      ),
    UserError,
    "Failed to resolve admin 'alice'",
  );
});
