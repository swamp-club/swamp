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
import fc from "fast-check";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { RunIndexSnapshot } from "../../domain/workflows/run_index_snapshot.ts";
import type { WorkflowRunSummary } from "../../domain/workflows/workflow_run_summary.ts";
import {
  runStatusBucket,
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchEvent,
  type WorkflowRunSearchInput,
} from "./run_search.ts";
import {
  summarizeWorkflowRuns,
  workflowRunSummary,
  type WorkflowRunSummaryEvent,
  type WorkflowRunSummaryRun,
} from "./run_summary.ts";

// The run search and run summary read each workflow's run index snapshot
// and narrow it before building anything (swamp-club#3443). These
// properties hold them to the algorithm they replaced: build every run of
// every workflow, sort, then filter, authorize and page. The one change is
// the order of runs from different workflows that started at the same
// moment, which used to follow which workflow's read finished first and now
// follows the workflows' order; the oracle uses that order.

const START = Date.UTC(2026, 0, 1);
// Start times and bounds fall on a coarse grid, so runs often share a start
// time and bounds often fall exactly on one.
const SLOT = 1000;
const SLOTS = 12;
const WORKFLOWS = ["alpha", "beta", "gamma", "delta"];
const STATUSES = [
  "succeeded",
  "failed",
  "interrupted",
  "running",
  "pending",
  "suspended",
  "cancelled",
  "unheard-of",
];
const SOURCES = ["schedule", "API", "webhook"];

