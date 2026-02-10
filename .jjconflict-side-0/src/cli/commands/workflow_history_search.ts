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
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";

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

          return {
            name: step.stepName,
            status: step.status,
            error: step.error,
            duration: stepStart && stepEnd ? stepEnd - stepStart : undefined,
          };
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

  return {
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    duration: startTime && endTime ? endTime - startTime : undefined,
  };
}

/**
 * Filters runs by a query string (case-insensitive match on workflow name, run id, or status).
 */
function filterRuns(
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

export const workflowHistorySearchCommand = new Command()
  .name("search")
  .description("Search workflow run history")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(
      options as GlobalOptions,
      ["workflow", "history", "search"],
    );
    ctx.logger.debug`Searching workflow history with query: ${
      query ?? "(none)"
    }`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
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

    const searchItems = allRuns.map(toSearchItem);

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredRuns = filterRuns(searchItems, query ?? "");
      const data: WorkflowHistorySearchData = {
        query: query ?? "",
        results: filteredRuns,
      };
      await renderWorkflowHistorySearch(data, ctx.outputMode);
    } else {
      // Interactive: show fuzzy search UI
      const data: WorkflowHistorySearchData = {
        query: query ?? "",
        results: searchItems,
      };

      const selected = await renderWorkflowHistorySearch(data, ctx.outputMode);

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
          renderWorkflowRun(runData, ctx.outputMode);
        }
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Workflow history search command completed");
  });
