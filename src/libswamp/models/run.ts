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

import type { DeferredExpression } from "../../domain/expressions/deferred_expression.ts";
import {
  type SwampError,
  validationFailed,
  wordedSwampError,
} from "../errors.ts";
import { inputValidationFailed } from "../workflows/run.ts";
import { selectLookup } from "../lookup_by_id.ts";
import type { LibSwampContext } from "../context.ts";
import { markOutcomeReported, withUnitOfWork } from "../unit_of_work.ts";
import type { MethodExecutionEvent } from "../../domain/models/method_events.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import { createModelUpdated } from "../../domain/events/types.ts";
import {
  DefaultModelValidationService,
  envVarWarningText,
} from "../../domain/models/validation_service.ts";
import {
  carryModelWording,
  markModelWording,
  wordedText,
  wordedUserError,
} from "../../domain/behavior_wording.ts";
import {
  executeReports,
  type ReportExecutionResult,
} from "../../domain/reports/report_execution_service.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { BUILTIN_METHOD_REPORTS } from "../../domain/reports/builtin/mod.ts";
import {
  buildMethodReportContext,
  type ModelReportContext,
} from "../../domain/reports/report_context.ts";
import { buildOutputSpecs } from "../../domain/models/output_spec_builder.ts";
import type { ReportResultView } from "./model_method_run_view.ts";
import type { Definition } from "../../domain/definitions/definition.ts";
import type { InputsSchema } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import {
  type MethodExecutionService,
  recoveredDataHandles,
  writtenVersionsOf,
} from "../../domain/models/method_execution_service.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import type { WrittenVersion } from "../../domain/datastore/datastore_sync_service.ts";
import type { OutputRepository } from "../../domain/models/repositories.ts";
import type { VaultService } from "../../domain/vaults/vault_service.ts";
import type { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { collectAuthoredExpressions } from "../../domain/expressions/expression_evaluation_service.ts";
import {
  secretRefusalCode,
  UnresolvedExpressionError,
} from "../../domain/expressions/errors.ts";
import {
  assertMethodArgumentsEvaluated,
  type FailedExpressions,
} from "../../domain/expressions/unresolved_expression_guard.ts";
import {
  RunSensitiveValues,
  type SecretRedactor,
  type WrittenReference,
} from "../../domain/secrets/mod.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import {
  alignProvenance,
  keySegment,
  methodArgumentPath,
  ProvenanceMap,
  routedGlobalProvenance,
  sentinelStandInOf,
} from "../../domain/expressions/provenance_map.ts";
import { attachBindingProvenance } from "../../domain/expressions/splice_origin.ts";
import {
  EVALUATED_CACHE_HOLDS_SENSITIVE_ARGUMENTS_CODE,
  evaluatedCacheHoldsSensitiveArgumentsMessage,
  findPlaintextSensitiveArguments,
  isNewerSensitiveFormat,
  type MaskedPath,
  maskSensitiveArgumentsForDisplay,
  mayHoldPlaintextSensitiveValues,
  persistEvaluatedDefinition,
  rehydrateEvaluatedDefinition,
} from "../../domain/expressions/persisted_evaluation.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import {
  createEphemeralStore,
  wrapWithEphemeral,
} from "../../infrastructure/persistence/ephemeral_store.ts";
import {
  buildMethodContext,
  type CommonMethodContextDeps,
} from "../../domain/models/method_context.ts";
import { createExtensionCelEnvironment } from "../../infrastructure/cel/cel_evaluator.ts";
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import type {
  DataArtifactView,
  ModelMethodRunView,
} from "./model_method_run_view.ts";
import {
  type ErrorRedactor,
  executionErrorFrom,
  ModelOutput,
  redactedError,
} from "../../domain/models/model_output.ts";
import { cancelCause } from "../../domain/models/cancel_cause.ts";
import {
  coerceInputTypes,
  InputValidationService,
} from "../../domain/inputs/mod.ts";
import {
  extractInputReferences,
  readSetMap,
} from "../../domain/expressions/expression_parser.ts";
import {
  extractSensitiveFieldValues,
  literalSensitiveGlobalArgsMessage,
} from "../../domain/models/sensitive_field_extractor.ts";
import { detectEnvVarUsageInDefinition } from "../../domain/models/env_var_detector.ts";
import { getObjectShape } from "../../domain/models/zod_type_coercion.ts";
import { withEventBridge } from "../../infrastructure/stream/event_bridge.ts";
import type { MethodResult } from "../../domain/models/model.ts";
import { getRunLogger } from "../../infrastructure/logging/logger.ts";
import {
  getTracer,
  withGeneratorSpan,
  withGeneratorTraceContext,
} from "../../infrastructure/tracing/mod.ts";
import { resolveOrCreateDefinition } from "./direct_execution.ts";
import { autoGc, type AutoGcLifecycleDeps } from "../data/gc.ts";
import { DefaultDataLifecycleService } from "../../domain/data/data_lifecycle_service.ts";
import { ActiveRun } from "../../domain/models/active_run.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import { hostname } from "node:os";
import {
  registerRunProgress,
  removeRunProgress,
  type RunProgress,
  withRunPhase,
  withRunProgress,
} from "../../domain/remote/run_progress.ts";
import {
  type DiagnosticPhaseHandle,
  observeDiagnosticPhase,
  startDiagnosticPhase,
} from "../../domain/diagnostics/diagnostic_phase.ts";

/**
 * Events emitted by the libswamp model method run generator.
 */
/** Describes a single env var usage in a definition. */
export interface EnvVarUsage {
  path: string;
  envVar: string;
}

export type ModelMethodRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "resolving_model"; modelIdOrName: string }
  | {
    kind: "auto_created";
    modelType: string;
    definitionName: string;
    definitionPath: string;
  }
  | {
    kind: "global_args_updated";
    definitionName: string;
  }
  | {
    kind: "model_resolved";
    modelName: string;
    modelType: string;
    modelId: string;
    methodName: string;
  }
  | {
    kind: "env_var_warning";
    modelName: string;
    envVars: EnvVarUsage[];
    message: string;
  }
  | { kind: "evaluating_expressions"; lastEvaluated: boolean }
  | { kind: "executing"; modelName: string; methodName: string }
  | {
    kind: "method_output";
    modelName: string;
    methodName: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "method_event";
    modelName: string;
    methodName: string;
    event: MethodExecutionEvent;
  }
  | { kind: "data_artifact_saved"; name: string; path: string }
  | {
    kind: "report_started";
    reportName: string;
    scope: string;
  }
  | {
    kind: "report_completed";
    reportName: string;
    scope: string;
    markdown: string;
    json: Record<string, unknown>;
  }
  | {
    kind: "report_failed";
    reportName: string;
    scope: string;
    error: string;
  }
  | { kind: "completed"; run: ModelMethodRunView }
  | { kind: "cancelled"; run: ModelMethodRunView; reason?: string }
  | { kind: "auto_gc_started" }
  | {
    kind: "auto_gc_completed";
    versionsDeleted: number;
    bytesReclaimed: number;
    dataEntriesExpired: number;
  }
  | { kind: "error"; error: SwampError };

/**
 * Log context for a single model method run.
 */
export interface RunLog {
  logFilePath: string;
  redactor: SecretRedactor;
  cleanup: () => void;
  runId?: string;
}

/**
 * Dependencies injected into the model method run generator.
 */
