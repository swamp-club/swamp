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
  createModelOutputGetDeps,
  modelOutputGet,
  type ModelOutputGetData,
  modelOutputSearch,
  type ModelOutputSearchDeps,
  type ModelOutputSearchItem,
} from "../../libswamp/mod.ts";
import { createModelOutputSearchRenderer } from "../../presentation/renderers/model_output_search.tsx";
import { createModelOutputGetRenderer } from "../../presentation/renderers/model_output_get.ts";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Creates a fetchPreview closure that fetches full model output detail data.
 * This bridges the presentation layer to the libswamp modelOutputGet application
 * service, capturing the repoDir dependency.
 */
async function createOutputFetchPreview(
  repoDir: string,
): Promise<(item: ModelOutputSearchItem) => Promise<ModelOutputGetData>> {
  const libCtx = createLibSwampContext();
  const getDeps = await createModelOutputGetDeps(repoDir);

  return async (item: ModelOutputSearchItem): Promise<ModelOutputGetData> => {
    let result: ModelOutputGetData | undefined;
    await consumeStream(modelOutputGet(libCtx, getDeps, item.id), {
      resolving: () => {},
      completed: (e) => {
        result = e.data;
      },
      error: () => {},
    });
    if (!result) {
      throw new Error(`Output not found: ${item.id}`);
    }
    return result;
  };
}

export const modelOutputSearchCommand = new Command()
  .name("search")
  .description("Search for model outputs")
  .example("Browse all outputs", "swamp model output search")
  .example("Search by keyword", "swamp model output search deploy")
  .arguments("[query:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "search",
    ]);
    const effectiveMode = interactiveOutputMode(ctx);
    const libCtx = createLibSwampContext();
    ctx.logger.debug`Searching outputs with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: effectiveMode,
    });

    const deps: ModelOutputSearchDeps = {
      findAllOutputsGlobal: () => repoContext.outputRepo.findAllGlobal(),
      findDefinitionById: (type, defId) =>
        repoContext.definitionRepo.findById(
          ModelType.create(type.normalized),
          createDefinitionId(defId),
        ),
    };

    const repoDir = resolveRepoDir(options.repoDir);
    const fetchPreview = effectiveMode === "log"
      ? await createOutputFetchPreview(repoDir)
      : undefined;

    const renderer = createModelOutputSearchRenderer(
      effectiveMode,
      fetchPreview,
    );
    await consumeStream(
      modelOutputSearch(libCtx, deps, { query }),
      renderer.handlers(),
    );

    const selected = renderer.selectedItem();
    if (selected) {
      ctx.logger.debug`Selected output: ${selected.id}`;
      // In JSON mode, still display the full output get after auto-select
      if (effectiveMode === "json") {
        const getRenderer = createModelOutputGetRenderer(effectiveMode);
        const getDeps = await createModelOutputGetDeps(repoDir);
        await consumeStream(
          modelOutputGet(libCtx, getDeps, selected.id),
          getRenderer.handlers(),
        );
      }
      // In interactive mode, the scrollback from the picker already contains
      // the output detail, so no additional modelOutputGet call is needed.
    } else {
      ctx.logger.debug`Search cancelled`;
    }

    ctx.logger.debug("Model output search command completed");
  });
