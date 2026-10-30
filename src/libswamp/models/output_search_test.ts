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
import { withDiagnosticArea } from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  diagnosticPhases,
  findSpan,
  withObservedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  modelOutputSearch,
  type ModelOutputSearchCandidate,
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

Deno.test("modelOutputSearch: passes since and until to the model's output lookup, and still filters what it returns (swamp-club#4058)", async () => {
  const windows: Array<{ since?: Date; until?: Date } | undefined> = [];
  const deps = makeDeps({
    resolveModel: () =>
      Promise.resolve([{
        definitionId: "def-1",
        name: "my-ec2",
        type: { normalized: "aws/ec2-instance" },
      }]),
    // Ignores the window, so the search's own check is what filters.
    findOutputsByDefinition: (_type, _definitionId, window) => {
      windows.push(window);
      return Promise.resolve(
        ["2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"]
          .map((startedAt, i) => ({
            id: `out-${i}`,
            definitionId: "def-1",
            methodName: "start",
            status: "succeeded",
            startedAt: new Date(startedAt),
          })),
      );
    },
  });
  const run = async (input: { since?: string; until?: string }) =>
    completedOf(
      await collect(
        modelOutputSearch(createLibSwampContext(), deps, {
          model: "my-ec2",
          ...input,
        }),
      ),
    ).results.map((r) => r.id);

  assertEquals(
    await run({
      since: "2026-01-15T10:00:00Z",
      until: "2026-01-15T11:00:00Z",
    }),
    ["out-1"],
  );
  assertEquals(await run({ since: "2026-01-15T10:00:00Z" }), [
    "out-2",
    "out-1",
  ]);
  assertEquals(await run({}), ["out-2", "out-1", "out-0"]);
  assertEquals(windows, [
    {
      since: new Date("2026-01-15T10:00:00Z"),
      until: new Date("2026-01-15T11:00:00Z"),
    },
    { since: new Date("2026-01-15T10:00:00Z"), until: undefined },
    undefined,
  ]);
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

Deno.test("modelOutputSearch: exports its phases only inside the output_search area (swamp-club#4056)", async () => {
  await withObservedSpans(async (spans) => {
    const deps = makeDeps({
      resolveWorkflowNames: () =>
        Promise.resolve(new Map([["wf-1", "nightly"]])),
    });
    const input = { includeProvenance: true };

    await collect(modelOutputSearch(createLibSwampContext(), deps, input));
    for (
      const phase of [
        "candidate_scan",
        "definition_names",
        "workflow_names",
      ] as const
    ) {
      assertEquals(diagnosticPhases(spans, phase).length, 0, phase);
    }

    const data = completedOf(
      await withDiagnosticArea(
        "output_search",
        () => collect(modelOutputSearch(createLibSwampContext(), deps, input)),
      ),
    );

    assertEquals(data.results.length, 2);
    const attributes = (phase: string) =>
      findSpan(spans, `swamp.diagnostic.${phase}`).attributes;
    assertEquals(
      attributes("candidate_scan")["swamp.diagnostic.candidates"],
      2,
    );
    assertEquals(
      attributes("definition_names")["swamp.diagnostic.definitions"],
      2,
    );
    assertEquals(
      attributes("workflow_names")["swamp.diagnostic.workflow_ids"],
      1,
    );
    assertEquals(
      attributes("candidate_scan")["swamp.diagnostic.area"],
      "output_search",
    );
  });
});

Deno.test("modelOutputSearch: names outputs through resolveModelNames instead of scanning every definition (swamp-club#4141)", async () => {
  const lookups: Array<Array<[string, string]>> = [];
  const outputs = [
    ...outputsOf(["def-a", "def-a", "def-b", "def-gone"]),
    // A definition id shared across types is asked for once per type.
    ...outputsOf(["def-a"], "aws/s3-bucket").map((o) => ({
      ...o,
      output: { ...o.output, id: "out-s3" },
    })),
  ];
  const names: Record<string, string> = {
    '["command/shell","def-a"]': "shell-a",
    '["command/shell","def-b"]': "shell-b",
    '["aws/s3-bucket","def-a"]': "bucket-a",
  };
  const deps = makeDeps({
    findAllOutputsGlobal: () => Promise.resolve(outputs),
    findAllDefinitions: () => {
      throw new Error("must not scan definitions");
    },
    resolveModelNames: (keys) => {
      lookups.push(keys.map((k) => [k.type.normalized, k.definitionId]));
      return Promise.resolve(
        keys.map((k) =>
          names[JSON.stringify([k.type.normalized, k.definitionId])]
        ),
      );
    },
  });
  const data = completedOf(
    await collect(modelOutputSearch(createLibSwampContext(), deps, {})),
  );
  assertEquals(lookups, [[
    ["command/shell", "def-a"],
    ["command/shell", "def-b"],
    ["command/shell", "def-gone"],
    ["aws/s3-bucket", "def-a"],
  ]]);
  assertEquals(
    Object.fromEntries(data.results.map((r) => [r.id, r.modelName])),
    {
      "out-0": "shell-a",
      "out-1": "shell-a",
      "out-2": "shell-b",
      "out-3": undefined,
      "out-s3": "bucket-a",
    },
  );
});

Deno.test("modelOutputSearch: resolveModelNames is asked only for outputs inside the window, and not at all when none needs a name", async () => {
  const lookups: string[][] = [];
  const deps = makeDeps({
    findAllOutputsGlobal: () => Promise.resolve(outputsOf(["early", "late"])),
    findAllDefinitions: () => {
      throw new Error("must not scan definitions");
    },
    resolveModelNames: (keys) => {
      lookups.push(keys.map((k) => k.definitionId));
      return Promise.resolve(keys.map(() => "named"));
    },
  });
  // outputsOf starts the outputs one second apart, from 10:00:00.
  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, {
        since: "2026-01-15T10:00:01Z",
      }),
    ),
  );
  assertEquals(lookups, [["late"]]);
  assertEquals(data.results.map((r) => r.modelName), ["named"]);

  lookups.length = 0;
  const empty = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, {
        since: "2030-01-01T00:00:00Z",
      }),
    ),
  );
  assertEquals(empty.results, []);
  assertEquals(lookups, []);
});

