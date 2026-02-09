import type { z } from "zod";
import type {
  DataOutput,
  FollowUpAction,
  MethodContext,
  MethodDefinition,
  MethodResult,
  ModelDefinition,
} from "./model.ts";
import type { Definition } from "../definitions/definition.ts";
import { Data } from "../data/mod.ts";
import type { DataArtifactRef } from "./model_output.ts";
import { ModelOutput } from "./model_output.ts";
import { DataOutputValidationService } from "./data_output_validation_service.ts";
import { DefinitionUpgradeService } from "./definition_upgrade_service.ts";

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
   * Executes a model method with the given definition and context.
   *
   * @param definition - The definition containing attributes
   * @param method - The method definition to execute
   * @param context - Execution context
   * @returns The method result
   * @throws Error if definition validation fails
   */
  execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult>;

  /**
   * Executes a method with follow-up actions (workflow execution).
   *
   * @param definition - The definition containing attributes
   * @param modelDef - The complete model definition (for accessing other methods)
   * @param methodName - Name of the method to execute
   * @param context - Execution context
   * @returns The final method result after all follow-up actions
   */
  executeWorkflow(
    definition: Definition,
    modelDef: ModelDefinition,
    methodName: string,
    context: MethodContext,
  ): Promise<MethodResult>;
}

/**
 * Default implementation of the method execution service.
 *
 * Validates definition attributes against the method's schema before execution.
 */
export class DefaultMethodExecutionService implements MethodExecutionService {
  private readonly dataOutputValidationService =
    new DataOutputValidationService();

  async execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult> {
    // Validate definition attributes against method's schema
    const validationResult = method.inputAttributesSchema.safeParse(
      definition.attributes,
    );

    if (!validationResult.success) {
      throw new Error(
        `Definition validation failed: ${
          formatZodError(validationResult.error)
        }`,
      );
    }

    // Execute the method
    const result = await method.execute(definition, context);

    // Validate and enhance data outputs if model definition is provided
    if (result.dataOutputs && context.modelDefinition) {
      const specs = context.modelDefinition.dataOutputSpecs;

      // Find the method name (for better error messages)
      const methodName = Object.entries(context.modelDefinition.methods)
        .find(([_, m]) => m === method)?.[0] ?? "unknown";

      // Validate spec type references
      const validation = this.dataOutputValidationService.validate(
        result.dataOutputs,
        specs,
        methodName,
      );

      if (!validation.valid) {
        throw new Error(
          `Data output validation failed: ${validation.errors.join("; ")}`,
        );
      }

      // Apply defaults from specs (no overrides at this level)
      result.dataOutputs = result.dataOutputs.map((output) => {
        const spec = specs[output.specType.value];
        return this.dataOutputValidationService.applyDefaultsAndOverrides(
          output,
          spec,
        );
      });
    }

    return result;
  }

  async executeWorkflow(
    definition: Definition,
    modelDef: ModelDefinition,
    methodName: string,
    context: MethodContext,
  ): Promise<MethodResult> {
    const method = modelDef.methods[methodName];
    if (!method) {
      throw new Error(`Method '${methodName}' not found in model`);
    }

    // Upgrade definition if needed
    const upgradeService = new DefinitionUpgradeService();
    const upgradeResult = upgradeService.upgrade(definition, modelDef);
    const currentDefinition = upgradeResult.definition;

    // Persist upgraded definition if it was upgraded
    if (upgradeResult.upgraded && context.definitionRepository) {
      await context.definitionRepository.save(
        context.modelType,
        currentDefinition,
      );
    }

    // Execute the initial method with the (possibly upgraded) definition
    const result = await this.execute(currentDefinition, method, context);
    let currentDataOutputs = result.dataOutputs ?? [];

    // Store data outputs
    const storedArtifacts: DataArtifactRef[] = [];
    if (currentDataOutputs.length > 0) {
      const definitionHash = await currentDefinition.computeHash();
      for (const output of currentDataOutputs) {
        const artifact = await this.storeDataOutput(
          output,
          definitionHash,
          methodName,
          context,
        );
        storedArtifacts.push(artifact);
      }
    }

    // Create ModelOutput if output repository is available
    if (context.outputRepository) {
      const definitionHash = await currentDefinition.computeHash();
      const output = ModelOutput.create({
        definitionId: currentDefinition.id,
        methodName,
        status: "running",
        provenance: {
          definitionHash,
          modelVersion: modelDef.version,
          triggeredBy: "manual",
        },
        artifacts: { dataArtifacts: storedArtifacts },
      });
      output.markSucceeded();
      await context.outputRepository.save(modelDef.type, methodName, output);
    }

    // Process follow-up actions
    if (result.followUpActions && currentDataOutputs.length > 0) {
      const finalResult = await this.processFollowUpActions(
        currentDefinition,
        modelDef,
        context,
        result.followUpActions,
        currentDataOutputs,
        0,
      );
      currentDataOutputs = finalResult.dataOutputs;
    }

    return {
      ...result,
      dataOutputs: currentDataOutputs,
    };
  }

  /**
   * Stores a data output and returns a reference to the stored artifact.
   */
  private async storeDataOutput(
    output: DataOutput,
    definitionHash: string,
    methodName: string,
    context: MethodContext,
  ): Promise<DataArtifactRef> {
    // Get next version for this data
    const dataId = context.dataRepository.nextId();

    // Create the Data entity
    const data = Data.create({
      id: dataId,
      name: output.name,
      version: 1, // Will be updated by save()
      contentType: output.metadata.contentType,
      lifetime: output.metadata.lifetime,
      garbageCollection: output.metadata.garbageCollection,
      streaming: output.metadata.streaming ?? false,
      tags: output.metadata.tags,
      ownerDefinition: {
        ...output.metadata.ownerDefinition,
        definitionHash,
        ownerRef: methodName,
      },
    });

    // Save the data with content
    const saveResult = await context.dataRepository.save(
      context.modelType,
      context.modelId,
      data,
      output.content,
    );

    return {
      dataId: data.id,
      name: data.name,
      version: saveResult.version,
      tags: data.tags,
    };
  }

  /**
   * Process follow-up actions using the data outputs pattern.
   */
  private async processFollowUpActions(
    definition: Definition,
    modelDef: ModelDefinition,
    context: MethodContext,
    followUpActions: FollowUpAction[],
    currentDataOutputs: DataOutput[],
    depth: number = 0,
  ): Promise<{ dataOutputs: DataOutput[] }> {
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
        if (action.continueCondition) {
          const conditionResult = action.continueCondition(currentDataOutputs);
          if (!conditionResult) {
            break;
          }
        }

        try {
          const followUpMethod = modelDef.methods[action.methodName];
          if (!followUpMethod) {
            throw new Error(
              `Follow-up method '${action.methodName}' not found`,
            );
          }

          // Execute with the same definition
          const result = await this.execute(
            definition,
            followUpMethod,
            context,
          );

          // Update current data outputs
          if (result.dataOutputs && result.dataOutputs.length > 0) {
            currentDataOutputs = result.dataOutputs;
          }

          // If this follow-up method has its own follow-up actions, process them recursively
          if (result.followUpActions && result.followUpActions.length > 0) {
            const recursiveResult = await this.processFollowUpActions(
              definition,
              modelDef,
              context,
              result.followUpActions,
              currentDataOutputs,
              depth + 1,
            );
            currentDataOutputs = recursiveResult.dataOutputs;
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

    return { dataOutputs: currentDataOutputs };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
