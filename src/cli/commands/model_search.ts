import { Command } from "@cliffy/command";
import {
  type ModelSearchData,
  type ModelSearchItem,
  renderModelSearch,
} from "../../presentation/output/model_search_output.tsx";
import {
  type ModelGetData,
  renderModelGet,
} from "../../presentation/output/model_get_output.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";

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
  definitionRepo: YamlDefinitionRepository,
  outputMode: OutputMode,
): Promise<void> {
  // Look up the full definition
  const definitionId = createDefinitionId(item.id);
  const modelType = modelRegistry.types().find(
    (t) => t.normalized === item.type,
  );

  if (!modelType) {
    throw new Error(`Unknown model type: ${item.type}`);
  }

  const definition = await definitionRepo.findById(modelType, definitionId);
  if (!definition) {
    throw new Error(`Model not found: ${item.id}`);
  }

  const data: ModelGetData = {
    id: definition.id,
    name: definition.name,
    type: modelType.normalized,
    version: definition.version,
    tags: definition.tags,
    attributes: definition.attributes,
  };

  renderModelGet(data, outputMode);
}

export const modelSearchCommand = new Command()
  .name("search")
  .description("Search for model definitions")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["model", "search"]);
    ctx.logger.debug`Searching models with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;

    // Get all models from repository
    const allResults = await definitionRepo.findAllGlobal();
    const allModels = toModelSearchItems(allResults);

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredModels = filterModels(allModels, query ?? "");

      // If query matches exactly one model, show full details (same as interactive selection)
      if (query && filteredModels.length === 1) {
        await displayModelGet(
          filteredModels[0],
          definitionRepo,
          ctx.outputMode,
        );
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
        await displayModelGet(selected, definitionRepo, ctx.outputMode);
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Model search command completed");
  });
