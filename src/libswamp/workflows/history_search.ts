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
import type { WorkflowRunSearchItem } from "./run_search.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Re-export the shared item type for history search consumers.
 */
export type WorkflowHistorySearchItem = WorkflowRunSearchItem;

/**
 * Data payload for the completed event.
 */
export interface WorkflowHistorySearchData {
  query: string;
  results: WorkflowHistorySearchItem[];
}

export type WorkflowHistorySearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowHistorySearchData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the workflow history search generator.
 */
export interface WorkflowHistorySearchDeps {
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
 * Input for the workflow history search generator.
 */
export interface WorkflowHistorySearchInput {
  query?: string;
}

/**
 * Searches workflow run history across all workflows.
 *
 * Fetches all workflows, then all runs for each workflow.
 * No filtering — just fetches all runs and sorts by startedAt descending.
 * The Ink renderer uses fzf for interactive fuzzy matching.
 */
export async function* workflowHistorySearch(
  _ctx: LibSwampContext,
  deps: WorkflowHistorySearchDeps,
  input: WorkflowHistorySearchInput,
): AsyncGenerator<WorkflowHistorySearchEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.history.search",
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
      const results: WorkflowHistorySearchItem[] = allRuns.map((run) => {
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
