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
import {
  setActiveSpanAttributes,
  withGeneratorSpan,
} from "../../infrastructure/tracing/mod.ts";
import {
  parseRunTimeBound,
  runDuration,
  type RunStatusBucket,
  runStatusBucket,
  selectWorkflowRuns,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchItem,
} from "./run_search.ts";

export const WORKFLOW_RUN_SUMMARY_DEFAULT_RECENT = 20;
export const WORKFLOW_RUN_SUMMARY_MAX_RECENT = 100;

export interface WorkflowRunStatusCounts {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  running: number;
  suspended: number;
}

export interface WorkflowRunSummaryRecentRun {
  runId: string;
  status: string;
  startedAt?: string;
  duration?: number;
  triggerSource?: string;
}

export interface WorkflowRunSummaryWorkflow extends WorkflowRunStatusCounts {
  workflowId: string;
  workflowName: string;
  durationMs: number;
  lastStartedAt?: string;
  recent: WorkflowRunSummaryRecentRun[];
}

export interface WorkflowRunSummaryBucket {
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
    workflows: number;
    durationMs: number;
  };
  workflows: WorkflowRunSummaryWorkflow[];
  oldestStartedAt?: string;
  timeline?: WorkflowRunSummaryBucket[];
}

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

export interface WorkflowRunSummaryOptions {
  recentLimit?: number;
  timeline?: boolean;
  since?: string;
  until?: string;
}

type StatusBucket = RunStatusBucket;

const FINISHED_BUCKETS: ReadonlySet<StatusBucket> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

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
  // Newest first, so the last dated run is the oldest.
  let oldestStartedAt: string | undefined;

  for (const { run, ms } of ordered) {
    if (ms !== undefined) oldestStartedAt = run.startedAt;
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
    ...(oldestStartedAt ? { oldestStartedAt } : {}),
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
 * Dependencies for the workflow run summary generator: the run search's.
 * Runs `isReadable` refuses never reach the counts, so an unreadable
 * workflow cannot show in totals or the timeline.
 */
export type WorkflowRunSummaryDeps = Omit<WorkflowRunSearchDeps, "runInputsOf">;

export interface WorkflowRunSummaryInput {
  since?: string;
  until?: string;
  workflows?: string[];
  triggerSource?: string;
  triggerSources?: string[];
  recentLimit?: number;
  timeline?: boolean;
}

export async function* workflowRunSummary(
  _ctx: LibSwampContext,
  deps: WorkflowRunSummaryDeps,
  input: WorkflowRunSummaryInput,
): AsyncGenerator<WorkflowRunSummaryEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.run_summary",
    {},
    (async function* (): AsyncGenerator<WorkflowRunSummaryEvent> {
      yield { kind: "resolving" };

      const now = Date.now();
      let sinceMs: number | undefined;
      let untilMs: number | undefined;
      try {
        if (input.since) sinceMs = parseRunTimeBound(input.since, now);
        if (input.until) untilMs = parseRunTimeBound(input.until, now);
      } catch (error) {
        if (error instanceof UserError) {
          yield { kind: "error", error: validationFailed(error.message) };
          return;
        }
        throw error;
      }

      const since = sinceMs === undefined
        ? undefined
        : new Date(sinceMs).toISOString();
      const until = untilMs === undefined
        ? undefined
        : new Date(untilMs).toISOString();

      const allWorkflows = await deps.findAllWorkflows();
      const selection = await selectWorkflowRuns(
        deps,
        allWorkflows,
        {
          sinceMs,
          untilMs,
          workflows: input.workflows,
          triggerSource: input.triggerSource,
          triggerSources: input.triggerSources,
        },
      );
      const readable: WorkflowRunSummaryRun[] = [];
      for (const group of selection.groups) {
        for (const run of group.runs) {
          const duration = runDuration(run);
          readable.push({
            runId: run.summary.id,
            workflowId: run.summary.workflowId,
            workflowName: run.summary.workflowName,
            status: run.summary.status,
            ...(run.startedAt ? { startedAt: run.startedAt } : {}),
            ...(duration !== undefined ? { duration } : {}),
            ...(run.summary.triggerSource
              ? { triggerSource: run.summary.triggerSource }
              : {}),
          });
        }
      }
      setActiveSpanAttributes({
        "workflow_runs.workflows": allWorkflows.length,
        "workflow_runs.summarized": readable.length,
      });
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
