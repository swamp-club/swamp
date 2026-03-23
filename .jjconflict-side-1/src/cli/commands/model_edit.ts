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
  createModelEditDeps,
  modelEdit,
} from "../../libswamp/mod.ts";
import {
  type ModelSearchData,
  type ModelSearchItem,
  renderModelSearch,
} from "../../presentation/output/model_search_output.tsx";
import { createModelEditRenderer } from "../../presentation/renderers/model_edit.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts repository results to ModelSearchItem array.
 */
function toModelSearchItems(
  results: Awaited<ReturnType<YamlDefinitionRepository["findAllGlobal"]>>,
): ModelSearchItem[] {
  return results.map(({ definition, type }) => ({
    id: definition.id,
    name: definition.name,
    type: type.normalized,
  }));
}

export const modelEditCommand = new Command()
  .name("edit")
  .description("Edit a model definition file")
  .arguments("[model_id_or_name:model_name]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["model", "edit"]);
    cliCtx.logger.debug`Editing model: ${modelIdOrName ?? "(interactive)"}`;

    const { repoContext, repoDir } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });

    // Interactive search mode when no argument provided
    if (!modelIdOrName) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Model ID or name is required in non-interactive mode",
        );
      }

      const definitionRepo = repoContext.definitionRepo;
      const allResults = await definitionRepo.findAllGlobal();
      const allModels = toModelSearchItems(allResults);

      if (allModels.length === 0) {
        throw new UserError("No models found in repository");
      }

      const searchData: ModelSearchData = {
        query: "",
        results: allModels,
      };

      const selected = await renderModelSearch(searchData, cliCtx.outputMode);

      if (!selected) {
        cliCtx.logger.debug`Search cancelled`;
        return;
      }

      cliCtx.logger.debug`Selected model: ${selected.name} (${selected.id})`;
      modelIdOrName = selected.id;
    }

    const stdinContent = await readStdin();

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createModelEditDeps(repoDir);

    const renderer = createModelEditRenderer(cliCtx.outputMode);
    await consumeStream(
      modelEdit(ctx, deps, {
        modelIdOrName,
        stdinContent,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model edit command completed");
  });
