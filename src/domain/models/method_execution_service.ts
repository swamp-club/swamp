// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
  isMutatingKind,
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
import { modelRequiresVault } from "./data_writer.ts";
import {
  coerceMethodArgs,
  getObjectShape,
  isRecordSchema,
} from "./zod_type_coercion.ts";
import {
  extractExpressions,
  valueContainsExpression,
} from "../expressions/expression_parser.ts";
import { containsVaultExpression } from "../expressions/expression_evaluation_service.ts";
import type { Data } from "../data/data.ts";
import type { ExecutionOutput } from "./execution_envelope.ts";
import { InProcessExecutor } from "./in_process_executor.ts";
import {
  injectTraceContext,
  withSpan,
} from "../../infrastructure/tracing/mod.ts";
import {
  getRemoteStepDispatcher,
  type RemoteStepResult,
} from "../remote/remote_dispatch.ts";
import type { RpcStreamEvent } from "../remote/protocol.ts";
import { hasPlacement } from "../remote/scheduler.ts";
import { createDataId } from "../data/data_id.ts";

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
 * Extracts DataHandle[] from "persisted" execution outputs.
 * In-process execution persists data as it runs, so every output already
 * references existing data.
 */
function collectPersistedHandles(outputs: ExecutionOutput[]): DataHandle[] {
  const handles: DataHandle[] = [];
  for (const output of outputs) {
    if (output.kind === "persisted") {
      handles.push(output.handle);
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

  modelInvocationService?: {
    invoke: (
      options: Parameters<NonNullable<MethodContext["runModel"]>>[0],
      callerContext: MethodContext,
    ) => ReturnType<NonNullable<MethodContext["runModel"]>>;
  };

  workflowGateService?:
    import("./workflow_gate_service.ts").WorkflowGateService;

  async execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult> {
    // Get raw method arguments (may contain vault sentinel tokens)
    const rawMethodArgs = definition.getMethodArguments(context.methodName);

    // Resolve vault sentinels to raw values for method args and global args.
    // This ensures extension models receive exact secret values with no escaping.
    const secretBag = context.vaultSecrets;
    const resolvedMethodArgs = secretBag && !secretBag.isEmpty
      ? secretBag.resolveDeep(rawMethodArgs) as Record<string, unknown>
      : rawMethodArgs;
    const resolvedGlobalArgs = secretBag && !secretBag.isEmpty
      ? secretBag.resolveDeep(
        definition.globalArguments,
      ) as Record<string, unknown>
      : definition.globalArguments;

    // Merge global args as fallback under per-method args (per design/models.md:
    // "at execution time receives the merged set of global arguments and
    // per-method arguments"). Per-method arguments take precedence.
    // Exclude global args with unresolved ${{ ... }} expressions (recursively,
    // including nested objects/arrays) — those are guarded by a Proxy on
    // context.globalArgs and should not be injected into per-method arguments
    // where they could pass schema validation as plain strings.
    const filteredGlobalArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(resolvedGlobalArgs)) {
      if (valueContainsExpression(value)) {
        continue;
      }
      filteredGlobalArgs[key] = value;
    }
    // Build a separate filter from raw (pre-vault-resolution) global args so
    // vault sentinel tokens are preserved for unresolvedMethodArgs below.
    const filteredRawGlobalArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(definition.globalArguments)) {
      if (valueContainsExpression(value)) {
        continue;
      }
      filteredRawGlobalArgs[key] = value;
    }

    const mergedArgs = isRecordSchema(method.arguments)
      ? resolvedMethodArgs
      : { ...filteredGlobalArgs, ...resolvedMethodArgs };
    const methodArgs = coerceMethodArgs(mergedArgs, method.arguments);
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
    const globalArgsProxy = new Proxy(resolvedGlobalArgs, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && valueContainsExpression(value)) {
          const exprs = extractExpressions(value);
          const hasVault = exprs.some((e) =>
            containsVaultExpression(e.celExpression)
          );
          const hint = hasVault
            ? " (contains vault.get() — check vault configuration and run with --log-level debug for details)"
            : "";
          throw new Error(
            `Unresolved expression in globalArguments.${prop}${hint}: ${
              JSON.stringify(value)
            }`,
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
      // Store unresolved args (with sentinels) so the shell model can
      // resolve vault secrets via env vars instead of command string injection.
      // Merge raw (pre-vault-resolution) global args as fallback so vault
      // sentinel tokens from either source are preserved for env-var isolation.
      // Filter out unresolved ${{ }} expressions (same policy as the method
      // args merge above).
      unresolvedMethodArgs: {
        ...filteredRawGlobalArgs,
        ...rawMethodArgs,
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

  /**
   * Rebuild a full DataHandle from the orchestrator's durable record of a
   * remotely-written output. The dispatch result carries only identities;
   * metadata (content type, lifetime, ownerDefinition, tags) comes from the
   * datastore, which the data plane wrote moments ago.
   */
  async #rebuildRemoteHandle(
    context: MethodContext,
    output: RemoteStepResult["outputs"][number],
  ): Promise<DataHandle> {
    const data = await context.dataRepository.findByName(
      context.modelType,
      context.modelId,
      output.name,
      output.version,
    );
    if (data === null) {
      // The write was durable before the dispatch result returned; a miss
      // here means the record vanished out from under us — fail loudly
      // rather than fabricate metadata.
      throw new Error(
        `Remotely-written output '${output.name}' v${output.version} was not found in the datastore`,
      );
    }
    return {
      name: data.name,
      specName: output.specName,
      kind: output.type,
      dataId: createDataId(output.dataId),
      version: data.version,
      size: data.size ?? 0,
      tags: { ...data.tags },
      metadata: {
        contentType: data.contentType,
        lifetime: data.lifetime,
        garbageCollection: data.garbageCollection,
        streaming: data.streaming,
        tags: { ...data.tags },
        ownerDefinition: { ...data.ownerDefinition },
      },
    };
  }

  /**
   * Dispatch the method body to a remote worker through the registered
   * dispatcher port. Vault sentinels are resolved into the shipped args —
   * the same resolve-before-dispatch pattern out-of-process execution has
   * always used; secrets travel only for the step that needs them.
   */
  async #executeRemotely(
    context: MethodContext,
    executionRequest: import("./execution_envelope.ts").ExecutionRequest,
    modelDef: ModelDefinition,
    currentDefinition: Definition,
    methodName: string,
  ): Promise<RemoteStepResult> {
    const dispatcher = getRemoteStepDispatcher();
    if (dispatcher === null) {
      throw new UserError(
        `Step requests remote placement but no worker dispatcher is active — ` +
          `remote execution requires running under 'swamp serve' with enrolled workers`,
      );
    }

    const secretBag = context.vaultSecrets;
    const methodArgs = secretBag && !secretBag.isEmpty
      ? secretBag.resolveDeep(
        executionRequest.methodArgs,
      ) as Record<string, unknown>
      : executionRequest.methodArgs;
    const globalArgs = secretBag && !secretBag.isEmpty
      ? secretBag.resolveDeep(
        executionRequest.globalArgs,
      ) as Record<string, unknown>
      : executionRequest.globalArgs;

    return await withSpan("swamp.remote.dispatch", {
      "model.type": context.modelType.normalized,
      "method.name": methodName,
    }, () =>
      dispatcher.executeRemote({
        placement: context.placement!,
        modelDef,
        modelType: context.modelType,
        modelId: context.modelId,
        methodName,
        definitionName: currentDefinition.name,
        definitionTags: currentDefinition.tags,
        definitionMeta: executionRequest.definitionMeta,
        globalArgs,
        methodArgs,
        resourceSpecs: executionRequest.resourceSpecs,
        fileSpecs: executionRequest.fileSpecs,
        traceHeaders: executionRequest.traceHeaders,
        runtimeTags: context.runtimeTags,
        workflowName: context.tagOverrides?.workflow,
        jobName: context.tagOverrides?.job,
        stepName: context.tagOverrides?.step,
        signal: context.signal,
        dataRepo: context.dataRepository,
        onEvent: context.onEvent
          ? (event: RpcStreamEvent) => {
            if (event.kind === "method_event" && "event" in event) {
              context.onEvent!(
                event.event as Parameters<
                  NonNullable<
                    MethodContext["onEvent"]
                  >
                >[0],
              );
            } else if (
              event.kind === "queued" && "requirement" in event
            ) {
              context.onEvent!({
                type: "step_queued",
                requirement: event.requirement as string,
              });
            }
          }
          : undefined,
      }));
  }

  executeWorkflow(
    definition: Definition,
    modelDef: ModelDefinition,
    methodName: string,
    context: MethodContext,
  ): Promise<MethodResult> {
    return withSpan("swamp.model.method", {
      "model.name": definition.name,
      "model.type": context.modelType.normalized,
      "method.name": methodName,
    }, async () => {
      const method = modelDef.methods[methodName];
      if (!method) {
        throw new Error(`Method '${methodName}' not found in model`);
      }

      // Upgrade definition if needed
      const upgradeService = new DefinitionUpgradeService();
      const upgradeResult = upgradeService.upgrade(definition, modelDef);
      const currentDefinition = upgradeResult.definition;

      // Persist upgraded definition if it was upgraded.
      // IMPORTANT: The in-memory definition may have vault sentinel tokens
      // (from runtime expression resolution). Sentinels are per-process random
      // strings that become meaningless once the process exits. We must re-read
      // the original definition from disk (which has vault CEL expressions
      // intact), apply the upgrade to that copy, and persist it.
      if (upgradeResult.upgraded && context.definitionRepository) {
        const originalDefinition = await context.definitionRepository.findById(
          context.modelType,
          definition.id,
        );
        if (originalDefinition) {
          const diskUpgrade = upgradeService.upgrade(
            originalDefinition,
            modelDef,
          );
          await context.definitionRepository.save(
            context.modelType,
            diskUpgrade.definition,
          );
        }
      }

      // Resolve vault sentinels in globalArguments before validation.
      // Sentinels must be replaced with raw values so Zod schemas (e.g., url(),
      // regex()) validate against actual secret values, not sentinel tokens.
      const secretBag = context.vaultSecrets;
      if (secretBag && !secretBag.isEmpty) {
        const rawGlobal = currentDefinition.globalArguments;
        const resolvedGlobal = secretBag.resolveDeep(rawGlobal) as Record<
          string,
          unknown
        >;
        for (const [key, value] of Object.entries(resolvedGlobal)) {
          currentDefinition.setGlobalArgument(key, value);
        }
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
        // model resource/file refs, or any other ${{ ... }} that wasn't evaluated).
        // Uses valueContainsExpression for recursive detection of expressions
        // inside nested objects and arrays.
        let hasUnresolved = false;
        const resolvedGlobalArgs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rawGlobalArgs)) {
          if (valueContainsExpression(value)) {
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
          const globalArgsSchema = modelDef.globalArguments;
          const shape = getObjectShape(globalArgsSchema);
          if (shape) {
            const unknownKeys = Object.keys(coercedGlobalArgs).filter(
              (k) => !Object.hasOwn(shape, k),
            );
            if (unknownKeys.length > 0) {
              const validKeys = Object.keys(shape).join(", ");
              throw new Error(
                `Global arguments validation failed: Unknown argument(s): ${
                  unknownKeys.join(", ")
                }. Valid arguments are: ${validKeys || "none"}`,
              );
            }
          }
          // Use lenient validation: validate provided fields but don't
          // require missing ones. Direct execution creates ephemeral instances
          // where not all globalArgs are needed (e.g. get doesn't need
          // creation-time fields). swamp model create validates strictly.
          const lenientSchema = "partial" in globalArgsSchema &&
              typeof globalArgsSchema.partial === "function"
            ? (globalArgsSchema.partial() as z.ZodTypeAny)
            : globalArgsSchema;
          const globalArgsResult = lenientSchema.safeParse(
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

      // Build unresolvedMethodArgs for pre-flight checks so they can
      // validate method arguments. Mirrors the merge in execute() (line ~326):
      // per-method args override global args, with unresolved ${{ }}
      // expressions filtered from global args.
      const rawMethodArgs = currentDefinition.getMethodArguments(methodName);
      const filteredRawGlobalArgs: Record<string, unknown> = {};
      for (
        const [key, value] of Object.entries(
          currentDefinition.globalArguments,
        )
      ) {
        if (valueContainsExpression(value)) {
          continue;
        }
        filteredRawGlobalArgs[key] = value;
      }
      const checkUnresolvedMethodArgs: Record<string, unknown> = {
        ...filteredRawGlobalArgs,
        ...rawMethodArgs,
      };

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
                unresolvedMethodArgs: checkUnresolvedMethodArgs,
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

      // Fast-fail: reject methods that write sensitive output without a vault.
      if (
        isMutatingKind(methodKind) && modelRequiresVault(modelDef.resources)
      ) {
        const hasVault = context.vaultService &&
          context.vaultService.getVaultNames().length > 0;
        if (!hasVault) {
          throw new UserError(
            `Model "${currentDefinition.name}" has sensitive resource output ` +
              `fields but no vault is configured. Create a vault before ` +
              `running this method: swamp vault create <type> <name>`,
          );
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

      const definitionHash = await currentDefinition.computeHash();

      const executionRequest:
        import("./execution_envelope.ts").ExecutionRequest = {
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
          traceHeaders: injectTraceContext(),
        };

      // Pre-create ModelOutput before execution so its ID is available
      // as parentOutputId for nested runModel() invocations.
      let output: ModelOutput | undefined;
      if (context.outputRepository) {
        const provenance = context._invocationProvenance
          ? {
            definitionHash,
            modelVersion: modelDef.version,
            triggeredBy: context._invocationProvenance.triggeredBy,
            parentOutputId: context._invocationProvenance.parentOutputId,
            callerExtension: context._invocationProvenance.callerExtension,
          }
          : {
            definitionHash,
            modelVersion: modelDef.version,
            triggeredBy: "manual" as const,
          };
        output = ModelOutput.create({
          definitionId: currentDefinition.id,
          methodName,
          status: "running",
          provenance,
        });
        context._currentOutputId = output.id;
        await context.outputRepository.save(modelDef.type, methodName, output);
      }

      let currentHandles: DataHandle[];
      let result: MethodResult;
      let executionContext: MethodContext = context;

      try {
        if (context.placement && hasPlacement(context.placement)) {
          // Remote placement: the method body runs on a matching worker; the
          // surrounding pipeline (checks above, output records and follow-up
          // actions below) stays at the orchestrator. See
          // design/remote-execution.md.
          const remoteResult = await this.#executeRemotely(
            context,
            executionRequest,
            modelDef,
            currentDefinition,
            methodName,
          );
          // Rebuild full handles from the durable records the data plane
          // persisted — downstream consumers (data-record mapping, workflow
          // artifact tracking) read metadata like ownerDefinition, which the
          // wire-thin dispatch outputs do not carry.
          currentHandles = await Promise.all(
            remoteResult.outputs.map((output) =>
              this.#rebuildRemoteHandle(context, output)
            ),
          );
          result = {
            dataHandles: currentHandles,
            followUpActions: remoteResult
              .followUpActions as FollowUpAction[] | undefined,
            executor: remoteResult.workerName,
          };
        } else {
          // Execute in-process — the single-host path (see
          // design/remote-execution.md "No execution drivers").
          const inProcessExecutor = new InProcessExecutor(
            this,
            currentDefinition,
            method,
            modelDef,
            context,
            methodName,
            this.modelInvocationService,
            this.workflowGateService,
          );
          const executionResult = await withSpan("swamp.method.execute", {
            "model.type": context.modelType.normalized,
          }, () => inProcessExecutor.execute(executionRequest));

          if (executionResult.outputs.some((o) => o.kind === "pending")) {
            throw new Error(
              "In-process execution unexpectedly produced pending outputs — " +
                "this is a bug; in-process execution should only produce " +
                "persisted outputs",
            );
          }
          // Process outputs first — even on error, data may have been written
          // to disk before the method threw (e.g. code-review writes log then
          // throws on verdict=FAIL). Handles must survive the error path.
          currentHandles = collectPersistedHandles(executionResult.outputs);

          if (executionResult.status === "error") {
            const err = new Error(
              executionResult.error ?? "Method execution failed",
            );
            (err as unknown as Record<string, unknown>).dataHandles =
              currentHandles;
            throw err;
          }

          result = {
            dataHandles: currentHandles,
            followUpActions: executionResult
              .followUpActions as FollowUpAction[] | undefined,
            executor: "loopback",
          };
          // Use the executor's context with writers for follow-up actions
          executionContext = inProcessExecutor.contextWithWriters ?? context;
        }
      } catch (error) {
        if (output && context.outputRepository) {
          output.markFailed({
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          await context.outputRepository.save(
            modelDef.type,
            methodName,
            output,
          );
        }
        throw error;
      }

      // Collect artifact refs from handles (data is already persisted)
      const storedArtifacts: DataArtifactRef[] = currentHandles.map((h) => ({
        dataId: h.dataId,
        name: h.name,
        version: h.version,
        tags: h.tags,
      }));

      if (output && context.outputRepository) {
        for (const artifact of storedArtifacts) {
          output.addDataArtifact(artifact);
        }
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
    }); // end withSpan
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
