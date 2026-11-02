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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { parseDuration } from "../data/search.ts";
import { UserError } from "../../domain/errors.ts";
import type {
  RunIndexRun,
  RunIndexSnapshot,
} from "../../domain/workflows/run_index_snapshot.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import type { WorkflowListing } from "../../domain/workflows/workflow_listing.ts";

import { findReapedBefore, type ReapedBefore } from "../retention/reaped.ts";
import type { RetentionWatermarkRepository } from "../../domain/retention/retention_watermark.ts";
import {
  setActiveSpanAttributes,
  type Span,
  withGeneratorSpan,
  withSpan,
} from "../../infrastructure/tracing/mod.ts";
import { collectBounded, RUN_FANOUT_CONCURRENCY } from "./run_fanout.ts";
export interface WorkflowRunSearchItem {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  tags?: Record<string, string>;
  inputs?: Record<string, unknown>;
  /** inputs too large to list: only the run's record holds their values */
  inputsOmitted?: string[];
  instanceId?: string;
  triggerSource?: string;
  failedStep?: string;
  failureReason?: string;
  stepProgress?: { completed: number; total: number };
  /**
   * Suspended with every approval gate decided and every nested run it waits
   * on finished: it needs a resume.
   */
  awaitingResume?: boolean;
  workflowHasInputs?: boolean;
  parentRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
  };
  nestedWaits?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    status?: string;
  }[];
}

export interface WorkflowRunSearchData {
  query: string;
  results: WorkflowRunSearchItem[];
  /**
   * set when retention has reaped runs older than `cutoff`, so the listing
   * cannot show them
   */
  reapedBefore?: ReapedBefore;
}

export type WorkflowRunSearchEvent =
  | { kind: "resolving" }
  | {
    kind: "completed";
    data: WorkflowRunSearchData;
    total: number;
    since?: string;
    /**
     * With `since`: the start time of the oldest of the `total` matches,
     * absent when nothing matched. On the same clock as `since`, so the gap
     * between them is how long until that run leaves a moving window.
     */
    oldestStartedAt?: string;
  }
  | { kind: "error"; error: SwampError };

export interface WorkflowRunSearchDeps {
  findAllWorkflows(): Promise<readonly WorkflowListing[]>;
  runIndexOf(workflowId: string): Promise<RunIndexSnapshot>;
  /**
   * Whether the caller may read runs recorded under this workflow id and
   * name. Asked once per distinct pair. Without it every run is readable.
   */
  isReadable?(workflowId: string, workflowName: string): Promise<boolean>;
  /**
   * the persisted inputs of a run the search has already listed, read from its
   * record when an --input filter names a key the index omits; workflowId is
   * the workflow whose runs listed it, never the id the index entry records.
   * Undefined for a run whose record is gone
   */
  runInputsOf(
    workflowId: string,
    runId: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined>;
  /**
   * where retention records how far it has reaped; with it the listing says
   * older runs have been reaped
   */
  retentionWatermarks?: RetentionWatermarkRepository;
}

type RunSelectionDeps =
  & Pick<WorkflowRunSearchDeps, "runIndexOf" | "isReadable">
  & Partial<Pick<WorkflowRunSearchDeps, "runInputsOf">>;

export interface WorkflowRunSearchInput {
  query?: string;
  since?: string;
  until?: string;
  /**
   * Keeps runs with this status, ignoring case. `failed` also keeps
   * interrupted runs and `running` also keeps pending ones, matching the run
   * summary's counts.
   */
  status?: string;
  workflow?: string;
  workflows?: string[];
  triggerSource?: string;
  statuses?: string[];
  triggerSources?: string[];
  tags?: Record<string, string>;
  inputs?: Record<string, string>;
  offset?: number;
  limit?: number;
}

export function parseRunTimeBound(value: string, now: number): number {
  if (/^\d+(mo|y|h|m|d|w)$/.test(value)) return now - parseDuration(value);
  const ms = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) {
    throw new UserError(
      `Invalid time: "${value}". Expected a duration like 1h, 7d, 1mo or an ISO timestamp`,
    );
  }
  return ms;
}

export type RunStatusBucket =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "running"
  | "suspended";

/**
 * The bucket a run status counts in, or undefined for a status this
 * version does not know. `interrupted` (a run that ended without settling)
 * counts as failed; `pending` (accepted, not yet started) as running.
 */
