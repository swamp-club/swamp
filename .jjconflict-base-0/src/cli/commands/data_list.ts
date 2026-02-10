import { Command } from "@cliffy/command";
import {
  type DataGroupedByType,
  type DataListData,
  type DataListItem,
  renderDataList,
} from "../../presentation/output/data_list_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataListCommand = new Command()
  .name("list")
  .description("List all data for a model, grouped by type")
  .arguments("<model_id_or_name:model_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--type <type:string>",
    "Filter by data type (log, file, resource, data)",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["data", "list"]);
    ctx.logger.debug`Listing data for model: ${modelIdOrName}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const dataRepo = repoContext.unifiedDataRepo;

    // Look up the model definition
    ctx.logger.debug`Looking up model: ${modelIdOrName}`;
    const result = await findDefinitionByIdOrName(
      definitionRepo,
      modelIdOrName,
    );
    if (!result) {
      throw new UserError(`Model not found: ${modelIdOrName}`);
    }
    const { definition, type: modelType } = result;

    ctx.logger
      .debug`Found model: id=${definition.id}, type=${modelType.normalized}`;

    // Get all data for the model
    const allData = await dataRepo.findAllForModel(modelType, definition.id);

    // Filter by type if specified
    const typeFilter = options.type as string | undefined;
    const filteredData = typeFilter
      ? allData.filter((d) => d.type === typeFilter)
      : allData;

    // Group by type tag
    const groupedByType = new Map<string, DataListItem[]>();

    for (const data of filteredData) {
      const typeTag = data.type;
      if (!groupedByType.has(typeTag)) {
        groupedByType.set(typeTag, []);
      }
      groupedByType.get(typeTag)!.push({
        id: data.id,
        name: data.name,
        version: data.version,
        contentType: data.contentType,
        type: typeTag,
        streaming: data.streaming,
        size: data.size,
        createdAt: data.createdAt.toISOString(),
      });
    }

    // Sort groups by type name, with standard types first
    const standardTypes = ["log", "file", "resource", "data"];
    const groups: DataGroupedByType[] = [];

    // Add standard types first (in order)
    for (const type of standardTypes) {
      const items = groupedByType.get(type);
      if (items) {
        groups.push({
          type,
          items: items.sort((a, b) => a.name.localeCompare(b.name)),
        });
        groupedByType.delete(type);
      }
    }

    // Add remaining custom types
    const customTypes = Array.from(groupedByType.keys()).sort();
    for (const type of customTypes) {
      const items = groupedByType.get(type)!;
      groups.push({
        type,
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    const output: DataListData = {
      modelId: definition.id,
      modelName: definition.name,
      modelType: modelType.normalized,
      groups,
      total: filteredData.length,
    };

    renderDataList(output, ctx.outputMode);
    ctx.logger.debug("Data list command completed");
  });
