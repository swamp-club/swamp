import { Command } from "@cliffy/command";
import {
  type ModelDeleteData,
  renderModelDelete,
  renderModelDeleteCancelled,
} from "../../presentation/output/model_delete_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { inputIdToResourceId } from "../../domain/models/model_resource.ts";
import { inputIdToDataId } from "../../domain/models/model_data.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { YamlEvaluatedInputRepository } from "../../infrastructure/persistence/yaml_evaluated_input_repository.ts";
import { findByIdOrName } from "../../domain/models/model_lookup.ts";
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
    "Skip confirmation and allow deletion when resource exists",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, "model-delete");
    ctx.logger.debug`Deleting model: ${modelIdOrName}`;

    const repoDir = options.repoDir ?? ".";
    const repoContext = createRepositoryContext({ repoDir });
    const inputRepo = repoContext.inputRepo;
    const resourceRepo = repoContext.resourceRepo;
    const outputRepo = repoContext.outputRepo;
    const dataRepo = repoContext.dataRepo;
    const workflowRepo = repoContext.workflowRepo;

    // Look up the model input
    ctx.logger.debug`Looking up model: ${modelIdOrName}`;
    const result = await findByIdOrName(inputRepo, modelIdOrName);
    if (!result) {
      throw new UserError(`Model not found: ${modelIdOrName}`);
    }
    const { input, type: modelType } = result;

    ctx.logger.debug`Found model: id=${input.id}, type=${modelType.normalized}`;

    // Check if model is referenced in any workflow
    const allWorkflows = await workflowRepo.findAll();
    const referencingWorkflows = findWorkflowsReferencingModel(
      allWorkflows,
      input.id,
      input.name,
    );

    if (referencingWorkflows.length > 0) {
      const workflowNames = referencingWorkflows.map((w) => w.name).join(", ");
      throw new UserError(
        `Model '${input.name}' is referenced by workflow(s): ${workflowNames}. ` +
          `Remove the model from these workflows before deleting.`,
      );
    }

    // Check for associated resource (resource ID equals input ID)
    const resource = await resourceRepo.findById(
      modelType,
      inputIdToResourceId(input.id),
    );
    ctx.logger.debug`Resource exists: ${resource !== null}`;

    // If resource exists and no --force flag, block deletion
    if (resource && !options.force) {
      throw new UserError(
        `Model '${input.name}' has an associated resource. ` +
          `Delete the resource first, or use --force to delete both.`,
      );
    }

    // Get paths before deletion
    const inputPath = inputRepo.getPath(modelType, input.id);
    const resourcePath = resource
      ? resourceRepo.getPath(modelType, resource.id)
      : undefined;

    // Find outputs related to this model (use input.id as definitionId during migration)
    const outputs = await outputRepo.findByDefinition(
      modelType,
      input
        .id as unknown as import("../../domain/definitions/definition.ts").DefinitionId,
    );
    ctx.logger.debug`Found ${outputs.length} outputs to delete`;

    // Check for evaluated input
    const evaluatedInputRepo = new YamlEvaluatedInputRepository(repoDir);
    const evaluatedInput = await evaluatedInputRepo.findById(
      modelType,
      input.id,
    );
    ctx.logger.debug`Evaluated input exists: ${evaluatedInput !== null}`;

    // Check for data artifact (data uses the same ID as the input)
    const dataId = inputIdToDataId(input.id);
    const dataArtifact = await dataRepo.findById(modelType, dataId);
    ctx.logger.debug`Data artifact exists: ${dataArtifact !== null}`;

    // In interactive mode without --force, prompt for confirmation
    if (ctx.outputMode === "interactive" && !options.force) {
      let deleteDetails = "";
      if (outputs.length > 0) {
        deleteDetails += ` ${outputs.length} output(s),`;
      }
      if (evaluatedInput) {
        deleteDetails += " evaluated input,";
      }
      if (dataArtifact) {
        deleteDetails += " data artifact,";
      }
      if (resource) {
        deleteDetails += " resource,";
      }
      if (deleteDetails) {
        deleteDetails = ` This will also delete:${deleteDetails.slice(0, -1)}.`;
      }

      const confirmed = await promptConfirmation(
        `Delete model '${input.name}' (${input.id})?${deleteDetails}`,
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

    // Delete data artifact if it exists
    let dataDeleted = false;
    if (dataArtifact) {
      ctx.logger.debug`Deleting data artifact: ${dataId}`;
      await dataRepo.delete(modelType, dataId);
      dataDeleted = true;
    }

    // Delete evaluated input if it exists
    let evaluatedInputDeleted = false;
    if (evaluatedInput) {
      ctx.logger.debug`Deleting evaluated input: ${input.id}`;
      await evaluatedInputRepo.delete(modelType, input.id);
      evaluatedInputDeleted = true;
    }

    // Delete resource if it exists
    if (resource) {
      ctx.logger.debug`Deleting resource: ${resource.id}`;
      await resourceRepo.delete(modelType, resource.id);
    }

    // Delete input (this emits ModelDeleted event which cleans up logical views)
    ctx.logger.debug`Deleting input: ${input.id}`;
    await inputRepo.delete(modelType, input.id);

    const data: ModelDeleteData = {
      id: input.id,
      name: input.name,
      type: modelType.normalized,
      inputPath,
      resourcePath,
      resourceDeleted: resource !== null,
      outputsDeleted,
      evaluatedInputDeleted,
      dataDeleted,
    };

    renderModelDelete(data, ctx.outputMode);
    ctx.logger.debug("Model delete command completed");
  });