export interface ModelMethodRunDeps {
  repoDir: string;
  /**
   * Told, in this process, the data versions the method wrote, on success
   * and on failure, so the caller's model lock can publish them and check
   * the remote holds them (swamp-club#3146). Never part of the event stream.
   */
  onWrittenVersions?: (
    versions: readonly WrittenVersion[],
    outcome: "completed" | "failed",
  ) => void;
  /** Looks up by name, then by exact id. */
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  /** Looks up by exact id only; required for a `byId` request. */
  lookupDefinitionById?: (
    id: string,
    expectedName?: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
  createEvaluationService: () => ExpressionEvaluationService;
  loadEvaluatedDefinition: (
    type: ModelType,
    name: string,
  ) => Promise<
    {
      definition: Definition;
      authoredExpressions: ReadonlySet<string>;
      deferredExpressions?: readonly DeferredExpression[];
      writtenReferences?: readonly WrittenReference[];
      /** See the evaluated cache's `maskedPaths`; absent on older caches. */
      maskedPaths?: readonly MaskedPath[];
      persistedProvenance?: ProvenanceMap | "unreadable";
      /** See the evaluated cache's `provenance`; absent on older caches. */
      provenance?: ProvenanceMap | "unreadable";
      sensitiveFormat?: number;
    } | null
  >;
  saveEvaluatedDefinition: (
    type: ModelType,
    definition: Definition,
    /** Where data sits in the definition's raw copy (swamp-club#3205). */
    provenance: ProvenanceMap,
    authoredExpressions: ReadonlySet<string>,
    writtenReferences?: readonly WrittenReference[],
    /** Where the definition holds the mask (swamp-club#3681). */
    maskedPaths?: readonly MaskedPath[],
    persistedProvenance?: ProvenanceMap,
  ) => Promise<void>;
  createExecutionService: () => MethodExecutionService;
  createVaultService: () => Promise<VaultService>;
  dataRepo: UnifiedDataRepository;
  catalogStore?: CatalogStore;
  definitionRepo: YamlDefinitionRepository;
  outputRepo: OutputRepository;
  dataQueryService: DataQueryService;
  createRunLog: (
    modelType: ModelType,
    methodName: string,
    definitionId: string,
  ) => Promise<RunLog>;
  createAndSaveDefinition?: (
    type: ModelType,
    definition: Definition,
  ) => Promise<void>;
  getDefinitionPath?: (type: ModelType, id: string) => string;
  autoDefinitionsDir?: string;
  runTracker?: RunTrackerRepository;
  eventBus?: EventBus;
  workflowRepo?:
    import("../../domain/workflows/repositories.ts").WorkflowRepository;
  workflowRunRepo?:
    import("../../domain/workflows/repositories.ts").WorkflowRunRepository;
}

/**
 * Input for the model method run generator.
 */
export interface ModelMethodRunInput {
  modelIdOrName: string;
  /**
   * Treat `modelIdOrName` as a definition id the caller already resolved,
   * and look it up by id only, so the run executes the model the caller
   * authorized. Applies to the standard path only; direct type execution
   * resolves `definitionName` itself.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a resource with this name and the id is accepted.
   */
  expectedName?: string;
  methodName: string;
  inputs: Record<string, unknown>;
  /**
   * Treat `inputs` as data: expression text in them is never evaluated, and
   * a global argument holding any is refused rather than persisted
   * (swamp-club#3205). Cannot be combined with `lastEvaluated`.
   */
  literalInputs?: boolean;
  lastEvaluated: boolean;
  /** When present, enables direct type execution (auto-create-then-run). */
  typeArg?: string;
  /** Definition name for direct type execution (separate from modelIdOrName). */
  definitionName?: string;
  /**
   * With `definitionName`, the id of the definition the caller authorized,
   * or null when it authorized a name no definition had.
   */
  expectedDefinitionId?: string | null;
  /**
   * Called when `expectedDefinitionId` is null (no definition had the name)
   * and a concurrent run has since created one. The run proceeds on it only
   * if this allows it, so the caller authorizes what actually runs
   * (swamp-club#2672).
   */
  authorizeResolvedDefinition?: (
    found: { definition: Definition; type: ModelType },
  ) => boolean;
  runtimeTags?: Record<string, string>;
  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  skipAllChecks?: boolean;
  skipReportNames?: string[];
  skipReportLabels?: string[];
  skipAllReports?: boolean;
  reportNames?: string[];
  reportLabels?: string[];
  swampSha?: string;
  autoGc?: boolean;
  /** W3C traceparent header for per-invocation trace context. */
  traceparent?: string;
  /** W3C tracestate header for per-invocation trace context. */
  tracestate?: string;
  /** Identity of the user who initiated this run (e.g. "user:paul"). */
  initiatedBy?: string;
  /** The `swamp serve` instance running this method run, when serve runs it. */
  instanceId?: string;
}

/**
 * Executes a model method, yielding progress events as a libswamp stream.
 */
export async function* modelMethodRun(
  ctx: LibSwampContext,
  deps: ModelMethodRunDeps,
  input: ModelMethodRunInput,
): AsyncGenerator<ModelMethodRunEvent> {
  let methodProgress: RunProgress | undefined;
  // Everything before setup, as the `prepare` diagnostic phase. Ended when
  // setup starts; ended here when the run stops before it.
  let prepare: DiagnosticPhaseHandle | undefined;
  let finished = false;
  try {
    yield* withUnitOfWork(ctx, () =>
      withGeneratorTraceContext(
        input.traceparent,
        input.tracestate,
        withGeneratorSpan(
          "swamp.model.method.run",
          {
            "model.id_or_name": input.modelIdOrName,
            "method.name": input.methodName,
          },
          (async function* (): AsyncGenerator<ModelMethodRunEvent> {
            const preparing = startDiagnosticPhase("prepare");
            prepare = preparing;
            // An error reported before setup ends preparation as failed now:
            // a consumer that stops on the event closes this generator, which
            // must not then read as a cancellation.
            const prepareFailed = <E>(event: E): E => {
              preparing.end("error");
              return event;
            };
            // Runs a preparation step as a child of `prepare`.
            const inPrepare = <A extends unknown[], R>(
              fn: (...args: A) => Promise<R>,
            ) =>
            (...args: A) => preparing.run(() => fn(...args));
            const resolveModelDef = (type: ModelType) =>
              preparing.run(() =>
                observeDiagnosticPhase(
                  "type_resolution",
                  {},
                  () => Promise.resolve(deps.getModelDef(type)),
                )
              );
            const ephemeral = createEphemeralStore(deps.dataRepo.namespace);
            if (deps.catalogStore) {
              const wrapped = wrapWithEphemeral(
                deps.dataRepo,
                deps.catalogStore,
                ephemeral,
              );
              deps = { ...deps, ...wrapped };
            }

            // --- Validate inputs phase ---
            yield { kind: "validating_inputs" };
            if (input.literalInputs && input.lastEvaluated) {
              // The cached evaluation may hold expressions an earlier run's
              // operator-written inputs vouched for; replaying it under
              // literal inputs would trust them.
              yield prepareFailed({
                kind: "error",
                error: validationFailed(
                  "--literal-inputs cannot be combined with --last-evaluated: the cached evaluation may hold expressions an earlier run's inputs vouched for.",
                ),
              });
              return;
            }
            // Keys the caller supplied; under literalInputs they are data.
            const callerInputKeys = new Set(Object.keys(input.inputs));

            // --- Resolve model ---
            yield {
              kind: "resolving_model",
              modelIdOrName: input.modelIdOrName,
            };

            let definition: Definition;
            // Where data sits in the definition before evaluation: the global
            // arguments a direct execution routed from literal inputs
            // (swamp-club#3205). Authored everywhere else.
            let routedGlobalsProvenance = ProvenanceMap.authored();
            let modelType: ModelType;
            let modelDef: ModelDefinition;

            if (input.typeArg && input.definitionName) {
              // Direct type execution path: auto-create-then-run
              const typeArg = input.typeArg;
              let resolvedType = ModelType.create(typeArg);

              let resolvedModelDef = await resolveModelDef(resolvedType);

              // Fallback: the @ prefix is the CLI syntax marker for direct execution
              // but repo-local extensions register types without @. Try stripping it.
              if (!resolvedModelDef && typeArg.startsWith("@")) {
                const strippedType = ModelType.create(typeArg.slice(1));
                const strippedDef = await resolveModelDef(strippedType);
                if (strippedDef) {
                  resolvedType = strippedType;
                  resolvedModelDef = strippedDef;
                }
              }

              // Use the model definition's canonical type so data is stored
              // under the registered type path, not the caller's @-prefixed
              // syntax marker (e.g. swamp/grant, not @swamp/grant).
              if (resolvedModelDef) {
                resolvedType = resolvedModelDef.type;
              }

              if (!resolvedModelDef) {
                yield prepareFailed({
                  kind: "error",
                  error: unknownModelType(resolvedType.normalized),
                });
                return;
              }

              if (!deps.createAndSaveDefinition || !deps.getDefinitionPath) {
                yield prepareFailed({
                  kind: "error",
                  error: {
                    code: "missing_deps",
                    message:
                      "Direct type execution is not supported in this context",
                  },
                });
                return;
              }

              const result = await inPrepare(resolveOrCreateDefinition)(
                {
                  lookupDefinition: input.expectedDefinitionId === undefined
                    ? deps.lookupDefinition
                    : async (name) => {
                      const found = await deps.lookupDefinition(name);
                      // Only a definition created since a check that found
                      // none (a concurrent run) may be adopted, if the caller
                      // may run it: creation is serialized by the
                      // auto-definition lock. One renamed in or deleted since
                      // is refused, since the lock held is not its lock and
                      // what would be created was never authorized.
                      const adoptable = input.expectedDefinitionId === null &&
                        found !== null &&
                        input.authorizeResolvedDefinition?.(found) === true;
                      if (
                        (found?.definition.id ?? null) !==
                          input.expectedDefinitionId &&
                        !adoptable
                      ) {
                        throw wordedUserError(
                          wordedText((w) =>
                            `${w.Noun} ${name} changed while the request was being ` +
                            `authorized; run it again`
                          ),
                        );
                      }
                      return found;
                    },
                  getModelDef: deps.getModelDef,
                  saveDefinition: deps.createAndSaveDefinition,
                  getDefinitionPath: deps.getDefinitionPath,
                },
                typeArg,
                input.definitionName,
                input.methodName,
                input.inputs,
                resolvedType,
                resolvedModelDef,
                undefined,
                deps.autoDefinitionsDir,
                // Inputs are typed by the operator running the command, unless
                // the caller marked them as data.
                input.literalInputs ? new Set() : "unrestricted",
                undefined,
                input.literalInputs
                  ? {
                    inputs: ProvenanceMap.data(),
                    globalArgs: ProvenanceMap.data(),
                  }
                  : undefined,
              );

              if (!result.ok) {
                yield prepareFailed({ kind: "error", error: result.error });
                return;
              }

              if (result.created) {
                yield {
                  kind: "auto_created",
                  modelType: resolvedType.normalized,
                  definitionName: result.definition.name,
                  definitionPath: result.definitionPath,
                };
              }

              if (result.globalArgsUpdated) {
                yield {
                  kind: "global_args_updated",
                  definitionName: result.definition.name,
                };
              }

              definition = result.definition;
              modelType = result.modelType;
              modelDef = result.modelDef;
              if (input.literalInputs) {
                routedGlobalsProvenance = routedGlobalProvenance(
                  result.routedInputs.globalArguments,
                  input.inputs,
                  ProvenanceMap.data(),
                );
              }

              // Use routed method arguments as the inputs for downstream processing.
              // Global args are already stored in the auto-created definition.
              input = {
                ...input,
                inputs: { ...result.routedInputs.methodArguments },
              };
            } else {
              // Standard path: look up existing definition
              const lookupDefinition = selectLookup(
                "model method run",
                input.byId,
                deps.lookupDefinition,
                deps.lookupDefinitionById,
                input.expectedName,
              );
              const lookupResult = await inPrepare(lookupDefinition)(
                input.modelIdOrName,
              );
              if (!lookupResult) {
                yield prepareFailed({
                  kind: "error",
                  error: modelNotFound(input.modelIdOrName),
                });
                return;
              }
              definition = lookupResult.definition;
              modelType = lookupResult.type;

              const resolvedModelDef = await resolveModelDef(modelType);
              if (!resolvedModelDef) {
                yield prepareFailed({
                  kind: "error",
                  error: unknownModelType(modelType.normalized),
                });
                return;
              }
              modelDef = resolvedModelDef;

              // A hand-edited definition skips the save-time refusal, so a
              // literal sensitive global is refused before it is used or shown.
              // Read after the upgrade chain too, as validate reads it: an
              // upgrade can move a literal into a sensitive field.
              const leakedArgs = new DefaultModelValidationService()
                .findLiteralSensitiveGlobals(definition, modelDef);
              if (leakedArgs.length > 0) {
                yield prepareFailed({
                  kind: "error",
                  error: validationFailed(
                    literalSensitiveGlobalArgsMessage(leakedArgs),
                  ),
                });
                return;
              }
            }

            // Validate method exists
            const method = modelDef.methods[input.methodName];
            if (!method) {
              const availableMethods = Object.keys(modelDef.methods).join(", ");
              yield prepareFailed({
                kind: "error",
                error: unknownMethod(
                  input.methodName,
                  modelType.normalized,
                  availableMethods,
                ),
              });
              return;
            }

            // Coerce and validate inputs against model's input schema
            const inputs = { ...input.inputs };
            if (definition.inputs) {
              const coercedInputs = coerceInputTypes(inputs, definition.inputs);
              Object.assign(inputs, coercedInputs);

              const validationService = new InputValidationService();
              const inputsWithDefaults = validationService.applyDefaults(
                inputs,
                definition.inputs,
              );

              // Build effective schema: only require inputs referenced by the method's arguments
              const referencedInputs = extractInputReferences(
                definition.getMethodArguments(input.methodName),
              );
              const originalRequired = definition.inputs.required ?? [];
              const effectiveRequired = originalRequired.filter((name) =>
                referencedInputs.has(name)
              );
              const effectiveSchema: InputsSchema = {
                ...definition.inputs,
                required: effectiveRequired,
              };

              const validationResult = validationService.validate(
                inputsWithDefaults,
                effectiveSchema,
              );
              if (!validationResult.valid) {
                yield prepareFailed({
                  kind: "error",
                  error: inputValidationFailed(validationResult.errors),
                });
                return;
              }
              Object.assign(inputs, inputsWithDefaults);
            }

            let runLogger = getRunLogger(definition.name, input.methodName);
            runLogger.debug("Found model {name} ({type})", {
              name: definition.name,
              type: modelType.normalized,
            });

            yield {
              kind: "model_resolved",
              modelName: definition.name,
              modelType: modelType.normalized,
              modelId: definition.id,
              methodName: input.methodName,
            };

            // --- Check for env var usage and warn ---
            const envVarUsages = detectEnvVarUsageInDefinition(definition);
            if (envVarUsages.length > 0) {
              const worded = envVarWarningText();
              yield markModelWording({
                kind: "env_var_warning" as const,
                modelName: definition.name,
                envVars: envVarUsages,
                message: worded.text,
              }, worded.modelText);
            }

            // --- Set up logging ---
            preparing.end();
            const setupSpan = getTracer().startSpan("swamp.model.method.setup");
            const runLog = await deps.createRunLog(
              modelType,
              input.methodName,
              definition.id,
            );
            const { logFilePath, redactor } = runLog;
            // Every sensitive value this run resolves for an expression is
            // recorded here and forwarded to the run's redactor. The registry
            // it carries is the run's typed-secrets switch (typed-secrets 3.5).
            const sensitiveValues = new RunSensitiveValues(redactor);
            if (runLog.runId) {
              runLogger = getRunLogger(
                definition.name,
                input.methodName,
                runLog.runId,
              );
            }

            try {
              // --- Evaluate expressions ---
              const exprSpan = getTracer().startSpan(
                "swamp.model.method.evaluate_expressions",
              );
              yield {
                kind: "evaluating_expressions",
                lastEvaluated: input.lastEvaluated,
              };

              // Over the stored definition, before the --input overrides below
              // write into it (a definition with no expressions is not copied
              // first): the hash then tells a definition edit from a different
              // input, and no input value reaches it (swamp-club#3722).
              const definitionHash = await definition.computeHash();

              const evaluationService = deps.createEvaluationService();
              let evaluatedDefinition = definition;
              // The copy that executes: the same splices as evaluatedDefinition,
              // with sensitive data values in its arguments replaced by
              // sentinels from this step's bag. evaluatedDefinition keeps real
              // values for caching, reports and self.globalArguments.
              let executedDefinition = definition;
              // Where data sits in the executed copy's data (swamp-club#3205).
              let executedProvenance = ProvenanceMap.authored();
              // Where data sits in the raw copy, as the evaluated cache stores it.
              let rawProvenance = ProvenanceMap.authored();
              // Method arguments the operator set whole with --input. The
              // value is the operator's own text for that argument, not data
              // spliced into the definition's, so a method that places data
              // text reads it as authored, as it reads the definition
              // (swamp-club#3868).
              const operatorArgumentKeys: string[] = [];
              const stepSecretBag = new VaultSecretBag(
                sensitiveValues.sentinels,
              );

              // Provenance for the runtime pass, collected from the SOURCE
              // definition — never from the evaluated one, which already has data
              // content spliced into it. Cached provenance is unioned below for
              // --last-evaluated. Inputs are typed by the operator
              // running the command (or an authenticated serve caller), so
              // expressions in them — schema-declared or method overrides — are
              // author-written too.
              // Under literalInputs the caller's inputs are data: they vouch for
              // nothing, and every key they supplied is data in the context.
              const sourceExpressions = collectAuthoredExpressions(
                definition.toData(),
              );
              const authoredExpressions = input.literalInputs
                ? new Set(sourceExpressions)
                : collectAuthoredExpressions(
                  inputs,
                  new Set(sourceExpressions),
                );
              // Where data sits in the inputs. The values an operator types are
              // the run's data, not the definition's source: spliced into a
              // sensitive argument they are masked in the cache and the
              // reports like any other data (swamp-club#3681). Only the
              // expression occurrences the operator typed stay authored, so
              // they still resolve. Under literalInputs every value is data
              // whole. A schema default is the definition's own.
              let inputsProvenance = ProvenanceMap.authored();
              for (const [key, value] of Object.entries(inputs)) {
                if (!callerInputKeys.has(key)) {
                  continue;
                }
                inputsProvenance = inputsProvenance.graft(
                  keySegment(key),
                  input.literalInputs
                    ? ProvenanceMap.data()
                    : readSetMap(value, collectAuthoredExpressions(value)),
                );
              }

              let deferredExpressions: readonly DeferredExpression[] = [];
              let failedExpressions: FailedExpressions = new Map();
              let pendingSave: Definition | undefined;
              let pendingReferences: readonly WrittenReference[] = [];
              let pendingMasked: readonly MaskedPath[] = [];
              let pendingProvenance = ProvenanceMap.authored();
              let pendingPersistedProvenance = ProvenanceMap.authored();
              // The inputs the definition declares; any other --input key is an
              // override of a method argument, merged below.
              const definitionInputKeys = definition.inputs
                ? Object.keys(
                  (definition.inputs as {
                    properties?: Record<string, unknown>;
                  })
                    .properties || {},
                )
                : [];
              if (input.lastEvaluated) {
                const lastEval = await deps.loadEvaluatedDefinition(
                  modelType,
                  definition.name,
                );
                if (!lastEval) {
                  exprSpan.end();
                  setupSpan.end();
                  yield {
                    kind: "error",
                    error: noEvaluatedDefinition(definition.name),
                  };
                  return;
                }
                if (mayHoldPlaintextSensitiveValues(lastEval)) {
                  exprSpan.end();
                  setupSpan.end();
                  yield {
                    kind: "error",
                    error: evaluatedCacheMayHoldSecrets(definition.name),
                  };
                  return;
                }
                // A newer swamp may have written a sensitive value in a form
                // this one does not recognise, as the mask is to a reader
                // before it (swamp-club#3681).
                if (isNewerSensitiveFormat(lastEval)) {
                  exprSpan.end();
                  setupSpan.end();
                  yield {
                    kind: "error",
                    error: evaluatedCacheFormatNewer(definition.name),
                  };
                  return;
                }
                if (
                  lastEval.provenance === "unreadable" ||
                  lastEval.persistedProvenance === "unreadable"
                ) {
                  exprSpan.end();
                  setupSpan.end();
                  yield {
                    kind: "error",
                    error: evaluatedCacheProvenanceUnreadable(definition.name),
                  };
                  return;
                }
                // A cache holds a sensitive argument that did not come from a
                // vault as the mask, or in plaintext when an older swamp wrote
                // it; neither replays (swamp-club#3681). Checked before
                // rehydration and provenance alignment, which such a cache
                // would not survive. Only this method's arguments count, and
                // one an --input override replaces below never executes from
                // the cache, so it is left out.
                const plaintextArgs = findPlaintextSensitiveArguments(
                  modelDef,
                  lastEval.definition.toData(),
                  lastEval.writtenReferences ?? [],
                  {
                    method: {
                      name: input.methodName,
                      replaced: Object.keys(inputs).filter((key) =>
                        !definitionInputKeys.includes(key)
                      ),
                    },
                    recordedMasks: lastEval.maskedPaths ?? [],
                    provenance: lastEval.provenance,
                    persistedProvenance: lastEval.persistedProvenance,
                  },
                );
                if (plaintextArgs.length > 0) {
                  exprSpan.end();
                  setupSpan.end();
                  yield {
                    kind: "error",
                    error: evaluatedCacheHoldsSensitiveArguments(
                      definition.name,
                      plaintextArgs,
                    ),
                  };
                  return;
                }
                // A cache written before provenance cannot say which text
                // came from data, and a method that places data text
                // (command/shell) would run all of it as authored
                // (swamp-club#3868).
                if (
                  !(lastEval.provenance instanceof ProvenanceMap) &&
                  method.placeDataSplices !== undefined
                ) {
                  exprSpan.end();
                  setupSpan.end();
                  yield {
                    kind: "error",
                    error: evaluatedCacheWithoutProvenance(
                      definition.name,
                      input.methodName,
                    ),
                  };
                  return;
                }
                // Restore cached references without reading the vault. Delivery
                // loads their current values under the current grants.
                const restored = await rehydrateEvaluatedDefinition({
                  sensitiveFormat: lastEval.sensitiveFormat,
                  definition: lastEval.definition,
                  deferredExpressions: lastEval.deferredExpressions ?? [],
                  writtenReferences: lastEval.writtenReferences ?? [],
                  ...(lastEval.persistedProvenance instanceof ProvenanceMap
                    ? { persistedProvenance: lastEval.persistedProvenance }
                    : {}),
                  ...(lastEval.provenance instanceof ProvenanceMap
                    ? { provenance: lastEval.provenance }
                    : {}),
                }, stepSecretBag);
                evaluatedDefinition = restored.definition;
                executedDefinition = restored.executedDefinition;
                deferredExpressions = restored.deferredExpressions;
                if (restored.provenance) {
                  // One copy, one map: the typed replay aligned the cache's
                  // persisted-coordinate map onto the sentinel copy.
                  rawProvenance = restored.provenance;
                  executedProvenance = restored.provenance;
                } else {
                  // A cache without provenance predates it and replays as it
                  // always did.
                  rawProvenance = lastEval.provenance ??
                    ProvenanceMap.authored();
                  executedProvenance = alignProvenance(
                    rawProvenance,
                    evaluatedDefinition.toData(),
                    executedDefinition.toData(),
                    sentinelStandInOf(stepSecretBag.registry),
                    sentinelStandInOf(stepSecretBag.registry),
                  );
                }
                for (const expression of lastEval.authoredExpressions) {
                  authoredExpressions.add(expression);
                }
                // A partial evaluation leaves failed CEL as authored text.
                // Recheck only what this method still needs, using the cache's
                // globals and provenance. Resolved values stay frozen; data
                // text and other methods never enter this replay pass.
                if (
                  evaluationService.hasDefinitionExpressions(
                    evaluatedDefinition,
                  )
                ) {
                  const replay = await evaluationService.evaluateDefinition(
                    evaluatedDefinition,
                    modelType,
                    sensitiveValues,
                    inputs,
                    undefined,
                    stepSecretBag,
                    {
                      inputs: inputsProvenance,
                      definition: {
                        raw: rawProvenance,
                        sanitized: executedProvenance,
                      },
                      authoredExpressions,
                      methodName: input.methodName,
                    },
                  );
                  evaluatedDefinition = replay.definition;
                  executedDefinition = replay.sanitizedDefinition ??
                    replay.definition;
                  rawProvenance = replay.provenance ?? rawProvenance;
                  executedProvenance = replay.sanitizedProvenance ??
                    rawProvenance;
                  failedExpressions = replay.failedExpressions ??
                    failedExpressions;
                }
              } else {
                if (evaluationService.hasDefinitionExpressions(definition)) {
                  const evalResult = await evaluationService.evaluateDefinition(
                    definition,
                    modelType,
                    sensitiveValues,
                    inputs,
                    undefined,
                    stepSecretBag,
                    {
                      inputs: inputsProvenance,
                      definition: {
                        raw: ProvenanceMap.authored().graft(
                          "globalArguments",
                          routedGlobalsProvenance,
                        ),
                        sanitized: ProvenanceMap.authored().graft(
                          "globalArguments",
                          routedGlobalsProvenance,
                        ),
                      },
                    },
                  );
                  evaluatedDefinition = evalResult.definition;
                  executedDefinition = evalResult.sanitizedDefinition ??
                    evalResult.definition;
                  rawProvenance = evalResult.provenance ??
                    ProvenanceMap.authored();
                  executedProvenance = evalResult.sanitizedProvenance ??
                    evalResult.provenance ?? ProvenanceMap.authored();
                  failedExpressions = evalResult.failedExpressions ??
                    failedExpressions;
                }
                // Saved once the argument check below passes, so a run that
                // fails it never replaces the last good evaluation that
                // --last-evaluated reuses. Snapshotted now because the --input
                // overrides below mutate the definition and are not persisted.
                // Built from the executed copy, so sensitive values are written
                // as the vault references they came from, and a literal under a
                // sensitive argument as the mask, never in plaintext.
                const persisted = persistEvaluatedDefinition(
                  executedDefinition,
                  [],
                  definition,
                  sensitiveValues,
                  modelDef,
                  executedProvenance,
                );
                pendingSave = persisted.definition;
                pendingReferences = persisted.writtenReferences;
                pendingMasked = persisted.maskedPaths;
                pendingPersistedProvenance = persisted.persistedProvenance;
                // In raw-copy coordinates, which rehydrate restores exactly.
                pendingProvenance = rawProvenance;
              }

              // Where data sits in the raw copy as reports and the completed
              // event show it: the evaluation's map, plus each override below.
              let shownProvenance = rawProvenance;

              // Merge override inputs into method arguments.
              // Override inputs are --input flags whose keys are not model inputs
              // schema keys (i.e. not used for CEL expression evaluation). They map
              // directly to method argument schema keys, so reject unknown ones here
              // before Zod's default strip mode silently discards them.
              const overrideInputs = Object.fromEntries(
                Object.entries(inputs).filter(([key]) =>
                  !definitionInputKeys.includes(key)
                ),
              );
              if (Object.keys(overrideInputs).length > 0) {
                const shape = getObjectShape(method.arguments);
                if (shape) {
                  const unknownKeys = Object.keys(overrideInputs).filter(
                    (k) => !Object.hasOwn(shape, k),
                  );
                  if (unknownKeys.length > 0) {
                    const validInputs = Object.keys(shape).join(", ");
                    exprSpan.end();
                    setupSpan.end();
                    yield {
                      kind: "error",
                      error: validationFailed(
                        `Unknown method input(s): ${unknownKeys.join(", ")}. ` +
                          `Valid inputs are: ${validInputs || "none"}`,
                      ),
                    };
                    return;
                  }
                }
                for (const [key, value] of Object.entries(overrideInputs)) {
                  operatorArgumentKeys.push(key);
                  evaluatedDefinition.setMethodArgument(
                    input.methodName,
                    key,
                    value,
                  );
                  if (executedDefinition !== evaluatedDefinition) {
                    executedDefinition.setMethodArgument(
                      input.methodName,
                      key,
                      value,
                    );
                  }
                  // The override replaces whatever was evaluated there, data
                  // included. Operator-typed inputs are authored, literal ones
                  // data.
                  executedProvenance = executedProvenance.graft(
                    methodArgumentPath(input.methodName, key),
                    inputsProvenance.subtree(keySegment(key)),
                  );
                  shownProvenance = shownProvenance.graft(
                    methodArgumentPath(input.methodName, key),
                    inputsProvenance.subtree(keySegment(key)),
                  );
                }
              }

              // A failed expression this method is about to receive would
              // otherwise be handed over as its raw ${{ ... }} text. Checked after
              // the overrides above, so an --input that replaces it wins.
              try {
                assertMethodArgumentsEvaluated(
                  input.methodName,
                  evaluatedDefinition.getMethodArguments(input.methodName),
                  failedExpressions,
                );
              } catch (error) {
                if (
                  !(error instanceof UnresolvedExpressionError) &&
                  secretRefusalCode(error) === undefined
                ) throw error;
                exprSpan.end();
                setupSpan.end();
                yield {
                  kind: "error",
                  error: error instanceof UnresolvedExpressionError
                    ? carryModelWording(
                      error,
                      validationFailed(error.message, {
                        path: error.path,
                        expression: error.expression,
                      }),
                    )
                    : methodExecutionFailed(error, redactor),
                };
                return;
              }
              // Written by the execution service once the method's arguments
              // pass their schema (its onArgumentsValidated), so a run the
              // schema refuses never replaces the last good evaluation that
              // --last-evaluated reuses (swamp-club#3681). The cache carries
              // the source's expressions and those an input contributed that
              // it still holds; an input expression the evaluation consumed
              // names nothing a replay needs and may hold what was typed.
              const saveEvaluation = pendingSave === undefined
                ? undefined
                : ((saved: Definition) => () =>
                  deps.saveEvaluatedDefinition(
                    modelType,
                    saved,
                    pendingProvenance,
                    persistedAuthoredExpressions(
                      sourceExpressions,
                      authoredExpressions,
                      saved,
                    ),
                    pendingReferences,
                    pendingMasked,
                    pendingPersistedProvenance,
                  ))(pendingSave);

              exprSpan.end();

              // Capture pre-vault args for report context (so vault secrets stay as expressions)
              // Reports and the completed event show arguments to the user and are
              // persisted with report output, so sensitive values are masked there,
              // by the walk the evaluated cache uses: a sensitive argument that
              // holds data (an input's value, a data read), a literal, or keys
              // that came with data, is the mask; then values read from a vault
              // wherever they sit (swamp-club#3681).
              const shownArguments = maskSensitiveArgumentsForDisplay(
                modelDef,
                evaluatedDefinition.toData(),
                input.methodName,
                shownProvenance,
              );
              const reportGlobalArgs = sensitiveValues.masked(
                shownArguments.globalArguments ?? {},
              ) as Record<string, unknown>;
              const reportMethodArgs = sensitiveValues.masked(
                shownArguments.methods?.[input.methodName]?.arguments ?? {},
              ) as Record<string, unknown>;

              // Resolve runtime expressions (vault and env).
              // Vault secrets become sentinel tokens; the secretBag maps sentinels to raw values.
              // The expression context is passed so that dynamic vault.get() arguments
              // (e.g. vault.get(inputs.vaultName, inputs.secretKey)) can be CEL-evaluated.
              const runtimeSpan = getTracer().startSpan(
                "swamp.model.method.resolve_runtime",
              );
              // Built from the evaluated definition so the full context (a walk
              // of every definition) is loaded only when a deferred expression
              // still reads model.* or file.*.
              const runtimeContext = await evaluationService
                .buildRuntimeContext(
                  executedDefinition,
                  sensitiveValues,
                  inputs,
                  deferredExpressions,
                );
              attachBindingProvenance(runtimeContext, {
                inputs: inputsProvenance,
                // Bound as self.globalArguments in the runtime pass.
                self: ProvenanceMap.authored().graft(
                  "globalArguments",
                  rawProvenance.subtree("globalArguments").union(
                    routedGlobalsProvenance,
                  ),
                ),
              });
              // Scoped to the invoked method: another method's vault and env
              // expressions are left as authored, neither checked, loaded nor
              // failed on, as its failed definition-pass expressions are never
              // asserted.
              const runtimeResult = await evaluationService
                .resolveRuntimeExpressionsInDefinition(
                  executedDefinition,
                  redactor,
                  runtimeContext,
                  authoredExpressions,
                  {
                    secretBag: stepSecretBag,
                    rawGlobalArguments: evaluatedDefinition.globalArguments,
                    provenance: executedProvenance,
                    methodName: input.methodName,
                  },
                );
              evaluatedDefinition = runtimeResult.definition;
              // Definition tags reach data artifacts and the catalog as they
              // are, so a sensitive value in one becomes its placeholder.
              for (
                const [key, value] of Object.entries(evaluatedDefinition.tags)
              ) {
                const placeholder = sensitiveValues.withPlaceholders(value);
                if (placeholder !== value) {
                  evaluatedDefinition.setTag(key, placeholder);
                }
              }
              const secretBag = runtimeResult.secretBag;

              // Register sensitive argument values with the redactor so they are
              // scrubbed from per-run log files. Must use post-vault-resolution values.
              const globalArgSchema = modelDef.globalArguments;
              if (globalArgSchema) {
                for (
                  const secret of extractSensitiveFieldValues(
                    globalArgSchema,
                    evaluatedDefinition.globalArguments,
                  )
                ) {
                  redactor.addSecret(secret);
                }
              }
              const methodArgSchema = modelDef.methods[input.methodName]
                ?.arguments;
              if (methodArgSchema) {
                for (
                  const secret of extractSensitiveFieldValues(
                    methodArgSchema,
                    evaluatedDefinition.getMethodArguments(input.methodName),
                  )
                ) {
                  redactor.addSecret(secret);
                }
              }

              runtimeSpan.end();

              // --- Execute ---
              runLogger.debug("Executing method {method}", {
                method: input.methodName,
              });

              yield {
                kind: "executing",
                modelName: definition.name,
                methodName: input.methodName,
              };

              // Create ModelOutput for tracking
              const preExecSpan = getTracer().startSpan(
                "swamp.model.method.pre_execute",
              );
              const output = ModelOutput.create({
                definitionId: definition.id,
                methodName: input.methodName,
                provenance: {
                  definitionHash,
                  modelVersion: modelDef.version,
                  triggeredBy: "manual",
                  initiatedBy: input.initiatedBy,
                  bundleFingerprint: modelDef.sourceFingerprint,
                },
              });
              output.markRunning(Deno.pid);
              output.setLogFile(logFilePath);
              methodProgress = registerRunProgress({
                runId: output.id,
                model: definition.name,
                method: input.methodName,
                scope: "method",
                traceId: /^0+$/.test(preExecSpan.spanContext().traceId)
                  ? undefined
                  : preExecSpan.spanContext().traceId,
              });
              methodProgress.enter("executing");

              // Register with the run tracker (if available).
              // Output YAML is only written in terminal state (write-once).
              let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
              if (deps.runTracker) {
                const activeRun = ActiveRun.createModelMethodRun({
                  id: output.id,
                  modelType: modelType.normalized,
                  definitionId: definition.id,
                  methodName: input.methodName,
                  pid: Deno.pid,
                  hostname: hostname(),
                  initiatedBy: input.initiatedBy,
                  instanceId: input.instanceId,
                });
                deps.runTracker.register(activeRun);
              }

              const vaultService = await deps.createVaultService();
              const executionService = deps.createExecutionService();

              if (
                "modelInvocationService" in executionService &&
                !executionService.modelInvocationService
              ) {
                const { ModelInvocationService } = await import(
                  "../../domain/models/model_invocation_service.ts"
                );
                const commonDeps: CommonMethodContextDeps = {
                  dataRepository: deps.dataRepo,
                  definitionRepository: deps.definitionRepo,
                  vaultService,
                  redactor,
                  dataQueryService: deps.dataQueryService,
                  createCelEnvironment: createExtensionCelEnvironment,
                };
                (executionService as { modelInvocationService?: unknown })
                  .modelInvocationService = new ModelInvocationService({
                    executionService,
                    commonDeps,
                    evaluationService,
                    repoDir: deps.repoDir,
                    pulledExtensionsRoot: resolvePulledExtensionsRoot(
                      deps.repoDir,
                    ),
                  });
              }

              // Gate service intentionally not wired here — approving/rejecting
              // workflow gates from model code bypasses authorization. Use the
              // CLI (swamp workflow approve/reject) or WebSocket API instead.

              // Start heartbeat inside the try so it's always cleaned up on error.
              if (deps.runTracker) {
                heartbeatInterval = setInterval(() => {
                  try {
                    deps.runTracker!.heartbeat(output.id);
                  } catch {
                    // Heartbeat failure is non-fatal
                  }
                }, 30_000);
              }

              preExecSpan.end();
              setupSpan.end();

              let execResult: MethodResult;
              try {
                execResult = yield* withEventBridge<
                  ModelMethodRunEvent,
                  MethodResult
                >(
                  (push) =>
                    withRunProgress(methodProgress!, () =>
                      executionService.executeWorkflow(
                        evaluatedDefinition,
                        modelDef,
                        input.methodName,
                        buildMethodContext(
                          {
                            dataRepository: deps.dataRepo,
                            definitionRepository: deps.definitionRepo,
                            vaultService,
                            redactor,
                            dataQueryService: deps.dataQueryService,
                            createCelEnvironment: createExtensionCelEnvironment,
                          },
                          {
                            signal: ctx.signal,
                            repoDir: deps.repoDir,
                            modelType,
                            modelId: evaluatedDefinition.id,
                            globalArgs: evaluatedDefinition.globalArguments,
                            definition: {
                              id: evaluatedDefinition.id,
                              name: evaluatedDefinition.name,
                              version: evaluatedDefinition.version,
                              tags: evaluatedDefinition.tags,
                            },
                            methodName: input.methodName,
                            logger: runLogger,
                            runtimeTags: input.runtimeTags,
                            tagOverrides: input.initiatedBy
                              ? { initiatedBy: input.initiatedBy }
                              : undefined,
                            dataOutputOverrides: evaluatedDefinition.resources
                              ? Object.entries(
                                evaluatedDefinition.resources,
                              ).map(([specName, override]) => ({
                                specName,
                                lifetime: override.lifetime,
                                garbageCollection: override.garbageCollection,
                                vaultName: override.vaultName,
                              }))
                              : undefined,
                            vaultSecrets: secretBag,
                            skipCheckNames: input.skipCheckNames,
                            skipCheckLabels: input.skipCheckLabels,
                            skipAllChecks: input.skipAllChecks,
                            extensionFilesRoot: modelDef.extensionFilesRoot,
                            onEvent: (event: MethodExecutionEvent) => {
                              if (event.type === "output") {
                                push({
                                  kind: "method_output",
                                  modelName: definition.name,
                                  methodName: input.methodName,
                                  stream: event.stream,
                                  line: event.line,
                                });
                              } else {
                                push({
                                  kind: "method_event",
                                  modelName: definition.name,
                                  methodName: input.methodName,
                                  event,
                                });
                              }
                            },
                          },
                        ),
                        {
                          secretLoader: evaluationService.secretLoader(
                            redactor,
                          ),
                          onArgumentsValidated: saveEvaluation,
                          argumentProvenance: operatorArgumentKeys.reduce(
                            (map, key) =>
                              map.graft(
                                methodArgumentPath(input.methodName, key),
                                ProvenanceMap.authored(),
                              ),
                            runtimeResult.provenance,
                          ),
                          unreadReferences: sensitiveValues,
                        },
                      )),
                );
                methodProgress.enter("finalizing");
              } catch (error) {
                methodProgress.enter("finalizing");
                // The record, the failed-run report and the error event carry
                // the message and stack through the run's redactor: a method
                // that echoes a sensitive argument in its error lands it in
                // none of them (swamp-club#3681).
                const failure = executionErrorFrom(error, redactor);
                const errorMessage = failure.message;

                if (heartbeatInterval) {
                  clearInterval(heartbeatInterval);
                }

                if (
                  ctx.signal.aborted ||
                  (error instanceof DOMException && error.name === "AbortError")
                ) {
                  // A plain abort names no cause, which leaves the tracker
                  // row's reason for `swamp model cancel` to fill in.
                  const cause = cancelCause(ctx.signal);
                  output.markCancelled(cause ?? "aborted");
                  await withRunProgress(methodProgress, () =>
                    withRunPhase("persisting", {}, () =>
                      deps.outputRepo.save(
                        modelType,
                        input.methodName,
                        output,
                      )));
                  if (deps.runTracker) {
                    deps.runTracker.complete(output.id, "cancelled", cause);
                  }
                  // Tell the unit the run reached its cancelled outcome before
                  // the stream says so, so on v3 the record and the outputs
                  // written before the abort commit even if the consumer stops
                  // short of the cancelled event below (swamp-club#3299).
                  markOutcomeReported();
                } else {
                  output.markFailed(failure);
                  await withRunProgress(methodProgress, () =>
                    withRunPhase("persisting", {}, () =>
                      deps.outputRepo.save(
                        modelType,
                        input.methodName,
                        output,
                      )));
                  if (deps.runTracker) {
                    deps.runTracker.complete(output.id, "failed");
                  }
                }

                // Run method-summary report for failed executions so JSON consumers
                // see structured error output (not just the raw error event).
                if (
                  output.status === "failed" && !input.skipAllReports &&
                  reportRegistry.getAll().length > 0
                ) {
                  const failedMethodContext = buildMethodReportContext(
                    {
                      repoDir: deps.repoDir,
                      logger: runLogger,
                      dataRepository: deps.dataRepo,
                      definitionRepository: deps.definitionRepo,
                      swampSha: input.swampSha,
                    },
                    {
                      modelType,
                      modelId: evaluatedDefinition.id,
                      definition: {
                        id: evaluatedDefinition.id,
                        name: evaluatedDefinition.name,
                        version: evaluatedDefinition.version,
                        tags: evaluatedDefinition.tags,
                      },
                      globalArgs: reportGlobalArgs,
                      methodArgs: reportMethodArgs,
                      methodName: input.methodName,
                      executionStatus: "failed",
                      errorMessage,
                      dataHandles: recoveredDataHandles(error),
                      outputSpecs: buildOutputSpecs(modelDef),
                      provenance: output.provenance,
                      extensionFilesRoot: modelDef.extensionFilesRoot,
                    },
                  );

                  const failedSummary = await executeReports(
                    reportRegistry,
                    failedMethodContext,
                    modelType,
                    evaluatedDefinition.id,
                    definition.reportSelection,
                    {
                      skipAllReports: input.skipAllReports,
                      skipReportNames: input.skipReportNames,
                      skipReportLabels: input.skipReportLabels,
                      reportNames: input.reportNames,
                      reportLabels: input.reportLabels,
                    },
                    {
                      onReportStarted: () => {},
                      onReportCompleted: () => {},
                      onReportFailed: () => {},
                    },
                    input.methodName,
                    [...BUILTIN_METHOD_REPORTS, ...(modelDef.reports ?? [])],
                  );

                  for (const result of failedSummary.results) {
                    yield {
                      kind: "report_started" as const,
                      reportName: result.name,
                      scope: result.scope,
                    };
                    if (result.success) {
                      yield {
                        kind: "report_completed" as const,
                        reportName: result.name,
                        scope: result.scope,
                        markdown: result.markdown!,
                        json: result.json!,
                      };
                    } else {
                      yield {
                        kind: "report_failed" as const,
                        reportName: result.name,
                        scope: result.scope,
                        error: result.error!,
                      };
                    }
                  }
                }

                deps.onWrittenVersions?.([
                  ...recoveredDataHandles(error)
                    .filter((handle) =>
                      handle.metadata.lifetime !== "ephemeral"
                    )
                    .map((handle) => ({
                      modelType: modelType.normalized,
                      modelId: evaluatedDefinition.id,
                      dataName: handle.name,
                      version: handle.version,
                    })),
                  ...writtenVersionsOf(error),
                ], "failed");

                if (output.status === "cancelled") {
                  // The caller learns of a cancelled run from this event: ending
                  // the stream silently reads as a success (swamp-club#3317).
                  yield {
                    kind: "cancelled",
                    run: {
                      modelId: definition.id,
                      modelName: definition.name,
                      modelType: modelType.normalized,
                      methodName: input.methodName,
                      status: "cancelled",
                      duration: output.durationMs,
                      outputId: output.id,
                      logFile: logFilePath,
                      dataArtifacts: [],
                      globalArguments: reportGlobalArgs,
                      methodArguments: reportMethodArgs,
                      initiatedBy: input.initiatedBy,
                    },
                    reason: output.error?.message,
                  };
                  return;
                }

                yield {
                  kind: "error",
                  error: methodExecutionFailed(error, redactor),
                };
                return;
              }

              // --- Process data artifacts ---
              const postExecSpan = getTracer().startSpan(
                "swamp.model.method.post_execute",
              );
              const dataArtifacts: DataArtifactView[] = [];
              deps.onWrittenVersions?.(
                (execResult.dataHandles ?? [])
                  .filter((handle) =>
                    handle.metadata.lifetime !== "ephemeral"
                  )
                  .map((handle) => ({
                    modelType: modelType.normalized,
                    modelId: evaluatedDefinition.id,
                    dataName: handle.name,
                    version: handle.version,
                  })),
                "completed",
              );
              if (execResult.dataHandles && execResult.dataHandles.length > 0) {
                for (const handle of execResult.dataHandles) {
                  const dataPath = deps.dataRepo.getPath(
                    modelType,
                    definition.id,
                    handle.name,
                    handle.version,
                  );

                  output.addDataArtifact({
                    dataId: handle.dataId,
                    name: handle.name,
                    version: handle.version,
                    tags: handle.tags,
                    ...(handle.sha256 !== undefined
                      ? { sha256: handle.sha256 }
                      : {}),
                  });

                  // Parse content if JSON for display
                  let attributes: Record<string, unknown> | undefined;
                  if (handle.metadata.contentType === "application/json") {
                    try {
                      const content = await deps.dataRepo.getContent(
                        modelType,
                        evaluatedDefinition.id,
                        handle.name,
                        handle.version,
                      );
                      if (content) {
                        const text = new TextDecoder().decode(content);
                        attributes = JSON.parse(text) as Record<
                          string,
                          unknown
                        >;
                      }
                    } catch {
                      // Not valid JSON, skip attributes
                    }
                  }

                  dataArtifacts.push({
                    id: handle.dataId,
                    name: handle.name,
                    path: dataPath,
                    attributes,
                  });
                  yield {
                    kind: "data_artifact_saved",
                    name: handle.name,
                    path: dataPath,
                  };
                }
              }

              runLogger.debug(
                "Method {method} completed on {model}",
                { method: input.methodName, model: definition.name },
              );

              // Mark output as succeeded and save (write-once)
              if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
              }
              output.markSucceeded();
              await withRunProgress(methodProgress, () =>
                withRunPhase("persisting", {}, () =>
                  deps.outputRepo.save(modelType, input.methodName, output)));
              if (deps.runTracker) {
                deps.runTracker.complete(output.id, "completed");
              }

              if (
                deps.eventBus &&
                execResult.dataHandles && execResult.dataHandles.length > 0
              ) {
                await deps.eventBus.publish(
                  createModelUpdated(
                    modelType.normalized,
                    definition.id,
                    definition.name,
                    execResult.dataHandles.map((handle) => ({
                      name: handle.name,
                      version: handle.version,
                    })),
                  ),
                );
              }

              // --- Post-run reports ---
              const reportsSpan = getTracer().startSpan(
                "swamp.model.method.reports",
              );
              let reportResults: Record<string, ReportResultView> | undefined;
              let reportFailures = 0;

              if (!input.skipAllReports && reportRegistry.getAll().length > 0) {
                const dataHandles = execResult.dataHandles ?? [];

                // Run method-scope reports
                const methodContext = buildMethodReportContext(
                  {
                    repoDir: deps.repoDir,
                    logger: runLogger,
                    dataRepository: deps.dataRepo,
                    definitionRepository: deps.definitionRepo,
                    swampSha: input.swampSha,
                  },
                  {
                    modelType,
                    modelId: evaluatedDefinition.id,
                    definition: {
                      id: evaluatedDefinition.id,
                      name: evaluatedDefinition.name,
                      version: evaluatedDefinition.version,
                      tags: evaluatedDefinition.tags,
                    },
                    globalArgs: reportGlobalArgs,
                    methodArgs: reportMethodArgs,
                    methodName: input.methodName,
                    executionStatus: "succeeded",
                    dataHandles,
                    outputSpecs: buildOutputSpecs(modelDef),
                    provenance: output.provenance,
                    extensionFilesRoot: modelDef.extensionFilesRoot,
                  },
                );

                const methodSummary = await executeReports(
                  reportRegistry,
                  methodContext,
                  modelType,
                  evaluatedDefinition.id,
                  definition.reportSelection,
                  {
                    skipAllReports: input.skipAllReports,
                    skipReportNames: input.skipReportNames,
                    skipReportLabels: input.skipReportLabels,
                    reportNames: input.reportNames,
                    reportLabels: input.reportLabels,
                  },
                  {
                    onReportStarted: () => {},
                    onReportCompleted: () => {},
                    onReportFailed: () => {},
                  },
                  input.methodName,
                  [...BUILTIN_METHOD_REPORTS, ...(modelDef.reports ?? [])],
                );

                // Yield report events and collect results
                reportResults = {};
                for (const result of methodSummary.results) {
                  yield {
                    kind: "report_started" as const,
                    reportName: result.name,
                    scope: result.scope,
                  };
                  if (result.success) {
                    yield {
                      kind: "report_completed" as const,
                      reportName: result.name,
                      scope: result.scope,
                      markdown: result.markdown!,
                      json: result.json!,
                    };
                  } else {
                    yield {
                      kind: "report_failed" as const,
                      reportName: result.name,
                      scope: result.scope,
                      error: result.error!,
                    };
                  }
                  reportResults[result.name] = toReportResultView(result);
                }
                reportFailures += methodSummary.failures;

                // Run model-scope reports
                const modelContext: ModelReportContext = {
                  ...methodContext,
                  scope: "model",
                };

                const modelSummary = await executeReports(
                  reportRegistry,
                  modelContext,
                  modelType,
                  evaluatedDefinition.id,
                  definition.reportSelection,
                  {
                    skipAllReports: input.skipAllReports,
                    skipReportNames: input.skipReportNames,
                    skipReportLabels: input.skipReportLabels,
                    reportNames: input.reportNames,
                    reportLabels: input.reportLabels,
                  },
                  {
                    onReportStarted: () => {},
                    onReportCompleted: () => {},
                    onReportFailed: () => {},
                  },
                  input.methodName,
                  [...BUILTIN_METHOD_REPORTS, ...(modelDef.reports ?? [])],
                  undefined,
                  // The method-scope call above already emitted failures for
                  // unresolvable required reports — suppress duplicates.
                  false,
                );

                for (const result of modelSummary.results) {
                  yield {
                    kind: "report_started" as const,
                    reportName: result.name,
                    scope: result.scope,
                  };
                  if (result.success) {
                    yield {
                      kind: "report_completed" as const,
                      reportName: result.name,
                      scope: result.scope,
                      markdown: result.markdown!,
                      json: result.json!,
                    };
                  } else {
                    yield {
                      kind: "report_failed" as const,
                      reportName: result.name,
                      scope: result.scope,
                      error: result.error!,
                    };
                  }
                  reportResults[result.name] = toReportResultView(result);
                }
                reportFailures += modelSummary.failures;
              }

              reportsSpan.end();
              postExecSpan.end();

              // --- Complete ---
              const view: ModelMethodRunView = {
                modelId: definition.id,
                modelName: definition.name,
                modelType: modelType.normalized,
                methodName: input.methodName,
                status: reportFailures > 0 ? "failed" : "succeeded",
                duration: output.durationMs,
                outputId: output.id,
                logFile: logFilePath,
                dataArtifacts,
                reports: reportResults,
                globalArguments: reportGlobalArgs,
                methodArguments: reportMethodArgs,
                initiatedBy: input.initiatedBy,
              };
              yield { kind: "completed", run: view };

              if (input.autoGc) {
                yield { kind: "auto_gc_started" };
                let lifecycleDeps: AutoGcLifecycleDeps | undefined;
                if (deps.workflowRunRepo) {
                  const lifecycleService = new DefaultDataLifecycleService(
                    deps.dataRepo,
                    deps.workflowRunRepo,
                  );
                  lifecycleDeps = {
                    dataRepo: deps.dataRepo,
                    lifecycleService,
                  };
                }
                const gcResult = await autoGc(
                  deps.dataRepo,
                  modelType,
                  definition.id,
                  lifecycleDeps,
                );
                if (
                  gcResult &&
                  (gcResult.versionsRemoved > 0 ||
                    gcResult.dataEntriesExpired > 0)
                ) {
                  yield {
                    kind: "auto_gc_completed" as const,
                    versionsDeleted: gcResult.versionsRemoved,
                    bytesReclaimed: gcResult.bytesReclaimed,
                    dataEntriesExpired: gcResult.dataEntriesExpired,
                  };
                }
              }
            } finally {
              runLog.cleanup();
              ephemeral.dispose();
            }
          })(),
        ),
      ));
    finished = true;
  } catch (error) {
    prepare?.fail(error);
    throw error;
  } finally {
    // A run that finished before setup returned after an error event; one
    // that did not finish was stopped by its consumer.
    prepare?.end(finished ? "error" : "cancelled");
    if (methodProgress) removeRunProgress(methodProgress);
  }
}

