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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { collect } from "../testing.ts";
import {
  FAKE_REAPED_CUTOFF,
  fakeWatermarks,
} from "../retention/reaped_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import {
  parseRunTimeBound,
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchEvent,
} from "./run_search.ts";
import { RunIndexSnapshot } from "../../domain/workflows/run_index_snapshot.ts";
import type { WorkflowRunSummary } from "../../domain/workflows/workflow_run_summary.ts";
import {
  findSpan,
  isChildOf,
  withCapturedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";

const now = Date.now();

function makeRun(overrides: {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt?: Date;
  completedAt?: Date;
  tags?: Record<string, string>;
  inputs?: Record<string, unknown>;
}) {
  return {
    id: overrides.id,
    workflowId: overrides.workflowId,
    workflowName: overrides.workflowName,
    status: overrides.status,
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    tags: overrides.tags ?? {},
    inputs: overrides.inputs ?? {},
  };
}

/**
 * Deps over fixed runs. `findAllRunsByWorkflowId` gives a workflow's runs,
 * which `runIndexOf` serves as that workflow's snapshot.
 */
function makeDeps(
  overrides: Partial<WorkflowRunSearchDeps> & {
    findAllRunsByWorkflowId?: (id: string) => Promise<WorkflowRunSummary[]>;
  } = {},
): WorkflowRunSearchDeps {
  const { findAllRunsByWorkflowId = defaultRuns, ...rest } = overrides;
  return {
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "deploy", declaresInputs: false },
        { id: "wf-2", name: "test", declaresInputs: false },
      ]),
    runIndexOf: async (id: string) =>
      RunIndexSnapshot.of(await findAllRunsByWorkflowId(id)),
    ...rest,
  };
}

function defaultRuns(id: string): Promise<WorkflowRunSummary[]> {
  if (id === "wf-1") {
    return Promise.resolve([
      makeRun({
        id: "run-1",
        workflowId: "wf-1",
        workflowName: "deploy",
        status: "succeeded",
        startedAt: new Date(now - 1000),
        completedAt: new Date(now),
      }),
      makeRun({
        id: "run-2",
        workflowId: "wf-1",
        workflowName: "deploy",
        status: "failed",
        startedAt: new Date(now - 5000),
        completedAt: new Date(now - 4000),
      }),
    ]);
  }
  if (id === "wf-2") {
    return Promise.resolve([
      makeRun({
        id: "run-3",
        workflowId: "wf-2",
        workflowName: "test",
        status: "succeeded",
        startedAt: new Date(now - 3000),
        completedAt: new Date(now - 2000),
      }),
    ]);
  }
  return Promise.resolve([]);
}

Deno.test("workflowRunSearch: returns all runs sorted by startedAt desc", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.results.length, 3);
  // Most recent first
  assertEquals(completed.data.results[0].runId, "run-1");
  assertEquals(completed.data.results[1].runId, "run-3");
  assertEquals(completed.data.results[2].runId, "run-2");
});

Deno.test("workflowRunSearch: filters by status", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { status: "failed" }),
  );

  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-2");
  assertEquals(completed.data.results[0].status, "failed");
});

Deno.test("workflowRunSearch: a bucket status filter matches the whole bucket", async () => {
  const runs = ["failed", "interrupted", "running", "pending", "succeeded"]
    .map((status, i) =>
      makeRun({
        id: `run-${status}`,
        workflowId: "wf-1",
        workflowName: "deploy",
        status,
        startedAt: new Date(now - (i + 1) * 1000),
      })
    );
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([{ id: "wf-1", name: "deploy", declaresInputs: false }]),
    findAllRunsByWorkflowId: () => Promise.resolve(runs),
  });
  const ids = async (status: string) => {
    const events = await collect<WorkflowRunSearchEvent>(
      workflowRunSearch(createLibSwampContext(), deps, { status }),
    );
    const completed = events[1] as Extract<
      WorkflowRunSearchEvent,
      { kind: "completed" }
    >;
    return completed.data.results.map((r) => r.runId);
  };

  assertEquals(await ids("failed"), ["run-failed", "run-interrupted"]);
  assertEquals(await ids("RUNNING"), ["run-running", "run-pending"]);
  // Any other status still matches exactly.
  assertEquals(await ids("interrupted"), ["run-interrupted"]);
  assertEquals(await ids("pending"), ["run-pending"]);
});