Deno.test("modelOutputSearch: the model filter matches a name resolveModelNames gives", async () => {
  const deps = makeDeps({
    findAllDefinitions: () => {
      throw new Error("must not scan definitions");
    },
    resolveModelNames: (keys) =>
      Promise.resolve(
        keys.map((k) => k.definitionId === "def-2" ? "my-bucket" : undefined),
      ),
  });
  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, { model: "my-bucket" }),
    ),
  );
  assertEquals(data.results.map((r) => r.id), ["out-2"]);
  assertEquals(data.results[0].modelName, "my-bucket");
});

Deno.test("modelOutputSearch: definition_names counts the definitions resolveModelNames is asked for", async () => {
  await withObservedSpans(async (spans) => {
    const deps = makeDeps({
      findAllOutputsGlobal: () =>
        Promise.resolve(outputsOf(["def-a", "def-a", "def-b"])),
      resolveModelNames: (keys) => Promise.resolve(keys.map(() => "named")),
    });
    await withDiagnosticArea(
      "output_search",
      () => collect(modelOutputSearch(createLibSwampContext(), deps, {})),
    );
    const phase = findSpan(spans, "swamp.diagnostic.definition_names");
    assertEquals(phase.attributes["swamp.diagnostic.definitions"], 2);
  });
});

Deno.test("modelOutputSearch: asks canRead about each key the scan finds, named as its results would be, and passes the scan its answers (swamp-club#4142)", async () => {
  const asked: ModelOutputSearchCandidate[][] = [];
  const selections: boolean[][] = [];
  const deps = makeDeps({
    canRead: (candidates) => {
      asked.push([...candidates]);
      return Promise.resolve(
        candidates.map((candidate) => candidate.modelName === "my-ec2"),
      );
    },
    findAllOutputsGlobalSince: async (_cutoff, selectReadable) => {
      selections.push([
        ...(await selectReadable!([
          {
            type: { normalized: "aws/ec2-instance" },
            definitionId: "def-1",
            methodName: "start",
          },
          {
            type: { normalized: "aws/s3-bucket" },
            definitionId: "def-2",
            methodName: "sync",
          },
          // A definition no longer found carries no name.
          {
            type: { normalized: "aws/s3-bucket" },
            definitionId: "gone",
            methodName: "sync",
          },
        ])),
      ]);
      return [];
    },
  });
  await collect(
    modelOutputSearch(createLibSwampContext(), deps, {
      since: "2026-01-01T00:00:00Z",
    }),
  );
  assertEquals(asked, [[
    {
      definitionId: "def-1",
      modelName: "my-ec2",
      type: "aws/ec2-instance",
      methodName: "start",
    },
    {
      definitionId: "def-2",
      modelName: "my-bucket",
      type: "aws/s3-bucket",
      methodName: "sync",
    },
    {
      definitionId: "gone",
      modelName: undefined,
      type: "aws/s3-bucket",
      methodName: "sync",
    },
  ]]);
  assertEquals(selections, [[true, false, false]]);
});

