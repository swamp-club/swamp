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

import { UnreadableRunRecordError } from "../../domain/workflows/unreadable_run_record.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import {
  FAKE_REAPED_CUTOFF,
  fakeWatermarks,
} from "../retention/reaped_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowHistorySearch,
  type WorkflowHistorySearchDeps,
  type WorkflowHistorySearchEvent,
} from "./history_search.ts";

const now = Date.now();

function makeDeps(
  overrides: Partial<WorkflowHistorySearchDeps> = {},
): WorkflowHistorySearchDeps {
  return {
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "deploy" },
        { id: "wf-2", name: "test" },
      ]),
    findAllRunsByWorkflowId: (id: string) => {
      if (id === "wf-1") {
        return Promise.resolve([
          {
            id: "run-1",
            workflowId: "wf-1",
            workflowName: "deploy",
            status: "succeeded",
            startedAt: new Date(now - 1000),
            completedAt: new Date(now),
            tags: {},
            inputs: {},
          },
        ]);
      }
      if (id === "wf-2") {
        return Promise.resolve([
          {
            id: "run-2",
            workflowId: "wf-2",
            workflowName: "test",
            status: "failed",
            startedAt: new Date(now - 3000),
            completedAt: new Date(now - 2000),
            tags: {},
            inputs: {},
          },
        ]);
      }
      return Promise.resolve([]);
    },
    runInputsOf: () => Promise.resolve(undefined),
    ...overrides,
  };
}

Deno.test("workflowHistorySearch: returns all runs sorted by startedAt desc", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].runId, "run-1");
  assertEquals(completed.data.results[1].runId, "run-2");
});

Deno.test("workflowHistorySearch: includes inputs in results", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "deploy" }]),
    findAllRunsByWorkflowId: () =>
      Promise.resolve([
        {
          id: "run-with-inputs",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 1000),
          completedAt: new Date(now),
          tags: {},
          inputs: { workItem: "PLT-1033" },
        },
      ]),
  });

  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results[0].inputs, { workItem: "PLT-1033" });
});

Deno.test("workflowHistorySearch: filters by inputs", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "deploy" }]),
    findAllRunsByWorkflowId: () =>
      Promise.resolve([
        {
          id: "run-match",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 1000),
          completedAt: new Date(now),
          tags: {},
          inputs: { workItem: "PLT-1033" },
        },
        {
          id: "run-no-match",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 2000),
          completedAt: new Date(now - 1000),
          tags: {},
          inputs: { workItem: "PLT-1034" },
        },
      ]),
  });

  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      inputs: { workItem: "PLT-1033" },
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-match");
});

Deno.test("workflowHistorySearch: filters by workflow name", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      workflow: "deploy",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].workflowName, "deploy");
});

Deno.test("workflowHistorySearch: workflow filter is case-insensitive", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      workflow: "DEPLOY",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].workflowName, "deploy");
});

Deno.test("workflowHistorySearch: workflow filter combined with inputs filter", async () => {
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "deploy" },
        { id: "wf-2", name: "test" },
      ]),
    findAllRunsByWorkflowId: (id: string) => {
      if (id === "wf-1") {
        return Promise.resolve([
          {
            id: "run-match",
            workflowId: "wf-1",
            workflowName: "deploy",
            status: "succeeded",
            startedAt: new Date(now - 1000),
            completedAt: new Date(now),
            tags: {},
            inputs: { env: "prod" },
          },
          {
            id: "run-no-input-match",
            workflowId: "wf-1",
            workflowName: "deploy",
            status: "succeeded",
            startedAt: new Date(now - 2000),
            completedAt: new Date(now - 1000),
            tags: {},
            inputs: { env: "staging" },
          },
        ]);
      }
      if (id === "wf-2") {
        return Promise.resolve([
          {
            id: "run-wrong-workflow",
            workflowId: "wf-2",
            workflowName: "test",
            status: "succeeded",
            startedAt: new Date(now - 500),
            completedAt: new Date(now),
            tags: {},
            inputs: { env: "prod" },
          },
        ]);
      }
      return Promise.resolve([]);
    },
  });

  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      workflow: "deploy",
      inputs: { env: "prod" },
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-match");
});

Deno.test("workflowHistorySearch: workflow filter with no matches returns empty", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      workflow: "nonexistent",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});

