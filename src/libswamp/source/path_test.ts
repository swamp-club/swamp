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
  sourcePath,
  type SourcePathDeps,
  type SourcePathEvent,
} from "./path.ts";

function makeDeps(overrides: Partial<SourcePathDeps> = {}): SourcePathDeps {
  return {
    getInfo: () =>
      Promise.resolve({
        status: "found" as const,
        version: "v1.0.0",
        path: "/source/path",
        fileCount: 42,
        fetchedAt: "2026-01-01T00:00:00Z",
      }),
    ...overrides,
  };
}

Deno.test("sourcePath: yields completed with found status", async () => {
  const deps = makeDeps();

  const events = await collect<SourcePathEvent>(
    sourcePath(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    SourcePathEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "found");
});

Deno.test("sourcePath: yields completed with not_found status", async () => {
  const deps = makeDeps({
    getInfo: () => Promise.resolve({ status: "not_found" as const }),
  });

  const events = await collect<SourcePathEvent>(
    sourcePath(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    SourcePathEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "not_found");
});
