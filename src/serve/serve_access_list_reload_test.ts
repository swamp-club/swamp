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
import { UsernameNotFoundError } from "./oauth_client.ts";
import {
  allowedUsersPartialReason,
  CLOSED_ALLOWED_USERS_ENTRY,
  planAllowedUsersReload,
  readStoredNameMap,
} from "./serve_access_list_reload.ts";
import { checkAdmission } from "../domain/access/admission.ts";

const NOW = "2026-11-10T00:00:00.000Z";

type PlanInput = Parameters<typeof planAllowedUsersReload>[0];

function planFor(
  input: Omit<PlanInput, "stored" | "previouslyConfigured"> & {
    stored?: PlanInput["stored"];
    previouslyConfigured?: PlanInput["previouslyConfigured"];
  },
) {
  return planAllowedUsersReload({
    stored: {},
    previouslyConfigured: [],
    ...input,
  });
}
const PROVIDER = "https://club.example";

function lookup(subs: Record<string, string>, failing: string[] = []) {
  const asked: string[] = [];
  return {
    asked,
    resolve: (name: string, _signal: AbortSignal) => {
      asked.push(name);
      if (failing.includes(name)) {
        return Promise.reject(new Error("connection reset"));
      }
      if (!Object.hasOwn(subs, name)) {
        return Promise.reject(new UsernameNotFoundError(name, PROVIDER));
      }
      return Promise.resolve(subs[name]);
    },
  };
}

Deno.test("planAllowedUsersReload: a removed name leaves the list and the name map; admin records stay", async () => {
  const plan = await planFor({
    configured: ["alice"],
    previouslyConfigured: ["alice", "bob"],
    allowedCollectives: [],
    cache: { "allowed:alice": "sub-a", "allowed:bob": "sub-b", root: "sub-r" },
    resolve: null,
    now: () => NOW,
  });
  assertEquals(plan.allowedUsers, ["sub-a"]);
  assertEquals(plan.namesInForce, ["alice"]);
  assertEquals(plan.cache, { "allowed:alice": "sub-a", root: "sub-r" });
  assertEquals(plan.cacheChanged, true);
  assertEquals(allowedUsersPartialReason(plan), undefined);
});

Deno.test("planAllowedUsersReload: without a club API key a new name waits, unmarked, while the removal applies", async () => {
  const plan = await planFor({
    configured: ["carol"],
    previouslyConfigured: ["alice"],
    allowedCollectives: [],
    cache: { "allowed:alice": "sub-a" },
    resolve: null,
    now: () => NOW,
  });
  // [alice] to [carol] with carol unresolvable: nobody is admitted
  assertEquals(plan.allowedUsers, [CLOSED_ALLOWED_USERS_ENTRY]);
  assertEquals(plan.closed, true);
  assertEquals(plan.deferred.map((d) => d.name), ["carol"]);
  assertEquals(plan.cache, {});
  assertEquals(
    checkAdmission("sub-a", [], [], plan.allowedUsers).admitted,
    false,
  );
});

Deno.test("planAllowedUsersReload: a lookup error defers only that name and writes no marker", async () => {
  const { resolve } = lookup({ dave: "sub-d" }, ["erin"]);
  const plan = await planFor({
    configured: ["dave", "erin"],
    allowedCollectives: [],
    cache: {},
    resolve,
    now: () => NOW,
  });
  assertEquals(plan.allowedUsers, ["sub-d"]);
  assertEquals(plan.deferred.map((d) => d.name), ["erin"]);
  assertEquals(plan.cache, { "allowed:dave": "sub-d" });
});

Deno.test("planAllowedUsersReload: a deferred name resolves on a later reload", async () => {
  const first = await planFor({
    configured: ["erin"],
    allowedCollectives: ["acme"],
    cache: {},
    resolve: null,
    now: () => NOW,
  });
  assertEquals(first.allowedUsers, []);
  assertEquals(first.closed, false);
  const { resolve } = lookup({ erin: "sub-e" });
  const second = await planFor({
    configured: ["erin"],
    allowedCollectives: ["acme"],
    cache: first.cache,
    resolve,
    now: () => NOW,
  });
  assertEquals(second.allowedUsers, ["sub-e"]);
  assertEquals(second.deferred, []);
});

Deno.test("planAllowedUsersReload: a name the provider lacks is marked and stays skipped, never looked up again", async () => {
  const first = lookup({});
  const plan = await planFor({
    configured: ["typo"],
    allowedCollectives: ["acme"],
    cache: {},
    resolve: first.resolve,
    now: () => NOW,
  });
  assertEquals(plan.cache, { "unresolved:allowed:typo": NOW });
  assertEquals(plan.skipped.map((s) => s.name), ["typo"]);
  const again = lookup({ typo: "sub-claimed" });
  const next = await planFor({
    configured: ["typo"],
    allowedCollectives: ["acme"],
    cache: plan.cache,
    resolve: again.resolve,
    now: () => NOW,
  });
  assertEquals(again.asked, []);
  assertEquals(next.allowedUsers, []);
});