Deno.test("workflowHistorySearch: returns empty results when no runs exist", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "deploy" }]),
    findAllRunsByWorkflowId: () => Promise.resolve([]),
  });
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, { query: "foo" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "foo");
  assertEquals(completed.data.results.length, 0);
});

function makeDepsWithInputs(): WorkflowHistorySearchDeps {
  return {
    runInputsOf: () => Promise.resolve(undefined),
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "verify-reviews" },
      ]),
    findAllRunsByWorkflowId: () =>
      Promise.resolve([
        {
          id: "run-a",
          workflowId: "wf-1",
          workflowName: "verify-reviews",
          status: "succeeded",
          startedAt: new Date(now - 1000),
          completedAt: new Date(now),
          tags: { env: "ci" },
          inputs: { commit: "abc123", branch: "main" },
        },
        {
          id: "run-b",
          workflowId: "wf-1",
          workflowName: "verify-reviews",
          status: "failed",
          startedAt: new Date(now - 3000),
          completedAt: new Date(now - 2000),
          tags: { env: "ci" },
          inputs: { commit: "def456", branch: "feature/foo" },
        },
      ]),
  };
}

Deno.test("workflowHistorySearch: filter by inputs.commit", async () => {
  const deps = makeDepsWithInputs();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      filter: 'inputs.commit == "abc123"',
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-a");
});

Deno.test("workflowHistorySearch: filter by status", async () => {
  const deps = makeDepsWithInputs();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      filter: 'status == "failed"',
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-b");
});

Deno.test("workflowHistorySearch: filter combined with workflow name", async () => {
  const deps = makeDepsWithInputs();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      workflow: "verify-reviews",
      filter: 'inputs.branch == "main"',
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-a");
});

Deno.test("workflowHistorySearch: filter with no matches returns empty", async () => {
  const deps = makeDepsWithInputs();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      filter: 'inputs.commit == "nonexistent"',
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});

Deno.test("workflowHistorySearch: filter with compound expression", async () => {
  const deps = makeDepsWithInputs();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      filter: 'status == "succeeded" && tags.env == "ci"',
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-a");
});

Deno.test("workflowHistorySearch: filter handles runs with missing input keys", async () => {
  const deps: WorkflowHistorySearchDeps = {
    runInputsOf: () => Promise.resolve(undefined),
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "verify" }]),
    findAllRunsByWorkflowId: () =>
      Promise.resolve([
        {
          id: "run-with-commit",
          workflowId: "wf-1",
          workflowName: "verify",
          status: "succeeded",
          startedAt: new Date(now - 1000),
          completedAt: new Date(now),
          tags: {},
          inputs: { commit: "abc123", branch: "main" },
        },
        {
          id: "run-without-commit",
          workflowId: "wf-1",
          workflowName: "verify",
          status: "succeeded",
          startedAt: new Date(now - 2000),
          completedAt: new Date(now - 1000),
          tags: {},
          inputs: { branch: "feature/x" },
        },
      ]),
  };

  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      filter: 'inputs.commit == "abc123"',
    }),
  );

  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-with-commit");
});

Deno.test("workflowHistorySearch: invalid filter yields error event", async () => {
  const deps = makeDepsWithInputs();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {
      filter: "status ==",
    }),
  );

  assertEquals(events.length, 2);
  const errorEvent = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "error" }
  >;
  assertEquals(errorEvent.kind, "error");
  assertStringIncludes(errorEvent.error.message, "Invalid --filter expression");
});

Deno.test("workflowHistorySearch: the completed data says where retention reaped runs", async () => {
  const deps = makeDeps({
    retentionWatermarks: fakeWatermarks(["workflowRuns"]),
  });
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {}),
  );
  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.reapedBefore, {
    cutoff: FAKE_REAPED_CUTOFF,
    retention: "14d",
  });
});

Deno.test("workflowHistorySearch: no reaped marker without a runs watermark", async () => {
  const deps = makeDeps({ retentionWatermarks: fakeWatermarks(["data"]) });
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {}),
  );
  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals("reapedBefore" in completed.data, false);
});

