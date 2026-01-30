import type { z } from "zod";
import type {
  FollowUpAction,
  MethodContext,
  MethodDefinition,
  MethodResult,
  ModelDefinition,
} from "./model.ts";
import { ModelInput } from "./model_input.ts";
import type { ModelResource } from "./model_resource.ts";

/**
 * Maximum depth for recursive follow-up action processing.
 * Prevents infinite loops in misconfigured workflows.
 */
const DEFAULT_MAX_FOLLOW_UP_DEPTH = 100;

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
    .map((issue: z.ZodIssue) => {
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

  /**
   * Executes a method with follow-up actions (workflow execution).
   *
   * @param input - The model input containing attributes
   * @param modelDef - The complete model definition (for accessing other methods)
   * @param methodName - Name of the method to execute
   * @param context - Execution context
   * @returns The final method result after all follow-up actions
   */
  executeWorkflow(
    input: ModelInput,
    modelDef: ModelDefinition,
    methodName: string,
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

  async executeWorkflow(
    input: ModelInput,
    modelDef: ModelDefinition,
    methodName: string,
    context: MethodContext,
  ): Promise<MethodResult> {
    const method = modelDef.methods[methodName];
    if (!method) {
      throw new Error(`Method '${methodName}' not found in model`);
    }

    // Execute the initial method
    const result = await this.execute(input, method, context);
    let currentResource = result.resource;

    // Process follow-up actions (requires resource)
    if (result.followUpActions && currentResource) {
      const finalResult = await this.processFollowUpActions(
        input,
        modelDef,
        context,
        result.followUpActions,
        currentResource,
        0,
      );
      currentResource = finalResult.resource;
    }

    return {
      ...result,
      resource: currentResource,
    };
  }

  private async processFollowUpActions(
    input: ModelInput,
    modelDef: ModelDefinition,
    context: MethodContext,
    followUpActions: FollowUpAction[],
    currentResource: ModelResource,
    depth: number = 0,
  ): Promise<{ resource: ModelResource }> {
    if (depth >= DEFAULT_MAX_FOLLOW_UP_DEPTH) {
      throw new Error(
        `Maximum follow-up action depth (${DEFAULT_MAX_FOLLOW_UP_DEPTH}) exceeded. ` +
          `This may indicate an infinite loop in the workflow.`,
      );
    }

    for (const action of followUpActions) {
      let retries = 0;
      const maxRetries = action.maxRetries ?? 0;

      while (retries <= maxRetries) {
        // Add delay if specified
        if (action.delayMs) {
          await this.delay(action.delayMs);
        }

        // Check continue condition
        if (
          action.continueCondition && !action.continueCondition(currentResource)
        ) {
          break;
        }

        // Create new input with updated attributes from the current resource
        const followUpInput = ModelInput.create({
          id: input.id, // Use same input ID
          name: input.name,
          version: input.version,
          resourceId: input.resourceId,
          tags: input.tags,
          attributes: currentResource.attributes, // Use resource attributes as input
        });

        try {
          const followUpMethod = modelDef.methods[action.methodName];
          if (!followUpMethod) {
            throw new Error(
              `Follow-up method '${action.methodName}' not found`,
            );
          }

          const result = await this.execute(
            followUpInput,
            followUpMethod,
            context,
          );

          // Follow-up actions require resources to continue
          if (!result.resource) {
            throw new Error(
              `Follow-up method '${action.methodName}' must return a resource`,
            );
          }
          currentResource = result.resource;

          // If this follow-up method has its own follow-up actions, process them recursively
          if (result.followUpActions && result.followUpActions.length > 0) {
            const recursiveResult = await this.processFollowUpActions(
              followUpInput,
              modelDef,
              context,
              result.followUpActions,
              currentResource,
              depth + 1,
            );
            currentResource = recursiveResult.resource;
          }

          break; // Success, exit retry loop
        } catch (error) {
          retries++;
          if (retries > maxRetries) {
            throw new Error(
              `Follow-up action '${action.methodName}' failed after ${maxRetries} retries: ${error}`,
            );
          }
        }
      }
    }

    return { resource: currentResource };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
