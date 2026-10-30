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
import type { ModelOutputSearchOutput } from "./output_search.ts";
import {
  type ModelUsageOutputGroup,
  modelUsageSummary,
  type ModelUsageSummaryData,
  type ModelUsageSummaryDeps,
  type ModelUsageSummaryEvent,
  type ModelUsageSummaryInput,
} from "./usage_summary.ts";

const TYPE = { normalized: "test/model" };

function candidate(
  o: Partial<ModelOutputSearchOutput> & { id: string },
  type = TYPE,
) {
  return {
    output: {
      definitionId: "def-a",
      methodName: "run",
      status: "succeeded",
      startedAt: new Date("2026-01-15T10:00:00Z"),
      ...o,
    },
    type,
  };
}

function makeDeps(
  candidates: ReturnType<typeof candidate>[],
  overrides: Partial<ModelUsageSummaryDeps> = {},
): ModelUsageSummaryDeps {
  return {
    findAllOutputsGlobal: () => Promise.resolve(candidates),
    findAllDefinitions: () =>
      Promise.resolve([
        { definition: { id: "def-a", name: "a" }, type: TYPE },
        { definition: { id: "def-b", name: "b" }, type: TYPE },
      ]),
    isReadable: () => Promise.resolve(true),
    definitionNameById: (id) =>
      Promise.resolve(
        ({ "def-a": "a", "def-b": "b" } as Record<string, string>)[id],
      ),
    ...overrides,
  };
}

async function summarize(
  deps: ModelUsageSummaryDeps,
  input: ModelUsageSummaryInput = {},
): Promise<ModelUsageSummaryData> {
  const events = await collect<ModelUsageSummaryEvent>(
    modelUsageSummary(createLibSwampContext(), deps, input),
  );
  const last = events[events.length - 1];
  if (last.kind !== "completed") {
    throw new Error(`expected completed, got ${JSON.stringify(last)}`);
  }
  return last.data;
}

Deno.test("modelUsageSummary: counts executions, failures and methods per model", async () => {
  const data = await summarize(makeDeps([
    candidate({
      id: "1",
      methodName: "old",
      startedAt: new Date("2026-01-10T00:00:00Z"),
    }),
    candidate({
      id: "2",
      status: "failed",
      startedAt: new Date("2026-01-12T00:00:00Z"),
    }),
    candidate({ id: "3", startedAt: new Date("2026-01-11T00:00:00Z") }),
    candidate({
      id: "4",
      definitionId: "def-b",
      startedAt: new Date("2026-01-09T00:00:00Z"),
    }),
  ]));

  assertEquals(data.totals, { executions: 4, failed: 1 });
  assertEquals(data.models.map((m) => m.modelName), ["a", "b"]);
  const [a, b] = data.models;
  assertEquals(a.definitionId, "def-a");
  assertEquals(a.type, TYPE.normalized);
  assertEquals(a.executions, 3);
  assertEquals(a.failed, 1);
  assertEquals(a.lastStartedAt, "2026-01-12T00:00:00.000Z");
  assertEquals(a.methods, ["run", "old"]);
  assertEquals(a.recent.map((o) => o.id), ["2", "3", "1"]);
  assertEquals(b.executions, 1);
});

Deno.test("modelUsageSummary: counts past the row search's old cap exactly", async () => {
  const count = 5_001 + 2_000;
  const data = await summarize(makeDeps(
    Array.from({ length: count }, (_, i) =>
      candidate({
        id: `out-${i}`,
        status: i % 7 === 0 ? "failed" : "succeeded",
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })),
  ));

  const failed = Math.ceil(count / 7);
  assertEquals(data.totals, { executions: count, failed });
  assertEquals(data.models[0].executions, count);
  assertEquals(data.models[0].failed, failed);
  assertEquals(data.models[0].recent.length, 20);
  assertEquals(data.models[0].recent[0].id, `out-${count - 1}`);
});

Deno.test("modelUsageSummary: since is inclusive and until is exclusive, as the output search reads them", async () => {
  const at = (id: string, iso: string) =>
    candidate({ id, startedAt: new Date(iso) });
  const data = await summarize(
    makeDeps([
      at("before", "2026-01-09T23:59:59Z"),
      at("at-since", "2026-01-10T00:00:00Z"),
      at("inside", "2026-01-11T00:00:00Z"),
      at("at-until", "2026-01-12T00:00:00Z"),
    ]),
    { since: "2026-01-10T00:00:00Z", until: "2026-01-12T00:00:00Z" },
  );

  assertEquals(data.since, "2026-01-10T00:00:00.000Z");
  assertEquals(data.until, "2026-01-12T00:00:00.000Z");
  assertEquals(data.totals.executions, 2);
  assertEquals(data.models[0].recent.map((o) => o.id), ["inside", "at-since"]);
});

