import { Command } from "@cliffy/command";
import { z } from "zod";
import {
  type MethodDescribeData,
  renderTypeDescribe,
  type TypeDescribeData,
} from "../../presentation/output/type_describe_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type MethodDefinition,
  modelRegistry,
} from "../../domain/models/model.ts";
import { typeSearchCommand } from "./type_search.ts";

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
): MethodDescribeData {
  return {
    name,
    description: method.description,
    inputAttributesSchema: zodToJsonSchema(method.inputAttributesSchema),
  };
}

export const typeDescribeCommand = new Command()
  .description("Describe a model type with schema details")
  .arguments("<type:string>")
  .action(function (options: AnyOptions, typeArg: string) {
    const ctx = createContext(options as GlobalOptions, "type-describe");
    ctx.logger.debug`Describing type: ${typeArg}`;

    // Parse and validate the model type
    const modelType = ModelType.create(typeArg);
    ctx.logger.debug`Normalized type: ${modelType.normalized}`;

    // Look up the model definition
    const definition = modelRegistry.get(modelType);
    if (!definition) {
      const availableTypes = modelRegistry.types().map((t) => t.normalized)
        .join(", ");
      throw new Error(
        `Unknown model type: ${typeArg}. Available types: ${
          availableTypes || "none"
        }`,
      );
    }

    // Convert Zod schemas to JSON Schema
    const inputAttributesSchema = zodToJsonSchema(
      definition.inputAttributesSchema,
    );
    const resourceAttributesSchema = zodToJsonSchema(
      definition.resourceAttributesSchema,
    );

    // Build method descriptions
    const methods: MethodDescribeData[] = Object.entries(definition.methods)
      .map(
        ([name, method]) => toMethodDescribeData(name, method),
      );

    // Build the output data
    const data: TypeDescribeData = {
      type: {
        raw: modelType.raw,
        normalized: modelType.normalized,
      },
      version: definition.version,
      inputAttributesSchema,
      resourceAttributesSchema,
      methods,
    };

    renderTypeDescribe(data, ctx.outputMode);
    ctx.logger.debug("Type describe command completed");
  });

export const typeCommand = new Command()
  .name("type")
  .description("Inspect model types")
  .action(function () {
    this.showHelp();
  })
  .command("describe", typeDescribeCommand)
  .command("search", typeSearchCommand);
