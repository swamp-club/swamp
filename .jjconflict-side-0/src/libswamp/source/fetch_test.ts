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
  sourceFetch,
  type SourceFetchDeps,
  type SourceFetchEvent,
} from "./fetch.ts";

function makeDeps(overrides: Partial<SourceFetchDeps> = {}): SourceFetchDeps {
  return {
    fetch: () =>
      Promise.resolve({
        status: "fetched" as const,
        version: "v1.0.0",
        path: "/source/path",
        fileCount: 42,
        fetchedAt: "2026-01-01T00:00:00Z",
      }),
    ...overrides,
  };
}

Deno.test("sourceFetch: yields fetching then completed", async () => {
  const deps = makeDeps();

  const events = await collect<SourceFetchEvent>(
    sourceFetch(createLibSwampContext(), deps, { version: "v1.0.0" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "fetching" });
  const completed = events[1] as Extract<
    SourceFetchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "fetched");
});

Deno.test("sourceFetch: yields completed with already_fetched status", async () => {
  const deps = makeDeps({
    fetch: () =>
      Promise.resolve({
        status: "already_fetched" as const,
        version: "v1.0.0",
        path: "/source/path",
        fileCount: 42,
        fetchedAt: "2026-01-01T00:00:00Z",
      }),
  });

  const events = await collect<SourceFetchEvent>(
    sourceFetch(createLibSwampContext(), deps, { version: "v1.0.0" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "fetching" });
  const completed = events[1] as Extract<
    SourceFetchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "already_fetched");
});