Deno.test("modelUsageSummary: a since search reads only since the cutoff when it can", async () => {
  let cutoff: Date | undefined;
  let fullScans = 0;
  await summarize(
    makeDeps([], {
      findAllOutputsGlobal: () => {
        fullScans++;
        return Promise.resolve([]);
      },
      findAllOutputsGlobalSince: (since) => {
        cutoff = since;
        return Promise.resolve([]);
      },
    }),
    { since: "2026-01-10T00:00:00Z" },
  );
  assertEquals(cutoff, new Date("2026-01-10T00:00:00Z"));
  assertEquals(fullScans, 0);
});

Deno.test("modelUsageSummary: refuses a malformed bound", async () => {
  for (const input of [{ since: "whenever" }, { until: "whenever" }]) {
    const events = await collect<ModelUsageSummaryEvent>(
      modelUsageSummary(createLibSwampContext(), makeDeps([]), input),
    );
    assertEquals(events[events.length - 1].kind, "error");
  }
});

Deno.test("modelUsageSummary: outputs of a definition with no name count in totals but get no row", async () => {
  const data = await summarize(makeDeps([
    candidate({ id: "1" }),
    candidate({ id: "gone", definitionId: "def-deleted", status: "failed" }),
  ]));

  assertEquals(data.totals, { executions: 2, failed: 1 });
  assertEquals(data.models.map((m) => m.definitionId), ["def-a"]);
});

Deno.test("modelUsageSummary: outputs recorded under a type the definition no longer has keep a row", async () => {
  const oldType = { normalized: "test/old" };
  const asked: ModelUsageOutputGroup[] = [];
  const data = await summarize(
    makeDeps([candidate({ id: "new" }), candidate({ id: "old" }, oldType)], {
      isReadable: (group) => {
        asked.push(group);
        return Promise.resolve(true);
      },
    }),
  );

  assertEquals(
    data.models.map((m) => [m.definitionId, m.modelName, m.type]).sort(),
    [["def-a", "a", "test/model"], ["def-a", "a", "test/old"]],
  );
  assertEquals(data.totals.executions, 2);
  // Authorized on the name under its own type, as the output search is.
  assertEquals(
    asked.find((g) => g.type === "test/old")!.modelName,
    undefined,
  );
});

Deno.test("modelUsageSummary: a scan leaves out unread what canRead refuses, judged on the name its results would carry", async () => {
  const asked: unknown[] = [];
  let selection: readonly boolean[] | undefined;
  await summarize(
    makeDeps([], {
      findAllOutputsGlobal: async (selectReadable) => {
        selection = await selectReadable?.([
          { type: TYPE, definitionId: "def-a", methodName: "run" },
          { type: TYPE, definitionId: "def-b", methodName: "run" },
        ]);
        return [];
      },
      canRead: (candidates) => {
        asked.push(...candidates);
        return Promise.resolve(
          candidates.map((c) => c.definitionId === "def-a"),
        );
      },
    }),
  );

  assertEquals(selection, [true, false]);
  assertEquals(asked, [
    {
      definitionId: "def-a",
      modelName: "a",
      type: TYPE.normalized,
      methodName: "run",
    },
    {
      definitionId: "def-b",
      modelName: "b",
      type: TYPE.normalized,
      methodName: "run",
    },
  ]);
});

Deno.test("modelUsageSummary: an unreadable method reaches no count, method or recent list", async () => {
  const data = await summarize(
    makeDeps([
      candidate({
        id: "secret",
        methodName: "secret",
        status: "failed",
        startedAt: new Date("2026-01-12T00:00:00Z"),
      }),
      candidate({ id: "open", startedAt: new Date("2026-01-11T00:00:00Z") }),
      candidate({ id: "hidden", definitionId: "def-b", status: "failed" }),
    ], {
      isReadable: (group) =>
        Promise.resolve(
          group.methodName !== "secret" && group.definitionId !== "def-b",
        ),
    }),
  );

  assertEquals(data.totals, { executions: 1, failed: 0 });
  assertEquals(data.models.length, 1);
  assertEquals(data.models[0].methods, ["run"]);
  assertEquals(data.models[0].lastStartedAt, "2026-01-11T00:00:00.000Z");
  assertEquals(data.models[0].recent.map((o) => o.id), ["open"]);
});