Deno.test("workflowRunSearch: filters by since", async () => {
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([{ id: "wf-1", name: "deploy", declaresInputs: false }]),
    findAllRunsByWorkflowId: () =>
      Promise.resolve([
        makeRun({
          id: "run-recent",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 1000),
        }),
        makeRun({
          id: "run-old",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        }),
      ]),
  });

  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { since: "1d" }),
  );

  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-recent");
});

Deno.test("workflowRunSearch: applies limit", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { limit: 2 }),
  );

  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 2);
});

Deno.test("workflowRunSearch: includes inputs in results", async () => {
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([{ id: "wf-1", name: "deploy", declaresInputs: false }]),
    findAllRunsByWorkflowId: () =>
      Promise.resolve([
        makeRun({
          id: "run-with-inputs",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 1000),
          inputs: { workItem: "PLT-1033", region: "us-east-1" },
        }),
        makeRun({
          id: "run-no-inputs",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 2000),
        }),
      ]),
  });

  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results[0].inputs, {
    workItem: "PLT-1033",
    region: "us-east-1",
  });
  assertEquals(completed.data.results[1].inputs, undefined);
});

Deno.test("workflowRunSearch: filters by inputs", async () => {
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([{ id: "wf-1", name: "deploy", declaresInputs: false }]),
    findAllRunsByWorkflowId: () =>
      Promise.resolve([
        makeRun({
          id: "run-plt-1033",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 1000),
          inputs: { workItem: "PLT-1033" },
        }),
        makeRun({
          id: "run-plt-1034",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 2000),
          inputs: { workItem: "PLT-1034" },
        }),
        makeRun({
          id: "run-no-inputs",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 3000),
        }),
      ]),
  });

  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {
      inputs: { workItem: "PLT-1033" },
    }),
  );

  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-plt-1033");
});

Deno.test("workflowRunSearch: surfaces awaitingResume and workflowHasInputs", async () => {
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "deploy", declaresInputs: true },
        { id: "wf-2", name: "test", declaresInputs: false },
      ]),
    findAllRunsByWorkflowId: (id: string) =>
      Promise.resolve(
        id === "wf-1"
          ? [{
            ...makeRun({
              id: "run-approved",
              workflowId: "wf-1",
              workflowName: "deploy",
              status: "suspended",
              startedAt: new Date(now - 1000),
            }),
            awaitingResume: true,
          }]
          : [makeRun({
            id: "run-gated",
            workflowId: "wf-2",
            workflowName: "test",
            status: "suspended",
            startedAt: new Date(now - 2000),
          })],
      ),
  });

  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {}),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind !== "completed") return;

  const approved = completed.data.results.find((r) =>
    r.runId === "run-approved"
  );
  assertEquals(approved?.awaitingResume, true);
  assertEquals(approved?.workflowHasInputs, true);

  const gated = completed.data.results.find((r) => r.runId === "run-gated");
  assertEquals(gated?.awaitingResume, undefined);
  assertEquals(gated?.workflowHasInputs, undefined);
});

// ── until / workflows / triggerSource filters ───────────────────────────

function completedRunIds(events: WorkflowRunSearchEvent[]): string[] {
  const completed = events.find((e) => e.kind === "completed") as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  return completed.data.results.map((r) => r.runId);
}

Deno.test("workflowRunSearch: until keeps runs started before an ISO time, exclusive", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), makeDeps(), {
      until: new Date(now - 3000).toISOString(),
    }),
  );
  // run-3 started exactly at the bound and is left out.
  assertEquals(completedRunIds(events), ["run-2"]);
});

Deno.test("workflowRunSearch: since accepts an ISO time as well as a duration", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), makeDeps(), {
      since: new Date(now - 3000).toISOString(),
    }),
  );
  assertEquals(completedRunIds(events), ["run-1", "run-3"]);
});

Deno.test("workflowRunSearch: since and until together bound a window", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), makeDeps(), {
      since: new Date(now - 5000).toISOString(),
      until: new Date(now - 1000).toISOString(),
    }),
  );
  assertEquals(completedRunIds(events), ["run-3", "run-2"]);
});

Deno.test("workflowRunSearch: with since, echoes it as ISO and the oldest match's start beyond the page", async () => {
  const since = new Date(now - 10_000).toISOString();
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), makeDeps(), {
      since,
      limit: 1,
    }),
  );
  const completed = events.find((e) => e.kind === "completed") as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.map((r) => r.runId), ["run-1"]);
  assertEquals(completed.total, 3);
  assertEquals(completed.since, since);
  // run-2, the oldest of the three matches, is not on the page.
  assertEquals(
    completed.oldestStartedAt,
    new Date(now - 5000).toISOString(),
  );
});

