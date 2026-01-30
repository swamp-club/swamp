import { Command } from "@cliffy/command";
import {
  type ModelEditData,
  renderModelEdit,
} from "../../presentation/output/model_edit_output.tsx";
import {
  type ModelSearchData,
  type ModelSearchItem,
  renderModelSearch,
} from "../../presentation/output/model_search_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import type { ModelInput } from "../../domain/models/model_input.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { inputIdToResourceId } from "../../domain/models/model_resource.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { findByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts repository results to ModelSearchItem array.
 */
function toModelSearchItems(
  results: Awaited<ReturnType<YamlInputRepository["findAllGlobal"]>>,
): ModelSearchItem[] {
  return results.map(({ input, type }) => ({
    id: input.id,
    name: input.name,
    type: type.normalized,
    resourceId: input.resourceId,
  }));
}

export const modelEditCommand = new Command()
  .name("edit")
  .description("Edit a model input or resource file")
  .arguments("[model_id_or_name:model_name]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--resource", "Edit the resource file instead of the input")
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName?: string) {
    const ctx = createContext(options as GlobalOptions, "model-edit");
    ctx.logger.debug`Editing model: ${modelIdOrName ?? "(interactive)"}`;

    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);
    const editorService = new EditorService();
    const editResource = options.resource === true;

    // Look up the model input
    let input: ModelInput;
    let modelType: ModelType;

    if (!modelIdOrName) {
      // No argument provided - check if interactive mode
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Model ID or name is required in non-interactive mode",
        );
      }

      // Show search UI to select a model
      const allResults = await inputRepo.findAllGlobal();
      const allModels = toModelSearchItems(allResults);

      if (allModels.length === 0) {
        throw new UserError("No models found in repository");
      }

      const searchData: ModelSearchData = {
        query: "",
        results: allModels,
      };

      const selected = await renderModelSearch(searchData, ctx.outputMode);

      if (!selected) {
        ctx.logger.debug`Search cancelled`;
        return;
      }

      ctx.logger.debug`Selected model: ${selected.name} (${selected.id})`;

      // Find the full input data
      const result = await findByIdOrName(inputRepo, selected.id);
      if (!result) {
        throw new UserError(`Model not found: ${selected.id}`);
      }
      input = result.input;
      modelType = result.type;
    } else {
      ctx.logger.debug`Looking up model: ${modelIdOrName}`;
      const result = await findByIdOrName(inputRepo, modelIdOrName);
      if (!result) {
        throw new UserError(`Model not found: ${modelIdOrName}`);
      }
      input = result.input;
      modelType = result.type;
    }

    ctx.logger.debug`Found model: id=${input.id}, type=${modelType.normalized}`;

    // Get the file path
    let filePath: string;
    if (editResource) {
      const resourceId = inputIdToResourceId(input.id);
      filePath = resourceRepo.getPath(modelType, resourceId);

      // Check if resource file exists
      try {
        await Deno.stat(filePath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new UserError(
            `Resource file not found for model '${input.name}'. ` +
              `Run a method to create the resource first.`,
          );
        }
        throw error;
      }
    } else {
      filePath = inputRepo.getPath(modelType, input.id);
    }

    ctx.logger.debug`Opening file: ${filePath}`;

    // Open the editor (auto-detects whether to wait based on editor type)
    const result = await editorService.openFile(filePath);

    const data: ModelEditData = {
      path: filePath,
      editor: result.editor,
      status: "opened",
      name: input.name,
      type: modelType.normalized,
      editType: editResource ? "resource" : "input",
    };

    renderModelEdit(data, ctx.outputMode);
    ctx.logger.debug("Model edit command completed");
  });
