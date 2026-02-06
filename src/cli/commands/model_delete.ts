import { Command } from "@cliffy/command";
import {
  type ModelDeleteData,
  renderModelDelete,
  renderModelDeleteCancelled,
} from "../../presentation/output/model_delete_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

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

/**
 * Finds all workflows that reference a model by ID or name.
 */
function findWorkflowsReferencingModel(
  workflows: Workflow[],
  modelId: string,
  modelName: string,
): Workflow[] {
  const referencingWorkflows: Workflow[] = [];

  for (const workflow of workflows) {
    let found = false;
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (step.task.isModelMethod()) {
          const taskData = step.task.data;
          if (taskData.type === "model_method") {
            const ref = taskData.modelIdOrName;
            if (ref === modelId || ref === modelName) {
              found = true;
              break;
            }
          }
        }
      }
      if (found) break;
    }
    if (found) {
      referencingWorkflows.push(workflow);
    }
  }

  return referencingWorkflows;
}

export const modelDeleteCommand = new Command()
  .name("delete")
  .description("Delete a model and all related artifacts")
  .arguments("<model_id_or_name:model_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "-f, --force",
    "Skip confirmation and allow deletion when data artifacts exist",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["model", "delete"]);
    ctx.logger.debug`Deleting model: ${modelIdOrName}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const unifiedDataRepo = repoContext.unifiedDataRepo;
    const outputRepo = repoContext.outputRepo;
    const workflowRepo = repoContext.workflowRepo;

    // Look up the model definition
    ctx.logger.debug`Looking up model: ${modelIdOrName}`;
    const result = await findDefinitionByIdOrName(
      definitionRepo,
      modelIdOrName,
    );
    if (!result) {
      throw new UserError(`Model not found: ${modelIdOrName}`);
    }
    const { definition, type: modelType } = result;

    ctx.logger
      .debug`Found model: id=${definition.id}, type=${modelType.normalized}`;

    // Check if model is referenced in any workflow
    const allWorkflows = await workflowRepo.findAll();
    const referencingWorkflows = findWorkflowsReferencingModel(
      allWorkflows,
      definition.id,
      definition.name,
    );

    if (referencingWorkflows.length > 0) {
      const workflowNames = referencingWorkflows.map((w) => w.name).join(", ");
      throw new UserError(
        `Model '${definition.name}' is referenced by workflow(s): ${workflowNames}. ` +
          `Remove the model from these workflows before deleting.`,
      );
    }

    // Find data artifacts for this model
    const dataArtifacts = await unifiedDataRepo.findAllForModel(
      modelType,
      definition.id,
    );
    ctx.logger
      .debug`Found ${dataArtifacts.length} data artifacts for this model`;

    // If data artifacts exist and no --force flag, block deletion
    if (dataArtifacts.length > 0 && !options.force) {
      throw new UserError(
        `Model '${definition.name}' has ${dataArtifacts.length} associated data artifact(s). ` +
          `Delete the data first, or use --force to delete all.`,
      );
    }

    // Get paths before deletion
    const definitionPath = definitionRepo.getPath(modelType, definition.id);

    // Find outputs related to this model
    const outputs = await outputRepo.findByDefinition(
      modelType,
      definition.id,
    );
    ctx.logger.debug`Found ${outputs.length} outputs to delete`;

    // In interactive mode without --force, prompt for confirmation
    if (ctx.outputMode === "log" && !options.force) {
      let deleteDetails = "";
      if (outputs.length > 0) {
        deleteDetails += ` ${outputs.length} output(s),`;
      }
      if (dataArtifacts.length > 0) {
        deleteDetails += ` ${dataArtifacts.length} data artifact(s),`;
      }
      if (deleteDetails) {
        deleteDetails = ` This will also delete:${deleteDetails.slice(0, -1)}.`;
      }

      const confirmed = await promptConfirmation(
        `Delete model '${definition.name}' (${definition.id})?${deleteDetails}`,
      );
      if (!confirmed) {
        renderModelDeleteCancelled(ctx.outputMode);
        return;
      }
    }

    // Delete outputs first
    let outputsDeleted = 0;
    for (const output of outputs) {
      ctx.logger.debug`Deleting output: ${output.id}`;
      await outputRepo.delete(modelType, output.methodName, output.id);
      outputsDeleted++;
    }

    // Delete data artifacts
    let dataDeleted = false;
    for (const data of dataArtifacts) {
      ctx.logger.debug`Deleting data artifact: ${data.name}`;
      await unifiedDataRepo.delete(modelType, definition.id, data.name);
      dataDeleted = true;
    }

    // Delete definition (this emits DefinitionDeleted event which cleans up logical views)
    ctx.logger.debug`Deleting definition: ${definition.id}`;
    await definitionRepo.delete(modelType, definition.id);

    const data: ModelDeleteData = {
      id: definition.id,
      name: definition.name,
      type: modelType.normalized,
      inputPath: definitionPath,
      resourcePath: undefined,
      resourceDeleted: false,
      outputsDeleted,
      evaluatedInputDeleted: false,
      dataDeleted,
    };

    renderModelDelete(data, ctx.outputMode);
    ctx.logger.debug("Model delete command completed");
  });
