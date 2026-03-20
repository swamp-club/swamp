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
  typeSearch,
  type TypeSearchDeps,
  type TypeSearchEvent,
} from "./search.ts";

function makeDeps(
  overrides: Partial<TypeSearchDeps> = {},
): TypeSearchDeps {
  return {
    getRegisteredTypes: () => [
      { raw: "aws/ec2_instance", normalized: "aws/ec2-instance" },
      { raw: "aws/s3_bucket", normalized: "aws/s3-bucket" },
      { raw: "docker/container", normalized: "docker/container" },
    ],
    ...overrides,
  };
}

Deno.test("typeSearch: returns all types with no query", async () => {
  const deps = makeDeps();
  const events = await collect<TypeSearchEvent>(
    typeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    TypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 3);
  assertEquals(completed.data.results[0].raw, "aws/ec2_instance");
  assertEquals(completed.data.results[0].normalized, "aws/ec2-instance");
});

Deno.test("typeSearch: passes query through in data", async () => {
  const deps = makeDeps();
  const events = await collect<TypeSearchEvent>(
    typeSearch(createLibSwampContext(), deps, { query: "aws" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    TypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "aws");
  assertEquals(completed.data.results.length, 3);
});

Deno.test("typeSearch: returns empty results when no types registered", async () => {
  const deps = makeDeps({
    getRegisteredTypes: () => [],
  });
  const events = await collect<TypeSearchEvent>(
    typeSearch(createLibSwampContext(), deps, { query: "aws" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    TypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
  assertEquals(completed.data.query, "aws");
});