/**
 * Creates a SwampError for a missing model.
 */
export function modelNotFound(idOrName: string): SwampError {
  return wordedSwampError(
    "model_not_found",
    wordedText((w) => `${w.Noun} not found: ${idOrName}`),
  );
}

/**
 * Creates a SwampError for an unknown model type.
 */
export function unknownModelType(type: string): SwampError {
  return wordedSwampError(
    "unknown_model_type",
    wordedText((w) => `Unknown ${w.noun} type: ${type}`),
  );
}

/**
 * Creates a SwampError for an unknown method.
 */
export function unknownMethod(
  methodName: string,
  modelType: string,
  availableMethods: string,
): SwampError {
  return {
    code: "unknown_method",
    message:
      `Unknown method '${methodName}' for type '${modelType}'. Available methods: ${
        availableMethods || "none"
      }`,
  };
}

/**
 * Creates a SwampError when no evaluated definition is available for --last-evaluated.
 */
export function noEvaluatedDefinition(
  name: string,
): SwampError {
  return {
    code: "no_evaluated_definition",
    message: `No previously evaluated definition found for "${name}".`,
  };
}

/**
 * Creates a SwampError for a cached evaluation written before sensitive
 * values were kept off disk, which --last-evaluated must not replay.
 */
export function evaluatedCacheMayHoldSecrets(name: string): SwampError {
  return {
    code: "evaluated_cache_may_hold_secrets",
    message:
      `The evaluated definition cached for "${name}" was written by an older swamp and may hold sensitive values in plaintext, so it is not replayed. Run the method without --last-evaluated to evaluate it again; that rewrites the cache.`,
  };
}

