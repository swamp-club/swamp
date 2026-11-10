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
} from "./serve_access_list_reload.ts";
import { checkAdmission } from "../domain/access/admission.ts";

const NOW = "2026-11-10T00:00:00.000Z";
const PROVIDER = "https://club.example";

function lookup(subs: Record<string, string>, failing: string[] = []) {
  const asked: string[] = [];
  return {
    asked,
    resolve: (name: string) => {
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
  const plan = await planAllowedUsersReload({
    configured: ["alice"],
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
  const plan = await planAllowedUsersReload({
    configured: ["carol"],
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
  const plan = await planAllowedUsersReload({
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
  const first = await planAllowedUsersReload({
    configured: ["erin"],
    allowedCollectives: ["acme"],
    cache: {},
    resolve: null,
    now: () => NOW,
  });
  assertEquals(first.allowedUsers, []);
  assertEquals(first.closed, false);
  const { resolve } = lookup({ erin: "sub-e" });
  const second = await planAllowedUsersReload({
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
  const plan = await planAllowedUsersReload({
    configured: ["typo"],
    allowedCollectives: ["acme"],
    cache: {},
    resolve: first.resolve,
    now: () => NOW,
  });
  assertEquals(plan.cache, { "unresolved:allowed:typo": NOW });
  assertEquals(plan.skipped.map((s) => s.name), ["typo"]);
  const again = lookup({ typo: "sub-claimed" });
  const next = await planAllowedUsersReload({
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
  const plan = await planAllowedUsersReload({
    configured: ["alice"],
    allowedCollectives: [],
    cache: { "allowed:alice": "sub-a" },
    resolve,
    now: () => NOW,
  });
  assertEquals(asked, []);
  assertEquals(plan.allowedUsers, ["sub-a"]);
  assertEquals(plan.cacheChanged, false);
});

Deno.test("planAllowedUsersReload: a name that is not a plain username is skipped with the reason", async () => {
  const plan = await planAllowedUsersReload({
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
