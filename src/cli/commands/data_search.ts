// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  type DataGetData,
  dataSearch,
  type DataSearchDeps,
  type DataSearchItem,
  parseTags,
} from "../../libswamp/mod.ts";
import {
  createDataSearchRenderer,
  type DataPreviewDetail,
} from "../../presentation/renderers/data_search.tsx";
import { renderDataGet } from "../../presentation/renderers/data_get.ts";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { toRelativePath } from "../../infrastructure/persistence/paths.ts";
import type { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Creates a fetchPreview closure for the data search picker.
 * Reads data content from disk for display in the preview pane.
 */
function createDataFetchPreview(
  dataRepo: FileSystemUnifiedDataRepository,
  repoDir: string,
): (item: DataSearchItem) => Promise<DataPreviewDetail> {
  return async (item: DataSearchItem): Promise<DataPreviewDetail> => {
    const modelType = ModelType.create(item.modelType);
    const absoluteContentPath = dataRepo.getContentPath(
      modelType,
      item.modelId,
      item.name,
      item.version,
    );
    const contentPath = toRelativePath(repoDir, absoluteContentPath);

    // Only read text content for preview
    const isText = item.contentType.startsWith("text/") ||
      item.contentType === "application/json" ||
      item.contentType === "application/yaml" ||
      item.contentType === "application/x-yaml";

    if (!isText) {
      return { content: undefined, contentPath };
    }

    try {
      const rawContent = await dataRepo.getContent(
        modelType,
        item.modelId,
        item.name,
        item.version,
      );
      if (rawContent) {
        const content = new TextDecoder().decode(rawContent);
        return { content, contentPath };
      }
    } catch {
      // Silently handle read errors
    }

    return { content: undefined, contentPath };
  };
}

/**
 * Fetches and displays full data details after selection from interactive search.
 */
async function displayDataDetail(
  item: DataSearchItem,
  dataRepo: FileSystemUnifiedDataRepository,
  repoDir: string,
  outputMode: OutputMode,
): Promise<void> {
  const modelType = ModelType.create(item.modelType);

  // Re-fetch full Data entity
  const data = await dataRepo.findByName(
    modelType,
    item.modelId,
    item.name,
  );

  if (!data) {
    throw new UserError(
      `Data "${item.name}" not found for model "${item.modelName}"`,
    );
  }

  const absoluteContentPath = dataRepo.getContentPath(
    modelType,
    item.modelId,
    item.name,
    data.version,
  );

  // Build DataGetData for display
  const output: DataGetData = {
    id: data.id,
    name: data.name,
    modelId: item.modelId,
    modelName: item.modelName,
    modelType: modelType.normalized,
    version: data.version,
    contentType: data.contentType,
    lifetime: data.lifetime,
    garbageCollection: data.garbageCollection,
    streaming: data.streaming,
    tags: data.tags,
    ownerDefinition: data.ownerDefinition,
    createdAt: data.createdAt.toISOString(),
    size: data.size,
    checksum: data.checksum,
    contentPath: toRelativePath(repoDir, absoluteContentPath),
  };

  // Fetch raw content for display
  const rawContent = await dataRepo.getContent(
    modelType,
    item.modelId,
    item.name,
    data.version,
  );
  if (rawContent) {
    output.content = new TextDecoder().decode(rawContent);
  }

  renderDataGet(output, outputMode);
}

export const dataSearchCommand = new Command()
  .name("search")
  .description("Search for data across all models")
  .example("Interactive search", "swamp data search")
  .example("Search with query", "swamp data search cpu-metrics")
  .example("Search within a model", "swamp data search --model my-server")
  .arguments("[query:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--type <type:string>",
    "Filter by data type tag (log, file, resource, data, output)",
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
  .option(
    "--tag <tag:string>",
    "Filter by tag (KEY=VALUE, repeatable)",
    { collect: true },
  )
  .option("--streaming", "Only show streaming data")
  .option("--limit <n:number>", "Max results", { default: 50 })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["data", "search"]);
    const effectiveMode = interactiveOutputMode(ctx);
    const libCtx = createLibSwampContext();
    ctx.logger.debug`Searching data with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: effectiveMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const dataRepo = repoContext.unifiedDataRepo;

    // Parse --tag values into Record<string, string>
    const parsedTags = options.tag
      ? parseTags(options.tag as string[])
      : undefined;

    const deps: DataSearchDeps = {
      findAllGlobal: () => dataRepo.findAllGlobal(),
      findDefinitionById: (type, defId) =>
        definitionRepo.findById(
          ModelType.create(type.normalized),
          createDefinitionId(defId),
        ),
      findDefinitionByIdOrName: (idOrName) =>
        findDefinitionByIdOrName(definitionRepo, idOrName),
    };

    const repoDir = resolveRepoDir(options.repoDir);
    const fetchPreview = effectiveMode === "log"
      ? createDataFetchPreview(dataRepo, repoDir)
      : undefined;

    const renderer = createDataSearchRenderer(effectiveMode, fetchPreview);
    await consumeStream(
      dataSearch(libCtx, deps, {
        query,
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
        tags: parsedTags,
        limit: (options.limit as number) ?? 50,
      }),
      renderer.handlers(),
    );

    const selected = renderer.selectedItem();
    if (selected) {
      // In JSON mode, display full data detail after selection
      if (effectiveMode === "json") {
        await displayDataDetail(selected, dataRepo, repoDir, effectiveMode);
      }
      // In interactive mode, scrollback from the picker already has the detail
    }

    ctx.logger.debug("Data search command completed");
  });