/**
 * Creates a SwampError for a cached evaluation written in a sensitive-value
 * format newer than this swamp's, which --last-evaluated must not replay: a
 * value in a form this swamp does not recognise would run as it is
 * (swamp-club#3681).
 */
export function evaluatedCacheFormatNewer(name: string): SwampError {
  return {
    code: "evaluated_cache_format_newer",
    message:
      `The evaluated definition cached for "${name}" was written by a newer swamp in a format this one cannot read safely, so it is not replayed. Run the method without --last-evaluated to evaluate it again; that rewrites the cache. Or upgrade swamp.`,
  };
}

/**
 * Creates a SwampError for a cached evaluation whose provenance record does
 * not parse: replaying it could evaluate data as authored (swamp-club#3205).
 */
export function evaluatedCacheProvenanceUnreadable(name: string): SwampError {
  return {
    code: "evaluated_cache_provenance_unreadable",
    message:
      `The evaluated definition cached for "${name}" has an unreadable provenance record, so it is not replayed. Run the method without --last-evaluated to evaluate it again; that rewrites the cache.`,
  };
}

/**
 * Creates a SwampError for a cached evaluation whose sensitive argument holds
 * a value that did not come from a vault — the mask this swamp writes, or
 * plaintext an older one wrote — which --last-evaluated must not replay
 * (swamp-club#3681). Names the paths, never a value.
 */
