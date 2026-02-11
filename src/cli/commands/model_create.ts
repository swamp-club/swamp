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
  type ModelCreateData,
  renderModelCreate,
} from "../../presentation/output/model_create_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { toMethodDescribeData, zodToJsonSchema } from "./type_describe.ts";
import { modelValidateCommand } from "./model_validate.ts";
import { modelMethodCommand } from "./model_method_run.ts";
import { modelSearchAction, modelSearchCommand } from "./model_search.ts";
import { modelGetCommand } from "./model_get.ts";
import { modelDeleteCommand } from "./model_delete.ts";
import { modelEditCommand } from "./model_edit.ts";
import { modelEvaluateCommand } from "./model_evaluate.ts";
import { modelOutputCommand } from "./model_output.ts";
import { modelTypeCommand } from "./model_type.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelCreateCommand = new Command()
  .description("Create a new model definition")
  .arguments("<type:model_type> <name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, typeArg: string, name: string) {
    const ctx = createContext(options as GlobalOptions, ["model", "create"]);
    ctx.logger.debug`Creating model definition: type=${typeArg}, name=${name}`;

    // Validate the model type
    const modelType = ModelType.create(typeArg);
    ctx.logger.debug`Normalized type: ${modelType.normalized}`;

    // Check if model type is registered
    if (!modelRegistry.has(modelType)) {
      const availableTypes = modelRegistry.types().map((t) => t.normalized)
        .join(", ");
      throw new UserError(
        `Unknown model type: ${typeArg}. Available types: ${
          availableTypes || "none"
        }`,
      );
    }

    // Validate repo initialization and create context
    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;

    // Check if name already exists (globally unique across all types)
    const existing = await definitionRepo.findByNameGlobal(name);
    if (existing) {
      throw new UserError(
        `Model definition with name '${name}' already exists (type: '${existing.type.normalized}')`,
      );
    }

    // Create and save the definition
    const modelDef = modelRegistry.get(modelType);
    const definition = Definition.create({
      name,
      type: modelType.normalized,
      typeVersion: modelDef?.version,
    });
    await definitionRepo.save(modelType, definition);

    ctx.logger.debug`Created definition with ID: ${definition.id}`;

    const data: ModelCreateData = {
      id: definition.id,
      type: modelType.normalized,
      name: definition.name,
      path: definitionRepo.getPath(modelType, definition.id),
      version: modelDef?.version,
      globalArguments: modelDef?.globalArguments
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

    renderModelCreate(data, ctx.outputMode);
    ctx.logger.debug("Model create command completed");
  });

export const modelCommand = new Command()
  .name("model")
  .description("Manage models")
  .action(function () {
    this.showHelp();
  })
  .command("create", modelCreateCommand)
  .command("delete", modelDeleteCommand)
  .command("edit", modelEditCommand)
  .command("evaluate", modelEvaluateCommand)
  .command("get", modelGetCommand)
  .command("search", modelSearchCommand)
  .command("validate", modelValidateCommand)
  .command("method", modelMethodCommand)
  .command("output", modelOutputCommand)
  .command("type", modelTypeCommand)
  .command(
    "list",
    new Command()
      .description("Alias for model search")
      .hidden()
      .arguments("[query:string]")
      .option("--repo-dir <dir:string>", "Repository directory", {
        default: ".",
      })
      .action(modelSearchAction),
  );