export function runStatusBucket(status: string): RunStatusBucket | undefined {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
    case "pending":
      return "running";
    case "suspended":
      return "suspended";
    default:
      return undefined;
  }
}

function runStatusMatches(status: string, filter: string): boolean {
  const actual = status.toLowerCase();
  if (actual === filter) return true;
  return (filter === "failed" || filter === "running") &&
    runStatusBucket(actual) === filter;
}

export interface WorkflowRunFilter {
  sinceMs?: number;
  untilMs?: number;
  status?: string;
  workflow?: string;
  workflows?: string[];
  triggerSource?: string;
  statuses?: string[];
  triggerSources?: string[];
  tags?: Record<string, string>;
  inputs?: Record<string, string>;
  query?: string;
}

export interface SelectedWorkflowRuns {
  workflowId: string;
  snapshot: RunIndexSnapshot;
  runs: RunIndexRun[];
}

export interface WorkflowRunSelection {
  groups: SelectedWorkflowRuns[];
  snapshots: ReadonlyMap<string, RunIndexSnapshot>;
  total: number;
}

function runPredicate(
  filter: WorkflowRunFilter,
): (run: RunIndexRun) => boolean {
  const checks: Array<(run: RunIndexRun) => boolean> = [];
  const { sinceMs, untilMs } = filter;
  if (sinceMs !== undefined || untilMs !== undefined) {
    checks.push((run) =>
      run.startMs !== undefined &&
      (sinceMs === undefined || run.startMs >= sinceMs) &&
      (untilMs === undefined || run.startMs < untilMs)
    );
  }
  if (filter.status) {
    const status = filter.status.toLowerCase();
    checks.push((run) => runStatusMatches(run.summary.status, status));
  }
  if (filter.workflow) {
    const name = filter.workflow.toLowerCase();
    checks.push((run) => run.summary.workflowName.toLowerCase() === name);
  }
  if (filter.workflows && filter.workflows.length > 0) {
    const names = new Set(filter.workflows);
    checks.push((run) => names.has(run.summary.workflowName));
  }
  if (filter.triggerSource) {
    const source = filter.triggerSource.toLowerCase();
    checks.push((run) => run.summary.triggerSource?.toLowerCase() === source);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    const wanted = filter.statuses.map((s) => s.toLowerCase());
    checks.push((run) =>
      wanted.some((s) => runStatusMatches(run.summary.status, s))
    );
  }
  if (filter.triggerSources && filter.triggerSources.length > 0) {
    const wanted = new Set(filter.triggerSources.map((s) => s.toLowerCase()));
    checks.push((run) =>
      run.summary.triggerSource !== undefined &&
      wanted.has(run.summary.triggerSource.toLowerCase())
    );
  }
  if (filter.tags) {
    const entries = Object.entries(filter.tags);
    checks.push((run) =>
      entries.every(([k, v]) => run.summary.tags?.[k] === v)
    );
  }
  if (filter.inputs) {
    const entries = Object.entries(filter.inputs);
    // An omitted key is decided from the record once the cheap checks pass.
    checks.push((run) =>
      entries.every(([k, v]) =>
        run.summary.inputsOmitted?.includes(k) ||
        String(run.summary.inputs?.[k]) === v
      )
    );
  }
  if (filter.query) {
    const q = filter.query.toLowerCase();
    checks.push((run) =>
      run.summary.workflowName.toLowerCase().includes(q) ||
      run.summary.id.toLowerCase().includes(q) ||
      run.summary.status.toLowerCase().includes(q)
    );
  }
  return (run) => checks.every((check) => check(run));
}

function cannotMatch(
  snapshot: RunIndexSnapshot,
  filter: WorkflowRunFilter,
): boolean {
  if (snapshot.size === 0) return true;
  const names = [...snapshot.recordedNames];
  if (filter.workflow) {
    const name = filter.workflow.toLowerCase();
    if (!names.some((n) => n.toLowerCase() === name)) return true;
  }
  if (filter.workflows && filter.workflows.length > 0) {
    const wanted = new Set(filter.workflows);
    if (!names.some((n) => wanted.has(n))) return true;
  }
  if (filter.sinceMs !== undefined || filter.untilMs !== undefined) {
    const newest = snapshot.newestStartMs;
    if (newest === undefined) return true;
    if (filter.sinceMs !== undefined && newest < filter.sinceMs) return true;
  }
  return false;
}