export function evaluatedCacheHoldsSensitiveArguments(
  name: string,
  paths: readonly string[],
): SwampError {
  return {
    code: EVALUATED_CACHE_HOLDS_SENSITIVE_ARGUMENTS_CODE,
    message: evaluatedCacheHoldsSensitiveArgumentsMessage(
      name,
      paths,
      "method",
    ),
  };
}

/** The error code of a replay refused for want of provenance. */
export const EVALUATED_CACHE_WITHOUT_PROVENANCE_CODE =
  "evaluated_cache_without_provenance";

/**
 * The error for a `--last-evaluated` replay of a method that places data
 * text, from a cache that records no provenance (swamp-club#3868).
 */
export function evaluatedCacheWithoutProvenance(
  name: string,
  methodName: string,
): SwampError {
  return {
    code: EVALUATED_CACHE_WITHOUT_PROVENANCE_CODE,
    message: `Cannot replay ${name} ${methodName} with --last-evaluated: its ` +
      `evaluation was saved by an older swamp and does not record which ` +
      `text came from data, so it cannot be run safely. Run it without ` +
      `--last-evaluated once to save a new evaluation.`,
  };
}

/**
 * Creates a SwampError for a method execution failure. With a redactor, the
 * message and the cause's stack are passed through it, so a method that
 * echoes a sensitive argument in its error never shows it (swamp-club#3681).
 */