function uuidOf(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

interface Fixture {
  workflows: Array<{ id: string; name: string }>;
  runsOf: Map<string, WorkflowRunSummary[]>;
  allIds: string[];
}

const arbFixture: fc.Arbitrary<Fixture> = fc.array(
  fc.record({
    workflow: fc.integer({ min: 0, max: WORKFLOWS.length - 1 }),
    // Some runs keep a name the workflow had before a rename.
    renamed: fc.boolean(),
    status: fc.constantFrom(...STATUSES),
    startMs: fc.option(
      fc.integer({ min: 0, max: SLOTS }).map((n) => START + n * SLOT),
      {
        nil: undefined,
        freq: 6,
      },
    ),
    durationMs: fc.option(fc.integer({ min: 0, max: 5000 }), {
      nil: undefined,
    }),
    source: fc.option(fc.constantFrom(...SOURCES), { nil: undefined }),
    env: fc.constantFrom("prod", "dev"),
  }),
  { minLength: 5, maxLength: 60 },
).map((rows) => {
  const workflows = WORKFLOWS.map((name, i) => ({ id: `wf-${i}`, name }));
  const runsOf = new Map<string, WorkflowRunSummary[]>(
    workflows.map((w) => [w.id, []]),
  );
  const allIds: string[] = [];
  rows.forEach((row, i) => {
    const workflow = workflows[row.workflow];
    const id = uuidOf(i + 1);
    allIds.push(id);
    runsOf.get(workflow.id)!.push({
      id,
      workflowId: workflow.id,
      workflowName: row.renamed ? `${workflow.name}-old` : workflow.name,
      status: row.status,
      ...(row.startMs !== undefined
        ? { startedAt: new Date(row.startMs) }
        : {}),
      ...(row.startMs !== undefined && row.durationMs !== undefined
        ? { completedAt: new Date(row.startMs + row.durationMs) }
        : {}),
      tags: { env: row.env },
      inputs: { env: row.env },
      ...(row.source ? { triggerSource: row.source } : {}),
    });
  });
  return { workflows, runsOf, allIds };
});

/** A filter that is mostly left out, so most cases still match runs. */
function sometimes<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> {
  return fc.oneof(
    { arbitrary: fc.constant(undefined), weight: 3 },
    { arbitrary: arb, weight: 1 },
  );
}

const arbTime = sometimes(
  fc.integer({ min: -1, max: SLOTS + 1 }).map((n) =>
    new Date(START + n * SLOT).toISOString()
  ),
);
const arbName = fc.constantFrom(
  ...WORKFLOWS,
  ...WORKFLOWS.map((n) => `${n}-old`),
  "ALPHA",
  "nope",
);

interface SearchCase {
  input: WorkflowRunSearchInput;
  /** Recorded names the caller may not read. */
  hidden: string[];
  queryRun?: number;
}

const arbSearchCase: fc.Arbitrary<SearchCase> = fc.record({
  since: arbTime,
  until: arbTime,
  status: sometimes(fc.constantFrom(...STATUSES, "FAILED")),
  workflow: sometimes(arbName),
  workflows: sometimes(fc.array(arbName, { maxLength: 3 })),
  triggerSource: sometimes(fc.constantFrom(...SOURCES, "api")),
  statuses: sometimes(fc.array(fc.constantFrom(...STATUSES), { maxLength: 3 })),
  triggerSources: sometimes(
    fc.array(fc.constantFrom(...SOURCES), { maxLength: 2 }),
  ),
  tags: sometimes(fc.constantFrom({ env: "prod" }, { env: "dev" })),
  inputs: sometimes(fc.constantFrom({ env: "prod" })),
  query: sometimes(fc.constantFrom("al", "fail", "0000-4000", "zzz")),
  // Indexes the fixture's runs: a full run id as the query.
  queryRun: sometimes(fc.integer({ min: 0, max: 30 })),
  offset: sometimes(fc.integer({ min: 0, max: 20 })),
  limit: sometimes(fc.integer({ min: 1, max: 30 })),
  hidden: fc.array(arbName, { maxLength: 2 }),
}).map(({ hidden, queryRun, ...input }) => {
  const cleaned = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as WorkflowRunSearchInput;
  return { input: cleaned, hidden, queryRun };
});

function depsOf(fixture: Fixture, hidden: string[]): WorkflowRunSearchDeps {
  return {
    findAllWorkflows: () => Promise.resolve(fixture.workflows),
    runIndexOf: (id) =>
      Promise.resolve(
        RunIndexSnapshot.of(
          (fixture.runsOf.get(id) ?? []).map((r) => structuredClone(r)),
        ),
      ),
    isReadable: (_id, name) => Promise.resolve(!hidden.includes(name)),
  };
}

function statusMatches(status: string, filter: string): boolean {
  const actual = status.toLowerCase();
  if (actual === filter) return true;
  return (filter === "failed" || filter === "running") &&
    runStatusBucket(actual) === filter;
}

/** The old algorithm: every run sorted, then each filter in turn. */
function oracle(
  fixture: Fixture,
  input: WorkflowRunSearchInput,
  hidden: string[],
): WorkflowRunSummary[] {
  const key = (r: WorkflowRunSummary) => r.startedAt?.getTime() ?? 0;
  const stableDesc = (runs: WorkflowRunSummary[]) =>
    runs.map((r, i) => ({ r, i }))
      .sort((a, b) => key(b.r) - key(a.r) || a.i - b.i)
      .map(({ r }) => r);
  let runs = stableDesc(
    fixture.workflows.flatMap((w) => stableDesc(fixture.runsOf.get(w.id)!)),
  );
  const now = Date.now();
  const ms = (v: string) => Date.parse(v) || now;
  if (input.since) {
    const cutoff = ms(input.since);
    runs = runs.filter((r) => r.startedAt && r.startedAt.getTime() >= cutoff);
  }
  if (input.until) {
    const end = ms(input.until);
    runs = runs.filter((r) => r.startedAt && r.startedAt.getTime() < end);
  }
  if (input.status) {
    const s = input.status.toLowerCase();
    runs = runs.filter((r) => statusMatches(r.status, s));
  }
  if (input.workflow) {
    const n = input.workflow.toLowerCase();
    runs = runs.filter((r) => r.workflowName.toLowerCase() === n);
  }
  if (input.workflows && input.workflows.length > 0) {
    const names = new Set(input.workflows);
    runs = runs.filter((r) => names.has(r.workflowName));
  }
  if (input.triggerSource) {
    const t = input.triggerSource.toLowerCase();
    runs = runs.filter((r) => r.triggerSource?.toLowerCase() === t);
  }
  if (input.statuses && input.statuses.length > 0) {
    const wanted = input.statuses.map((s) => s.toLowerCase());
    runs = runs.filter((r) => wanted.some((s) => statusMatches(r.status, s)));
  }
  if (input.triggerSources && input.triggerSources.length > 0) {
    const wanted = new Set(input.triggerSources.map((s) => s.toLowerCase()));
    runs = runs.filter((r) =>
      r.triggerSource !== undefined &&
      wanted.has(r.triggerSource.toLowerCase())
    );
  }
  if (input.tags) {
    const entries = Object.entries(input.tags);
    runs = runs.filter((r) => entries.every(([k, v]) => r.tags[k] === v));
  }
  if (input.inputs) {
    const entries = Object.entries(input.inputs);
    runs = runs.filter((r) =>
      entries.every(([k, v]) => String(r.inputs[k]) === v)
    );
  }
  if (input.query) {
    const q = input.query.toLowerCase();
    runs = runs.filter((r) =>
      r.workflowName.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q)
    );
  }
  return runs.filter((r) => !hidden.includes(r.workflowName));
}

