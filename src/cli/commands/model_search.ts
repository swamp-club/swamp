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
import {
  consumeStream,
  createLibSwampContext,
  createModelGetDeps,
  modelGet,
  type ModelGetData,
  modelSearch,
  type ModelSearchData,
  type ModelSearchDeps,
  type ModelSearchItem,
} from "../../libswamp/mod.ts";
import { createModelSearchRenderer } from "../../presentation/renderers/model_search.tsx";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelSearchResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Creates a fetchPreview closure that fetches full model detail data.
 * This bridges the presentation layer to the libswamp modelGet application
 * service, capturing the repoDir dependency.
 */
async function createModelFetchPreview(
  repoDir: string,
): Promise<(item: ModelSearchItem) => Promise<ModelGetData>> {
  const libCtx = createLibSwampContext();
  const getDeps = await createModelGetDeps(repoDir);

  return async (item: ModelSearchItem): Promise<ModelGetData> => {
    let result: ModelGetData | undefined;
    await consumeStream(modelGet(libCtx, getDeps, item.name), {
      resolving: () => {},
      completed: (e) => {
        result = e.data;
      },
      error: () => {},
    });
    if (!result) {
      throw new Error(`Model not found: ${item.name}`);
    }
    return result;
  };
}

export async function modelSearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["model", "search"]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<ModelSearchResponse>(
      { server, token },
      {
        type: "model.search",
        payload: { query },
      },
    );
    const renderer = createModelSearchRenderer(ctx.outputMode);
    renderer.handlers().completed({
      kind: "completed",
      data: response.data as unknown as ModelSearchData,
    });
    return;
  }

  const effectiveMode = interactiveOutputMode(ctx);
  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching models with query: ${query ?? "(none)"}`;

  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: effectiveMode,
  });

  const deps: ModelSearchDeps = {
    findAllGlobal: () => repoContext.definitionRepo.findAllGlobal(),
  };

  const repoDir = resolveRepoDir(options.repoDir);
  const fetchPreview = effectiveMode === "log"
    ? await createModelFetchPreview(repoDir)
    : undefined;

  const renderer = createModelSearchRenderer(effectiveMode, fetchPreview);
  await consumeStream(
    modelSearch(libCtx, deps, { query }),
    renderer.handlers(),
  );

  const selected = renderer.selectedItem();
  if (selected) {
    ctx.logger.debug`Selected model: ${selected.name} (${selected.id})`;
  } else {
    ctx.logger.debug`Search completed`;
  }

  ctx.logger.debug("Model search command completed");
}

export const modelSearchCommand = withRemoteOptions(
  new Command()
    .name("search")
    .description("Search for model definitions")
    .example("Browse all models", "swamp model search")
    .example("Search by keyword", "swamp model search aws")
    .arguments("[query:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(modelSearchAction);
