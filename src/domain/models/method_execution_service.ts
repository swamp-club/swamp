import type { z } from "zod";
import type { MethodContext, MethodDefinition, MethodResult } from "./model.ts";
import type { ModelInput } from "./model_input.ts";

/**
 * Formats a Zod error into a human-readable string.
 */
function formatZodError(error: z.ZodError): string {
  if (error.issues.length === 1) {
    const issue = error.issues[0];
    const path = issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
    return `${issue.message}${path}`;
  }
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
      return `${issue.message}${path}`;
    })
    .join("; ");
}

/**
 * Domain service interface for method execution.
 */
export interface MethodExecutionService {
  /**
   * Executes a model method with the given input and context.
   *
   * @param input - The model input containing attributes
   * @param method - The method definition to execute
   * @param context - Execution context
   * @returns The method result containing the created resource
   * @throws Error if input validation fails
   */
  execute(
    input: ModelInput,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult>;
}

/**
 * Default implementation of the method execution service.
 *
 * Validates input attributes against the method's schema before execution.
 */
export class DefaultMethodExecutionService implements MethodExecutionService {
  execute(
    input: ModelInput,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult> {
    // Validate input attributes against method's schema
    const validationResult = method.inputAttributesSchema.safeParse(
      input.attributes,
    );

    if (!validationResult.success) {
      throw new Error(
        `Input validation failed: ${formatZodError(validationResult.error)}`,
      );
    }

    // Execute the method
    return method.execute(input, context);
  }
}
