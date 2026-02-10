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
  type DataOutputSpecification,
  type MethodDefinition,
  modelRegistry,
} from "../../domain/models/model.ts";
import { typeSearchCommand } from "./type_search.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a Zod schema to JSON Schema format.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): object {
  return z.toJSONSchema(schema);
}

/**
 * Converts a MethodDefinition to MethodDescribeData for presentation.
 */
function toMethodDescribeData(
  name: string,
  method: MethodDefinition,
  dataOutputSpecs?: Record<string, DataOutputSpecification>,
): MethodDescribeData {
  return {
    name,
    description: method.description,
    inputAttributesSchema: zodToJsonSchema(method.inputAttributesSchema),
    dataOutputSpecs: dataOutputSpecs
      ? Object.values(dataOutputSpecs).map(
        (spec) => ({
          specType: spec.specType.value,
          description: spec.description,
          contentType: spec.contentType,
          lifetime: spec.lifetime,
          garbageCollection: spec.garbageCollection,
          streaming: spec.streaming,
          tags: spec.tags,
        }),
      )
      : undefined,
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
  const inputAttributesSchema = zodToJsonSchema(
    definition.inputAttributesSchema,
  );

  // Build method descriptions
  const methods: MethodDescribeData[] = Object.entries(definition.methods)
    .map(
      ([name, method]) =>
        toMethodDescribeData(name, method, definition.dataOutputSpecs),
    );

  // Build the output data
  const data: TypeDescribeData = {
    type: {
      raw: modelType.raw,
      normalized: modelType.normalized,
    },
    version: definition.version,
    inputAttributesSchema,
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

export const typeCommand = new Command()
  .name("type")
  .description("Inspect model types")
  .action(function () {
    this.showHelp();
  })
  .command("describe", typeDescribeCommand)
  .command("search", typeSearchCommand);