Deno.test("modelUsageSummary: asks about each model and method once, with the name authorization needs", async () => {
  const asked: ModelUsageOutputGroup[] = [];
  await summarize(
    makeDeps([
      candidate({ id: "1" }),
      candidate({ id: "2" }),
      candidate({ id: "3", methodName: "other" }),
      candidate({ id: "4", definitionId: "def-deleted" }),
    ], {
      isReadable: (group) => {
        asked.push(group);
        return Promise.resolve(true);
      },
    }),
  );

  assertEquals(
    asked.map((g) => [g.definitionId, g.modelName, g.methodName, g.type]).sort(
      (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    [
      ["def-a", "a", "other", TYPE.normalized],
      ["def-a", "a", "run", TYPE.normalized],
      ["def-deleted", undefined, "run", TYPE.normalized],
    ],
  );
});

Deno.test("modelUsageSummary: the same definition id under two types makes two rows", async () => {
  const other = { normalized: "test/other" };
  const data = await summarize(
    makeDeps([candidate({ id: "1" }), candidate({ id: "2" }, other)], {
      findAllDefinitions: () =>
        Promise.resolve([
          { definition: { id: "def-a", name: "a" }, type: TYPE },
          { definition: { id: "def-a", name: "a" }, type: other },
        ]),
    }),
  );

  assertEquals(
    data.models.map((m) => [m.type, m.executions]).sort(),
    [["test/model", 1], ["test/other", 1]],
  );
});

Deno.test("modelUsageSummary: recentLimit is clamped, and zero keeps the counts", async () => {
  const many = Array.from({ length: 150 }, (_, i) =>
    candidate({
      id: String(i),
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }));
  const recentOf = async (recentLimit: number) =>
    (await summarize(makeDeps(many), { recentLimit })).models[0];

  assertEquals((await recentOf(5)).recent.length, 5);
  assertEquals((await recentOf(500)).recent.length, 100);
  assertEquals((await recentOf(-1)).recent.length, 0);
  const none = await recentOf(0);
  assertEquals(none.recent.length, 0);
  assertEquals(none.executions, 150);
});

Deno.test("modelUsageSummary: the newest outputs across methods make the recent list", async () => {
  const data = await summarize(
    makeDeps([
      candidate({
        id: "a-new",
        methodName: "a",
        startedAt: new Date("2026-01-12T00:00:00Z"),
      }),
      candidate({
        id: "a-old",
        methodName: "a",
        startedAt: new Date("2026-01-09T00:00:00Z"),
      }),
      candidate({
        id: "b-mid",
        methodName: "b",
        startedAt: new Date("2026-01-11T00:00:00Z"),
      }),
    ]),
    { recentLimit: 2 },
  );

  assertEquals(data.models[0].recent.map((o) => o.id), ["a-new", "b-mid"]);
  assertEquals(data.models[0].executions, 3);
});

Deno.test("modelUsageSummary: recent outputs carry provenance and workflow names from one lookup", async () => {
  const lookups: string[][] = [];
  const data = await summarize(
    makeDeps([
      candidate({
        id: "1",
        durationMs: 5,
        provenance: {
          triggeredBy: "workflow",
          workflowId: "wf-1",
          workflowRunId: "run-1",
          stepName: "step",
        },
      }),
      candidate({
        id: "2",
        definitionId: "def-b",
        provenance: {
          triggeredBy: "workflow",
          workflowId: "wf-1",
          workflowRunId: "run-2",
        },
      }),
      candidate({
        id: "3",
        definitionId: "def-b",
        provenance: { triggeredBy: "manual" },
      }),
    ], {
      resolveWorkflowNames: (ids) => {
        lookups.push([...ids]);
        return Promise.resolve(new Map([["wf-1", "nightly"]]));
      },
    }),
  );

  assertEquals(lookups, [["wf-1"]]);
  const recent = data.models.flatMap((m) => m.recent);
  const first = recent.find((o) => o.id === "1")!;
  assertEquals(first.durationMs, 5);
  assertEquals(first.triggeredBy, "workflow");
  assertEquals(first.workflowName, "nightly");
  assertEquals(first.workflowRunId, "run-1");
  assertEquals(first.stepName, "step");
  const manual = recent.find((o) => o.id === "3")!;
  assertEquals(manual.triggeredBy, "manual");
  assertEquals(manual.workflowId, undefined);
});

Deno.test("modelUsageSummary: an empty window is empty, without a definition scan", async () => {
  let scans = 0;
  const data = await summarize(makeDeps([], {
    findAllDefinitions: () => {
      scans++;
      return Promise.resolve([]);
    },
  }));

  assertEquals(data.totals, { executions: 0, failed: 0 });
  assertEquals(data.models, []);
  assertEquals(scans, 0);
});
