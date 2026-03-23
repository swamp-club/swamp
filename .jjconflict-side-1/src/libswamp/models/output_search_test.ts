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
  modelOutputSearch,
  type ModelOutputSearchDeps,
  type ModelOutputSearchEvent,
} from "./output_search.ts";

function makeDeps(
  overrides: Partial<ModelOutputSearchDeps> = {},
): ModelOutputSearchDeps {
  return {
    findAllOutputsGlobal: () =>
      Promise.resolve([
        {
          output: {
            id: "out-1",
            definitionId: "def-1",
            methodName: "start",
            status: "succeeded",
            startedAt: new Date("2026-01-15T10:00:00Z"),
            durationMs: 1500,
          },
          type: { normalized: "aws/ec2-instance" },
        },
        {
          output: {
            id: "out-2",
            definitionId: "def-2",
            methodName: "sync",
            status: "failed",
            startedAt: new Date("2026-01-15T11:00:00Z"),
            durationMs: 500,
          },
          type: { normalized: "aws/s3-bucket" },
        },
      ]),
    findDefinitionById: (_type, defId) => {
      if (defId === "def-1") return Promise.resolve({ name: "my-ec2" });
      if (defId === "def-2") return Promise.resolve({ name: "my-bucket" });
      return Promise.resolve(null);
    },
    ...overrides,
  };
}

Deno.test("modelOutputSearch: returns all outputs sorted by startedAt descending", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputSearchEvent>(
    modelOutputSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ModelOutputSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.results.length, 2);
  // Most recent first
  assertEquals(completed.data.results[0].id, "out-2");
  assertEquals(completed.data.results[1].id, "out-1");
});

Deno.test("modelOutputSearch: resolves model names from definitions", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputSearchEvent>(
    modelOutputSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    ModelOutputSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results[0].modelName, "my-bucket");
  assertEquals(completed.data.results[1].modelName, "my-ec2");
});

Deno.test("modelOutputSearch: handles missing definitions gracefully", async () => {
  const deps = makeDeps({
    findDefinitionById: () => Promise.resolve(null),
  });
  const events = await collect<ModelOutputSearchEvent>(
    modelOutputSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    ModelOutputSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results[0].modelName, undefined);
});

Deno.test("modelOutputSearch: returns empty results when no outputs", async () => {
  const deps = makeDeps({
    findAllOutputsGlobal: () => Promise.resolve([]),
  });
  const events = await collect<ModelOutputSearchEvent>(
    modelOutputSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    ModelOutputSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});
