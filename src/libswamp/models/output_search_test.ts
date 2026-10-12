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
            provenance: { triggeredBy: "manual" },
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
            provenance: {
              triggeredBy: "workflow",
              workflowId: "wf-1",
              workflowRunId: "run-1",
              stepName: "sync-step",
            },
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

function completedOf(events: ModelOutputSearchEvent[]) {
  const completed = events.find((e) => e.kind === "completed");
  if (!completed || completed.kind !== "completed") {
    throw new Error("expected a completed event");
  }
  return completed.data;
}

Deno.test("modelOutputSearch: maps provenance and resolves workflow names in one lookup", async () => {
  const lookups: string[][] = [];
  const deps = makeDeps({
    resolveWorkflowNames: (ids) => {
      lookups.push([...ids]);
      return Promise.resolve(new Map([["wf-1", "nightly"]]));
    },
  });
  const data = completedOf(
    await collect(modelOutputSearch(createLibSwampContext(), deps, {})),
  );

  assertEquals(lookups, [["wf-1"]]);
  assertEquals(data.results[0].triggeredBy, "workflow");
  assertEquals(data.results[0].workflowId, "wf-1");
  assertEquals(data.results[0].workflowName, "nightly");
  assertEquals(data.results[0].workflowRunId, "run-1");
  assertEquals(data.results[0].stepName, "sync-step");
  assertEquals(data.results[1].triggeredBy, "manual");
  assertEquals("workflowId" in data.results[1], false);
});

Deno.test("modelOutputSearch: omits the workflow name when the id no longer resolves", async () => {
  const deps = makeDeps({
    resolveWorkflowNames: () => Promise.resolve(new Map()),
  });
  const data = completedOf(
    await collect(modelOutputSearch(createLibSwampContext(), deps, {})),
  );
  assertEquals(data.results[0].workflowId, "wf-1");
  assertEquals("workflowName" in data.results[0], false);
});

Deno.test("modelOutputSearch: filters by model name or id over every output", async () => {
  for (const model of ["my-ec2", "def-1"]) {
    const data = completedOf(
      await collect(
        modelOutputSearch(createLibSwampContext(), makeDeps(), { model }),
      ),
    );
    assertEquals(data.results.map((r) => r.id), ["out-1"]);
  }
});

Deno.test("modelOutputSearch: reads only the named model's outputs when it can look them up by definition", async () => {
  const deps = makeDeps({
    findAllOutputsGlobal: () => {
      throw new Error("must not scan every output");
    },
    resolveModel: (idOrName) =>
      Promise.resolve(
        idOrName === "my-ec2"
          ? [{
            definitionId: "def-1",
            name: "my-ec2",
            type: { normalized: "aws/ec2-instance" },
          }]
          : [],
      ),
    findOutputsByDefinition: (_type, definitionId) =>
      Promise.resolve(
        definitionId === "def-1"
          ? [{
            id: "out-1",
            definitionId: "def-1",
            methodName: "start",
            status: "succeeded",
            startedAt: new Date("2026-01-15T10:00:00Z"),
            provenance: { triggeredBy: "manual" as const },
          }]
          : [],
      ),
  });
  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, { model: "my-ec2" }),
    ),
  );
  assertEquals(data.results.map((r) => [r.id, r.modelName]), [[
    "out-1",
    "my-ec2",
  ]]);
});

Deno.test("modelOutputSearch: filters by since and until, inclusive", async () => {
  const run = async (input: { since?: string; until?: string }) =>
    completedOf(
      await collect(
        modelOutputSearch(createLibSwampContext(), makeDeps(), input),
      ),
    ).results.map((r) => r.id);

  assertEquals(await run({ since: "2026-01-15T10:30:00Z" }), ["out-2"]);
  assertEquals(await run({ until: "2026-01-15T10:00:00Z" }), ["out-1"]);
  assertEquals(
    await run({
      since: "2026-01-15T10:00:00Z",
      until: "2026-01-15T11:00:00Z",
    }),
    ["out-2", "out-1"],
  );
});

Deno.test("modelOutputSearch: uses the since-bounded scan when the repository offers one", async () => {
  const cutoffs: string[] = [];
  const deps = makeDeps({
    findAllOutputsGlobalSince: (cutoff) => {
      cutoffs.push(cutoff.toISOString());
      return Promise.resolve([]);
    },
  });
  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, {
        since: "2026-01-15T10:30:00Z",
      }),
    ),
  );
  assertEquals(cutoffs, ["2026-01-15T10:30:00.000Z"]);
  assertEquals(data.results, []);
});

Deno.test("modelOutputSearch: keeps at most limit results, most recent first", async () => {
  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), makeDeps(), { limit: 1 }),
    ),
  );
  assertEquals(data.results.map((r) => r.id), ["out-2"]);
});

Deno.test("modelOutputSearch: rejects an unparseable since and a negative limit", async () => {
  for (
    const input of [{ since: "yesterday" }, { until: "nope" }, { limit: -1 }]
  ) {
    const events = await collect<ModelOutputSearchEvent>(
      modelOutputSearch(createLibSwampContext(), makeDeps(), input),
    );
    const last = events[events.length - 1];
    assertEquals(last.kind, "error");
    if (last.kind === "error") {
      assertEquals(last.error.code, "validation_failed");
    }
  }
});