Deno.test("modelOutputSearch: gives the full scan a selection only when canRead is given (swamp-club#4142)", async () => {
  let selected: unknown = "not called";
  const scan: ModelOutputSearchDeps["findAllOutputsGlobal"] = (
    selectReadable,
  ) => {
    selected = selectReadable;
    return Promise.resolve([]);
  };
  await collect(
    modelOutputSearch(
      createLibSwampContext(),
      makeDeps({ findAllOutputsGlobal: scan }),
      {},
    ),
  );
  assertEquals(selected, undefined);

  await collect(
    modelOutputSearch(
      createLibSwampContext(),
      makeDeps({
        findAllOutputsGlobal: scan,
        canRead: (candidates) => Promise.resolve(candidates.map(() => true)),
      }),
      {},
    ),
  );
  assertEquals(typeof selected, "function");
});

/**
 * A newest-first read over `files`, given in the order the repository would
 * read them, counting what it reads and how often it is opened. `named: false`
 * is a file whose name says nothing about its start.
 */
function fakeNewestFirst(
  files: Array<{ id: string; startedAt: string; named?: boolean }>,
) {
  let at = 0;
  const counts = { opened: 0, read: 0, batches: [] as number[] };
  const instantOf = (startedAt: string) => new Date(startedAt);
  const dep: NonNullable<ModelOutputSearchDeps["findOutputsNewestFirst"]> =
    () => {
      counts.opened++;
      return Promise.resolve({
        get unread() {
          return files.length - at;
        },
        unreadStartedBefore: (instant: Date) => {
          const head = files[at];
          if (head === undefined) return true;
          return head.named !== false &&
            instantOf(head.startedAt).getTime() < instant.getTime();
        },
        next: (count: number) => {
          const batch = files.slice(at, at + count);
          at += batch.length;
          counts.read += batch.length;
          counts.batches.push(batch.length);
          return Promise.resolve(batch.map((file, i) => ({
            output: {
              id: file.id,
              definitionId: `def-${file.id}`,
              methodName: "run",
              status: "succeeded",
              startedAt: instantOf(file.startedAt),
            },
            type: { normalized: "command/shell" },
            position: at - batch.length + i,
          })));
        },
      });
    };
  return { dep, counts };
}

/** Deps whose only way to find outputs is the given newest-first read. */
function newestFirstDeps(
  dep: NonNullable<ModelOutputSearchDeps["findOutputsNewestFirst"]>,
  overrides: Partial<ModelOutputSearchDeps> = {},
): ModelOutputSearchDeps {
  return makeDeps({
    findAllOutputsGlobal: () => {
      throw new Error("a limited search must not read every output");
    },
    findOutputsNewestFirst: dep,
    ...overrides,
  });
}

/** `count` files a minute apart, newest first. */
function minutesApart(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `out-${i}`,
    startedAt: new Date(Date.UTC(2026, 0, 1, 1, -i)).toISOString(),
  }));
}

Deno.test("modelOutputSearch: with a limit, reads no further than the results it returns, and counts what it left unread", async () => {
  await withObservedSpans(async (spans) => {
    const { dep, counts } = fakeNewestFirst(minutesApart(100));

    const data = completedOf(
      await withDiagnosticArea(
        "output_search",
        () =>
          collect(
            modelOutputSearch(createLibSwampContext(), newestFirstDeps(dep), {
              limit: 20,
            }),
          ),
      ),
    );

    assertEquals(
      data.results.map((r) => r.id),
      minutesApart(20).map((file) => file.id),
    );
    assertEquals(counts.batches, [20]);
    const scan = findSpan(spans, "swamp.diagnostic.candidate_scan").attributes;
    assertEquals(scan["swamp.diagnostic.candidates"], 20);
    assertEquals(scan["swamp.diagnostic.left_unread"], 80);
  });
});

