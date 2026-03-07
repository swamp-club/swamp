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
import {
  type DataHandle,
  type FollowUpAction,
  inferMethodKind,
  type MethodContext,
  type MethodDefinition,
  type MethodResult,
  type ModelDefinition,
} from "./model.ts";
import type { Definition } from "../definitions/definition.ts";
import { UserError } from "../errors.ts";
import type { DataArtifactRef } from "./model_output.ts";
import { ModelOutput } from "./model_output.ts";
import { DataOutputValidationService } from "./data_output_validation_service.ts";
import { DefinitionUpgradeService } from "./definition_upgrade_service.ts";
import {
  createFileWriterFactory,
  createResourceWriter,
} from "./data_writer.ts";
import { coerceMethodArgs } from "./zod_type_coercion.ts";
import { containsExpression } from "../expressions/expression_parser.ts";

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
    const rawMethodArgs = definition.getMethodArguments(context.methodName);
    const methodArgs = coerceMethodArgs(rawMethodArgs, method.arguments);
    const argsResult = method.arguments.safeParse(methodArgs);

    if (!argsResult.success) {
      throw new Error(
        `Method arguments validation failed: ${
          formatZodError(argsResult.error)
        }`,
      );
    }

    // Populate context with global args and definition metadata.
    // Wrap globalArgs in a Proxy that throws a clear error when the method
    // accesses a field with an unresolved ${{ ... }} expression.
    // This allows methods that don't need certain fields to succeed while
    // failing fast with a helpful message if they do.
    const rawGlobalArgs = definition.globalArguments;
    const globalArgsProxy = new Proxy(rawGlobalArgs, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (
          typeof prop === "string" && typeof value === "string" &&
          containsExpression(value)
        ) {
          throw new Error(
            `Unresolved expression in globalArguments.${prop}: ${value}`,
          );
        }
        return value;
      },
    });

    const enrichedContext: MethodContext = {
      ...context,
      globalArgs: globalArgsProxy,
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

    // Validate globalArguments against schema (after upgrade and runtime resolution).
    // GlobalArguments may contain unevaluated ${{ inputs.* }} expressions when
    // the user didn't provide those inputs (e.g., running "delete" without
    // create-time inputs). Strip unresolved fields before Zod validation so
    // methods that don't need them can proceed. A Proxy on context.globalArgs
    // will throw a clear error if the method actually accesses an unresolved field.
    if (modelDef.globalArguments) {
      const rawGlobalArgs = currentDefinition.globalArguments;

      // Identify globalArg fields with unresolved expressions (inputs,
      // model resource/file refs, or any other ${{ ... }} that wasn't evaluated)
      let hasUnresolved = false;
      const resolvedGlobalArgs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawGlobalArgs)) {
        if (typeof value === "string" && containsExpression(value)) {
          hasUnresolved = true;
        } else {
          resolvedGlobalArgs[key] = value;
        }
      }

      if (hasUnresolved) {
        // Validate only the resolved fields — unresolved fields are guarded
        // by a Proxy that throws when the method actually accesses them
        const coercedGlobalArgs = coerceMethodArgs(
          resolvedGlobalArgs,
          modelDef.globalArguments,
        );
        // Apply coerced values for resolved fields
        for (const [key, value] of Object.entries(coercedGlobalArgs)) {
          currentDefinition.setGlobalArgument(key, value);
        }
      } else {
        const coercedGlobalArgs = coerceMethodArgs(
          rawGlobalArgs,
          modelDef.globalArguments,
        );
        const globalArgsResult = modelDef.globalArguments.safeParse(
          coercedGlobalArgs,
        );
        if (!globalArgsResult.success) {
          throw new Error(
            `Global arguments validation failed: ${
              formatZodError(globalArgsResult.error)
            }`,
          );
        }
        // Update definition with parsed values so methods receive correct types
        const parsedGlobalArgs = globalArgsResult.data as Record<
          string,
          unknown
        >;
        for (const [key, value] of Object.entries(parsedGlobalArgs)) {
          currentDefinition.setGlobalArgument(key, value);
        }
      }
    }

    // Infer method kind for lifecycle checks
    const methodKind = inferMethodKind(methodName, method);

    // Fast-fail: reject read/update on deleted resources
    if (methodKind === "read" || methodKind === "update") {
      const resources = modelDef.resources ?? {};
      if (Object.keys(resources).length > 0) {
        const existingData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        for (const data of existingData) {
          if (data.isDeleted) {
            // Read the deletion marker content for the timestamp
            let deletedAt = "unknown";
            try {
              const content = await context.dataRepository.getContent(
                context.modelType,
                context.modelId,
                data.name,
              );
              if (content) {
                const marker = JSON.parse(
                  new TextDecoder().decode(content),
                );
                if (marker.deletedAt) {
                  deletedAt = marker.deletedAt;
                }
              }
            } catch {
              // Use default "unknown" timestamp
            }
            throw new UserError(
              `Resource '${data.name}' was deleted at ${deletedAt} — run a 'create' method to re-create it first`,
            );
          }
        }
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
      context.vaultService,
      methodName,
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

    // Write deletion markers after a successful delete method
    if (methodKind === "delete") {
      const resources = modelDef.resources ?? {};
      if (Object.keys(resources).length > 0) {
        const existingData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        for (const data of existingData) {
          if (!data.isDeleted) {
            const marker = data.withDeletionMarker({
              version: data.version + 1,
            });
            const content = new TextEncoder().encode(JSON.stringify({
              deletedAt: new Date().toISOString(),
              deletedByMethod: methodName,
            }));
            await context.dataRepository.save(
              context.modelType,
              context.modelId,
              marker,
              content,
            );
          }
        }
      }
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
