import { z } from "zod";
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";

/**
 * Schema for echo model method arguments.
 */
export const EchoArgumentsSchema = z.object({
  message: z.string().min(1),
});

/**
 * Type for echo model method arguments.
 */
export type EchoArguments = z.infer<typeof EchoArgumentsSchema>;

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
  args: EchoArguments,
  context: MethodContext,
): Promise<MethodResult> {
  // Create the data attributes with message and timestamp
  const dataAttributes = {
    message: args.message,
    timestamp: new Date().toISOString(),
  };

  const handle = await context.writeResource!(
    "message",
    "message",
    dataAttributes,
  );

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
export const echoModel: ModelDefinition = defineModel({
  type: ECHO_MODEL_TYPE,
  version: "2026.02.09.1",
  resources: {
    "message": {
      description: "Echo message with timestamp",
      schema: EchoDataAttributesSchema,
      lifetime: "ephemeral",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description:
        "Write the definition message to a data artifact with a timestamp",
      arguments: EchoArgumentsSchema,
      execute: executeWrite,
    },
  },
});
