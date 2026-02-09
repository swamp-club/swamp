import { Command } from "@cliffy/command";
import {
  type DataSearchData,
  type DataSearchItem,
  renderDataSearch,
} from "../../presentation/output/data_search_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import type { Data } from "../../domain/data/data.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Options for filtering data search results.
 */
export interface DataSearchFilterOptions {
  type?: string;
  lifetime?: string;
  ownerType?: string;
  workflow?: string;
  model?: string;
  contentType?: string;
  since?: string;
  output?: string;
  run?: string;
  streaming?: boolean;
  query?: string;
}

/**
 * Parses a duration string (e.g., "1h", "1d", "7d", "1w", "1mo") to milliseconds.
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(mo|y|h|m|d|w)$/);
  if (!match) {
    throw new UserError(
      `Invalid duration format: "${duration}". Expected format like 1h, 1d, 7d, 1w, 1mo`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "mo":
      return value * 30 * 24 * 60 * 60 * 1000;
    case "y":
      return value * 365 * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      throw new UserError(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Converts raw repository data to DataSearchItem array.
 */
async function toDataSearchItems(
  results: Array<{ data: Data; modelType: ModelType; modelId: string }>,
  definitionRepo: YamlDefinitionRepository,
): Promise<DataSearchItem[]> {
  const items: DataSearchItem[] = [];

  for (const { data, modelType, modelId } of results) {
    let modelName = modelId;
    const definition = await definitionRepo.findById(
      modelType,
      createDefinitionId(modelId),
    );
    if (definition) {
      modelName = definition.name;
    }

    items.push({
      id: data.id,
      name: data.name,
      version: data.version,
      contentType: data.contentType,
      type: data.type,
      lifetime: data.lifetime,
      ownerType: data.ownerDefinition.ownerType,
      ownerRef: data.ownerDefinition.ownerRef,
      modelId,
      modelName,
      modelType: modelType.normalized,
      streaming: data.streaming,
      size: data.size,
      createdAt: data.createdAt.toISOString(),
      workflowTag: data.tags.workflow,
      stepTag: data.tags.step,
    });
  }

  return items;
}

/**
 * Filters data search items according to the provided options.
 * All filters combine with AND logic.
 */
export function filterData(
  items: DataSearchItem[],
  opts: DataSearchFilterOptions,
): DataSearchItem[] {
  let result = items;

  if (opts.type) {
    result = result.filter((i) => i.type === opts.type);
  }
  if (opts.lifetime) {
    result = result.filter((i) => i.lifetime === opts.lifetime);
  }
  if (opts.ownerType) {
    result = result.filter((i) => i.ownerType === opts.ownerType);
  }
  if (opts.workflow) {
    result = result.filter((i) => i.workflowTag === opts.workflow);
  }
  if (opts.model) {
    result = result.filter((i) => i.modelName === opts.model);
  }
  if (opts.contentType) {
    result = result.filter((i) => i.contentType === opts.contentType);
  }
  if (opts.streaming) {
    result = result.filter((i) => i.streaming);
  }
  if (opts.since) {
    const cutoff = Date.now() - parseDuration(opts.since);
    result = result.filter((i) => new Date(i.createdAt).getTime() >= cutoff);
  }
  if (opts.output) {
    const outputId = opts.output;
    result = result.filter((i) =>
      i.ownerRef.includes(outputId) || i.id === outputId
    );
  }
  if (opts.run) {
    const runId = opts.run;
    result = result.filter((i) => i.ownerRef.includes(runId));
  }

  if (opts.query) {
    const q = opts.query.toLowerCase();
    result = result.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q) ||
        i.modelName.toLowerCase().includes(q) ||
        i.ownerRef.toLowerCase().includes(q),
    );
  }

  return result;
}

export const dataSearchCommand = new Command()
  .name("search")
  .description("Search for data across all models")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--type <type:string>",
    "Filter by data type tag (log, file, resource, data, step-output)",
  )
  .option(
    "--lifetime <lifetime:string>",
    "Filter by lifetime (ephemeral, infinite, job, workflow, or duration)",
  )
  .option(
    "--owner-type <type:string>",
    "Filter by owner type (model-method, workflow-step, manual)",
  )
  .option(
    "--workflow <name:string>",
    "Filter to data tagged with this workflow name",
  )
  .option("--model <name:string>", "Filter to data owned by this model name")
  .option(
    "--content-type <mime:string>",
    "Filter by MIME content type (e.g., application/json)",
  )
  .option(
    "--since <duration:string>",
    "Only data created within duration (1h, 1d, 7d, 1w, 1mo)",
  )
  .option(
    "--output <output_id:string>",
    "Data from a specific model output (by output ID)",
  )
  .option(
    "--run <run_id:string>",
    "Data from a specific workflow run (by run ID)",
  )
  .option("--streaming", "Only show streaming data")
  .option("--limit <n:number>", "Max results", { default: 50 })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["data", "search"]);
    ctx.logger.debug`Searching data with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const dataRepo = repoContext.unifiedDataRepo;

    // Validate --model if provided
    if (options.model) {
      const modelResult = await findDefinitionByIdOrName(
        definitionRepo,
        options.model as string,
      );
      if (!modelResult) {
        throw new UserError(`Model not found: ${options.model}`);
      }
    }

    // Get all data from repository
    const allResults = await dataRepo.findAllGlobal();
    const allItems = await toDataSearchItems(allResults, definitionRepo);

    // Build filter options
    const filterOpts: DataSearchFilterOptions = {
      type: options.type as string | undefined,
      lifetime: options.lifetime as string | undefined,
      ownerType: options.ownerType as string | undefined,
      workflow: options.workflow as string | undefined,
      model: options.model as string | undefined,
      contentType: options.contentType as string | undefined,
      since: options.since as string | undefined,
      output: options.output as string | undefined,
      run: options.run as string | undefined,
      streaming: options.streaming as boolean | undefined,
      query,
    };

    // Apply filters
    const filtered = filterData(allItems, filterOpts);

    // Sort by createdAt descending (most recent first)
    filtered.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    // Apply limit
    const limit = (options.limit as number) ?? 50;
    const total = filtered.length;
    const limited = total > limit;
    const results = filtered.slice(0, limit);

    // Build active filters for output
    const filters: Record<string, string> = {};
    if (options.type) filters.type = options.type as string;
    if (options.lifetime) filters.lifetime = options.lifetime as string;
    if (options.ownerType) filters.ownerType = options.ownerType as string;
    if (options.workflow) filters.workflow = options.workflow as string;
    if (options.model) filters.model = options.model as string;
    if (options.contentType) {
      filters.contentType = options.contentType as string;
    }
    if (options.since) filters.since = options.since as string;
    if (options.output) filters.output = options.output as string;
    if (options.run) filters.run = options.run as string;
    if (options.streaming) filters.streaming = "true";

    const data: DataSearchData = {
      query: query ?? "",
      filters,
      results,
      total,
      limited,
    };

    renderDataSearch(data, ctx.outputMode);
    ctx.logger.debug("Data search command completed");
  });
