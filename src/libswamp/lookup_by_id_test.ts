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

import { assertEquals, assertThrows } from "@std/assert";
import { selectLookup } from "./lookup_by_id.ts";

const byIdOrName = (s: string) => Promise.resolve(`name-first:${s}`);
const byIdOnly = (s: string) => Promise.resolve(`id-only:${s}`);

Deno.test("selectLookup: uses the id-or-name lookup without byId", async () => {
  const lookup = selectLookup("op", undefined, byIdOrName, byIdOnly);
  assertEquals(await lookup("x"), "name-first:x");
});

Deno.test("selectLookup: uses the id-only lookup with byId", async () => {
  const lookup = selectLookup("op", true, byIdOrName, byIdOnly);
  assertEquals(await lookup("x"), "id-only:x");
});

Deno.test("selectLookup: byId without an id-only lookup throws instead of falling back", () => {
  assertThrows(
    () => selectLookup("model get", true, byIdOrName, undefined),
    Error,
    "model get: a by-id lookup was requested but none is wired",
  );
});

Deno.test("selectLookup: passes the expected name to the id-only lookup", async () => {
  const lookup = selectLookup(
    "op",
    true,
    byIdOrName,
    (id: string, name?: string) => Promise.resolve(`id-only:${id}:${name}`),
    "authorized-name",
  );
  assertEquals(await lookup("x"), "id-only:x:authorized-name");
});
