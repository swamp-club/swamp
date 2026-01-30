import { z } from "zod";
import { ModelType } from "../model_type.ts";
import { ModelData } from "../model_data.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";
import type { ModelInput } from "../model_input.ts";

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
 * Takes the message from the input and writes it to a data artifact
 * along with a timestamp.
 */
function executeWrite(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  // Validate input attributes
  const attrs = EchoInputAttributesSchema.parse(input.attributes);

  // Create the data artifact with message and timestamp
  const data = ModelData.create({
    id: input.id, // Use same ID as input for consistency
    attributes: {
      message: attrs.message,
      timestamp: new Date().toISOString(),
    },
  });

  return Promise.resolve({ data });
}

/**
 * The echo model definition.
 *
 * A simple model that takes a string message input and writes it
 * to a data artifact with a timestamp.
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const echoModel: ModelDefinition<
  typeof EchoInputAttributesSchema,
  never,
  typeof EchoDataAttributesSchema
> = defineModel({
  type: ECHO_MODEL_TYPE,
  version: 1,
  inputAttributesSchema: EchoInputAttributesSchema,
  dataAttributesSchema: EchoDataAttributesSchema,
  methods: {
    write: {
      description:
        "Write the input message to a data artifact with a timestamp",
      inputAttributesSchema: EchoInputAttributesSchema,
      execute: executeWrite,
    },
  },
});
