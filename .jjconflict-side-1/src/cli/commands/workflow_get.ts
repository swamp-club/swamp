import { Command } from "@cliffy/command";
import {
  renderWorkflowGet,
  type WorkflowGetData,
} from "../../presentation/output/workflow_get_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import { UserError } from "../../domain/errors.ts";

/**
 * UUID v4 regex pattern for detecting if an argument is a UUID.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Checks if a string looks like a UUID.
 */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowGetCommand = new Command()
  .name("get")
  .description("Show details of a workflow")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "get"]);
    ctx.logger.debug`Getting workflow: ${workflowIdOrName}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const repo = repoContext.workflowRepo;

    // Look up the workflow
    let workflow: Workflow | null = null;

    if (isUuid(workflowIdOrName)) {
      ctx.logger.debug`Looking up by ID: ${workflowIdOrName}`;
      const id: WorkflowId = createWorkflowId(workflowIdOrName);
      workflow = await repo.findById(id);
    } else {
      ctx.logger.debug`Looking up by name: ${workflowIdOrName}`;
      workflow = await repo.findByName(workflowIdOrName);
    }

    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }

    ctx.logger.debug`Found workflow: id=${workflow.id}, name=${workflow.name}`;

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
    ctx.logger.debug("Workflow get command completed");
  });
