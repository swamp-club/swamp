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
  type ModelMethodDescribeData,
  renderModelMethodDescribe,
} from "../../presentation/output/model_method_describe_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { toMethodDescribeData } from "./type_describe.ts";

// Cliffy's custom type system returns `unknown` for custom types like `model_name`,
// but we need to pass `options` to functions expecting specific types. Using `any`
// here is the pragmatic workaround for Cliffy's type inference limitations.
// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodDescribeCommand = new Command()
  .name("describe")
  .description("Describe a method on a model with argument details")
  .example(
    "Describe a method",
    "swamp model method describe my-server getSystemInfo",
  )
  .arguments("<model_id_or_name:model_name> <method_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      methodName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, [
        "model",
        "method",
        "describe",
      ]);
      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });
      const definitionRepo = repoContext.definitionRepo;

      ctx.logger
        .debug`Describing method '${methodName}' on model: ${modelIdOrName}`;

      // Look up the model definition
      const result = await findDefinitionByIdOrName(
        definitionRepo,
        modelIdOrName,
      );
      if (!result) {
        throw new UserError(`Model not found: ${modelIdOrName}`);
      }
      const { definition, type: modelType } = result;

      // Get the model definition from registry
      const modelDef = modelRegistry.get(modelType);
      if (!modelDef) {
        throw new UserError(`Unknown model type: ${modelType.normalized}`);
      }

      // Validate method exists on the model
      const method = modelDef.methods[methodName];
      if (!method) {
        const availableMethods = Object.keys(modelDef.methods).join(", ");
        throw new UserError(
          `Unknown method '${methodName}' for type '${modelType.normalized}'. Available methods: ${
            availableMethods || "none"
          }`,
        );
      }

      // Build the output data
      const methodData = toMethodDescribeData(
        methodName,
        method,
        modelDef.resources,
        modelDef.files,
      );

      const data: ModelMethodDescribeData = {
        modelName: definition.name,
        modelType: modelType.normalized,
        version: modelDef.version,
        method: methodData,
      };

      renderModelMethodDescribe(data, ctx.outputMode);
      ctx.logger.debug("Method describe command completed");
    },
  );
