import { Command } from "@cliffy/command";
import {
  type ModelSearchData,
  type ModelSearchItem,
  renderModelSearch,
} from "../../presentation/output/model_search_output.tsx";
import {
  type ModelGetData,
  renderModelGet,
  type ResourceData,
} from "../../presentation/output/model_get_output.tsx";
import type { OutputMode } from "../../presentation/output/output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { createModelInputId } from "../../domain/models/model_input.ts";
import { inputIdToResourceId } from "../../domain/models/model_resource.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";

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
  }));
}

/**
 * Filters models by a query string (case-insensitive match on name, type, or id).
 */
export function filterModels(
  models: ModelSearchItem[],
  query: string,
): ModelSearchItem[] {
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
  item: ModelSearchItem,
  repoDir: string,
  outputMode: OutputMode,
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
  const resource = await resourceRepo.findById(
    modelType,
    inputIdToResourceId(input.id),
  );

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

export const modelSearchCommand = new Command()
  .name("search")
  .description("Search for model inputs")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, "model-search");
    ctx.logger.debug`Searching models with query: ${query ?? "(none)"}`;

    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);

    // Get all models from repository
    const allResults = await inputRepo.findAllGlobal();
    const allModels = toModelSearchItems(allResults);

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredModels = filterModels(allModels, query ?? "");

      // If query matches exactly one model, show full details (same as interactive selection)
      if (query && filteredModels.length === 1) {
        await displayModelGet(filteredModels[0], repoDir, ctx.outputMode);
      } else {
        const data: ModelSearchData = {
          query: query ?? "",
          results: filteredModels,
        };
        await renderModelSearch(data, ctx.outputMode);
      }
    } else {
      // Interactive: show fuzzy search UI
      const data: ModelSearchData = {
        query: query ?? "",
        results: allModels,
      };

      const selected = await renderModelSearch(data, ctx.outputMode);

      if (selected) {
        ctx.logger.debug`Selected model: ${selected.name} (${selected.id})`;
        // Display the full model details
        await displayModelGet(selected, repoDir, ctx.outputMode);
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Model search command completed");
  });
