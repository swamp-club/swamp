import { Command } from "@cliffy/command";
import {
  renderWorkflowSearch,
  type WorkflowSearchData,
  type WorkflowSearchItem,
} from "../../presentation/output/workflow_search_output.tsx";
import {
  renderWorkflowGet,
  type WorkflowGetData,
} from "../../presentation/output/workflow_get_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a Workflow to WorkflowSearchItem.
 */
function toSearchItem(workflow: Workflow): WorkflowSearchItem {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    jobCount: workflow.jobs.length,
  };
}

/**
 * Filters workflows by a query string (case-insensitive match on name, id, or description).
 */
function filterWorkflows(
  workflows: WorkflowSearchItem[],
  query: string,
): WorkflowSearchItem[] {
  if (!query) {
    return workflows;
  }
  const lowerQuery = query.toLowerCase();
  return workflows.filter(
    (w) =>
      w.name.toLowerCase().includes(lowerQuery) ||
      w.id.toLowerCase().includes(lowerQuery) ||
      (w.description?.toLowerCase().includes(lowerQuery) ?? false),
  );
}

/**
 * Displays the workflow get output for a selected workflow.
 */
async function displayWorkflowGet(
  item: WorkflowSearchItem,
  repo: YamlWorkflowRepository,
  options: AnyOptions,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["workflow", "search"]);
  const workflow = await repo.findByName(item.name);

  if (!workflow) {
    throw new Error(`Workflow not found: ${item.name}`);
  }

  const data: WorkflowGetData = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    version: workflow.version,
    jobs: workflow.jobs.map((job) => ({
      name: job.name,
      description: job.description,
      steps: job.steps.map((step) => ({
        name: step.name,
        description: step.description,
        task: step.task.toData(),
      })),
    })),
    path: repo.getPath(workflow.id),
  };

  renderWorkflowGet(data, ctx.outputMode);
}

export const workflowSearchCommand = new Command()
  .name("search")
  .description("Search for workflows")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "search"]);
    ctx.logger.debug`Searching workflows with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const repo = repoContext.workflowRepo;

    const allWorkflows = await repo.findAll();
    const searchItems = allWorkflows.map(toSearchItem);

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredWorkflows = filterWorkflows(searchItems, query ?? "");

      // If query matches exactly one workflow, show full details (same as interactive selection)
      if (query && filteredWorkflows.length === 1) {
        await displayWorkflowGet(filteredWorkflows[0], repo, options);
      } else {
        const data: WorkflowSearchData = {
          query: query ?? "",
          results: filteredWorkflows,
        };
        await renderWorkflowSearch(data, ctx.outputMode);
      }
    } else {
      // Interactive: show fuzzy search UI
      const data: WorkflowSearchData = {
        query: query ?? "",
        results: searchItems,
      };

      const selected = await renderWorkflowSearch(data, ctx.outputMode);

      if (selected) {
        ctx.logger.debug`Selected workflow: ${selected.name}`;
        // Display the workflow details
        await displayWorkflowGet(selected, repo, options);
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Workflow search command completed");
  });
