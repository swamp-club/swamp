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
  sourceClean,
  type SourceCleanDeps,
  type SourceCleanEvent,
} from "./clean.ts";

function makeDeps(overrides: Partial<SourceCleanDeps> = {}): SourceCleanDeps {
  return {
    clean: () =>
      Promise.resolve({
        status: "cleaned" as const,
        path: "/source/path",
      }),
    ...overrides,
  };
}

Deno.test("sourceClean: yields completed with cleaned status", async () => {
  const deps = makeDeps();

  const events = await collect<SourceCleanEvent>(
    sourceClean(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    SourceCleanEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "cleaned");
});

Deno.test("sourceClean: yields completed with not_found status", async () => {
  const deps = makeDeps({
    clean: () =>
      Promise.resolve({
        status: "not_found" as const,
        path: "/source/path",
      }),
  });

  const events = await collect<SourceCleanEvent>(
    sourceClean(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    SourceCleanEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "not_found");
});
