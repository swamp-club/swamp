import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  type ModelEditData,
  renderModelEdit,
} from "../../presentation/output/model_edit_output.ts";
import {
  type ModelSearchData,
  type ModelSearchItem,
  renderModelSearch,
} from "../../presentation/output/model_search_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import {
  Definition,
  type DefinitionData,
} from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
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

/**
 * Resolves the symlink at models/{name}/definition.yaml to find the actual
 * file path. Returns null if the symlink doesn't exist.
 */
export async function resolveModelSymlink(
  repoDir: string,
  name: string,
): Promise<string | null> {
  const symlinkPath = join(repoDir, "models", name, "definition.yaml");
  try {
    const realPath = await Deno.realPath(symlinkPath);
    return realPath;
  } catch {
    return null;
  }
}

export const modelEditCommand = new Command()
  .name("edit")
  .description("Edit a model definition file")
  .arguments("[model_id_or_name:model_name]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName?: string) {
    const ctx = createContext(options as GlobalOptions, ["model", "edit"]);
    ctx.logger.debug`Editing model: ${modelIdOrName ?? "(interactive)"}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const repoDir = options.repoDir ?? ".";
    const definitionRepo = repoContext.definitionRepo;
    const editorService = new EditorService();

    // Look up the model definition
    let definition: Definition | null = null;
    let modelType: ModelType | null = null;
    let filePath: string | null = null;

    if (!modelIdOrName) {
      // No argument provided - check if interactive mode
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Model ID or name is required in non-interactive mode",
        );
      }

      // Show search UI to select a model (resilient findAllGlobal skips broken files)
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
      filePath = definitionRepo.getPath(modelType, definition.id);
    } else {
      ctx.logger.debug`Looking up model: ${modelIdOrName}`;
      try {
        const result = await findDefinitionByIdOrName(
          definitionRepo,
          modelIdOrName,
        );
        if (result) {
          definition = result.definition;
          modelType = result.type;
          filePath = definitionRepo.getPath(modelType, definition.id);
        }
      } catch (error) {
        // Lookup failed (e.g. broken YAML in the target file) — will try symlink fallback below
        ctx.logger
          .debug`Model lookup failed, will try symlink fallback: ${error}`;
      }

      // If normal lookup didn't find the model, try symlink fallback
      if (!filePath) {
        const resolvedPath = await resolveModelSymlink(
          repoDir,
          modelIdOrName,
        );
        if (resolvedPath) {
          ctx.logger
            .debug`Using symlink fallback for broken model: ${resolvedPath}`;
          filePath = resolvedPath;
        } else {
          throw new UserError(`Model not found: ${modelIdOrName}`);
        }
      }
    }

    ctx.logger.debug`Using file path: ${filePath}`;

    // Check for stdin content (non-interactive update mode)
    const stdinContent = await readStdin();

    if (stdinContent !== null) {
      ctx.logger.debug`Reading model content from stdin`;

      if (!definition || !modelType) {
        throw new UserError(
          "Cannot update model from stdin: the model's YAML is broken and must be fixed in an editor first",
        );
      }

      try {
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
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError(
          `Invalid model YAML from stdin: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return;
    }

    ctx.logger.debug`Opening file: ${filePath}`;

    // Open the editor (auto-detects whether to wait based on editor type)
    const result = await editorService.openFile(filePath);

    const data: ModelEditData = {
      path: filePath,
      editor: result.editor,
      status: "opened",
      name: definition?.name ?? modelIdOrName ?? "unknown",
      type: modelType?.normalized ?? "unknown",
      editType: "definition",
    };

    renderModelEdit(data, ctx.outputMode);
    ctx.logger.debug("Model edit command completed");
  });
