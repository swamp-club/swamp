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
import type { InputsSchema } from "../../domain/definitions/definition.ts";
import { workflowDeclaresInputs } from "../../domain/workflows/workflow.ts";
import type {
  RunIndexRun,
  RunIndexSnapshot,
} from "../../domain/workflows/run_index_snapshot.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { collectBounded, RUN_FANOUT_CONCURRENCY } from "./run_fanout.ts";
/**
 * A single workflow run search result item.
 */
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
  /** The run's workflow declares inputs, so a resume may need `--input`. */
  workflowHasInputs?: boolean;
  /** On a nested workflow's run: the parent step that started it. */
  parentRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
  };
  /**
   * The nested runs this run's steps wait on, with each one's status when
   * it was found among the searched runs (swamp-club#2736).
   */
  nestedWaits?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    status?: string;
  }[];
}

/**
 * Data payload for the completed event.
 */
export interface WorkflowRunSearchData {
  query: string;
  results: WorkflowRunSearchItem[];
}

export type WorkflowRunSearchEvent =
  | { kind: "resolving" }
  | {
    kind: "completed";
    data: WorkflowRunSearchData;
    /**
     * How many runs matched and are readable, before `offset` and `limit`
     * cut out the page.
     */
    total: number;
  }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the workflow run search generator.
 */
export interface WorkflowRunSearchDeps {
  findAllWorkflows(): Promise<
    Array<{ id: string; name: string; inputs?: InputsSchema }>
  >;
  /** The run index snapshot of one workflow (swamp-club#3443). */
  runIndexOf(workflowId: string): Promise<RunIndexSnapshot>;
  /**
   * Whether the caller may read runs recorded under this workflow id and
   * name. Asked once per distinct pair. Without it every run is readable.
   */
  isReadable?(workflowId: string, workflowName: string): Promise<boolean>;
}

/**
 * Input for the workflow run search generator.
 */
export interface WorkflowRunSearchInput {
  query?: string;
  /**
   * Keeps runs started at or after this time: a duration back from now
   * (`1h`, `7d`) or an ISO timestamp.
   */
  since?: string;
  /**
   * Keeps runs started before this time (exclusive): a duration back from
   * now or an ISO timestamp.
   */
  until?: string;
  /**
   * Keeps runs with this status, ignoring case. `failed` also keeps
   * interrupted runs and `running` also keeps pending ones, matching the run
   * summary's counts.
   */
  status?: string;
  /** Keeps runs of the workflow with this name, ignoring case. */
  workflow?: string;
  /**
   * Keeps runs of any of these workflows, by exact name. An empty list
   * filters nothing.
   */
  workflows?: string[];
  /** Keeps runs with this trigger source (`schedule`, `api`…), ignoring case. */
  triggerSource?: string;
  /**
   * Keeps runs with any of these statuses (each matched like `status`). An
   * empty list filters nothing; with `status` both must hold.
   */
  statuses?: string[];
  /**
   * Keeps runs with any of these trigger sources, ignoring case. An empty
   * list filters nothing; with `triggerSource` both must hold.
   */
  triggerSources?: string[];
  tags?: Record<string, string>;
  inputs?: Record<string, string>;
  /** Runs to skip, newest first, before the page starts. */
  offset?: number;
  limit?: number;
}

/**
 * Resolves a run time bound to epoch milliseconds: a swamp duration (`1h`,
 * `7d`) counts back from `now`, anything else must parse as an ISO
 * timestamp.
 */
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

/** The status groups the run summary counts runs in. */
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

/**
 * Whether a run's status matches a lower-cased status filter. A bucket name
 * matches every status in that bucket (`failed` also matches `interrupted`,
 * `running` also matches `pending`), so a filtered search agrees with the
 * run summary's counts; any other filter matches the status exactly.
 */
function runStatusMatches(status: string, filter: string): boolean {
  const actual = status.toLowerCase();
  if (actual === filter) return true;
  return (filter === "failed" || filter === "running") &&
    runStatusBucket(actual) === filter;
}