Deno.test("modelOutputSearch: with a large limit, reads at most 1024 outputs at once, so it takes turns at the shared reads", async () => {
  const { dep, counts } = fakeNewestFirst(minutesApart(3000));

  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), newestFirstDeps(dep), {
        limit: 2500,
      }),
    ),
  );

  assertEquals(data.results.length, 2500);
  assertEquals(counts.batches, [1024, 1024, 452]);
});

Deno.test("modelOutputSearch: with a limit, reads through outputs started in the same millisecond as the last result, keeping the first in walk order", async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const { dep, counts } = fakeNewestFirst([
    { id: "tied-1", startedAt: at },
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `tied-${i + 2}`,
      startedAt: at,
    })),
    { id: "older", startedAt: "2025-01-01T00:00:00.000Z" },
  ]);

  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), newestFirstDeps(dep), {
        limit: 1,
      }),
    ),
  );

  assertEquals(data.results.map((r) => r.id), ["tied-1"]);
  // Every tied output, in batches of at least 16, and so the older one too.
  assertEquals(counts.read, 22);
});

Deno.test("modelOutputSearch: with a limit, an old output whose name says nothing does not end the search before newer ones are read", async () => {
  const { dep } = fakeNewestFirst([
    { id: "old-unnamed", startedAt: "2020-01-01T00:00:00.000Z", named: false },
    ...minutesApart(40),
  ]);

  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), newestFirstDeps(dep), {
        limit: 20,
      }),
    ),
  );

  assertEquals(
    data.results.map((r) => r.id),
    minutesApart(20).map((file) => file.id),
  );
});

Deno.test("modelOutputSearch: with a limit, an output canRead refuses takes no place among the results, and the search reads on", async () => {
  const { dep, counts } = fakeNewestFirst(minutesApart(100));
  const refused = new Set(
    minutesApart(30).map((file) => `def-${file.id}`),
  );

  const data = completedOf(
    await collect(
      modelOutputSearch(
        createLibSwampContext(),
        newestFirstDeps(dep, {
          canRead: (candidates) =>
            Promise.resolve(
              candidates.map((c) => !refused.has(c.definitionId)),
            ),
        }),
        { limit: 2 },
      ),
    ),
  );

  assertEquals(data.results.map((r) => r.id), ["out-30", "out-31"]);
  assertEquals(counts.batches, [16, 16]);
});

Deno.test("modelOutputSearch: with a limit, an output its name placed in the window but whose record does not is left out", async () => {
  const { dep } = fakeNewestFirst([
    { id: "in", startedAt: "2026-01-02T00:00:00.000Z" },
    { id: "out", startedAt: "2020-01-02T00:00:00.000Z" },
  ]);

  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), newestFirstDeps(dep), {
        since: "2026-01-01T00:00:00.000Z",
        limit: 5,
      }),
    ),
  );

  assertEquals(data.results.map((r) => r.id), ["in"]);
});

Deno.test("modelOutputSearch: a limit of 0 reads nothing", async () => {
  const { dep, counts } = fakeNewestFirst(minutesApart(5));

  const data = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), newestFirstDeps(dep), {
        limit: 0,
      }),
    ),
  );

  assertEquals(data.results, []);
  assertEquals(counts.opened, 0);
});

Deno.test("modelOutputSearch: reads newest first only with a limit and without a model", async () => {
  const { dep, counts } = fakeNewestFirst(minutesApart(5));
  const deps = makeDeps({ findOutputsNewestFirst: dep });

  const unlimited = completedOf(
    await collect(modelOutputSearch(createLibSwampContext(), deps, {})),
  );
  assertEquals(unlimited.results.length, 2);

  const forModel = completedOf(
    await collect(
      modelOutputSearch(createLibSwampContext(), deps, {
        model: "def-1",
        limit: 1,
      }),
    ),
  );
  assertEquals(forModel.results.map((r) => r.definitionId), ["def-1"]);

  assertEquals(counts.opened, 0);
});