Deno.test("planAllowedUsersReload: a resolved name is pinned and never looked up again", async () => {
  const { asked, resolve } = lookup({ alice: "sub-other" });
  const plan = await planFor({
    configured: ["alice"],
    allowedCollectives: [],
    stored: { "allowed:alice": "sub-a" },
    cache: { "allowed:alice": "sub-a" },
    resolve,
    now: () => NOW,
  });
  assertEquals(asked, []);
  assertEquals(plan.allowedUsers, ["sub-a"]);
  assertEquals(plan.cacheChanged, false);
});

Deno.test("planAllowedUsersReload: a name that is not a plain username is skipped with the reason", async () => {
  const plan = await planFor({
    configured: ["group:ops"],
    allowedCollectives: ["acme"],
    cache: {},
    resolve: lookup({}).resolve,
    now: () => NOW,
  });
  assertEquals(plan.allowedUsers, []);
  assertEquals(plan.skipped[0].name, "group:ops");
});

Deno.test("CLOSED_ALLOWED_USERS_ENTRY: admits no one, so an emptied list never opens admission", () => {
  assertEquals(
    checkAdmission("anyone", [], [], [CLOSED_ALLOWED_USERS_ENTRY]).admitted,
    false,
  );
  assertEquals(checkAdmission("anyone", [], [], []).admitted, true);
});

Deno.test("planAllowedUsersReload: a peer's records survive, and only names this reload removed lose theirs", async () => {
  const result = await planFor({
    configured: ["alice"],
    previouslyConfigured: ["alice", "bob"],
    allowedCollectives: [],
    // a peer marked typo missing and pinned dave after this instance started
    stored: {
      "allowed:alice": "sub-a",
      "allowed:bob": "sub-b",
      "unresolved:allowed:typo": NOW,
      "allowed:dave": "sub-d",
    },
    cache: { "allowed:alice": "sub-a", "allowed:bob": "sub-b" },
    resolve: null,
    now: () => NOW,
  });
  assertEquals(result.cache, {
    "allowed:alice": "sub-a",
    "unresolved:allowed:typo": NOW,
    "allowed:dave": "sub-d",
  });
});

Deno.test("planAllowedUsersReload: a waiting name a peer has since pinned resolves without a lookup", async () => {
  const result = await planFor({
    configured: ["dave"],
    allowedCollectives: [],
    stored: { "allowed:dave": "sub-d" },
    cache: {},
    resolve: null,
    now: () => NOW,
  });
  assertEquals(result.allowedUsers, ["sub-d"]);
  assertEquals(result.deferred, []);
});

Deno.test("planAllowedUsersReload: lookups run a few at a time under one deadline, and too many new names wait", async () => {
  let inFlight = 0;
  let most = 0;
  const resolve = async (name: string) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await Promise.resolve();
    inFlight--;
    return `sub-${name}`;
  };
  const many = Array.from({ length: 10 }, (_, i) => `user${i}`);
  const bounded = await planFor({
    configured: many,
    allowedCollectives: [],
    cache: {},
    resolve,
    now: () => NOW,
    limits: { concurrency: 3, deadlineMs: 60_000, maxNewNames: 10 },
  });
  assertEquals(bounded.allowedUsers.length, 10);
  assertEquals(most <= 3, true);

  const tooMany = await planFor({
    configured: many,
    allowedCollectives: ["acme"],
    cache: {},
    resolve,
    now: () => NOW,
    limits: { concurrency: 3, deadlineMs: 60_000, maxNewNames: 5 },
  });
  assertEquals(tooMany.allowedUsers, []);
  assertEquals(tooMany.deferred.length, 10);
});

Deno.test("readStoredNameMap: reads through list and get, which every vault provider has", async () => {
  const vault = (
    keys: string[],
    value: string | Error,
    listFails = false,
  ) => ({
    list: () =>
      listFails
        ? Promise.reject(new Error("vault down"))
        : Promise.resolve(keys),
    get: () =>
      value instanceof Error ? Promise.reject(value) : Promise.resolve(value),
  });
  const KEY = "oauth-resolved-admins";
  assertEquals(
    await readStoredNameMap(vault([KEY], '{"allowed:bob":"sub-b"}'), KEY),
    { "allowed:bob": "sub-b" },
  );
  // no key listed: nothing stored yet
  assertEquals(await readStoredNameMap(vault([], "unused"), KEY), {});
  // anything else is unreadable, never empty
  assertEquals(await readStoredNameMap(vault([], "", true), KEY), undefined);
  assertEquals(
    await readStoredNameMap(vault([KEY], new Error("get failed")), KEY),
    undefined,
  );
  assertEquals(await readStoredNameMap(vault([KEY], "[1,2]"), KEY), undefined);
  assertEquals(await readStoredNameMap(vault([KEY], "null"), KEY), undefined);
});
