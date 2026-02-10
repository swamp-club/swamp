import { Command } from "@cliffy/command";
import {
  renderWorkflowDelete,
  renderWorkflowDeleteCancelled,
  type WorkflowDeleteData,
} from "../../presentation/output/workflow_delete_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
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

/**
 * Prompts user for confirmation in interactive mode.
 * Uses basic stdin reading for confirmation prompt.
 */
async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    return false;
  }

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowDeleteCommand = new Command()
  .name("delete")
  .description("Delete a workflow and its run history")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("-f, --force", "Skip confirmation prompt")
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "delete"]);
    ctx.logger.debug`Deleting workflow: ${workflowIdOrName}`;

    const { repoDir, repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const workflowRepo = repoContext.workflowRepo;
    const workflowRunRepo = repoContext.workflowRunRepo;

    // Look up the workflow
    let workflow: Workflow | null = null;

    if (isUuid(workflowIdOrName)) {
      ctx.logger.debug`Looking up by ID: ${workflowIdOrName}`;
      const id: WorkflowId = createWorkflowId(workflowIdOrName);
      workflow = await workflowRepo.findById(id);
    } else {
      ctx.logger.debug`Looking up by name: ${workflowIdOrName}`;
      workflow = await workflowRepo.findByName(workflowIdOrName);
    }

    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }

    ctx.logger.debug`Found workflow: id=${workflow.id}, name=${workflow.name}`;

    // Get path before deletion
    const workflowPath = workflowRepo.getPath(workflow.id);

    // Check how many runs exist
    const runs = await workflowRunRepo.findAllByWorkflowId(workflow.id);
    const runCount = runs.length;

    // In interactive mode without --force, prompt for confirmation
    if (ctx.outputMode === "log" && !options.force) {
      const runWarning = runCount > 0
        ? ` This will also delete ${runCount} run${runCount === 1 ? "" : "s"}.`
        : "";
      const confirmed = await promptConfirmation(
        `Delete workflow '${workflow.name}' (${workflow.id})?${runWarning}`,
      );
      if (!confirmed) {
        renderWorkflowDeleteCancelled(ctx.outputMode);
        return;
      }
    }

    // Delete workflow runs first
    let runsDeleted = 0;
    if (runCount > 0) {
      ctx.logger.debug`Deleting ${runCount} workflow runs`;
      runsDeleted = await workflowRunRepo.deleteAllByWorkflowId(workflow.id);
    }

    // Delete evaluated workflow if it exists
    const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(repoDir);
    ctx.logger.debug`Deleting evaluated workflow: ${workflow.id}`;
    await evaluatedWorkflowRepo.delete(workflow.id);

    // Delete the workflow (this will emit WorkflowDeleted event which cleans up logical views)
    ctx.logger.debug`Deleting workflow: ${workflow.id}`;
    await workflowRepo.delete(workflow.id);

    const data: WorkflowDeleteData = {
      id: workflow.id,
      name: workflow.name,
      workflowPath,
      runsDeleted,
    };

    renderWorkflowDelete(data, ctx.outputMode);
    ctx.logger.debug("Workflow delete command completed");
  });
