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
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  consumeStream,
  createLibSwampContext,
  dataVersions,
} from "../../libswamp/mod.ts";
import { createDataVersionsRenderer } from "../../presentation/renderers/data_versions.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataVersionsCommand = new Command()
  .name("versions")
  .description("List all versions of specific data")
  .arguments("<model_id_or_name:model_name> <data_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      dataName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "data",
        "versions",
      ]);
      cliCtx.logger
        .debug`Listing versions: model=${modelIdOrName}, name=${dataName}`;

      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir: options.repoDir ?? ".",
        outputMode: cliCtx.outputMode,
      });
      const definitionRepo = repoContext.definitionRepo;
      const dataRepo = repoContext.unifiedDataRepo;

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = {
        lookupDefinition: (idOrName: string) =>
          findDefinitionByIdOrName(definitionRepo, idOrName),
        listVersions: (
          type: ModelType,
          definitionId: string,
          name: string,
        ) => dataRepo.listVersions(type, definitionId, name),
        findByName: (
          type: ModelType,
          definitionId: string,
          name: string,
          version: number,
        ) => dataRepo.findByName(type, definitionId, name, version),
      };

      const renderer = createDataVersionsRenderer(cliCtx.outputMode);
      await consumeStream(
        dataVersions(ctx, deps, { modelIdOrName, dataName }),
        renderer.handlers(),
      );

      cliCtx.logger.debug("Data versions command completed");
    },
  );
