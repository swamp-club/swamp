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

import { assert, assertEquals } from "@std/assert";
import { createLibSwampContext } from "../context.ts";
import { creekTypeSearch } from "./type_search.ts";

const items = [
  {
    type: "@me/jira",
    version: "2026.06.01.1",
    description: "Jira API",
    methodCount: 3,
  },
  {
    type: "@me/billing",
    version: "2026.06.01.1",
    description: "Billing DB",
    methodCount: 1,
  },
  {
    type: "@swamp/echo-creek",
    version: "2026.06.01.1",
    description: "Echo",
    methodCount: 3,
  },
];

Deno.test("creekTypeSearch: empty query returns all", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekTypeSearch(
      ctx,
      { getCreekTypes: () => items },
      {},
    )
  ) {
    events.push(event);
  }

  const last = events.at(-1);
  assert(last?.kind === "completed");
  assertEquals(last.data.results.length, 3);
});

Deno.test("creekTypeSearch: filters by query against type and description", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekTypeSearch(
      ctx,
      { getCreekTypes: () => items },
      { query: "jira" },
    )
  ) {
    events.push(event);
  }

  const last = events.at(-1);
  assert(last?.kind === "completed");
  assertEquals(last.data.results.length, 1);
  assertEquals(last.data.results[0].type, "@me/jira");
});

Deno.test("creekTypeSearch: case-insensitive description match", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekTypeSearch(
      ctx,
      { getCreekTypes: () => items },
      { query: "BILLING" },
    )
  ) {
    events.push(event);
  }

  const last = events.at(-1);
  assert(last?.kind === "completed");
  assertEquals(last.data.results.length, 1);
  assertEquals(last.data.results[0].type, "@me/billing");
});
