import { Command } from "@cliffy/command";
import {
  type ModelOutputSearchData,
  type ModelOutputSearchItem,
  renderModelOutputSearch,
} from "../../presentation/output/model_output_search_output.tsx";
import {
  type ModelOutputGetData,
  renderModelOutputGet,
} from "../../presentation/output/model_output_get_output.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { ModelOutput } from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";

// Cliffy's custom type system returns `unknown` for custom types like `model_name`,
// but we need to pass `options` to functions expecting specific types. Using `any`
// here is the pragmatic workaround for Cliffy's type inference limitations.
// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts repository results to ModelOutputSearchItem array.
 */
async function toModelOutputSearchItems(
  results: { output: ModelOutput; type: ModelType; method: string }[],
  definitionRepo: YamlDefinitionRepository,
): Promise<ModelOutputSearchItem[]> {
  const items: ModelOutputSearchItem[] = [];

  for (const { output, type } of results) {
    // Try to get model name using definitionId
    let modelName: string | undefined;
    const definition = await definitionRepo.findById(type, output.definitionId);
    if (definition) {
      modelName = definition.name;
    }

    items.push({
      id: output.id,
      definitionId: output.definitionId,
      modelName,
      type: type.normalized,
      methodName: output.methodName,
      status: output.status,
      startedAt: output.startedAt.toISOString(),
      durationMs: output.durationMs,
    });
  }

  // Sort by startedAt descending (most recent first)
  items.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  return items;
}

/**
 * Filters outputs by a query string (case-insensitive match on model name, type, method, status, or id).
 */
export function filterOutputs(
  outputs: ModelOutputSearchItem[],
  query: string,
): ModelOutputSearchItem[] {
  if (!query) {
    return outputs;
  }
  const lowerQuery = query.toLowerCase();
  return outputs.filter(
    (o) =>
      (o.modelName?.toLowerCase().includes(lowerQuery) ?? false) ||
      o.type.toLowerCase().includes(lowerQuery) ||
      o.methodName.toLowerCase().includes(lowerQuery) ||
      o.status.toLowerCase().includes(lowerQuery) ||
      o.id.toLowerCase().includes(lowerQuery) ||
      o.definitionId.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Displays the model output get output for a selected output.
 */
async function displayModelOutputGet(
  item: ModelOutputSearchItem,
  definitionRepo: YamlDefinitionRepository,
  outputRepo: YamlOutputRepository,
  outputMode: OutputMode,
): Promise<void> {
  // Look up the full output
  const allOutputs = await outputRepo.findAllGlobal();
  const result = allOutputs.find((r) => r.output.id === item.id);

  if (!result) {
    throw new Error(`Output not found: ${item.id}`);
  }

  const { output, type } = result;

  // Try to get model name using definitionId
  let modelName: string | undefined;
  const definition = await definitionRepo.findById(type, output.definitionId);
  if (definition) {
    modelName = definition.name;
  }

  const data: ModelOutputGetData = {
    id: output.id,
    definitionId: output.definitionId,
    modelName,
    type: type.normalized,
    methodName: output.methodName,
    status: output.status,
    startedAt: output.startedAt.toISOString(),
    completedAt: output.completedAt?.toISOString(),
    durationMs: output.durationMs,
    retryCount: output.retryCount,
    provenance: output.provenance,
    artifacts: output.artifacts,
    error: output.error,
  };

  renderModelOutputGet(data, outputMode);
}

export const modelOutputSearchCommand = new Command()
  .name("search")
  .description("Search for model outputs")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "search",
    ]);
    ctx.logger.debug`Searching outputs with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const outputRepo = repoContext.outputRepo;

    // Get all outputs from repository
    const allResults = await outputRepo.findAllGlobal();
    const allOutputs = await toModelOutputSearchItems(
      allResults,
      definitionRepo,
    );

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredOutputs = filterOutputs(allOutputs, query ?? "");
      const data: ModelOutputSearchData = {
        query: query ?? "",
        results: filteredOutputs,
      };
      await renderModelOutputSearch(data, ctx.outputMode);
    } else {
      // Interactive: show fuzzy search UI
      const data: ModelOutputSearchData = {
        query: query ?? "",
        results: allOutputs,
      };

      const selected = await renderModelOutputSearch(data, ctx.outputMode);

      if (selected) {
        ctx.logger.debug`Selected output: ${selected.id}`;
        // Display the full output details
        await displayModelOutputGet(
          selected,
          definitionRepo,
          outputRepo,
          ctx.outputMode,
        );
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Model output search command completed");
  });
