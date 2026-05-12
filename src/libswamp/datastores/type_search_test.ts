// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  datastoreTypeSearch,
  type DatastoreTypeSearchDeps,
  type DatastoreTypeSearchEvent,
} from "./type_search.ts";

function makeDeps(
  overrides: Partial<DatastoreTypeSearchDeps> = {},
): DatastoreTypeSearchDeps {
  return {
    getDatastoreTypes: () => [
      {
        type: "filesystem",
        name: "Filesystem",
        description: "Store data on the local filesystem",
      },
      {
        type: "s3",
        name: "S3",
        description: "Store data in Amazon S3",
      },
    ],
    ...overrides,
  };
}

Deno.test("datastoreTypeSearch: returns all datastore types with no query", async () => {
  const deps = makeDeps();
  const events = await collect<DatastoreTypeSearchEvent>(
    datastoreTypeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    DatastoreTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].type, "filesystem");
  assertEquals(completed.data.results[0].name, "Filesystem");
});

Deno.test("datastoreTypeSearch: passes query through in data", async () => {
  const deps = makeDeps();
  const events = await collect<DatastoreTypeSearchEvent>(
    datastoreTypeSearch(createLibSwampContext(), deps, { query: "s3" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    DatastoreTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "s3");
  assertEquals(completed.data.results.length, 2);
});

Deno.test("datastoreTypeSearch: returns empty results when no datastore types", async () => {
  const deps = makeDeps({
    getDatastoreTypes: () => [],
  });
  const events = await collect<DatastoreTypeSearchEvent>(
    datastoreTypeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    DatastoreTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});
