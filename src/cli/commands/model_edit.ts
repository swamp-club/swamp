import { Command } from "@cliffy/command";
import { parse as parseYaml } from "@std/yaml";
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
import {
  Definition,
  type DefinitionData,
} from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts repository results to ModelSearchItem array.
 */
function toModelSearchItems(
  results: Awaited<ReturnType<YamlDefinitionRepository["findAllGlobal"]>>,
): ModelSearchItem[] {
  return results.map(({ definition, type }) => ({
    id: definition.id,
    name: definition.name,
    type: type.normalized,
  }));
}

export const modelEditCommand = new Command()
  .name("edit")
  .description("Edit a model definition file")
  .arguments("[model_id_or_name:model_name]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName?: string) {
    const ctx = createContext(options as GlobalOptions, "model-edit");
    ctx.logger.debug`Editing model: ${modelIdOrName ?? "(interactive)"}`;

    const repoDir = options.repoDir ?? ".";
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const editorService = new EditorService();

    // Look up the model definition
    let definition: Definition;
    let modelType: ModelType;

    if (!modelIdOrName) {
      // No argument provided - check if interactive mode
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Model ID or name is required in non-interactive mode",
        );
      }

      // Show search UI to select a model
      const allResults = await definitionRepo.findAllGlobal();
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

      // Find the full definition data
      const result = await findDefinitionByIdOrName(
        definitionRepo,
        selected.id,
      );
      if (!result) {
        throw new UserError(`Model not found: ${selected.id}`);
      }
      definition = result.definition;
      modelType = result.type;
    } else {
      ctx.logger.debug`Looking up model: ${modelIdOrName}`;
      const result = await findDefinitionByIdOrName(
        definitionRepo,
        modelIdOrName,
      );
      if (!result) {
        throw new UserError(`Model not found: ${modelIdOrName}`);
      }
      definition = result.definition;
      modelType = result.type;
    }

    ctx.logger
      .debug`Found model: id=${definition.id}, type=${modelType.normalized}`;

    // Get the file path
    const filePath = definitionRepo.getPath(modelType, definition.id);

    // Check for stdin content (non-interactive update mode)
    const stdinContent = await readStdin();

    if (stdinContent !== null) {
      ctx.logger.debug`Reading model content from stdin`;

      // Parse YAML content from stdin
      const yamlData = parseYaml(stdinContent) as DefinitionData;

      // Preserve the original ID to ensure we update the same model
      yamlData.id = definition.id;

      // Validate and create domain object
      const updatedDefinition = Definition.fromData(yamlData);

      // Save via repository (emits events for indexing)
      await definitionRepo.save(modelType, updatedDefinition);

      const data: ModelEditData = {
        path: filePath,
        status: "updated",
        name: updatedDefinition.name,
        type: modelType.normalized,
        editType: "definition",
      };

      renderModelEdit(data, ctx.outputMode);
      ctx.logger.debug("Model updated from stdin");
      return;
    }

    ctx.logger.debug`Opening file: ${filePath}`;

    // Open the editor (auto-detects whether to wait based on editor type)
    const result = await editorService.openFile(filePath);

    const data: ModelEditData = {
      path: filePath,
      editor: result.editor,
      status: "opened",
      name: definition.name,
      type: modelType.normalized,
      editType: "definition",
    };

    renderModelEdit(data, ctx.outputMode);
    ctx.logger.debug("Model edit command completed");
  });
