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

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * A single workflow search result item.
 */
export interface WorkflowSearchItem {
  id: string;
  name: string;
  description?: string;
  jobCount: number;
}

/**
 * Data payload for the completed event.
 */
export interface WorkflowSearchData {
  query: string;
  results: WorkflowSearchItem[];
}

export type WorkflowSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowSearchData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the workflow search generator.
 */
export interface WorkflowSearchDeps {
  findAllWorkflows(): Promise<
    Array<{
      id: string;
      name: string;
      description?: string;
      jobs: readonly unknown[];
    }>
  >;
}

/**
 * Input for the workflow search generator.
 */
export interface WorkflowSearchInput {
  query?: string;
}

/**
 * Searches workflow definitions.
 *
 * Returns all workflows — filtering for JSON mode is handled by the renderer.
 * The Ink renderer uses fzf for interactive fuzzy matching.
 */
export async function* workflowSearch(
  _ctx: LibSwampContext,
  deps: WorkflowSearchDeps,
  input: WorkflowSearchInput,
): AsyncGenerator<WorkflowSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.search",
    { "search.query": input.query ?? "" },
    (async function* () {
      yield { kind: "resolving" };

      const allWorkflows = await deps.findAllWorkflows();
      const results: WorkflowSearchItem[] = allWorkflows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        jobCount: w.jobs.length,
      }));

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
