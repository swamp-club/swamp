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
import { UsernameNotFoundError } from "./oauth_client.ts";
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
    chooseResolutionMode(["alice", "bob"], [], { alice: "sub-alice" }, false),
    "full",
  );
});

Deno.test("chooseResolutionMode: cached when every name is resolved in the cache", () => {
  assertEquals(
    chooseResolutionMode(
      ["user:alice"],
      ["bob"],
      { alice: "sub-alice", "allowed:bob": "sub-bob" },
      true,
    ),
    "cached",
  );
});

Deno.test("chooseResolutionMode: a not-found marker counts as cached without retry", () => {
  const cache = {
    alice: "sub-alice",
    [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
  };
  assertEquals(
    chooseResolutionMode(["alice", "alic_e"], [], cache, false),
    "cached",
  );
  assertEquals(
    chooseResolutionMode(["alice", "alic_e"], [], cache, true),
    "retry",
  );
});

Deno.test("chooseResolutionMode: admin and allowed-user markers are separate", () => {
  const cache = { [unresolvedCacheKey("admin", "bob")]: EARLIER };
  assertEquals(chooseResolutionMode([], ["bob"], cache, false), "full");
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
    `Failed to resolve admin 'bob': Failed to resolve username 'bob': 503. Ensure the username exists on ${PROVIDER}.`,
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

Deno.test("resolveAccessLists: full mode re-resolves names that are already cached", async () => {
  const { resolve, calls } = fakeResolver(["alice", "bob"]);
  await run({
    admins: ["alice", "bob"],
    cache: { alice: "sub-alice" },
    mode: "full",
    resolve,
  });
  assertEquals(calls, ["alice", "bob"]);
});

// ── resolveAccessLists: retry mode ─────────────────────────────────────

Deno.test("resolveAccessLists: retry mode looks up only not-found names", async () => {
  const { resolve, calls } = fakeResolver(["alice", "bob"]);
  const result = await run({
    admins: ["alice", "bob", "alic_e"],
    cache: {
      alice: "sub-alice",
      bob: "sub-bob",
      [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
    },
    mode: "retry",
    resolve,
  });
  assertEquals(calls, ["alic_e"]);
  assertEquals(result.admins, ["user:sub-alice", "user:sub-bob"]);
  assertEquals(result.unresolved[0].notFoundSince, EARLIER);
  assertEquals(result.cacheChanged, false);
});

Deno.test("resolveAccessLists: retry mode keeps a name skipped on a transient error", async () => {
  const { resolve } = fakeResolver(["alice"], ["alic_e"]);
  const cache = {
    alice: "sub-alice",
    [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
  };
  const result = await run({
    admins: ["alice", "alic_e"],
    cache,
    mode: "retry",
    resolve,
  });
  assertEquals(result.admins, ["user:sub-alice"]);
  assertEquals(result.unresolved.length, 1);
  assertStringIncludes(result.unresolved[0].reason ?? "", "503");
  assertEquals(result.cache, cache);
});

Deno.test("resolveAccessLists: retry mode promotes a name that now exists", async () => {
  const { resolve } = fakeResolver(["alice", "alic_e"]);
  const result = await run({
    admins: ["alice", "alic_e"],
    cache: {
      alice: "sub-alice",
      [unresolvedCacheKey("admin", "alic_e")]: EARLIER,
    },
    mode: "retry",
    resolve,
  });
  assertEquals(result.admins, ["user:sub-alice", "user:sub-alic_e"]);
  assertEquals(result.unresolved, []);
  assertEquals(result.cache, { alice: "sub-alice", alic_e: "sub-alic_e" });
  assert(result.cacheChanged);
});

// ── resolveAccessLists: cached mode ────────────────────────────────────

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
