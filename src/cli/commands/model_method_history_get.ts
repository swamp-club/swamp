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
import { consumeStream } from "../../libswamp/mod.ts";
import { modelOutputGet } from "../../libswamp/models/output_get.ts";
import type { ModelOutputGetDeps } from "../../libswamp/models/output_get.ts";
import { createModelOutputGetRenderer } from "../../presentation/renderers/model_output_get.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  findDefinitionByIdOrName,
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodHistoryGetCommand = new Command()
  .name("get")
  .description("Show details of a model method run")
  .arguments("<output_id_or_model_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, outputIdOrModelName: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "model",
      "method",
      "history",
      "get",
    ]);
    cliCtx.logger.debug`Getting method run: ${outputIdOrModelName}`;

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const outputRepo = repoContext.outputRepo;

    const deps: ModelOutputGetDeps = {
      findAllOutputsGlobal: () => outputRepo.findAllGlobal(),
      findDefinitionByIdOrName: (idOrName) =>
        findDefinitionByIdOrName(definitionRepo, idOrName),
      findLatestOutputByDefinition: (type, defId) =>
        outputRepo.findLatestByDefinition(type, createDefinitionId(defId)),
      findOutputsByDefinition: (type, defId) =>
        outputRepo.findByDefinition(type, createDefinitionId(defId)),
      findDefinitionById: (type, defId) =>
        definitionRepo.findById(type, createDefinitionId(defId)),
      matchByPartialId,
      isPartialId,
      modelTypes: () => [...modelRegistry.types()],
    };

    const renderer = createModelOutputGetRenderer(cliCtx.outputMode);
    await consumeStream(
      modelOutputGet(deps, outputIdOrModelName),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model method history get command completed");
  });
