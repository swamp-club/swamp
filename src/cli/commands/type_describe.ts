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
import { z } from "zod";
import {
  type MethodDescribeData,
  renderTypeDescribe,
  type TypeDescribeData,
} from "../../presentation/output/type_describe_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type FileOutputSpec,
  type MethodDefinition,
  modelRegistry,
  type ResourceOutputSpec,
} from "../../domain/models/model.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a Zod schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): object {
  return z.toJSONSchema(schema);
}

/**
 * Converts a MethodDefinition to MethodDescribeData for presentation.
 */
export function toMethodDescribeData(
  name: string,
  method: MethodDefinition,
  resources?: Record<string, ResourceOutputSpec>,
  files?: Record<string, FileOutputSpec>,
): MethodDescribeData {
  const resourceSpecs = resources
    ? Object.entries(resources).map(
      ([specName, spec]) => ({
        specName,
        kind: "resource" as const,
        description: spec.description,
        schema: zodToJsonSchema(spec.schema),
        lifetime: spec.lifetime,
        garbageCollection: spec.garbageCollection,
        tags: spec.tags,
      }),
    )
    : [];

  const fileSpecs = files
    ? Object.entries(files).map(
      ([specName, spec]) => ({
        specName,
        kind: "file" as const,
        description: spec.description,
        contentType: spec.contentType,
        lifetime: spec.lifetime,
        garbageCollection: spec.garbageCollection,
        streaming: spec.streaming,
        tags: spec.tags,
      }),
    )
    : [];

  const dataOutputSpecs = [...resourceSpecs, ...fileSpecs];

  return {
    name,
    description: method.description,
    arguments: zodToJsonSchema(method.arguments),
    dataOutputSpecs: dataOutputSpecs.length > 0 ? dataOutputSpecs : undefined,
  };
}

/**
 * Core action for describing a model type.
 * Shared between 'describe' and 'get' commands.
 */
function typeDescribeAction(options: AnyOptions, typeArg: string): void {
  const ctx = createContext(options as GlobalOptions, ["type", "describe"]);
  ctx.logger.debug`Describing type: ${typeArg}`;

  // Parse and validate the model type
  const modelType = ModelType.create(typeArg);
  ctx.logger.debug`Normalized type: ${modelType.normalized}`;

  // Look up the model definition
  const definition = modelRegistry.get(modelType);
  if (!definition) {
    const availableTypes = modelRegistry.types().map((t) => t.normalized)
      .join(", ");
    throw new UserError(
      `Unknown model type: ${typeArg}. Available types: ${
        availableTypes || "none"
      }`,
    );
  }

  // Convert Zod schemas to JSON Schema
  const globalArguments = definition.globalArguments
    ? zodToJsonSchema(definition.globalArguments)
    : undefined;

  // Build method descriptions
  const methods: MethodDescribeData[] = Object.entries(definition.methods)
    .map(
      ([name, method]) =>
        toMethodDescribeData(
          name,
          method,
          definition.resources,
          definition.files,
        ),
    );

  // Build the output data
  const data: TypeDescribeData = {
    type: {
      raw: modelType.raw,
      normalized: modelType.normalized,
    },
    version: definition.version,
    globalArguments,
    methods,
  };

  renderTypeDescribe(data, ctx.outputMode);
  ctx.logger.debug("Type describe command completed");
}

export const typeDescribeCommand = new Command()
  .description("Describe a model type with schema details")
  .alias("get")
  .arguments("<type:model_type>")
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(typeDescribeAction);