export function methodExecutionFailed(
  cause: unknown,
  redactor?: ErrorRedactor,
): SwampError {
  const shown = redactedError(cause, redactor);
  // Keeps the cause's model spelling for `swamp model …` (swamp-club#3437).
  return carryModelWording(shown, {
    code: secretRefusalCode(cause) ?? "method_execution_failed",
    message: executionErrorFrom(cause, redactor).message,
    cause: shown instanceof Error ? shown : undefined,
  });
}

/**
 * The authored set an evaluated cache carries: the source definition's
 * expressions, and those the run's inputs contributed that `persisted`
 * still holds, for the runtime pass of a replay. An input expression the
 * evaluation consumed — a constant, say — names nothing a replay needs, and
 * may hold what the operator typed (swamp-club#3681).
 */
function persistedAuthoredExpressions(
  source: ReadonlySet<string>,
  authored: ReadonlySet<string>,
  persisted: Definition,
): Set<string> {
  const held = collectAuthoredExpressions(persisted.toData());
  const kept = new Set(source);
  for (const raw of authored) {
    if (held.has(raw)) kept.add(raw);
  }
  return kept;
}

/**
 * Converts a ReportExecutionResult to a ReportResultView.
 */
export function toReportResultView(
  result: ReportExecutionResult,
): ReportResultView {
  return {
    name: result.name,
    scope: result.scope,
    success: result.success,
    markdown: result.markdown,
    json: result.json,
    error: result.error,
  };
}