/**
 * a full run id finds its run directly unless a recorded name or status could
 * also contain it; any other filter reads the time window
 */
function candidates(
  snapshot: RunIndexSnapshot,
  filter: WorkflowRunFilter,
): readonly RunIndexRun[] {
  const q = filter.query?.toLowerCase();
  // Run ids are UUIDs, so a full one is contained only in its own run's id.
  if (
    q && isUuid(q) &&
    ![...snapshot.recordedNames].some((n) => n.toLowerCase().includes(q)) &&
    ![...snapshot.distinctStatuses].some((s) => s.toLowerCase().includes(q))
  ) {
    const run = snapshot.get(q);
    return run ? [run] : [];
  }
  return snapshot.between(filter.sinceMs, filter.untilMs);
}

/**
 * each workflow's runs come from its run index snapshot, narrowed by name and
 * time before any run is looked at, so cost follows the runs in the window, not
 * the whole history
 */
export function selectWorkflowRuns(
  deps: RunSelectionDeps,
  workflows: ReadonlyArray<{ id: string }>,
  filter: WorkflowRunFilter,
): Promise<WorkflowRunSelection> {
  return withSpan(
    "swamp.workflow.run_selection",
    { "workflow_runs.workflows": workflows.length },
    (span) => selectRuns(deps, workflows, filter, span),
  );
}

/**
 * reads the record only of a run that already passed every other check and
 * the readability check, and compares, never returns, what it holds
 */
async function confirmOmittedInputs(
  deps: RunSelectionDeps,
  workflowId: string,
  runs: RunIndexRun[],
  wanted: Readonly<Record<string, string>>,
): Promise<RunIndexRun[]> {
  const entries = Object.entries(wanted);
  const unsure = runs.filter((run) =>
    entries.some(([key]) => run.summary.inputsOmitted?.includes(key))
  );
  if (unsure.length === 0) return runs;
  const runInputsOf = deps.runInputsOf;
  if (!runInputsOf) {
    throw new Error("An --input filter on an omitted input needs runInputsOf");
  }
  const confirmed = new Set(
    await collectBounded(unsure, RUN_FANOUT_CONCURRENCY, async (run) => {
      const inputs = await runInputsOf(workflowId, run.summary.id);
      return inputs !== undefined &&
          entries.every(([k, v]) => String(inputs[k]) === v)
        ? [run]
        : [];
    }),
  );
  const decided = new Set(unsure);
  return runs.filter((run) => !decided.has(run) || confirmed.has(run));
}

async function selectRuns(
  deps: RunSelectionDeps,
  workflows: ReadonlyArray<{ id: string }>,
  filter: WorkflowRunFilter,
  span: Span,
): Promise<WorkflowRunSelection> {
  const loaded = await collectBounded(
    workflows,
    RUN_FANOUT_CONCURRENCY,
    async (workflow) => [{
      workflowId: workflow.id,
      snapshot: await deps.runIndexOf(workflow.id),
    }],
  );
  const snapshots = new Map(loaded.map((l) => [l.workflowId, l.snapshot]));

  const matches = runPredicate(filter);
  const readable = new Map<string, boolean>();
  const groups: SelectedWorkflowRuns[] = [];
  let total = 0;
  let scanned = 0;
  let denied = 0;
  for (const workflow of workflows) {
    const snapshot = snapshots.get(workflow.id);
    if (!snapshot || cannotMatch(snapshot, filter)) continue;
    const tested = candidates(snapshot, filter);
    scanned += tested.length;
    let runs = tested.filter(matches);
    if (runs.length === 0) continue;

    if (deps.isReadable) {
      const pairs = new Map<string, [string, string]>();
      for (const run of runs) {
        const pair: [string, string] = [
          run.summary.workflowId,
          run.summary.workflowName,
        ];
        pairs.set(JSON.stringify(pair), pair);
      }
      for (const [key, [id, name]] of pairs) {
        if (!readable.has(key)) {
          const allowed = await deps.isReadable(id, name);
          readable.set(key, allowed);
          if (!allowed) denied++;
        }
      }
      runs = runs.filter((run) =>
        readable.get(
          JSON.stringify([run.summary.workflowId, run.summary.workflowName]),
        )
      );
      if (runs.length === 0) continue;
    }
    if (filter.inputs) {
      runs = await confirmOmittedInputs(
        deps,
        workflow.id,
        runs,
        filter.inputs,
      );
      if (runs.length === 0) continue;
    }
    groups.push({ workflowId: workflow.id, snapshot, runs });
    total += runs.length;
  }
  span.setAttributes({
    "workflow_runs.workflows_denied": denied,
    "workflow_runs.scanned": scanned,
    "workflow_runs.matched": total,
  });
  return { groups, snapshots, total };
}

