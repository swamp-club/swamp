import { Command } from "@cliffy/command";
import {
  type ModelDeleteData,
  renderModelDelete,
  renderModelDeleteCancelled,
} from "../../presentation/output/model_delete_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import type { ModelInput } from "../../domain/models/model_input.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { inputIdToResourceId } from "../../domain/models/model_resource.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import {
  findInputByIdGlobal,
  isUuid,
} from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

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

export const modelDeleteCommand = new Command()
  .name("delete")
  .description("Delete a model input")
  .arguments("<model_id_or_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "-f, --force",
    "Skip confirmation and allow deletion when resource exists",
  )
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, "model-delete");
    ctx.logger.debug`Deleting model: ${modelIdOrName}`;

    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);

    // Look up the model input
    let input: ModelInput;
    let modelType: ModelType;

    if (isUuid(modelIdOrName)) {
      ctx.logger.debug`Looking up by ID: ${modelIdOrName}`;
      const result = await findInputByIdGlobal(inputRepo, modelIdOrName);
      if (!result) {
        throw new UserError(`Model not found: ${modelIdOrName}`);
      }
      input = result.input;
      modelType = result.type;
    } else {
      ctx.logger.debug`Looking up by name: ${modelIdOrName}`;
      const result = await inputRepo.findByNameGlobal(modelIdOrName);
      if (!result) {
        throw new UserError(`Model not found: ${modelIdOrName}`);
      }
      input = result.input;
      modelType = result.type;
    }

    ctx.logger.debug`Found model: id=${input.id}, type=${modelType.normalized}`;

    // Check for associated resource (resource ID equals input ID)
    const resource = await resourceRepo.findById(
      modelType,
      inputIdToResourceId(input.id),
    );
    ctx.logger.debug`Resource exists: ${resource !== null}`;

    // If resource exists and no --force flag, block deletion
    if (resource && !options.force) {
      throw new UserError(
        `Model '${input.name}' has an associated resource. Use --force to delete both.`,
      );
    }

    // Get paths before deletion
    const inputPath = inputRepo.getPath(modelType, input.id);
    const resourcePath = resource
      ? resourceRepo.getPath(modelType, resource.id)
      : undefined;

    // In interactive mode without --force, prompt for confirmation
    if (ctx.outputMode === "interactive" && !options.force) {
      const confirmed = await promptConfirmation(
        `Delete model '${input.name}' (${input.id})?`,
      );
      if (!confirmed) {
        renderModelDeleteCancelled(ctx.outputMode);
        return;
      }
    }

    // Delete resource first if it exists
    if (resource) {
      ctx.logger.debug`Deleting resource: ${resource.id}`;
      await resourceRepo.delete(modelType, resource.id);
    }

    // Delete input
    ctx.logger.debug`Deleting input: ${input.id}`;
    await inputRepo.delete(modelType, input.id);

    const data: ModelDeleteData = {
      id: input.id,
      name: input.name,
      type: modelType.normalized,
      inputPath,
      resourcePath,
      resourceDeleted: resource !== null,
    };

    renderModelDelete(data, ctx.outputMode);
    ctx.logger.debug("Model delete command completed");
  });