Deno.test("workflowRunSearch: without since, reports neither since nor the oldest start", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), makeDeps(), {}),
  );
  const completed = events.find((e) => e.kind === "completed") as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals("since" in completed, false);
  assertEquals("oldestStartedAt" in completed, false);
});

Deno.test("workflowRunSearch: with since and no match, reports since alone", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), makeDeps(), {
      since: new Date(now + 60_000).toISOString(),
    }),
  );
  const completed = events.find((e) => e.kind === "completed") as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.total, 0);
  assertEquals(typeof completed.since, "string");
  assertEquals("oldestStartedAt" in completed, false);
});

Deno.test("workflowRunSearch: workflows keeps runs of any listed workflow by exact name", async () => {
  const deps = makeDeps();
  const only = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { workflows: ["test"] }),
  );
  assertEquals(completedRunIds(only), ["run-3"]);

  const both = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {
      workflows: ["test", "deploy"],
    }),
  );
  assertEquals(completedRunIds(both), ["run-1", "run-3", "run-2"]);

  const caseDiffers = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { workflows: ["TEST"] }),
  );
  assertEquals(completedRunIds(caseDiffers), []);

  const empty = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { workflows: [] }),
  );
  assertEquals(completedRunIds(empty), ["run-1", "run-3", "run-2"]);
});

Deno.test("workflowRunSearch: triggerSource keeps runs with that source, ignoring case", async () => {
  const deps = makeDeps({
    findAllRunsByWorkflowId: (id: string) =>
      Promise.resolve(
        id === "wf-1"
          ? [
            {
              ...makeRun({
                id: "run-s",
                workflowId: "wf-1",
                workflowName: "deploy",
                status: "succeeded",
                startedAt: new Date(now - 1000),
              }),
              triggerSource: "schedule",
            },
            {
              ...makeRun({
                id: "run-a",
                workflowId: "wf-1",
                workflowName: "deploy",
                status: "succeeded",
                startedAt: new Date(now - 2000),
              }),
              triggerSource: "api",
            },
            makeRun({
              id: "run-none",
              workflowId: "wf-1",
              workflowName: "deploy",
              status: "succeeded",
              startedAt: new Date(now - 3000),
            }),
          ]
          : [],
      ),
  });
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {
      triggerSource: "Schedule",
    }),
  );
  assertEquals(completedRunIds(events), ["run-s"]);
});

function mixedRunsDeps() {
  const run = (
    id: string,
    status: string,
    triggerSource: string | undefined,
    ago: number,
  ) => ({
    ...makeRun({
      id,
      workflowId: "wf-1",
      workflowName: "deploy",
      status,
      startedAt: new Date(now - ago),
    }),
    ...(triggerSource ? { triggerSource } : {}),
  });
  return makeDeps({
    findAllRunsByWorkflowId: (id: string) =>
      Promise.resolve(
        id === "wf-1"
          ? [
            run("ok-sched", "succeeded", "schedule", 1000),
            run("fail-hook", "failed", "webhook", 2000),
            run("int-api", "interrupted", "api", 3000),
            run("run-cli", "running", "manual", 4000),
            run("ok-none", "succeeded", undefined, 5000),
          ]
          : [],
      ),
  });
}

Deno.test("workflowRunSearch: statuses keeps runs with any of them, by bucket", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), mixedRunsDeps(), {
      statuses: ["FAILED", "running"],
    }),
  );
  // "failed" also keeps interrupted runs.
  assertEquals(completedRunIds(events), ["fail-hook", "int-api", "run-cli"]);
});

Deno.test("workflowRunSearch: triggerSources keeps runs with any of them", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), mixedRunsDeps(), {
      triggerSources: ["Schedule", "webhook"],
    }),
  );
  assertEquals(completedRunIds(events), ["ok-sched", "fail-hook"]);
});

Deno.test("workflowRunSearch: list filters combine with AND", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), mixedRunsDeps(), {
      statuses: ["succeeded", "failed"],
      triggerSources: ["webhook", "api"],
    }),
  );
  assertEquals(completedRunIds(events), ["fail-hook", "int-api"]);
});

