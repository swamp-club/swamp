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
  driverTypeSearch,
  type DriverTypeSearchDeps,
  type DriverTypeSearchEvent,
} from "./type_search.ts";

function makeDeps(
  overrides: Partial<DriverTypeSearchDeps> = {},
): DriverTypeSearchDeps {
  return {
    getDriverTypes: () => [
      {
        type: "raw",
        name: "Raw (In-Process)",
        description: "Execute directly in the host Deno process",
      },
      {
        type: "docker",
        name: "Docker",
        description: "Execute in isolated Docker containers",
      },
    ],
    ...overrides,
  };
}

Deno.test("driverTypeSearch: returns all driver types with no query", async () => {
  const deps = makeDeps();
  const events = await collect<DriverTypeSearchEvent>(
    driverTypeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    DriverTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].type, "raw");
  assertEquals(completed.data.results[0].name, "Raw (In-Process)");
});

Deno.test("driverTypeSearch: passes query through in data", async () => {
  const deps = makeDeps();
  const events = await collect<DriverTypeSearchEvent>(
    driverTypeSearch(createLibSwampContext(), deps, { query: "docker" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    DriverTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "docker");
  assertEquals(completed.data.results.length, 2);
});

Deno.test("driverTypeSearch: returns empty results when no driver types", async () => {
  const deps = makeDeps({
    getDriverTypes: () => [],
  });
  const events = await collect<DriverTypeSearchEvent>(
    driverTypeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    DriverTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});
