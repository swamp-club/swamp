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

import type { z } from "zod";
import type {
  DataHandle,
  FollowUpAction,
  MethodContext,
  MethodDefinition,
  MethodResult,
  ModelDefinition,
} from "./model.ts";
import type { Definition } from "../definitions/definition.ts";
import type { DataArtifactRef } from "./model_output.ts";
import { ModelOutput } from "./model_output.ts";
import { DataOutputValidationService } from "./data_output_validation_service.ts";
import { DefinitionUpgradeService } from "./definition_upgrade_service.ts";
import {
  createFileWriterFactory,
  createResourceWriter,
} from "./data_writer.ts";

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
 * Creates writeResource/createFileWriter and injects them into context so methods
 * write data directly to disk. The result contains DataHandle[] (already persisted).
 */
export class DefaultMethodExecutionService implements MethodExecutionService {
  private readonly dataOutputValidationService =
    new DataOutputValidationService();

  async execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult> {
    // Validate per-method arguments against the method's schema
    const methodArgs = definition.getMethodArguments(context.methodName);
    const argsResult = method.arguments.safeParse(methodArgs);

    if (!argsResult.success) {
      throw new Error(
        `Method arguments validation failed: ${
          formatZodError(argsResult.error)
        }`,
      );
    }

    // Populate context with global args and definition metadata
    const enrichedContext: MethodContext = {
      ...context,
      globalArgs: definition.globalArguments,
      definition: {
        id: definition.id,
        name: definition.name,
        version: definition.version,
        tags: definition.tags,
      },
    };

    // Execute the method with pre-validated args
    const result = await method.execute(argsResult.data, enrichedContext);

    // Validate data handles
    if (result.dataHandles) {
      const validation = this.dataOutputValidationService.validate(
        result.dataHandles,
      );

      if (!validation.valid) {
        throw new Error(
          `Data output validation failed: ${validation.errors.join("; ")}`,
        );
      }
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

    // Validate globalArguments against schema (after upgrade and runtime resolution)
    if (modelDef.globalArguments) {
      const globalArgsResult = modelDef.globalArguments.safeParse(
        currentDefinition.globalArguments,
      );
      if (!globalArgsResult.success) {
        throw new Error(
          `Global arguments validation failed: ${
            formatZodError(globalArgsResult.error)
          }`,
        );
      }
    }

    // Create writeResource and createFileWriter for this execution
    const definitionHash = await currentDefinition.computeHash();
    const resources = modelDef.resources ?? {};
    const files = modelDef.files ?? {};

    const {
      writeResource,
      getHandles: _getResourceHandles,
    } = createResourceWriter(
      context.dataRepository,
      context.modelType,
      context.modelId,
      resources,
      context.tagOverrides,
      context.dataOutputOverrides,
      currentDefinition.tags,
      context.runtimeTags,
      currentDefinition.name,
    );

    const {
      createFileWriter,
      getHandles: _getFileHandles,
    } = createFileWriterFactory(
      context.dataRepository,
      context.modelType,
      context.modelId,
      files,
      context.tagOverrides,
      context.dataOutputOverrides,
      undefined, // callbacks
      currentDefinition.tags,
      context.runtimeTags,
      currentDefinition.name,
    );

    // Inject into context
    const contextWithWriters: MethodContext = {
      ...context,
      methodName,
      writeResource,
      createFileWriter,
    };

    // Execute the initial method
    const result = await this.execute(
      currentDefinition,
      method,
      contextWithWriters,
    );
    let currentHandles = result.dataHandles ?? [];

    // Collect artifact refs from handles (data is already persisted)
    const storedArtifacts: DataArtifactRef[] = currentHandles.map((h) => ({
      dataId: h.dataId,
      name: h.name,
      version: h.version,
      tags: h.tags,
    }));

    // Create ModelOutput if output repository is available
    if (context.outputRepository) {
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
    if (result.followUpActions && currentHandles.length > 0) {
      const finalResult = await this.processFollowUpActions(
        currentDefinition,
        modelDef,
        contextWithWriters,
        result.followUpActions,
        currentHandles,
        0,
      );
      currentHandles = finalResult.dataHandles;
    }

    return {
      ...result,
      dataHandles: currentHandles,
    };
  }

  /**
   * Process follow-up actions using the data handles pattern.
   */
  private async processFollowUpActions(
    definition: Definition,
    modelDef: ModelDefinition,
    context: MethodContext,
    followUpActions: FollowUpAction[],
    currentHandles: DataHandle[],
    depth: number = 0,
  ): Promise<{ dataHandles: DataHandle[] }> {
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
          const conditionResult = action.continueCondition(currentHandles);
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

          // Update current handles
          if (result.dataHandles && result.dataHandles.length > 0) {
            currentHandles = result.dataHandles;
          }

          // If this follow-up method has its own follow-up actions, process them recursively
          if (result.followUpActions && result.followUpActions.length > 0) {
            const recursiveResult = await this.processFollowUpActions(
              definition,
              modelDef,
              context,
              result.followUpActions,
              currentHandles,
              depth + 1,
            );
            currentHandles = recursiveResult.dataHandles;
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

    return { dataHandles: currentHandles };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
