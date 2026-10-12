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
import { createLibSwampContext } from "../context.ts";
import {
  parseRunTimeBound,
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchEvent,
} from "./run_search.ts";

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

function makeDeps(
  overrides: Partial<WorkflowRunSearchDeps> = {},
): WorkflowRunSearchDeps {
  return {
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "deploy" },
        { id: "wf-2", name: "test" },
      ]),
    findAllRunsByWorkflowId: (id: string) => {
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
    },
    ...overrides,
  };
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

Deno.test("workflowRunSearch: filters by since", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "deploy" }]),
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
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "deploy" }]),
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
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "deploy" }]),
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
        {
          id: "wf-1",
          name: "deploy",
          inputs: {
            type: "object",
            properties: { authKey: { type: "string" } },
          },
        },
        { id: "wf-2", name: "test" },
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
