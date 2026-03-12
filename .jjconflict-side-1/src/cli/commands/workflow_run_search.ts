// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { Command } from "@cliffy/command";
import {
  type JobRunData,
  renderWorkflowRun,
  type StepRunData,
  type WorkflowRunData,
} from "../../presentation/output/workflow_run_output.ts";
import {
  renderWorkflowHistorySearch,
  type WorkflowHistorySearchData,
  type WorkflowHistorySearchItem,
} from "../../presentation/output/workflow_history_search_output.tsx";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import { parseDuration, parseTags } from "./data_search.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a WorkflowRun to WorkflowRunData for presentation.
 */
function toRunData(run: WorkflowRun, path?: string): WorkflowRunData {
  const startTime = run.startedAt?.getTime();
  const endTime = run.completedAt?.getTime();

  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    jobs: run.jobs.map((job): JobRunData => {
      const jobStart = job.startedAt?.getTime();
      const jobEnd = job.completedAt?.getTime();

      return {
        name: job.jobName,
        status: job.status,
        steps: job.steps.map((step): StepRunData => {
          const stepStart = step.startedAt?.getTime();
          const stepEnd = step.completedAt?.getTime();

          const stepData: StepRunData = {
            name: step.stepName,
            status: step.status,
            error: step.error,
            duration: stepStart && stepEnd ? stepEnd - stepStart : undefined,
          };
          if (step.allowedFailure) {
            stepData.allowedFailure = true;
          }
          return stepData;
        }),
        duration: jobStart && jobEnd ? jobEnd - jobStart : undefined,
      };
    }),
    duration: startTime && endTime ? endTime - startTime : undefined,
    path,
  };
}

/**
 * Converts a WorkflowRun to WorkflowHistorySearchItem.
 */
function toSearchItem(run: WorkflowRun): WorkflowHistorySearchItem {
  const startTime = run.startedAt?.getTime();
  const endTime = run.completedAt?.getTime();
  const tags = Object.keys(run.tags).length > 0 ? { ...run.tags } : undefined;

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
}

/**
 * Filters runs by a query string (case-insensitive match on workflow name, run id, or status).
 */
function filterByQuery(
  runs: WorkflowHistorySearchItem[],
  query: string,
): WorkflowHistorySearchItem[] {
  if (!query) {
    return runs;
  }
  const lowerQuery = query.toLowerCase();
  return runs.filter(
    (r) =>
      r.workflowName.toLowerCase().includes(lowerQuery) ||
      r.runId.toLowerCase().includes(lowerQuery) ||
      r.status.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Options for filtering workflow run search results.
 */
interface RunSearchFilterOptions {
  since?: string;
  status?: string;
  workflow?: string;
  tags?: Record<string, string>;
  limit?: number;
}

/**
 * Applies structured filters to workflow run search items.
 */
export function applyFilters(
  runs: WorkflowHistorySearchItem[],
  options: RunSearchFilterOptions,
): WorkflowHistorySearchItem[] {
  let filtered = runs;

  if (options.since) {
    const durationMs = parseDuration(options.since);
    const cutoff = Date.now() - durationMs;
    filtered = filtered.filter((r) => {
      if (!r.startedAt) return false;
      return new Date(r.startedAt).getTime() >= cutoff;
    });
  }

  if (options.status) {
    const status = options.status.toLowerCase();
    filtered = filtered.filter((r) => r.status === status);
  }

  if (options.workflow) {
    const name = options.workflow.toLowerCase();
    filtered = filtered.filter(
      (r) => r.workflowName.toLowerCase() === name,
    );
  }

  if (options.tags) {
    const tagEntries = Object.entries(options.tags);
    filtered = filtered.filter((r) =>
      tagEntries.every(([k, v]) => r.tags?.[k] === v)
    );
  }

  if (options.limit !== undefined) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

export async function workflowRunSearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(
    options as GlobalOptions,
    ["workflow", "run", "search"],
  );
  const effectiveMode = interactiveOutputMode(ctx);
  ctx.logger.debug`Searching workflow runs with query: ${query ?? "(none)"}`;

  const { repoContext } = await requireInitializedRepo({
    repoDir: options.repoDir ?? ".",
    outputMode: effectiveMode,
  });
  const workflowRepo = repoContext.workflowRepo;
  const runRepo = repoContext.workflowRunRepo;

  // Get all workflows
  const allWorkflows = await workflowRepo.findAll();

  // Get all runs for all workflows
  const allRuns: WorkflowRun[] = [];
  for (const workflow of allWorkflows) {
    const runs = await runRepo.findAllByWorkflowId(workflow.id);
    allRuns.push(...runs);
  }

  // Sort by startedAt descending (most recent first)
  allRuns.sort((a, b) => {
    const aTime = a.startedAt?.getTime() ?? 0;
    const bTime = b.startedAt?.getTime() ?? 0;
    return bTime - aTime;
  });

  // Parse --tag values into Record<string, string>
  const parsedTags = options.tag
    ? parseTags(options.tag as string[])
    : undefined;

  // Convert to search items and apply structured filters
  let searchItems = allRuns.map(toSearchItem);
  searchItems = applyFilters(searchItems, {
    since: options.since as string | undefined,
    status: options.status as string | undefined,
    workflow: options.workflow as string | undefined,
    tags: parsedTags,
    limit: options.limit as number | undefined,
  });

  if (effectiveMode === "json") {
    // Non-interactive: also apply query text filter
    const filteredRuns = filterByQuery(searchItems, query ?? "");
    const data: WorkflowHistorySearchData = {
      query: query ?? "",
      results: filteredRuns,
    };
    await renderWorkflowHistorySearch(data, effectiveMode);
  } else {
    // Interactive: show fuzzy search UI
    const data: WorkflowHistorySearchData = {
      query: query ?? "",
      results: searchItems,
    };

    const selected = await renderWorkflowHistorySearch(data, effectiveMode);

    if (selected) {
      ctx.logger.debug`Selected run: ${selected.runId}`;
      // Display the run details
      const run = await runRepo.findById(
        createWorkflowId(selected.workflowId),
        createWorkflowRunId(selected.runId),
      );
      if (run) {
        const path = runRepo.getPath(
          createWorkflowId(selected.workflowId),
          createWorkflowRunId(selected.runId),
        );
        const runData = toRunData(run, path);
        renderWorkflowRun(runData, effectiveMode);
      }
    } else {
      ctx.logger.debug`Search cancelled`;
    }
  }

  ctx.logger.debug("Workflow run search command completed");
}

export const workflowRunSearchCommand = new Command()
  .name("search")
  .description("Search workflow run history")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--since <duration:string>",
    "Only runs started within duration (1h, 1d, 7d, 1w, 1mo)",
  )
  .option(
    "--status <status:string>",
    "Filter by run status (pending, running, succeeded, failed)",
  )
  .option(
    "--workflow <name:string>",
    "Filter by workflow name",
  )
  .option(
    "--tag <tag:string>",
    "Filter by tag (KEY=VALUE), can be repeated",
    { collect: true },
  )
  .option("--limit <n:number>", "Max results", { default: 50 })
  .action(workflowRunSearchAction);
