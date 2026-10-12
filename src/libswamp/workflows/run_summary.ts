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
import { validationFailed } from "../errors.ts";
import { UserError } from "../../domain/errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  parseRunTimeBound,
  type RunStatusBucket,
  runStatusBucket,
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchItem,
} from "./run_search.ts";

/** Runs kept per workflow in `recent` when the caller names no limit. */
export const WORKFLOW_RUN_SUMMARY_DEFAULT_RECENT = 20;
/** The most runs a caller may ask to keep per workflow in `recent`. */
export const WORKFLOW_RUN_SUMMARY_MAX_RECENT = 100;

/** Run counts by outcome bucket. */
export interface WorkflowRunStatusCounts {
  runs: number;
  /** Runs that succeeded. */
  succeeded: number;
  /** Runs that failed, or were interrupted (ended without settling). */
  failed: number;
  /** Runs that were cancelled. */
  cancelled: number;
  /** Runs in flight: running, or pending a start. */
  running: number;
  /** Runs paused on an approval, a signal or a nested run. */
  suspended: number;
}

/** One run in a workflow's `recent` list. */
export interface WorkflowRunSummaryRecentRun {
  runId: string;
  status: string;
  startedAt?: string;
  duration?: number;
  triggerSource?: string;
}

/** The runs of one workflow, counted. */
export interface WorkflowRunSummaryWorkflow extends WorkflowRunStatusCounts {
  workflowId: string;
  /** The name the workflow's newest run recorded. */
  workflowName: string;
  /** Total duration of the finished runs (succeeded, failed, cancelled). */
  durationMs: number;
  lastStartedAt?: string;
  /** The newest runs, newest first, at most `recentLimit`. */
  recent: WorkflowRunSummaryRecentRun[];
}

/** The runs started within one UTC hour. */
export interface WorkflowRunSummaryBucket {
  /** Top of the UTC hour, as an ISO timestamp. */
  start: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/**
 * Run counts across workflows. A run whose status is in no bucket (a status
 * this version does not know) counts in `runs` only, so the bucket counts
 * can sum to less than `runs`.
 */
export interface WorkflowRunSummaryData {
  since?: string;
  until?: string;
  totals: WorkflowRunStatusCounts & {
    /** Workflows with at least one counted run. */
    workflows: number;
    /** Total duration of the finished runs. */
    durationMs: number;
  };
  /** One entry per workflow with a counted run, ordered by name. */
  workflows: WorkflowRunSummaryWorkflow[];
  /**
   * Hourly buckets, ascending, only for hours with runs. Runs without a
   * start time are left out. Present only when asked for.
   */
  timeline?: WorkflowRunSummaryBucket[];
}

/** The fields of a run the summary reads. */
export type WorkflowRunSummaryRun = Pick<
  WorkflowRunSearchItem,
  | "runId"
  | "workflowId"
  | "workflowName"
  | "status"
  | "startedAt"
  | "duration"
  | "triggerSource"
>;

/** How `summarizeWorkflowRuns` shapes its result. */
export interface WorkflowRunSummaryOptions {
  /** Runs kept per workflow in `recent`; clamped to 0..100, default 20. */
  recentLimit?: number;
  /** Include hourly buckets. */
  timeline?: boolean;
  /** Echoed back as the summary's window. */
  since?: string;
  until?: string;
}

type StatusBucket = RunStatusBucket;

const FINISHED_BUCKETS: ReadonlySet<StatusBucket> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/** Clamps a requested recent limit to 0..100; default 20. */
export function clampRecentLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return WORKFLOW_RUN_SUMMARY_DEFAULT_RECENT;
  }
  return Math.min(
    WORKFLOW_RUN_SUMMARY_MAX_RECENT,
    Math.max(0, Math.floor(limit)),
  );
}

function emptyCounts(): WorkflowRunStatusCounts {
  return {
    runs: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    suspended: 0,
  };
}