Deno.test("workflowRunSearch: empty lists filter nothing", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), mixedRunsDeps(), {
      statuses: [],
      triggerSources: [],
    }),
  );
  assertEquals(completedRunIds(events).length, 5);
});

Deno.test("workflowRunSearch: new filters left out change nothing", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), makeDeps(), {
      until: undefined,
      workflows: undefined,
      triggerSource: undefined,
    }),
  );
  assertEquals(completedRunIds(events), ["run-1", "run-3", "run-2"]);
});

Deno.test("parseRunTimeBound: reads durations back from now and ISO times, and rejects anything else", () => {
  const at = Date.UTC(2026, 9, 12, 12, 0, 0);
  assertEquals(parseRunTimeBound("1h", at), at - 60 * 60 * 1000);
  assertEquals(
    parseRunTimeBound("2026-10-01T00:00:00Z", at),
    Date.UTC(2026, 9, 1),
  );
  for (const bad of ["soon", "", "12345", "yesterday", "2026-13-45"]) {
    assertThrows(() => parseRunTimeBound(bad, at), UserError);
  }
});

Deno.test("workflowRunSearch: a fractional offset and limit cut the page as slice does", async () => {
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), makeDeps(), {
      offset: 1.5,
      limit: 2,
    }),
  );
  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  // Newest first: run-1, run-3, run-2; slice(1.5, 3.5) is slice(1, 3).
  assertEquals(completed.data.results.map((r) => r.runId), ["run-3", "run-2"]);
  assertEquals(completed.total, 3);
});

Deno.test("workflowRunSearch: the completed data says where retention reaped runs", async () => {
  const deps = makeDeps({
    retentionWatermarks: fakeWatermarks(["workflowRuns"]),
  });
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {}),
  );
  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.reapedBefore, {
    cutoff: FAKE_REAPED_CUTOFF,
    retention: "14d",
  });
});

Deno.test("workflowRunSearch: no reaped marker without a runs watermark", async () => {
  const deps = makeDeps({ retentionWatermarks: fakeWatermarks(["data"]) });
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {}),
  );
  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals("reapedBefore" in completed.data, false);
});

Deno.test("workflowRunSearch: records the run selection as a child span with its counts", async () => {
  // "test" is refused: its one run is scanned but not matched.
  const deps = makeDeps({
    isReadable: (_id, name) => Promise.resolve(name !== "test"),
  });
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowRunSearchEvent>(
      workflowRunSearch(createLibSwampContext(), deps, {}),
    );
    const search = findSpan(spans, "swamp.workflow.run_search");
    const selection = findSpan(spans, "swamp.workflow.run_selection");
    assertEquals(isChildOf(selection, search), true);
    assertEquals(selection.attributes["workflow_runs.workflows"], 2);
    assertEquals(selection.attributes["workflow_runs.workflows_denied"], 1);
    assertEquals(selection.attributes["workflow_runs.scanned"], 3);
    assertEquals(selection.attributes["workflow_runs.matched"], 2);
  });
});

Deno.test("workflowRunSearch: records the page size, limit and query on the span", async () => {
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowRunSearchEvent>(
      workflowRunSearch(createLibSwampContext(), makeDeps(), {
        query: "deploy",
        limit: 1,
      }),
    );
    const search = findSpan(spans, "swamp.workflow.run_search");
    assertEquals(search.attributes["search.query"], "deploy");
    assertEquals(search.attributes["workflow_runs.returned"], 1);
    assertEquals(search.attributes["workflow_runs.limit"], 1);
  });
});

Deno.test("workflowRunSearch: records no query or limit on the span when none is given", async () => {
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowRunSearchEvent>(
      workflowRunSearch(createLibSwampContext(), makeDeps(), {}),
    );
    const search = findSpan(spans, "swamp.workflow.run_search");
    assertEquals(search.attributes["search.query"], undefined);
    assertEquals(search.attributes["workflow_runs.limit"], undefined);
    assertEquals(search.attributes["workflow_runs.returned"], 3);
  });
});

Deno.test("workflowRunSearch: records a long query on the span cut to 256 characters", async () => {
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowRunSearchEvent>(
      workflowRunSearch(createLibSwampContext(), makeDeps(), {
        query: "q".repeat(300),
      }),
    );
    const search = findSpan(spans, "swamp.workflow.run_search");
    assertEquals(search.attributes["search.query"], "q".repeat(256));
    assertEquals(search.attributes["workflow_runs.returned"], 0);
  });
});
