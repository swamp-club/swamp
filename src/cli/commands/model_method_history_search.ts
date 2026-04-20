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
  modelOutputSearch,
  type ModelOutputSearchDeps,
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

export const modelMethodHistorySearchCommand = new Command()
  .name("search")
  .description("Search model method run history")
  .example("Browse all history", "swamp model method history search")
  .example("Search by keyword", "swamp model method history search deploy")
  .arguments("[query:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "model",
      "method",
      "history",
      "search",
    ]);
    const effectiveMode = interactiveOutputMode(ctx);
    const libCtx = createLibSwampContext();
    ctx.logger.debug`Searching method history with query: ${query ?? "(none)"}`;

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

    const renderer = createModelOutputSearchRenderer(effectiveMode);
    await consumeStream(
      modelOutputSearch(libCtx, deps, { query }),
      renderer.handlers(),
    );

    const selected = renderer.selectedItem();
    if (selected) {
      ctx.logger.debug`Selected output: ${selected.id}`;
      const getRenderer = createModelOutputGetRenderer(effectiveMode);
      const getDeps = await createModelOutputGetDeps(
        resolveRepoDir(options.repoDir),
      );
      await consumeStream(
        modelOutputGet(libCtx, getDeps, selected.id),
        getRenderer.handlers(),
      );
    } else {
      ctx.logger.debug`Search cancelled`;
    }

    ctx.logger.debug("Model method history search command completed");
  });
