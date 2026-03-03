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
  type ModelGetData,
  renderModelGet,
} from "../../presentation/output/model_get_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { toMethodDescribeData, zodToJsonSchema } from "./type_describe.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelGetCommand = new Command()
  .name("get")
  .description("Show details of a model definition")
  .arguments("<model_id_or_name:model_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["model", "get"]);
    ctx.logger.debug`Getting model: ${modelIdOrName}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;

    // Look up the model definition
    ctx.logger.debug`Looking up model: ${modelIdOrName}`;
    const result = await findDefinitionByIdOrName(
      definitionRepo,
      modelIdOrName,
    );
    if (!result) {
      throw new UserError(`Model not found: ${modelIdOrName}`);
    }
    const { definition, type: modelType } = result;

    ctx.logger
      .debug`Found model: id=${definition.id}, type=${modelType.normalized}`;

    const modelDef = modelRegistry.get(modelType);

    const data: ModelGetData = {
      id: definition.id,
      name: definition.name,
      type: modelType.normalized,
      version: definition.version,
      tags: definition.tags,
      globalArguments: definition.globalArguments,
      typeVersion: modelDef?.version,
      globalArgumentsSchema: modelDef?.globalArguments
        ? zodToJsonSchema(modelDef.globalArguments)
        : undefined,
      methods: modelDef
        ? Object.entries(modelDef.methods).map(
          ([name, method]) =>
            toMethodDescribeData(
              name,
              method,
              modelDef.resources,
              modelDef.files,
            ),
        )
        : undefined,
    };

    renderModelGet(data, ctx.outputMode);
    ctx.logger.debug("Model get command completed");
  });