function startKey(run: RunIndexRun): number {
  return run.startMs ?? 0;
}

/**
 * newest first across workflows; ties keep workflow order, then order within
 * the workflow. A merge of the per-workflow lists, so it reads only as far as
 * the page reaches.
 */
export function pageOfSelection(
  groups: readonly SelectedWorkflowRuns[],
  offset: number,
  limit: number | undefined,
): Array<{ run: RunIndexRun; group: SelectedWorkflowRuns }> {
  // bounds as Array.prototype.slice takes them, truncated toward zero
  const start = Math.trunc(offset);
  const end = limit === undefined ? Infinity : Math.trunc(offset + limit);
  const page: Array<{ run: RunIndexRun; group: SelectedWorkflowRuns }> = [];
  if (end <= start) return page;
  const cursor = groups.map(() => 0);
  const heap: number[] = [];
  const before = (a: number, b: number): boolean => {
    const ka = startKey(groups[a].runs[cursor[a]]);
    const kb = startKey(groups[b].runs[cursor[b]]);
    return ka !== kb ? ka > kb : a < b;
  };
  const up = (i: number) => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i], heap[parent])) return;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  };
  const down = (i: number) => {
    while (true) {
      const l = 2 * i + 1;
      const r = l + 1;
      let top = i;
      if (l < heap.length && before(heap[l], heap[top])) top = l;
      if (r < heap.length && before(heap[r], heap[top])) top = r;
      if (top === i) return;
      [heap[i], heap[top]] = [heap[top], heap[i]];
      i = top;
    }
  };
  for (let g = 0; g < groups.length; g++) {
    if (groups[g].runs.length > 0) {
      heap.push(g);
      up(heap.length - 1);
    }
  }
  let index = 0;
  while (heap.length > 0 && index < end) {
    const g = heap[0];
    if (index >= start) {
      page.push({ run: groups[g].runs[cursor[g]], group: groups[g] });
    }
    index++;
    cursor[g]++;
    if (cursor[g] < groups[g].runs.length) {
      down(0);
    } else {
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        down(0);
      }
    }
  }
  return page;
}

export function runDuration(run: RunIndexRun): number | undefined {
  return run.startMs && run.completedMs
    ? run.completedMs - run.startMs
    : undefined;
}

const SEARCH_QUERY_ATTR_MAX = 256;

function boundMs(value: string | undefined, now: number): number | undefined {
  return value ? parseRunTimeBound(value, now) : undefined;
}

