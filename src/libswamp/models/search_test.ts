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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  modelSearch,
  type ModelSearchDeps,
  type ModelSearchEvent,
} from "./search.ts";

const DEFAULT_RESULTS = [
  {
    definition: { id: "def-1", name: "my-ec2" },
    type: { normalized: "aws/ec2-instance" },
  },
  {
    definition: { id: "def-2", name: "my-bucket" },
    type: { normalized: "aws/s3-bucket" },
  },
];

const RESULTS_WITH_INTERNAL = [
  ...DEFAULT_RESULTS,
  {
    definition: { id: "def-3", name: "server-token-1" },
    type: { normalized: "swamp/server-token" },
  },
  {
    definition: { id: "def-4", name: "grant-1" },
    type: { normalized: "swamp/grant" },
  },
];

const INTERNAL_TYPES = new Set(["swamp/server-token", "swamp/grant"]);

function makeDeps(
  overrides: Partial<ModelSearchDeps> = {},
): ModelSearchDeps {
  return {
    findAllGlobal: () => Promise.resolve(DEFAULT_RESULTS),
    ...overrides,
  };
}

Deno.test("modelSearch: returns all models with no query", async () => {
  const deps = makeDeps();
  const events = await collect<ModelSearchEvent>(
    modelSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ModelSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].id, "def-1");
  assertEquals(completed.data.results[0].name, "my-ec2");
  assertEquals(completed.data.results[0].type, "aws/ec2-instance");
});

Deno.test("modelSearch: passes query through in data", async () => {
  const deps = makeDeps();
  const events = await collect<ModelSearchEvent>(
    modelSearch(createLibSwampContext(), deps, { query: "ec2" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    ModelSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "ec2");
  assertEquals(completed.data.results.length, 2);
});

Deno.test("modelSearch: returns empty results when no models exist", async () => {
  const deps = makeDeps({
    findAllGlobal: () => Promise.resolve([]),
  });
  const events = await collect<ModelSearchEvent>(
    modelSearch(createLibSwampContext(), deps, { query: "foo" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    ModelSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});

Deno.test("modelSearch: excludes internal types by default", async () => {
  const deps = makeDeps({
    findAllGlobal: () => Promise.resolve(RESULTS_WITH_INTERNAL),
    isInternalType: (type: string) => INTERNAL_TYPES.has(type),
  });
  const events = await collect<ModelSearchEvent>(
    modelSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    ModelSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].name, "my-ec2");
  assertEquals(completed.data.results[1].name, "my-bucket");
});

Deno.test("modelSearch: includes internal types when includeInternal is true", async () => {
  const deps = makeDeps({
    findAllGlobal: () => Promise.resolve(RESULTS_WITH_INTERNAL),
    isInternalType: (type: string) => INTERNAL_TYPES.has(type),
  });
  const events = await collect<ModelSearchEvent>(
    modelSearch(createLibSwampContext(), deps, { includeInternal: true }),
  );

  const completed = events[1] as Extract<
    ModelSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 4);
});

Deno.test("modelSearch: returns all when isInternalType dep is not provided", async () => {
  const deps = makeDeps({
    findAllGlobal: () => Promise.resolve(RESULTS_WITH_INTERNAL),
  });
  const events = await collect<ModelSearchEvent>(
    modelSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    ModelSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 4);
});
