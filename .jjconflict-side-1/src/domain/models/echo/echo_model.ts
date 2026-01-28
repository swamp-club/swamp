import { z } from "zod";
import { ModelType } from "../model_type.ts";
import { ModelResource } from "../model_resource.ts";
import type { MethodContext, MethodResult, ModelDefinition } from "../model.ts";
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
 * Schema for echo model resource attributes.
 */
export const EchoResourceAttributesSchema = z.object({
  message: z.string(),
  timestamp: z.string().datetime(),
});

/**
 * Type for echo model resource attributes.
 */
export type EchoResourceAttributes = z.infer<
  typeof EchoResourceAttributesSchema
>;

/**
 * The echo model type identifier.
 */
export const ECHO_MODEL_TYPE = ModelType.create("swamp/echo");

/**
 * Executes the "write" method for the echo model.
 *
 * Takes the message from the input and writes it to a resource
 * along with a timestamp.
 */
function executeWrite(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  // Validate input attributes
  const attrs = EchoInputAttributesSchema.parse(input.attributes);

  // Create the resource with message and timestamp
  const resource = ModelResource.create({
    inputId: input.id,
    attributes: {
      message: attrs.message,
      timestamp: new Date().toISOString(),
    },
  });

  return Promise.resolve({ resource });
}

/**
 * The echo model definition.
 *
 * A simple model that takes a string message input and writes it
 * to a resource with a timestamp.
 */
export const echoModel: ModelDefinition<
  typeof EchoInputAttributesSchema,
  typeof EchoResourceAttributesSchema
> = {
  type: ECHO_MODEL_TYPE,
  version: 1,
  inputAttributesSchema: EchoInputAttributesSchema,
  resourceAttributesSchema: EchoResourceAttributesSchema,
  methods: {
    write: {
      description: "Write the input message to a resource with a timestamp",
      inputAttributesSchema: EchoInputAttributesSchema,
      execute: executeWrite,
    },
  },
};
