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
  surfaceMethodNoun,
} from "../../presentation/command_surface.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createModelOutputGetDeps,
  modelOutputGet,
} from "../../libswamp/models/output_get.ts";
import {
  modelOutputSearch,
  type ModelOutputSearchData,
  type ModelOutputSearchDeps,
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
import type { ModelMethodHistorySearchResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function modelMethodHistorySearchAction(
  options: AnyOptions,
  query?: string,
  surface: CommandSurface = DEFAULT_COMMAND_SURFACE,
): Promise<void> {
  const labels = outputSearchPickerLabels(surface, "history");
  const ctx = createContext(options as GlobalOptions, [
    "model",
    "method",
    "history",
    "search",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<
      ModelMethodHistorySearchResponse
    >(
      { server, token },
      {
        type: "model.method.history.search",
        payload: { query },
      },
    );
    // A remote search prints a plain list and never starts the picker
    // (swamp-club#3917).
    const renderer = createModelOutputSearchRenderer(
      interactiveOutputMode(ctx),
      undefined,
      labels,
      { interactive: false },
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
  ctx.logger.debug`Searching method history with query: ${query ?? "(none)"}`;

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

  const renderer = createModelOutputSearchRenderer(
    effectiveMode,
    undefined,
    labels,
  );
  await consumeStream(
    modelOutputSearch(libCtx, deps, { query }),
    renderer.handlers(),
  );

  const selected = renderer.selectedItem();
  if (selected) {
    ctx.logger.debug`Selected output: ${selected.id}`;
    const getRenderer = createModelOutputGetRenderer(effectiveMode);
    // Read the selected run where the list found it (swamp-club#3743).
    const getDeps = await createModelOutputGetDeps(
      repoDir,
      datastoreResolver,
      repoContext.definitionRepo,
      repoContext.unreadableContent,
    );
    await consumeStream(
      modelOutputGet(libCtx, getDeps, selected.id),
      getRenderer.handlers(),
    );
  } else {
    ctx.logger.debug`Search cancelled`;
  }

  ctx.logger.debug("Model method history search command completed");
}

/** The preferred spelling: `swamp behavior history search`. */
export const BEHAVIOR_HISTORY_SEARCH_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior history search",
  surface: "behavior",
};

/** The legacy spelling: `swamp model method history search`. */
export const MODEL_METHOD_HISTORY_SEARCH_SYNTAX: CommandSyntax = {
  invocation: "swamp model method history search",
  surface: "model",
  preferred: `${BEHAVIOR_HISTORY_SEARCH_SYNTAX.invocation} deploy`,
};

export function createModelMethodHistorySearchCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("search")
      .alias("list")
      .description(`Search ${surfaceMethodNoun(syntax.surface)} run history`)
      .example("Browse all history", syntax.invocation)
      .example("Search by keyword", `${syntax.invocation} deploy`)
      .arguments("[query:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      ),
    syntax,
  )).action((options: AnyOptions, query?: string) =>
    modelMethodHistorySearchAction(options, query, syntax.surface)
  );
  return recordDefiningModule(command, import.meta.url);
}

export const modelMethodHistorySearchCommand =
  createModelMethodHistorySearchCommand(MODEL_METHOD_HISTORY_SEARCH_SYNTAX);
