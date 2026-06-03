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

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
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
  findAllWorkflows(): Promise<Array<{ id: string; name: string }>>;
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
    }>
  >;
}

/**
 * Input for the workflow run search generator.
 */
export interface WorkflowRunSearchInput {
  query?: string;
  since?: string;
  status?: string;
  workflow?: string;
  tags?: Record<string, string>;
  limit?: number;
}

/**
 * Searches workflow runs across all workflows.
 *
 * Fetches all workflows, then all runs for each workflow.
 * Applies filters (since, status, workflow, tags, limit) and sorts
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

      // Fetch all runs for all workflows in parallel
      const runsPerWorkflow = await Promise.all(
        allWorkflows.map((workflow) =>
          deps.findAllRunsByWorkflowId(workflow.id)
        ),
      );
      const allRuns = runsPerWorkflow.flat();

      // Sort by startedAt descending (most recent first)
      allRuns.sort((a, b) => {
        const aTime = a.startedAt?.getTime() ?? 0;
        const bTime = b.startedAt?.getTime() ?? 0;
        return bTime - aTime;
      });

      // Convert to search items
      let results: WorkflowRunSearchItem[] = allRuns.map((run) => {
        const startTime = run.startedAt?.getTime();
        const endTime = run.completedAt?.getTime();
        const tags = run.tags && Object.keys(run.tags).length > 0
          ? { ...run.tags }
          : undefined;

        return {
          runId: run.id,
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          status: run.status,
          startedAt: run.startedAt?.toISOString(),
          completedAt: run.completedAt?.toISOString(),
          duration: startTime && endTime ? endTime - startTime : undefined,
          tags,
        };
      });

      // Apply filters
      if (input.since) {
        const durationMs = parseDuration(input.since);
        const cutoff = Date.now() - durationMs;
        results = results.filter((r) => {
          if (!r.startedAt) return false;
          return new Date(r.startedAt).getTime() >= cutoff;
        });
      }

      if (input.status) {
        const status = input.status.toLowerCase();
        results = results.filter((r) => r.status.toLowerCase() === status);
      }

      if (input.workflow) {
        const name = input.workflow.toLowerCase();
        results = results.filter(
          (r) => r.workflowName.toLowerCase() === name,
        );
      }

      if (input.tags) {
        const tagEntries = Object.entries(input.tags);
        results = results.filter((r) =>
          tagEntries.every(([k, v]) => r.tags?.[k] === v)
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