export async function* workflowRunSearch(
  _ctx: LibSwampContext,
  deps: WorkflowRunSearchDeps,
  input: WorkflowRunSearchInput,
): AsyncGenerator<WorkflowRunSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.run_search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const now = Date.now();
      const filter: WorkflowRunFilter = {
        sinceMs: boundMs(input.since, now),
        untilMs: boundMs(input.until, now),
        status: input.status,
        workflow: input.workflow,
        workflows: input.workflows,
        triggerSource: input.triggerSource,
        statuses: input.statuses,
        triggerSources: input.triggerSources,
        tags: input.tags,
        inputs: input.inputs,
        query: input.query,
      };

      const allWorkflows = await deps.findAllWorkflows();
      const workflowsWithInputs = new Set(
        allWorkflows.filter((w) => w.declaresInputs).map((w) => w.id),
      );
      const selection = await selectWorkflowRuns(deps, allWorkflows, filter);
      const page = pageOfSelection(
        selection.groups,
        Math.max(0, input.offset ?? 0),
        input.limit,
      );
      setActiveSpanAttributes({
        ...(input.query
          ? { "search.query": input.query.slice(0, SEARCH_QUERY_ATTR_MAX) }
          : {}),
        "workflow_runs.returned": page.length,
        ...(input.limit !== undefined
          ? { "workflow_runs.limit": input.limit }
          : {}),
      });

      // a nested wait is resolved by finding the child in its workflow's
      // snapshot, its parentRun the back-link check, with no further reads
      const snapshotIds = new Map(
        [...selection.snapshots.keys()].map((id) => [id.toLowerCase(), id]),
      );
      const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
      const nestedWaitsOf = (run: RunIndexRun["summary"]) => {
        if (!run.waitingOnRun) return undefined;
        let allFinished = true;
        const waits = run.waitingOnRun.map((ref) => {
          const owner = snapshotIds.get(ref.workflowId.toLowerCase());
          const child = owner
            ? selection.snapshots.get(owner)?.get(ref.runId)?.summary
            : undefined;
          // The index is not trusted: the child must link back to this run
          // and be of the linked workflow.
          const linked = child?.parentRun &&
            child.parentRun.runId.toLowerCase() === run.id.toLowerCase() &&
            child.parentRun.workflowId.toLowerCase() ===
              run.workflowId.toLowerCase() &&
            child.workflowId.toLowerCase() === ref.workflowId.toLowerCase();
          if (linked && !FINISHED.has(child.status)) allFinished = false;
          return {
            workflowId: ref.workflowId,
            workflowName: ref.workflowName,
            runId: ref.runId,
            ...(linked ? { status: child.status } : {}),
          };
        });
        return {
          waits,
          resumable: run.status === "suspended" &&
            run.waitsOnlyOnNestedRuns === true && allFinished,
        };
      };

      const results: WorkflowRunSearchItem[] = page.map(({ run: entry }) => {
        const run = entry.summary;
        // Copied out: the snapshot is shared and frozen.
        const tags = run.tags && Object.keys(run.tags).length > 0
          ? { ...run.tags }
          : undefined;
        const inputs = run.inputs && Object.keys(run.inputs).length > 0
          ? structuredClone(run.inputs)
          : undefined;
        const inputsOmitted = run.inputsOmitted
          ? [...run.inputsOmitted]
          : undefined;
        const nested = nestedWaitsOf(run);

        return {
          runId: run.id,
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          status: run.status,
          startedAt: entry.startedAt,
          completedAt: entry.completedAt,
          duration: runDuration(entry),
          tags,
          inputs,
          inputsOmitted,
          instanceId: run.instanceId,
          triggerSource: run.triggerSource,
          failedStep: run.failedStep,
          failureReason: run.failureReason,
          stepProgress: run.stepProgress ? { ...run.stepProgress } : undefined,
          awaitingResume: run.awaitingResume || nested?.resumable
            ? true
            : undefined,
          workflowHasInputs: workflowsWithInputs.has(run.workflowId)
            ? true
            : undefined,
          ...(run.parentRun
            ? {
              parentRun: {
                workflowId: run.parentRun.workflowId,
                workflowName: run.parentRun.workflowName,
                runId: run.parentRun.runId,
                stepName: run.parentRun.stepName,
              },
            }
            : {}),
          ...(nested ? { nestedWaits: nested.waits } : {}),
        };
      });

      // A since bound keeps only dated runs, and each group is newest
      // first, so a group's last run is its oldest.
      let oldestMs: number | undefined;
      if (filter.sinceMs !== undefined) {
        for (const group of selection.groups) {
          const ms = group.runs[group.runs.length - 1]?.startMs;
          if (ms !== undefined && (oldestMs === undefined || ms < oldestMs)) {
            oldestMs = ms;
          }
        }
      }

      const reaped = await findReapedBefore(
        deps.retentionWatermarks,
        "workflowRuns",
      );
      yield {
        kind: "completed",
        data: {
          query: input.query ?? "",
          results,
          ...(reaped ? { reapedBefore: reaped } : {}),
        },
        total: selection.total,
        ...(filter.sinceMs !== undefined
          ? { since: new Date(filter.sinceMs).toISOString() }
          : {}),
        ...(oldestMs !== undefined
          ? { oldestStartedAt: new Date(oldestMs).toISOString() }
          : {}),
      };
    })(),
  );
}
