import { z } from "zod";
import { ModelType } from "../model_type.ts";
import {
  DataSpecType,
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";
import type { Definition } from "../../definitions/definition.ts";

/**
 * Schema for echo model input attributes.
 */
export const EchoInputAttributesSchema = z.object({
  message: z.string().min(1),
});

/**
 * Type for echo model input attributes.
 */
export type EchoInputAttributes = z.infer<typeof EchoInputAttributesSchema>;

/**
 * Schema for echo model data attributes.
 */
export const EchoDataAttributesSchema = z.object({
  message: z.string(),
  timestamp: z.string().datetime(),
});

/**
 * Type for echo model data attributes.
 */
export type EchoDataAttributes = z.infer<typeof EchoDataAttributesSchema>;

/**
 * The echo model type identifier.
 */
export const ECHO_MODEL_TYPE = ModelType.create("swamp/echo");

/**
 * Executes the "write" method for the echo model.
 *
 * Takes the message from the definition and writes it to a data artifact
 * along with a timestamp.
 */
async function executeWrite(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  // Validate definition attributes
  const attrs = EchoInputAttributesSchema.parse(definition.attributes);

  // Create the data attributes with message and timestamp
  const dataAttributes = {
    message: attrs.message,
    timestamp: new Date().toISOString(),
  };

  const writer = context.createDataWriter!({
    name: `${definition.name}-message`,
    specType: "message",
  });

  const handle = await writer.writeText(JSON.stringify(dataAttributes));

  return { dataHandles: [handle] };
}

/**
 * The echo model definition.
 *
 * A simple model that takes a string message definition and writes it
 * to a data artifact with a timestamp.
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const echoModel: ModelDefinition<
  typeof EchoInputAttributesSchema
> = defineModel({
  type: ECHO_MODEL_TYPE,
  version: "2026.02.09.1",
  inputAttributesSchema: EchoInputAttributesSchema,
  dataOutputSpecs: {
    "message": {
      specType: DataSpecType.create("message"),
      description: "Echo message with timestamp",
      contentType: "application/json",
      lifetime: "ephemeral",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description:
        "Write the definition message to a data artifact with a timestamp",
      inputAttributesSchema: EchoInputAttributesSchema,
      execute: executeWrite,
    },
  },
});