function startMs(run: WorkflowRunSummaryRun): number | undefined {
  if (!run.startedAt) return undefined;
  const ms = Date.parse(run.startedAt);
  return Number.isNaN(ms) ? undefined : ms;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Counts runs per workflow, in total and (when asked) per UTC hour. Pure:
 * the caller decides which runs count, so authorization and time filters
 * happen before this runs.
 */
export function summarizeWorkflowRuns(
  runs: readonly WorkflowRunSummaryRun[],
  options: WorkflowRunSummaryOptions = {},
): WorkflowRunSummaryData {
  const recentLimit = clampRecentLimit(options.recentLimit);
  // Newest first; runs without a start time last; run id breaks ties so the
  // order does not depend on the input's.
  const ordered = runs.map((run) => ({ run, ms: startMs(run) }));
  ordered.sort((a, b) => {
    const at = a.ms ?? -Infinity;
    const bt = b.ms ?? -Infinity;
    if (at !== bt) return bt - at;
    return a.run.runId < b.run.runId ? -1 : a.run.runId > b.run.runId ? 1 : 0;
  });

  const totals = { ...emptyCounts(), workflows: 0, durationMs: 0 };
  const byWorkflow = new Map<string, WorkflowRunSummaryWorkflow>();
  const buckets = new Map<number, WorkflowRunSummaryBucket>();

  for (const { run, ms } of ordered) {
    let entry = byWorkflow.get(run.workflowId);
    if (!entry) {
      entry = {
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        ...emptyCounts(),
        durationMs: 0,
        ...(run.startedAt ? { lastStartedAt: run.startedAt } : {}),
        recent: [],
      };
      byWorkflow.set(run.workflowId, entry);
    }
    const bucket = runStatusBucket(run.status);
    const duration = bucket && FINISHED_BUCKETS.has(bucket) &&
        run.duration !== undefined
      ? run.duration
      : 0;

    entry.runs++;
    totals.runs++;
    if (bucket) {
      entry[bucket]++;
      totals[bucket]++;
    }
    entry.durationMs += duration;
    totals.durationMs += duration;

    if (entry.recent.length < recentLimit) {
      entry.recent.push({
        runId: run.runId,
        status: run.status,
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.duration !== undefined ? { duration: run.duration } : {}),
        ...(run.triggerSource ? { triggerSource: run.triggerSource } : {}),
      });
    }

    if (options.timeline && ms !== undefined) {
      const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
      let slot = buckets.get(hour);
      if (!slot) {
        slot = {
          start: new Date(hour).toISOString(),
          runs: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
        };
        buckets.set(hour, slot);
      }
      slot.runs++;
      if (
        bucket === "succeeded" || bucket === "failed" || bucket === "cancelled"
      ) {
        slot[bucket]++;
      }
    }
  }

  const workflows = [...byWorkflow.values()].sort((a, b) =>
    a.workflowName < b.workflowName
      ? -1
      : a.workflowName > b.workflowName
      ? 1
      : a.workflowId < b.workflowId
      ? -1
      : a.workflowId > b.workflowId
      ? 1
      : 0
  );
  totals.workflows = workflows.length;

  return {
    ...(options.since ? { since: options.since } : {}),
    ...(options.until ? { until: options.until } : {}),
    totals,
    workflows,
    ...(options.timeline
      ? {
        timeline: [...buckets.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, slot]) => slot),
      }
      : {}),
  };
}

export type WorkflowRunSummaryEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowRunSummaryData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the workflow run summary generator: the run search's
 * loaders, plus the filter that keeps the runs the caller may read.
 */
export interface WorkflowRunSummaryDeps extends WorkflowRunSearchDeps {
  /**
   * Keeps the runs the caller may read. Runs it drops never reach the
   * counts, so an unreadable workflow cannot show in totals or the
   * timeline. A caller with no authorization passes the runs through.
   */
  keepReadable(
    runs: WorkflowRunSearchItem[],
  ): Promise<WorkflowRunSearchItem[]>;
}

/**
 * Input for the workflow run summary generator. Every field is optional.
 */
export interface WorkflowRunSummaryInput {
  /** Counts runs started at or after this time (ISO, or a duration back). */
  since?: string;
  /** Counts runs started before this time (exclusive). */
  until?: string;
  /** Counts only runs of these workflows, by exact name. */
  workflows?: string[];
  /** Counts only runs with this trigger source, ignoring case. */
  triggerSource?: string;
  /** Counts only runs with any of these trigger sources, ignoring case. */
  triggerSources?: string[];
  /** Runs kept per workflow in `recent`; clamped to 0..100, default 20. */
  recentLimit?: number;
  /** Include hourly buckets. */
  timeline?: boolean;
}

/**
 * Summarises workflow runs: counts per workflow and in total, each
 * workflow's newest runs, and optionally an hourly timeline. Loads runs
 * through the run search, keeps the readable ones, then counts them.
 */
export async function* workflowRunSummary(
  ctx: LibSwampContext,
  deps: WorkflowRunSummaryDeps,
  input: WorkflowRunSummaryInput,
): AsyncGenerator<WorkflowRunSummaryEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.run_summary",
    {},
    (async function* (): AsyncGenerator<WorkflowRunSummaryEvent> {
      yield { kind: "resolving" };

      const now = Date.now();
      let since: string | undefined;
      let until: string | undefined;
      try {
        if (input.since) {
          since = new Date(parseRunTimeBound(input.since, now)).toISOString();
        }
        if (input.until) {
          until = new Date(parseRunTimeBound(input.until, now)).toISOString();
        }
      } catch (error) {
        if (error instanceof UserError) {
          yield { kind: "error", error: validationFailed(error.message) };
          return;
        }
        throw error;
      }

      let runs: WorkflowRunSearchItem[] = [];
      for await (
        const event of workflowRunSearch(ctx, deps, {
          since,
          until,
          workflows: input.workflows,
          triggerSource: input.triggerSource,
          triggerSources: input.triggerSources,
        })
      ) {
        if (event.kind === "error") {
          yield event;
          return;
        }
        if (event.kind === "completed") runs = event.data.results;
      }

      const readable = await deps.keepReadable(runs);
      yield {
        kind: "completed",
        data: summarizeWorkflowRuns(readable, {
          since,
          until,
          recentLimit: input.recentLimit,
          timeline: input.timeline,
        }),
      };
    })(),
  );
}
