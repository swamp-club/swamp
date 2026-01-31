import { Command } from "@cliffy/command";
import {
  type ModelOutputSearchData,
  type ModelOutputSearchItem,
  renderModelOutputSearch,
} from "../../presentation/output/model_output_search_output.tsx";
import {
  type ModelOutputGetData,
  renderModelOutputGet,
} from "../../presentation/output/model_output_get_output.tsx";
import type { OutputMode } from "../../presentation/output/output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
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
  inputRepo: YamlInputRepository,
): Promise<ModelOutputSearchItem[]> {
  const items: ModelOutputSearchItem[] = [];

  for (const { output, type } of results) {
    // Try to get model name
    let modelName: string | undefined;
    const input = await inputRepo.findById(type, output.modelInputId);
    if (input) {
      modelName = input.name;
    }

    items.push({
      id: output.id,
      modelInputId: output.modelInputId,
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
      o.modelInputId.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Displays the model output get output for a selected output.
 */
async function displayModelOutputGet(
  item: ModelOutputSearchItem,
  repoDir: string,
  outputMode: OutputMode,
): Promise<void> {
  const inputRepo = new YamlInputRepository(repoDir);
  const outputRepo = new YamlOutputRepository(repoDir);

  // Look up the full output
  const allOutputs = await outputRepo.findAllGlobal();
  const result = allOutputs.find((r) => r.output.id === item.id);

  if (!result) {
    throw new Error(`Output not found: ${item.id}`);
  }

  const { output, type } = result;

  // Try to get model name
  let modelName: string | undefined;
  const input = await inputRepo.findById(type, output.modelInputId);
  if (input) {
    modelName = input.name;
  }

  const data: ModelOutputGetData = {
    id: output.id,
    modelInputId: output.modelInputId,
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
    const ctx = createContext(options as GlobalOptions, "model-output-search");
    ctx.logger.debug`Searching outputs with query: ${query ?? "(none)"}`;

    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);
    const outputRepo = new YamlOutputRepository(repoDir);

    // Get all outputs from repository
    const allResults = await outputRepo.findAllGlobal();
    const allOutputs = await toModelOutputSearchItems(allResults, inputRepo);

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
        await displayModelOutputGet(selected, repoDir, ctx.outputMode);
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Model output search command completed");
  });
