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

import type {
  NestedRunRef,
  ParentRunRef,
} from "../../domain/workflows/nested_run_ref.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { parseDuration } from "../data/search.ts";
import { UserError } from "../../domain/errors.ts";
import type { InputsSchema } from "../../domain/definitions/definition.ts";
import { workflowDeclaresInputs } from "../../domain/workflows/workflow.ts";

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
  | { kind: "completed"; data: WorkflowRunSearchData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the workflow run search generator.
 */
export interface WorkflowRunSearchDeps {
  findAllWorkflows(): Promise<
    Array<{ id: string; name: string; inputs?: InputsSchema }>
  >;
  findAllRunsByWorkflowId(id: string): Promise<
    Array<{
      id: string;
      workflowId: string;
      workflowName: string;
      status: string;
      startedAt?: Date;
      completedAt?: Date;
      duration?: number;
      tags: Record<string, string>;
      inputs: Record<string, unknown>;
      instanceId?: string;
      triggerSource?: string;
      failedStep?: string;
      failureReason?: string;
      stepProgress?: { completed: number; total: number };
      awaitingResume?: boolean;
      parentRun?: ParentRunRef;
      waitingOnRun?: NestedRunRef[];
      waitsOnlyOnNestedRuns?: boolean;
    }>
  >;
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
  tags?: Record<string, string>;
  inputs?: Record<string, string>;
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

/**
 * Searches workflow runs across all workflows.
 *
 * Fetches all workflows, then all runs for each workflow.
 * Applies filters (since, until, status, workflow, workflows, trigger
 * source, tags, inputs, query, limit) and sorts
 * by startedAt descending (most recent first).
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

      const allWorkflows = await deps.findAllWorkflows();
      const workflowsWithInputs = new Set(
        allWorkflows
          .filter((w) => workflowDeclaresInputs(w.inputs))
          .map((w) => w.id),
      );

      // Fetch run summaries for all workflows with bounded concurrency. Each
      // per-workflow read streams one run file at a time; the bound keeps at
      // most RUN_FANOUT_CONCURRENCY of those in flight so peak memory does not
      // scale with the number of workflows. Summaries are lightweight, so
      // holding them all before filtering is cheap (see WorkflowRunSummary).
      const allRuns = await collectBounded(
        allWorkflows,
        RUN_FANOUT_CONCURRENCY,
        (workflow) => deps.findAllRunsByWorkflowId(workflow.id),
      );

      // Sort by startedAt descending (most recent first)
      allRuns.sort((a, b) => {
        const aTime = a.startedAt?.getTime() ?? 0;
        const bTime = b.startedAt?.getTime() ?? 0;
        return bTime - aTime;
      });

      // Every run is already in memory: a nested wait is resolved by joining
      // on the child's summary, its parentRun the back-link check, with no
      // further reads (swamp-club#2736).
      const byId = new Map(allRuns.map((r) => [r.id.toLowerCase(), r]));
      const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
      const nestedWaitsOf = (run: (typeof allRuns)[number]) => {
        if (!run.waitingOnRun) return undefined;
        let allFinished = true;
        const waits = run.waitingOnRun.map((ref) => {
          const child = byId.get(ref.runId.toLowerCase());
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

      // Convert to search items
      let results: WorkflowRunSearchItem[] = allRuns.map((run) => {
        const startTime = run.startedAt?.getTime();
        const endTime = run.completedAt?.getTime();
        const tags = run.tags && Object.keys(run.tags).length > 0
          ? { ...run.tags }
          : undefined;
        const inputs = run.inputs && Object.keys(run.inputs).length > 0
          ? { ...run.inputs }
          : undefined;
        const nested = nestedWaitsOf(run);

        return {
          runId: run.id,
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          status: run.status,
          startedAt: run.startedAt?.toISOString(),
          completedAt: run.completedAt?.toISOString(),
          duration: startTime && endTime ? endTime - startTime : undefined,
          tags,
          inputs,
          instanceId: run.instanceId,
          triggerSource: run.triggerSource,
          failedStep: run.failedStep,
          failureReason: run.failureReason,
          stepProgress: run.stepProgress,
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

      // Apply filters
      const now = Date.now();
      if (input.since) {
        const cutoff = parseRunTimeBound(input.since, now);
        results = results.filter((r) => {
          if (!r.startedAt) return false;
          return new Date(r.startedAt).getTime() >= cutoff;
        });
      }

      if (input.until) {
        const end = parseRunTimeBound(input.until, now);
        results = results.filter((r) => {
          if (!r.startedAt) return false;
          return new Date(r.startedAt).getTime() < end;
        });
      }

      if (input.status) {
        const status = input.status.toLowerCase();
        results = results.filter((r) => runStatusMatches(r.status, status));
      }

      if (input.workflow) {
        const name = input.workflow.toLowerCase();
        results = results.filter(
          (r) => r.workflowName.toLowerCase() === name,
        );
      }

      if (input.workflows && input.workflows.length > 0) {
        const names = new Set(input.workflows);
        results = results.filter((r) => names.has(r.workflowName));
      }

      if (input.triggerSource) {
        const source = input.triggerSource.toLowerCase();
        results = results.filter((r) =>
          r.triggerSource?.toLowerCase() === source
        );
      }

      if (input.tags) {
        const tagEntries = Object.entries(input.tags);
        results = results.filter((r) =>
          tagEntries.every(([k, v]) => r.tags?.[k] === v)
        );
      }

      if (input.inputs) {
        const inputEntries = Object.entries(input.inputs);
        results = results.filter((r) =>
          inputEntries.every(([k, v]) => String(r.inputs?.[k]) === v)
        );
      }

      if (input.query) {
        const q = input.query.toLowerCase();
        results = results.filter(
          (r) =>
            r.workflowName.toLowerCase().includes(q) ||
            r.runId.toLowerCase().includes(q) ||
            r.status.toLowerCase().includes(q),
        );
      }

      if (input.limit !== undefined) {
        results = results.slice(0, input.limit);
      }

      yield {
        kind: "completed",
        data: {
          query: input.query ?? "",
          results,
        },
      };
    })(),
  );
}
