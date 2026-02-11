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
  type ModelOutputSearchData,
  renderModelOutputSearch,
} from "../../presentation/output/model_output_search_output.tsx";
import {
  type ModelOutputGetData,
  renderModelOutputGet,
} from "../../presentation/output/model_output_get_output.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { ModelOutputSearchItem } from "../../presentation/output/model_output_search_output.tsx";
import {
  filterOutputs,
  toModelOutputSearchItems,
} from "./model_output_search.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Displays the model output get output for a selected output.
 */
async function displayModelOutputGet(
  item: ModelOutputSearchItem,
  definitionRepo: YamlDefinitionRepository,
  outputRepo: YamlOutputRepository,
  outputMode: OutputMode,
): Promise<void> {
  const allOutputs = await outputRepo.findAllGlobal();
  const result = allOutputs.find((r) => r.output.id === item.id);

  if (!result) {
    throw new UserError(`Output not found: ${item.id}`);
  }

  const { output, type } = result;

  let modelName: string | undefined;
  const definition = await definitionRepo.findById(type, output.definitionId);
  if (definition) {
    modelName = definition.name;
  }

  const data: ModelOutputGetData = {
    id: output.id,
    definitionId: output.definitionId,
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

export const modelMethodHistorySearchCommand = new Command()
  .name("search")
  .description("Search model method run history")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "model",
      "method",
      "history",
      "search",
    ]);
    ctx.logger.debug`Searching method history with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const outputRepo = repoContext.outputRepo;

    // Get all outputs from repository
    const allResults = await outputRepo.findAllGlobal();
    const allOutputs = await toModelOutputSearchItems(
      allResults,
      definitionRepo,
    );

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
        await displayModelOutputGet(
          selected,
          definitionRepo,
          outputRepo,
          ctx.outputMode,
        );
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Model method history search command completed");
  });