function withQueryRun(c: SearchCase, fixture: Fixture): WorkflowRunSearchInput {
  if (c.queryRun === undefined) return c.input;
  // A full run id, in upper case half the time; an id past the last run
  // names nothing.
  const id = fixture.allIds[c.queryRun] ?? uuidOf(10_000 + c.queryRun);
  return { ...c.input, query: c.queryRun % 2 ? id.toUpperCase() : id };
}

Deno.test("workflowRunSearch: results and total equal the old build-everything-then-filter algorithm", async () => {
  await fc.assert(
    fc.asyncProperty(arbFixture, arbSearchCase, async (fixture, c) => {
      const input = withQueryRun(c, fixture);
      const events = await collect<WorkflowRunSearchEvent>(
        workflowRunSearch(
          createLibSwampContext(),
          depsOf(fixture, c.hidden),
          input,
        ),
      );
      const completed = events.find((e) => e.kind === "completed") as Extract<
        WorkflowRunSearchEvent,
        { kind: "completed" }
      >;
      const expected = oracle(fixture, input, c.hidden);
      const offset = input.offset ?? 0;
      const page = expected.slice(
        offset,
        input.limit === undefined ? undefined : offset + input.limit,
      );
      assertEquals(completed.total, expected.length);
      assertEquals(
        completed.data.results.map((r) => r.runId),
        page.map((r) => r.id),
      );
      for (const [i, item] of completed.data.results.entries()) {
        const run = page[i];
        assertEquals(item.startedAt, run.startedAt?.toISOString());
        assertEquals(item.completedAt, run.completedAt?.toISOString());
        assertEquals(item.status, run.status);
        assertEquals(item.workflowName, run.workflowName);
        assertEquals(item.tags, run.tags);
        assertEquals(item.triggerSource, run.triggerSource);
      }
    }),
    { numRuns: 500 },
  );
});

Deno.test("workflowRunSummary: counts equal summarizing the old algorithm's runs", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbFixture,
      arbSearchCase,
      fc.boolean(),
      async (fixture, c, timeline) => {
        const input = {
          since: c.input.since,
          until: c.input.until,
          workflows: c.input.workflows,
          triggerSource: c.input.triggerSource,
          triggerSources: c.input.triggerSources,
          timeline,
          recentLimit: c.input.limit,
        };
        const events = await collect<WorkflowRunSummaryEvent>(
          workflowRunSummary(
            createLibSwampContext(),
            depsOf(fixture, c.hidden),
            input,
          ),
        );
        const completed = events.find((e) => e.kind === "completed") as
          | Extract<WorkflowRunSummaryEvent, { kind: "completed" }>
          | undefined;
        const kept = oracle(fixture, {
          since: input.since,
          until: input.until,
          workflows: input.workflows,
          triggerSource: input.triggerSource,
          triggerSources: input.triggerSources,
        }, c.hidden);
        const expected = summarizeWorkflowRuns(
          kept.map((r): WorkflowRunSummaryRun => {
            const start = r.startedAt?.getTime();
            const end = r.completedAt?.getTime();
            return {
              runId: r.id,
              workflowId: r.workflowId,
              workflowName: r.workflowName,
              status: r.status,
              startedAt: r.startedAt?.toISOString(),
              duration: start && end ? end - start : undefined,
              triggerSource: r.triggerSource,
            };
          }),
          {
            recentLimit: input.recentLimit,
            timeline,
            since: input.since && new Date(Date.parse(input.since))
              .toISOString(),
            until: input.until && new Date(Date.parse(input.until))
              .toISOString(),
          },
        );
        assertEquals(completed?.data, expected);
      },
    ),
    { numRuns: 500 },
  );
});
