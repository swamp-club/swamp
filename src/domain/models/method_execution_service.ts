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
  type FileOutputSpec,
  type FollowUpAction,
  inferMethodKind,
  isMutatingKind,
  type MethodContext,
  type MethodDefinition,
  type MethodResult,
  type ModelDefinition,
  type ResourceOutputSpec,
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
import type { Data } from "../data/data.ts";
import type { DriverOutput } from "../drivers/execution_driver.ts";
import { RawExecutionDriver } from "../drivers/raw_execution_driver.ts";
import { driverTypeRegistry } from "../drivers/driver_type_registry.ts";

/**
 * Maximum depth for recursive follow-up action processing.
 * Prevents infinite loops in misconfigured workflows.
 */
const DEFAULT_MAX_FOLLOW_UP_DEPTH = 100;

/**
 * Filters data entries to only those belonging to declared resource specs.
 * Uses the `specName` tag that `writeResource()` auto-injects on every write.
 */
function filterDeclaredResourceData(
  allData: Data[],
  declaredResources: Record<string, unknown>,
): Data[] {
  const specNames = new Set(Object.keys(declaredResources));
  return allData.filter((d) =>
    d.tags["type"] === "resource" &&
    d.tags["specName"] !== undefined &&
    specNames.has(d.tags["specName"])
  );
}

/**
 * Context needed to persist "pending" driver outputs on the host side.
 * Uses types from MethodContext to avoid direct infrastructure imports.
 */
interface PersistContext extends
  Pick<
    MethodContext,
    | "dataRepository"
    | "modelType"
    | "modelId"
    | "tagOverrides"
    | "runtimeTags"
    | "vaultService"
  > {
  resources: Record<string, ResourceOutputSpec>;
  files: Record<string, FileOutputSpec>;
  definitionTags?: Record<string, string>;
  definitionName?: string;
  methodName?: string;
}

/**
 * Converts DriverOutput[] to DataHandle[].
 * For "persisted" outputs, extracts the handle directly.
 * For "pending" outputs (from out-of-process drivers), persists data
 * via the host-side DataWriter infrastructure.
 */
