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
    findAllDefinitions: () =>
      Promise.resolve([
        {
          definition: { id: "def-1", name: "my-ec2" },
          type: { normalized: "aws/ec2-instance" },
        },
        {
          definition: { id: "def-2", name: "my-bucket" },
          type: { normalized: "aws/s3-bucket" },
        },
      ]),
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
    findAllDefinitions: () => Promise.resolve([]),
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
    await collect(modelOutputSearch(createLibSwampContext(), deps, {
      includeProvenance: true,
    })),
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
    await collect(modelOutputSearch(createLibSwampContext(), deps, {
      includeProvenance: true,
    })),
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

Deno.test("modelOutputSearch: filters by since (inclusive) and until (exclusive)", async () => {
  const run = async (input: { since?: string; until?: string }) =>
    completedOf(
      await collect(
        modelOutputSearch(createLibSwampContext(), makeDeps(), input),
      ),
    ).results.map((r) => r.id);

  assertEquals(await run({ since: "2026-01-15T10:30:00Z" }), ["out-2"]);
  assertEquals(await run({ until: "2026-01-15T10:00:00Z" }), []);
  assertEquals(await run({ until: "2026-01-15T10:00:01Z" }), ["out-1"]);
  assertEquals(
    await run({
      since: "2026-01-15T10:00:00Z",
      until: "2026-01-15T11:00:00Z",
    }),
    ["out-1"],
  );
});

Deno.test("modelOutputSearch: reads a duration since and until as that long before now", async () => {
  const hour = 3_600_000;
  const now = Date.now();
  const output = (id: string, agoMs: number) => ({
    output: {
      id,
      definitionId: "def-1",
      methodName: "sync",
      status: "succeeded",
      startedAt: new Date(now - agoMs),
    },
    type: { normalized: "aws/ec2-instance" },
  });
  const deps = makeDeps({
    findAllOutputsGlobal: () =>
      Promise.resolve([
        output("two-hours", 2 * hour),
        output("six-days", 6 * 24 * hour),
        output("eight-days", 8 * 24 * hour),
      ]),
  });
  const run = async (input: { since?: string; until?: string }) =>
    completedOf(
      await collect(modelOutputSearch(createLibSwampContext(), deps, input)),
    ).results.map((r) => r.id);

  assertEquals(await run({ since: "7d" }), ["two-hours", "six-days"]);
  assertEquals(await run({ since: "1d" }), ["two-hours"]);
  assertEquals(await run({ until: "1h" }), [
    "two-hours",
    "six-days",
    "eight-days",
  ]);
  assertEquals(await run({ since: "1w", until: "1d" }), ["six-days"]);
});

Deno.test("modelOutputSearch: gives the since-bounded scan the cutoff a duration resolves to", async () => {
  const cutoffs: number[] = [];
  const deps = makeDeps({
    findAllOutputsGlobalSince: (cutoff) => {
      cutoffs.push(cutoff.getTime());
      return Promise.resolve([]);
    },
  });
  const before = Date.now();
  await collect(
    modelOutputSearch(createLibSwampContext(), deps, { since: "7d" }),
  );
  const after = Date.now();
  const week = 7 * 86_400_000;
  assertEquals(cutoffs.length, 1);
  assertEquals(
    cutoffs[0] >= before - week && cutoffs[0] <= after - week,
    true,
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
    const input of [
      { since: "yesterday" },
      { until: "nope" },
      { since: "7x" },
      // A duration too long to resolve to a date.
      { since: "99999999999999999999d" },
      { limit: -1 },
    ]
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

/** One output per definition id, all of one type, a second apart. */
function outputsOf(definitionIds: string[], type = "command/shell") {
  return definitionIds.map((definitionId, i) => ({
    output: {
      id: `out-${i}`,
      definitionId,
      methodName: "execute",
      status: "succeeded",
      startedAt: new Date(Date.UTC(2026, 0, 15, 10, 0, i)),
    },
    type: { normalized: type },
  }));
}

Deno.test("modelOutputSearch: names outputs of many deleted definitions from one definition scan (swamp-club#3959)", async () => {
  const deleted = Array.from({ length: 50 }, (_, i) => `gone-${i}`);
  let scans = 0;
  const deps = makeDeps({
    findAllOutputsGlobal: () =>
      Promise.resolve(outputsOf([...deleted, "kept"])),
    findAllDefinitions: () => {
      scans++;
      return Promise.resolve([{
        definition: { id: "kept", name: "still-here" },
        type: { normalized: "command/shell" },
      }]);
    },
  });
  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, { limit: 5 }),
    ),
  );
  assertEquals(scans, 1);
  assertEquals(data.results[0].modelName, "still-here");
  assertEquals(
    data.results.slice(1).map((r) => r.modelName),
    [undefined, undefined, undefined, undefined],
  );
});

Deno.test("modelOutputSearch: names an output after the first definition listed for its type and id", async () => {
  const deps = makeDeps({
    findAllOutputsGlobal: () => Promise.resolve(outputsOf(["shared"])),
    // Primary definitions are listed before auto-definitions.
    findAllDefinitions: () =>
      Promise.resolve([
        {
          definition: { id: "shared", name: "primary" },
          type: { normalized: "command/shell" },
        },
        {
          definition: { id: "shared", name: "auto" },
          type: { normalized: "command/shell" },
        },
      ]),
  });
  const data = completedOf(
    await collect(modelOutputSearch(createLibSwampContext(), deps, {})),
  );
  assertEquals(data.results.map((r) => r.modelName), ["primary"]);
});

Deno.test("modelOutputSearch: does not name an output after a definition of another type", async () => {
  const deps = makeDeps({
    findAllOutputsGlobal: () => Promise.resolve(outputsOf(["def-x"])),
    findAllDefinitions: () =>
      Promise.resolve([{
        definition: { id: "def-x", name: "other-type" },
        type: { normalized: "aws/s3-bucket" },
      }]),
  });
  const data = completedOf(
    await collect(modelOutputSearch(createLibSwampContext(), deps, {})),
  );
  assertEquals(data.results.map((r) => r.modelName), [undefined]);
});

Deno.test("modelOutputSearch: scans no definitions when no output needs a name", async () => {
  const deps = makeDeps({
    findAllDefinitions: () => {
      throw new Error("must not scan definitions");
    },
    resolveModel: () =>
      Promise.resolve([{
        definitionId: "def-1",
        name: "my-ec2",
        type: { normalized: "aws/ec2-instance" },
      }]),
    findOutputsByDefinition: () =>
      Promise.resolve(
        outputsOf(["def-1"], "aws/ec2-instance").map((o) => o.output),
      ),
  });
  // The model filter already knows each output's name.
  const named = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, { model: "my-ec2" }),
    ),
  );
  assertEquals(named.results.map((r) => r.modelName), ["my-ec2"]);
  // A window no output falls in names nothing.
  const empty = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, {
        since: "2030-01-01T00:00:00Z",
      }),
    ),
  );
  assertEquals(empty.results, []);
});
