// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  dataSearch,
  type DataSearchDeps,
  type DataSearchItem,
  parseTags,
} from "../../libswamp/data/search.ts";
import {
  createDataSearchRenderer,
  type DataPreviewDetail,
} from "../../presentation/renderers/data_search.tsx";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DataSearchResponse } from "../../serve/protocol.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { decodePreview } from "../../domain/data/content_encoding.ts";
import { canonicalOwnerType } from "../../domain/data/data_metadata.ts";
import { toRelativePath } from "../../infrastructure/persistence/paths.ts";
import type { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { findLatestItemsFromCatalog } from "../../infrastructure/persistence/catalog_search_adapter.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export function createDataFetchPreview(
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

    const isText = item.contentType.startsWith("text/") ||
      item.contentType === "application/json" ||
      item.contentType === "application/yaml" ||
      item.contentType === "application/x-yaml";

    if (!isText) {
      return { content: undefined, contentPath };
    }

    try {
      const bytes = await dataRepo.getContentPrefix(
        modelType,
        item.modelId,
        item.name,
        item.version,
        PREVIEW_BYTES + 1,
      );
      if (bytes) {
        const { text, truncated } = decodePreview(bytes, PREVIEW_BYTES);
        return {
          content: text,
          contentPath,
          ...(truncated ? { truncatedFrom: item.size } : {}),
        };
      }
    } catch {
      // Silently handle read errors
    }

    return { content: undefined, contentPath };
  };
}

const PREVIEW_BYTES = 64 * 1024;

export const dataSearchCommand = withRemoteOptions(
  new Command()
    .name("search")
    .description("Search for data across all behaviors")
    .example("Interactive search", "swamp data search")
    .example("Search with query", "swamp data search cpu-metrics")
    .example(
      "Search within a behavior",
      "swamp data search --behavior my-server",
    )
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
      "--lifecycle <lifecycle:string>",
      "Filter by lifecycle (active, deleted)",
    )
    .option(
      "--owner-type <type:string>",
      "Filter by owner type (behavior-method or model-method, workflow-step, manual)",
    )
    .option(
      "--workflow <name:string>",
      "Filter to data tagged with this workflow name",
    )
    .option(
      "--behavior, --model <name:string>",
      "Filter to data owned by this behavior name (--model is the kept legacy spelling)",
    )
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
      "Data from a specific behavior output (by output ID)",
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
    .option("--limit <n:number>", "Max results", { default: 50 }),
).action(async function (options: AnyOptions, query?: string) {
  const ctx = createContext(options as GlobalOptions, ["data", "search"]);
  const effectiveMode = interactiveOutputMode(ctx);
  // the behavior spellings in the stored model form, so the local search and a
  // serve filter on the same value.
  const model = options.behavior as string | undefined;
  const ownerType = options.ownerType === undefined
    ? undefined
    : canonicalOwnerType(options.ownerType as string);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const parsedTags = options.tag
      ? parseTags(options.tag as string[])
      : undefined;
    const response = await requestServerResponse<DataSearchResponse>(
      { server, token },
      {
        type: "data.search",
        payload: {
          query,
          type: options.type as string | undefined,
          lifetime: options.lifetime as string | undefined,
          lifecycle: options.lifecycle as string | undefined,
          ownerType,
          workflow: options.workflow as string | undefined,
          model,
          contentType: options.contentType as string | undefined,
          since: options.since as string | undefined,
          output: options.output as string | undefined,
          run: options.run as string | undefined,
          streaming: options.streaming as boolean | undefined,
          tags: parsedTags,
          limit: (options.limit as number) ?? 50,
        },
      },
    );
    // a remote search prints a plain list and never starts the picker.
    const renderer = createDataSearchRenderer(effectiveMode, undefined, {
      interactive: false,
    });
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response
            .data as unknown as import("../../libswamp/data/search.ts").DataSearchData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching data with query: ${query ?? "(none)"}`;

  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: effectiveMode,
  });
  const definitionRepo = repoContext.definitionRepo;
  const dataRepo = repoContext.unifiedDataRepo;
  const dataQueryService = repoContext.dataQueryService;
  const catalogStore = repoContext.catalogStore;

  const parsedTags = options.tag
    ? parseTags(options.tag as string[])
    : undefined;

  const deps: DataSearchDeps = {
    findLatestItems: () =>
      findLatestItemsFromCatalog(dataQueryService, catalogStore),
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
      lifecycle: options.lifecycle as string | undefined,
      ownerType,
      workflow: options.workflow as string | undefined,
      model,
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

  ctx.logger.debug("Data search command completed");
});