async function processDriverOutputs(
  outputs: DriverOutput[],
  persistContext?: PersistContext,
): Promise<DataHandle[]> {
  const handles: DataHandle[] = [];
  for (const output of outputs) {
    if (output.kind === "persisted") {
      handles.push(output.handle);
    } else if (output.kind === "pending" && persistContext) {
      if (output.type === "resource") {
        const { writeResource } = createResourceWriter(
          persistContext.dataRepository,
          persistContext.modelType,
          persistContext.modelId,
          persistContext.resources,
          persistContext.tagOverrides,
          undefined, // dataOutputOverrides
          persistContext.definitionTags,
          persistContext.runtimeTags,
          persistContext.definitionName,
          persistContext.vaultService,
          persistContext.methodName,
        );
        // Shape the raw content into resource data.
        // If content is valid JSON, use it directly.
        // Otherwise, build structured data from driver metadata + raw stdout.
        const text = new TextDecoder().decode(output.content);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(text);
        } catch {
          const meta = output.metadata ?? {};
          data = {
            ...meta,
            executedAt: new Date().toISOString(),
            stdout: text,
          };
        }
        const handle = await writeResource(
          output.specName,
          output.name,
          data,
        );
        handles.push(handle);
      } else if (output.type === "file") {
        const { createFileWriter } = createFileWriterFactory(
          persistContext.dataRepository,
          persistContext.modelType,
          persistContext.modelId,
          persistContext.files,
          persistContext.tagOverrides,
          undefined, // dataOutputOverrides
          undefined, // callbacks
          persistContext.definitionTags,
          persistContext.runtimeTags,
          persistContext.definitionName,
        );
        const writer = createFileWriter(output.specName, output.name);
        const handle = await writer.writeAll(output.content);
        handles.push(handle);
      }
    }
  }
  return handles;
}

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

    // Run pre-flight checks for mutating methods
    if (modelDef.checks && isMutatingKind(methodKind)) {
      const defChecks = currentDefinition.checkSelection;
      const requiredCheckNames = new Set(defChecks?.require ?? []);
      const skippedCheckNames = new Set(defChecks?.skip ?? []);

      const applicableChecks = Object.entries(modelDef.checks).filter(
        ([name, check]) => {
          // Definition-level skip always wins
          if (skippedCheckNames.has(name)) return false;
          // Respect appliesTo for all checks (including required)
          if (check.appliesTo && !check.appliesTo.includes(methodName)) {
            return false;
          }
          // Required checks are immune to CLI skip flags
          if (requiredCheckNames.has(name)) return true;
          // Non-required: honor CLI skip flags
          if (context.skipAllChecks) return false;
          if (context.skipCheckNames?.includes(name)) return false;
          if (
            context.skipCheckLabels &&
            check.labels?.some((l) => context.skipCheckLabels!.includes(l))
          ) {
            return false;
          }
          return true;
        },
      );

      if (applicableChecks.length > 0) {
        context.logger.info(
          `Running ${applicableChecks.length} pre-flight check(s)`,
        );

        const failures: Array<{ checkName: string; errors: string[] }> = [];

        for (const [checkName, check] of applicableChecks) {
          try {
            const checkResult = await check.execute({
              ...context,
              methodName,
              globalArgs: currentDefinition.globalArguments,
              definition: {
                id: currentDefinition.id,
                name: currentDefinition.name,
                version: currentDefinition.version,
                tags: currentDefinition.tags,
              },
            });
            if (!checkResult || typeof checkResult.pass !== "boolean") {
              failures.push({
                checkName,
                errors: [
                  "Check returned invalid result (expected { pass: boolean })",
                ],
              });
            } else if (!checkResult.pass) {
              failures.push({
                checkName,
                errors: checkResult.errors ?? ["Check failed"],
              });
            }
          } catch (error) {
            failures.push({
              checkName,
              errors: [
                error instanceof Error ? error.message : String(error),
              ],
            });
          }
        }

        if (failures.length > 0) {
          const lines = [
            `Pre-flight checks failed for "${currentDefinition.name}" → ${methodName}:`,
          ];
          for (const failure of failures) {
            lines.push(`  ${failure.checkName}:`);
            for (const err of failure.errors) {
              lines.push(`    - ${err}`);
            }
          }
          throw new UserError(lines.join("\n"));
        }
      }
    }

    // Fast-fail: reject read/update on deleted resources.
    // Only check declared resource data (tagged with specName matching a
    // declared resource spec). Block only when ALL declared resource data
    // is deleted — old historical data entries should not cause false positives.
    if (methodKind === "read" || methodKind === "update") {
      const resources = modelDef.resources ?? {};
      if (Object.keys(resources).length > 0) {
        const existingData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        const resourceData = filterDeclaredResourceData(
          existingData,
          resources,
        );
        if (
          resourceData.length > 0 && resourceData.every((d) => d.isDeleted)
        ) {
          const deleted = resourceData[0];
          let deletedAt = "unknown";
          try {
            const content = await context.dataRepository.getContent(
              context.modelType,
              context.modelId,
              deleted.name,
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
            `Resource '${deleted.name}' was deleted at ${deletedAt} — run a 'create' method to re-create it first`,
          );
        }
      }
    }

    // Resolve the execution driver
    const driverType = context.driver ?? "raw";
    const definitionHash = await currentDefinition.computeHash();

    const executionRequest:
      import("../drivers/execution_driver.ts").ExecutionRequest = {
        protocolVersion: 1,
        modelType: context.modelType.normalized,
        modelId: context.modelId,
        methodName,
        globalArgs: currentDefinition.globalArguments,
        methodArgs: currentDefinition.getMethodArguments(methodName),
        definitionMeta: {
          id: currentDefinition.id,
          name: currentDefinition.name,
          version: currentDefinition.version,
          tags: currentDefinition.tags,
        },
        resourceSpecs: modelDef.resources
          ? Object.fromEntries(
            Object.entries(modelDef.resources).map(([name, spec]) => [
              name,
              { description: spec.description },
            ]),
          )
          : undefined,
        fileSpecs: modelDef.files
          ? Object.fromEntries(
            Object.entries(modelDef.files).map(([name, spec]) => [
              name,
              { contentType: spec.contentType },
            ]),
          )
          : undefined,
      };

    let currentHandles: DataHandle[];
    let result: MethodResult;
    let executionContext: MethodContext = context;

    if (driverType === "raw") {
      // Use the raw in-process driver
      const driver = new RawExecutionDriver(
        this,
        currentDefinition,
        method,
        modelDef,
        context,
        methodName,
      );
      const driverResult = await driver.execute(executionRequest);

      if (driverResult.outputs.some((o) => o.kind === "pending")) {
        throw new Error(
          "Raw driver unexpectedly produced pending outputs — " +
            "this is a bug; raw driver should only produce persisted outputs",
        );
      }
      currentHandles = await processDriverOutputs(driverResult.outputs);
      result = {
        dataHandles: currentHandles,
        followUpActions: driverResult
          .followUpActions as FollowUpAction[] | undefined,
      };
      // Use the driver's context with writers for follow-up actions
      executionContext = driver.contextWithWriters ?? context;
    } else {
      // Populate bundle only for out-of-process drivers (raw driver doesn't use it)
      if (modelDef.bundleSourceFactory) {
        executionRequest.bundle = new TextEncoder().encode(
          await modelDef.bundleSourceFactory(),
        );
      }

      // Look up a registered driver type
      const driverInfo = driverTypeRegistry.get(driverType);
      if (!driverInfo) {
        throw new Error(
          `Unknown execution driver '${driverType}'. ` +
            `Available drivers: ${
              driverTypeRegistry.getAll().map((d) => d.type).join(", ")
            }`,
        );
      }
      if (!driverInfo.createDriver) {
        throw new Error(
          `Execution driver '${driverType}' does not have a createDriver factory.`,
        );
      }
      const driver = driverInfo.createDriver(context.driverConfig ?? {});
      const driverResult = await driver.execute(executionRequest, {
        onLog: (line) => context.logger?.info(line),
      });

      if (driverResult.status === "error") {
        throw new Error(driverResult.error ?? "Driver execution failed");
      }

      const resources = modelDef.resources ?? {};
      const files = modelDef.files ?? {};
      currentHandles = await processDriverOutputs(driverResult.outputs, {
        dataRepository: context.dataRepository,
        modelType: context.modelType,
        modelId: context.modelId,
        resources,
        files,
        tagOverrides: context.tagOverrides,
        definitionTags: currentDefinition.tags,
        runtimeTags: context.runtimeTags,
        definitionName: currentDefinition.name,
        vaultService: context.vaultService,
        methodName,
      });
      result = { dataHandles: currentHandles };
    }

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

    // Write deletion markers after a successful delete method.
    // Only mark declared resource data — untagged or non-resource data is left alone.
    // Markers include the last known active state so that data.latest() still
    // resolves original attributes after deletion (enables idempotent workflow re-runs).
    if (methodKind === "delete") {
      const resources = modelDef.resources ?? {};
      if (Object.keys(resources).length > 0) {
        const existingData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        const resourceData = filterDeclaredResourceData(
          existingData,
          resources,
        );
        for (const data of resourceData) {
          if (!data.isDeleted) {
            // Read last known active state to preserve in tombstone
            let lastKnownState: Record<string, unknown> = {};
            if (data.contentType === "application/json") {
              try {
                const activeContent = await context.dataRepository.getContent(
                  context.modelType,
                  context.modelId,
                  data.name,
                );
                if (activeContent) {
                  lastKnownState = JSON.parse(
                    new TextDecoder().decode(activeContent),
                  ) as Record<string, unknown>;
                }
              } catch {
                // Not valid JSON or read error — proceed with empty state
              }
            }

            const marker = data.withDeletionMarker({
              version: data.version + 1,
            });
            const markerContent = new TextEncoder().encode(JSON.stringify({
              ...lastKnownState,
              deletedAt: new Date().toISOString(),
              deletedByMethod: methodName,
            }));
            await context.dataRepository.save(
              context.modelType,
              context.modelId,
              marker,
              markerContent,
            );

            // Append deletion marker as a data handle so it surfaces
            // in the method response as a data artifact.
            currentHandles.push({
              name: data.name,
              specName: data.tags["specName"] ?? data.name,
              kind: "resource",
              dataId: marker.id,
              version: marker.version,
              size: markerContent.byteLength,
              tags: { ...marker.tags },
              metadata: {
                contentType: marker.contentType,
                lifetime: marker.lifetime,
                garbageCollection: marker.garbageCollection,
                streaming: marker.streaming,
                tags: { ...marker.tags },
                ownerDefinition: marker.ownerDefinition,
                lifecycle: marker.lifecycle,
              },
            });
          }
        }
      }
    }

    // Process follow-up actions
    if (result.followUpActions && currentHandles.length > 0) {
      const finalResult = await this.processFollowUpActions(
        currentDefinition,
        modelDef,
        executionContext,
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