/** What {@link selectWorkflowRuns} keeps a run by. */
export interface WorkflowRunFilter {
  /** Keeps runs started at or after this epoch ms. */
  sinceMs?: number;
  /** Keeps runs started before this epoch ms. */
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

/** The matching runs of one workflow, newest first. */
export interface SelectedWorkflowRuns {
  workflowId: string;
  snapshot: RunIndexSnapshot;
  runs: RunIndexRun[];
}

/** The runs {@link selectWorkflowRuns} kept. */
export interface WorkflowRunSelection {
  /** One entry per workflow with a match, in the order the workflows came. */
  groups: SelectedWorkflowRuns[];
  /** Every workflow's snapshot, by workflow id. */
  snapshots: ReadonlyMap<string, RunIndexSnapshot>;
  total: number;
}

/** A predicate over one run, from the filters that look at the run alone. */
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
    checks.push((run) =>
      entries.every(([k, v]) => String(run.summary.inputs?.[k]) === v)
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

/**
 * Whether a workflow can hold no match, from what its snapshot says of all
 * its runs: no recorded name passes a name filter, or no run started inside
 * the window.
 */
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
 * The runs worth testing against the filter: a full run id finds its run
 * directly, unless a recorded name or status could also contain it; any
 * other filter reads the time window.
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
 * Selects the runs of `workflows` that pass `filter` and that the caller may
 * read (swamp-club#3443). Each workflow's runs come from its run index
 * snapshot, narrowed by name and time before any run is looked at, so the
 * cost follows the runs in the window, not the whole history.
 */
export async function selectWorkflowRuns(
  deps: Pick<WorkflowRunSearchDeps, "runIndexOf" | "isReadable">,
  workflows: ReadonlyArray<{ id: string }>,
  filter: WorkflowRunFilter,
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
  for (const workflow of workflows) {
    const snapshot = snapshots.get(workflow.id);
    if (!snapshot || cannotMatch(snapshot, filter)) continue;
    let runs = candidates(snapshot, filter).filter(matches);
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
          readable.set(key, await deps.isReadable(id, name));
        }
      }
      runs = runs.filter((run) =>
        readable.get(
          JSON.stringify([run.summary.workflowId, run.summary.workflowName]),
        )
      );
      if (runs.length === 0) continue;
    }
    groups.push({ workflowId: workflow.id, snapshot, runs });
    total += runs.length;
  }
  return { groups, snapshots, total };
}

/** The sort key of a run: its start time, or 0 without one. */
function startKey(run: RunIndexRun): number {
  return run.startMs ?? 0;
}

/**
 * The selected runs from `offset`, at most `limit` of them, newest first
 * across workflows. Runs that started at the same moment keep the order of
 * their workflows, then their order within the workflow. A merge of the
 * per-workflow lists, so it reads only as far as the page reaches.
 */
export function pageOfSelection(
  groups: readonly SelectedWorkflowRuns[],
  offset: number,
  limit: number | undefined,
): Array<{ run: RunIndexRun; group: SelectedWorkflowRuns }> {
  // Bounds as Array.prototype.slice takes them, truncated toward zero, as
  // the page was cut before (swamp-club#3443).
  const start = Math.trunc(offset);
  const end = limit === undefined ? Infinity : Math.trunc(offset + limit);
  const page: Array<{ run: RunIndexRun; group: SelectedWorkflowRuns }> = [];
  if (end <= start) return page;
  // A binary heap of each workflow's next run: newest first, then the
  // earlier workflow.
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

/** A run's duration, when it has both a start and a completion time. */
export function runDuration(run: RunIndexRun): number | undefined {
  return run.startMs && run.completedMs
    ? run.completedMs - run.startMs
    : undefined;
}

/** Resolves an optional run time bound to epoch ms. */
function boundMs(value: string | undefined, now: number): number | undefined {
  return value ? parseRunTimeBound(value, now) : undefined;
}

/**
 * Searches workflow runs across all workflows.
 *
 * Selects the matching runs from each workflow's run index snapshot
 * (filters: since, until, status, workflow, workflows, trigger source, tags,
 * inputs, query; then readability), and returns the page from `offset`,
 * at most `limit` runs, by startedAt descending (most recent first).
 * Search items are built for the page only.
 */
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
        allWorkflows
          .filter((w) => workflowDeclaresInputs(w.inputs))
          .map((w) => w.id),
      );
      const selection = await selectWorkflowRuns(deps, allWorkflows, filter);
      const page = pageOfSelection(
        selection.groups,
        Math.max(0, input.offset ?? 0),
        input.limit,
      );

      // A nested wait is resolved by finding the child in its workflow's
      // snapshot, its parentRun the back-link check, with no further reads
      // (swamp-club#2736).
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

      yield {
        kind: "completed",
        data: {
          query: input.query ?? "",
          results,
        },
        total: selection.total,
      };
    })(),
  );
}
