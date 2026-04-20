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
  modelSearch,
  type ModelSearchDeps,
} from "../../libswamp/mod.ts";
import { createModelSearchRenderer } from "../../presentation/renderers/model_search.tsx";
import { createModelEditRenderer } from "../../presentation/renderers/model_edit.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelEditCommand = new Command()
  .name("edit")
  .description("Edit a model definition file")
  .example("Edit a model", "swamp model edit my-server")
  .example("Interactive search", "swamp model edit")
  .arguments("[model_id_or_name:model_name]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["model", "edit"]);
    cliCtx.logger.debug`Editing model: ${modelIdOrName ?? "(interactive)"}`;

    const { repoContext, repoDir } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });

    // Interactive search mode when no argument provided
    if (!modelIdOrName) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Model ID or name is required in non-interactive mode",
        );
      }

      const searchDeps: ModelSearchDeps = {
        findAllGlobal: () => repoContext.definitionRepo.findAllGlobal(),
      };

      const searchRenderer = createModelSearchRenderer(cliCtx.outputMode);
      await consumeStream(
        modelSearch(libCtx, searchDeps, { query: undefined }),
        searchRenderer.handlers(),
      );

      const selected = searchRenderer.selectedItem();
      if (!selected) {
        cliCtx.logger.debug`Search cancelled`;
        return;
      }

      cliCtx.logger.debug`Selected model: ${selected.name} (${selected.id})`;
      modelIdOrName = selected.id;
    }

    const stdinContent = await readStdin();
    const deps = createModelEditDeps(repoDir);

    const renderer = createModelEditRenderer(cliCtx.outputMode);
    await consumeStream(
      modelEdit(libCtx, deps, {
        modelIdOrName,
        stdinContent,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model edit command completed");
  });
