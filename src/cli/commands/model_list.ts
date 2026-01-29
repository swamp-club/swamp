import { Command } from "@cliffy/command";
import {
  type ModelListData,
  type ModelListItem,
  renderModelList,
} from "../../presentation/output/model_list_output.tsx";
import {
  type ModelGetData,
  renderModelGet,
  type ResourceData,
} from "../../presentation/output/model_get_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { createModelInputId } from "../../domain/models/model_input.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts repository results to ModelListItem array.
 */
function toModelListItems(
  results: Awaited<ReturnType<YamlInputRepository["findAllGlobal"]>>,
): ModelListItem[] {
  return results.map(({ input, type }) => ({
    id: input.id,
    name: input.name,
    type: type.normalized,
    resourceId: input.resourceId,
  }));
}

/**
 * Filters models by a query string (case-insensitive match on name, type, or id).
 */
export function filterModels(
  models: ModelListItem[],
  query: string,
): ModelListItem[] {
  if (!query) {
    return models;
  }
  const lowerQuery = query.toLowerCase();
  return models.filter(
    (m) =>
      m.name.toLowerCase().includes(lowerQuery) ||
      m.type.toLowerCase().includes(lowerQuery) ||
      m.id.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Displays the model get output for a selected model.
 */
async function displayModelGet(
  item: ModelListItem,
  repoDir: string,
  outputMode: "interactive" | "json",
): Promise<void> {
  const inputRepo = new YamlInputRepository(repoDir);
  const resourceRepo = new YamlResourceRepository(repoDir);

  // Look up the full input
  const inputId = createModelInputId(item.id);
  const modelType = modelRegistry.types().find(
    (t) => t.normalized === item.type,
  );

  if (!modelType) {
    throw new Error(`Unknown model type: ${item.type}`);
  }

  const input = await inputRepo.findById(modelType, inputId);
  if (!input) {
    throw new Error(`Model not found: ${item.id}`);
  }

  // Load the resource if it exists
  const resource = await resourceRepo.findByInputId(modelType, input.id);

  // Build resource data
  let resourceData: ResourceData | undefined;
  if (resource) {
    resourceData = {
      id: resource.id,
      createdAt: resource.createdAt.toISOString(),
      attributes: resource.attributes,
    };
  }

  const data: ModelGetData = {
    id: input.id,
    name: input.name,
    type: modelType.normalized,
    version: input.version,
    tags: input.tags,
    attributes: input.attributes,
    resource: resourceData,
  };

  renderModelGet(data, outputMode);
}

export const modelListCommand = new Command()
  .name("list")
  .description("List and search model inputs")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, "model-list");
    ctx.logger.debug`Listing models with query: ${query ?? "(none)"}`;

    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);

    // Get all models from repository
    const allResults = await inputRepo.findAllGlobal();
    const allModels = toModelListItems(allResults);

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredModels = filterModels(allModels, query ?? "");
      const data: ModelListData = {
        query: query ?? "",
        results: filteredModels,
      };
      await renderModelList(data, ctx.outputMode);
    } else {
      // Interactive: show fuzzy search UI
      const data: ModelListData = {
        query: query ?? "",
        results: allModels,
      };

      const selected = await renderModelList(data, ctx.outputMode);

      if (selected) {
        ctx.logger.debug`Selected model: ${selected.name} (${selected.id})`;
        // Display the full model details
        await displayModelGet(selected, repoDir, ctx.outputMode);
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Model list command completed");
  });