function makeDepsOmitting(): {
  deps: WorkflowHistorySearchDeps;
  calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  const recorded: Record<string, Record<string, unknown>> = {
    "run-a": { commit: "abc123", body: "deploy the fleet" },
    "run-b": { commit: "def456", body: "hold" },
  };
  return {
    calls,
    deps: {
      findAllWorkflows: () =>
        Promise.resolve([{ id: "wf-1", name: "webhook" }]),
      findAllRunsByWorkflowId: () =>
        Promise.resolve([
          {
            id: "run-a",
            workflowId: "recorded-elsewhere",
            workflowName: "webhook",
            status: "succeeded",
            startedAt: new Date(now - 1000),
            tags: {},
            inputs: { commit: "abc123" },
            inputsOmitted: ["body"],
          },
          {
            id: "run-b",
            workflowId: "wf-1",
            workflowName: "webhook",
            status: "succeeded",
            startedAt: new Date(now - 2000),
            tags: {},
            inputs: { commit: "def456" },
            inputsOmitted: ["body"],
          },
        ]),
      runInputsOf: (workflowId, runId) => {
        calls.push([workflowId, runId]);
        return Promise.resolve(recorded[runId]);
      },
    },
  };
}

async function historyResults(
  deps: WorkflowHistorySearchDeps,
  input: Parameters<typeof workflowHistorySearch>[2],
) {
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, input),
  );
  const completed = events[events.length - 1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  return completed.data.results;
}

Deno.test("workflowHistorySearch: rows carry the listed inputs and the keys left out", async () => {
  const { deps, calls } = makeDepsOmitting();
  const results = await historyResults(deps, {});

  assertEquals(results[0].inputs, { commit: "abc123" });
  assertEquals(results[0].inputsOmitted, ["body"]);
  assertEquals(calls, []);
});

Deno.test("workflowHistorySearch: an --input filter on an omitted key reads the record under the listing workflow", async () => {
  const { deps, calls } = makeDepsOmitting();
  const results = await historyResults(deps, {
    inputs: { body: "deploy the fleet" },
  });

  assertEquals(results.map((r) => r.runId), ["run-a"]);
  assertEquals(calls.sort(), [["wf-1", "run-a"], ["wf-1", "run-b"]]);
  assertEquals(results[0].inputs, { commit: "abc123" });
});

Deno.test("workflowHistorySearch: a --filter on inputs evaluates the values only the record holds", async () => {
  const { deps } = makeDepsOmitting();
  const results = await historyResults(deps, {
    filter: 'inputs.body.contains("fleet")',
  });

  assertEquals(results.map((r) => r.runId), ["run-a"]);
});

Deno.test("workflowHistorySearch: a --filter that cannot read inputs, or an --input on a kept key, reads no record", async () => {
  const { deps, calls } = makeDepsOmitting();
  assertEquals(
    (await historyResults(deps, { filter: 'status == "succeeded"' })).length,
    2,
  );
  assertEquals(
    (await historyResults(deps, { inputs: { commit: "def456" } })).map((r) =>
      r.runId
    ),
    ["run-b"],
  );
  assertEquals(calls, []);
});

Deno.test("workflowHistorySearch: a run the caller may not read never has its record read", async () => {
  const { deps, calls } = makeDepsOmitting();
  const results = await historyResults(
    { ...deps, isReadable: () => Promise.resolve(false) },
    { inputs: { body: "deploy the fleet" } },
  );

  assertEquals(results, []);
  assertEquals(calls, []);
});

Deno.test("workflowHistorySearch: a workflow with an unreadable record is left out, and the others are still listed", async () => {
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "deploy" },
        { id: "wf-2", name: "test" },
      ]),
    findAllRunsByWorkflowId: (id: string) =>
      id === "wf-1"
        ? Promise.reject(
          new UnreadableRunRecordError("run-1", "/runs/r.yaml", "cut short"),
        )
        : Promise.resolve([{
          id: "run-2",
          workflowId: "wf-2",
          workflowName: "test",
          status: "succeeded",
          startedAt: new Date(),
          completedAt: new Date(),
          tags: {},
          inputs: {},
        }]),
  });

  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {}),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") throw new Error("not completed");
  assertEquals(completed.data.results.map((r) => r.runId), ["run-2"]);
  assertEquals(completed.data.skippedWorkflows, [{
    workflowId: "wf-1",
    workflowName: "deploy",
    runId: "run-1",
    reason: "cut short",
  }]);

  const narrowed = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, { workflow: "test" }),
  );
  const other = narrowed.find((e) => e.kind === "completed");
  if (other?.kind !== "completed") throw new Error("not completed");
  assertEquals(other.data.skippedWorkflows, undefined);
});
