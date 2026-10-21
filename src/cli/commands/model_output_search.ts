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
  type CommandSyntax,
  recordDefiningModule,
  withPreferredExample,
} from "./command_syntax.ts";
import {
  type CommandSurface,
  DEFAULT_COMMAND_SURFACE,
} from "../../presentation/command_surface.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createModelOutputGetDeps,
  modelOutputGet,
  type ModelOutputGetData,
  type ModelOutputGetDeps,
} from "../../libswamp/models/output_get.ts";
import {
  modelOutputSearch,
  type ModelOutputSearchData,
  type ModelOutputSearchDeps,
  type ModelOutputSearchItem,
} from "../../libswamp/models/output_search.ts";
import {
  createModelOutputSearchRenderer,
  outputSearchPickerLabels,
} from "../../presentation/renderers/model_output_search.tsx";
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
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelOutputSearchResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Creates a fetchPreview closure that fetches full model output detail data.
 * This bridges the presentation layer to the libswamp modelOutputGet application
 * service, capturing its deps.
 */
function createOutputFetchPreview(
  getDeps: ModelOutputGetDeps,
): (item: ModelOutputSearchItem) => Promise<ModelOutputGetData> {
  const libCtx = createLibSwampContext();

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

export async function modelOutputSearchAction(
  options: AnyOptions,
  query?: string,
  surface: CommandSurface = DEFAULT_COMMAND_SURFACE,
): Promise<void> {
  const labels = outputSearchPickerLabels(surface, "output");
  const ctx = createContext(options as GlobalOptions, [
    "model",
    "output",
    "search",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<ModelOutputSearchResponse>(
      { server, token },
      {
        type: "model.output.search",
        payload: { query },
      },
    );
    const renderer = createModelOutputSearchRenderer(
      interactiveOutputMode(ctx),
      undefined,
      labels,
    );
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as ModelOutputSearchData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  const effectiveMode = interactiveOutputMode(ctx);
  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching outputs with query: ${query ?? "(none)"}`;

  const { repoDir, repoContext, datastoreResolver } =
    await requireInitializedRepoReadOnly({
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

  // The list reads outputs through the datastore, so the preview and the
  // selected-run lookup must too (swamp-club#3743).
  const getDeps = () =>
    createModelOutputGetDeps(
      repoDir,
      datastoreResolver,
      repoContext.definitionRepo,
      repoContext.unreadableContent,
    );
  const fetchPreview = effectiveMode === "log"
    ? createOutputFetchPreview(await getDeps())
    : undefined;

  const renderer = createModelOutputSearchRenderer(
    effectiveMode,
    fetchPreview,
    labels,
  );
  await consumeStream(
    modelOutputSearch(libCtx, deps, { query }),
    renderer.handlers(),
  );

  const selected = renderer.selectedItem();
  if (selected) {
    ctx.logger.debug`Selected output: ${selected.id}`;
    if (effectiveMode === "json") {
      const getRenderer = createModelOutputGetRenderer(effectiveMode);
      await consumeStream(
        modelOutputGet(libCtx, await getDeps(), selected.id),
        getRenderer.handlers(),
      );
    }
  } else {
    ctx.logger.debug`Search cancelled`;
  }

  ctx.logger.debug("Model output search command completed");
}

/** The preferred spelling: `swamp behavior output search`. */
export const BEHAVIOR_OUTPUT_SEARCH_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior output search",
  surface: "behavior",
};

/** The legacy spelling: `swamp model output search`. */
export const MODEL_OUTPUT_SEARCH_SYNTAX: CommandSyntax = {
  invocation: "swamp model output search",
  surface: "model",
  preferred: `${BEHAVIOR_OUTPUT_SEARCH_SYNTAX.invocation} deploy`,
};

export function createModelOutputSearchCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("search")
      .alias("list")
      .description(`Search for ${syntax.surface} outputs`)
      .example("Browse all outputs", syntax.invocation)
      .example("Search by keyword", `${syntax.invocation} deploy`)
      .arguments("[query:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      ),
    syntax,
  )).action((options: AnyOptions, query?: string) =>
    modelOutputSearchAction(options, query, syntax.surface)
  );
  return recordDefiningModule(command, import.meta.url);
}

export const modelOutputSearchCommand = createModelOutputSearchCommand(
  MODEL_OUTPUT_SEARCH_SYNTAX,
);
