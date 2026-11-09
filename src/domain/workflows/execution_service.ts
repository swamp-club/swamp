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

import type { Workflow } from "./workflow.ts";
import type { Job } from "./job.ts";
import { Step } from "./step.ts";
import { escapeControlCharacters } from "../control_characters.ts";
import {
  mergePlacementFields,
  resolveAffinityKey,
  resolvePlacement,
} from "./placement.ts";
import { StepTask } from "./step_task.ts";
import type { AssertSeverity } from "./step_task.ts";
import { gateTimeoutSeconds } from "./approval_timeout.ts";
import { severityAtOrAbove } from "./assert_severity.ts";
import {
  type ExpandedStep,
  type ForEachBinding,
  ForEachExpansionService,
} from "./for_each_expansion_service.ts";
import { coerceToSuffix } from "./data_suffix.ts";
import { coerceInputTypes } from "../inputs/input_coercion.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import { InputValidationService } from "../inputs/input_validation_service.ts";
import {
  CANCELLED_STEP_ERROR,
  // deno-lint-ignore verbatim-module-syntax
  JobRun,
  type StepRun,
  WorkflowRun,
  type WorkflowRunData,
} from "./workflow_run.ts";
import type { RunStartKeyData } from "./run_start_key.ts";
import { unclaimedRuns, type WorkflowRunClaims } from "./run_claim.ts";
import {
  acquireContinuation,
  type ContinuationClaim,
  type ContinuationClaims,
  ContinuationHeldError,
  type ContinuationMode,
  type RunRecordCurrency,
  RunRecordStaleError,
  suspensionKeyOf,
} from "./continuation_claim.ts";
import {
  type OwnerLiveness,
  suspendedRunOwnerStillRuns,
} from "./orphaned_run_reaper.ts";
import {
  cancelledOutcome,
  isWaitExpired,
  registrationOf,
  type StoredWaitRecord,
  type WaitOutcome,
  type WaitRegistration,
} from "./signal_wait_records.ts";
import { earlyWaitRef, takePendingSignal } from "./pending_signal.ts";
import {
  SIGNAL_WAITS_NOT_CONFIGURED,
  type SignalWaitStore,
  type SignalWaitSupport,
  UNSHARED_SIGNAL_WAITS,
} from "./signal_wait_store.ts";
import {
  NO_RUN_CHECKPOINTS,
  type RunCheckpointer,
} from "./run_checkpointer.ts";
import { OPEN_RUN_WRITE_FENCE, type RunWriteFence } from "./run_write_fence.ts";
import {
  applyAcceptedSignals,
  closeRunWaits,
  findRegistrationOfStep,
  settleReenteredWait,
  waitRefOf,
} from "./signal_wait_cleanup.ts";
import {
  MAX_WORKFLOW_NESTING_DEPTH,
  type ParentRunRef,
} from "./nested_run_ref.ts";
import {
  assertNestedWaitsSettled,
  isFinishedRun,
  NestedRunLink,
} from "./nested_run_link.ts";
import {
  OrphanedNestedRunError,
  settleOrphanedNestedRun,
} from "./orphaned_nested_run.ts";
import {
  openSignalWaitMessage,
  receiptForCaller,
  schemaExpressions,
  SignalWait,
  WAIT_KEY_HELD_STEP_ERROR,
  WAIT_TIMEOUT_STEP_ERROR,
  WAIT_UNREADABLE_STEP_ERROR,
} from "./signal_wait.ts";
import {
  claimWaitKey,
  type WaitKeyAcquisition,
  type WaitKeyClaim,
  waitKeyRefusal,
} from "./wait_key_claim.ts";
import {
  cancelAndSettle,
  failAbandonedSteps,
  jobRunsAfterFailure,
  runsAfterFailure,
  settleNotResumedJob,
  settleUnstartedJob,
  settleUnstartedStep,
  shouldJobRun,
  shouldStepRun,
} from "./abort_settlement.ts";
import {
  checkSuspendedRunResume,
  planFailedRunResume,
  refuseFanOutRecover,
  type ResumeReset,
} from "./resume_reset.ts";
import { evaluatedJobMismatch, pairExpressionJobs } from "./job_pairing.ts";
import {
  fanOutEventMember,
  fanOutJobFailed,
  fanOutSnapshot,
  laneFailed,
  laneStepName,
  laneStepOf,
  laneSucceeded,
  laneWorkerScope,
  membersOf,
  perWorkerBehaviorName,
  planLaneSteps,
  refusedPlanMessage,
  refuseSharedLaneInstances,
  resumedLaneVerdict,
} from "./fan_out_lanes.ts";
import { getWorkerPoolReader } from "../remote/worker_pool.ts";
import { planFanOut } from "../remote/scheduler.ts";
import { planBatches } from "../remote/rollout.ts";
import { checkResumeInputOverrides } from "./resume_input_guard.ts";
import {
  FROM_JOB_WITHOUT_FROM,
  nextActionForStatus,
  RunNotSuspendedError,
} from "./suspended_run_resolver.ts";
import {
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
} from "./workflow_id.ts";
import { findWorkflowById } from "./workflow_lookup.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { DatastorePathResolver } from "../datastore/datastore_path_resolver.ts";
import {
  type LentLocks,
  processLockHolderMarker,
} from "../datastore/lock_holder_marker.ts";
import type { OutputRepository } from "../models/repositories.ts";
import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import { ActiveRun, type ActiveRunStatus } from "../models/active_run.ts";
import { cancelCause, cleanupGraceSignal } from "../models/cancel_cause.ts";
import { hostname } from "node:os";
import type {
  ForeignContentFetcher,
  UnifiedDataRepository,
} from "../data/repositories.ts";
import type { MethodExecutionService } from "../models/method_execution_service.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import {
  type EvaluatedWorkflowCache,
  YamlEvaluatedWorkflowRepository,
} from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { resolveDurableWrites } from "../datastore/datastore_config.ts";
import { type Namespace, SOLO_NAMESPACE } from "../data/namespace.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import {
  type HydrateFileHook,
  isUnpublishedDataError,
  type MarkDirtyHook,
  type UnreadableContentLookup,
  type WrittenVersion,
} from "../datastore/datastore_sync_service.ts";
import { DataQueryService } from "../data/data_query_service.ts";
import {
  DATA_WRITE_STOP_GRACE_MS,
  InFlightDataWrites,
  processDataWrites,
} from "../data/in_flight_data_writes.ts";
import { CompositeUnifiedDataRepository } from "../data/composite_data_repository.ts";
import { CompositeDataQueryService } from "../data/composite_data_query_service.ts";
import type { ResourceOverrides } from "../definitions/definition.ts";
import type { DataOutputOverride } from "../models/data_output_override.ts";
import {
  fromFileHandle,
  fromResourceHandle,
} from "../data/data_record_mapper.ts";
import { resolveModelType } from "../extensions/extension_auto_resolver.ts";
import { MethodReportRunner } from "./method_report_runner.ts";
import { modelMethodResourceResult } from "./model_method_result.ts";
import {
  WorkflowReportRunner,
  type WorkflowStepExecutionDetail,
} from "./workflow_report_runner.ts";
import { getAutoResolver } from "../extensions/auto_resolver_context.ts";
import {
  DefaultMethodExecutionService,
  recoveredDataHandles,
  writtenVersionsOf,
} from "../models/method_execution_service.ts";
import {
  DefaultModelValidationService,
  envVarWarningText,
} from "../models/validation_service.ts";
import { buildMethodContext } from "../models/method_context.ts";
import { detectEnvVarUsageInDefinition } from "../models/env_var_detector.ts";
import { acceptsMethodArgumentKey } from "../models/zod_type_coercion.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";
import {
  type ReservedTagLookups,
  reservedWorkflowRunTag,
} from "./reserved_workflow_tags.ts";
import { wordedError } from "../behavior_wording.ts";
import type { MethodExecutionEvent } from "../models/method_events.ts";
import {
  executionErrorFrom,
  ModelOutput,
  redactedError,
} from "../models/model_output.ts";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import type { MethodResult, ModelDefinition } from "../models/model.ts";
import {
  authoredConstantsProducing,
  type AuthoredExpressions,
  collectAuthoredExpressions,
  ExpressionEvaluationService,
  partitionAuthoredAt,
} from "../expressions/expression_evaluation_service.ts";
import {
  createRejectionReport,
  runWithRejectionReport,
} from "../expressions/expression_rejection_report.ts";
import {
  type DeferredExpression,
  deferredExpressionReference,
} from "../expressions/deferred_expression.ts";
import {
  resolveAvailableExpressionsPair,
} from "../expressions/available_expression_resolver.ts";
import {
  sensitiveSpliceSanitizer,
  SplicePair,
} from "../expressions/splice_pair.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import type { SecretLoader } from "../vaults/secret_loader.ts";
import {
  isNewerSensitiveFormat,
  mayHoldPlaintextSensitiveValues,
  persistEvaluatedDefinition,
} from "../expressions/persisted_evaluation.ts";
import {
  type PersistedEvaluatedWorkflow,
  persistEvaluatedWorkflow,
  recordableEvaluatedInputs,
  rehydrateEvaluatedWorkflow,
  rehydrateRunReferences,
  replayInputs,
} from "./persisted_workflow.ts";
import {
  extractCelExpression,
  extractExpressions,
  replaceExpressions,
  replaceExpressionsTracked,
} from "../expressions/expression_parser.ts";
import { inputNamesRead } from "../expressions/cel_grammar.ts";
import { replaceExpressionSpans } from "../expressions/expression_scanner.ts";
import { requiresModelNamespace } from "../expressions/dependency_extractor.ts";
import { extractStepDefinitionReferences } from "./model_reference_extractor.ts";
import {
  type DataRecord,
  type ExpressionContext,
  type FileDataRecord,
  ModelResolver,
} from "../expressions/model_resolver.ts";
import {
  createExtensionCelEnvironment,
} from "../../infrastructure/cel/cel_evaluator.ts";
import type { CelExpressionEvaluator } from "../expressions/cel_runtime.ts";
import { sensitiveValuesOf } from "../expressions/sensitive_context.ts";
import { attachStepOutputSources } from "../expressions/step_output_sources.ts";
import {
  collectWorkflowAuthoredExpressions,
  DefinitionExpressionEvaluator,
  type ForeignTaskArgument,
  type SanitizedTaskOverlay,
  StepProvenanceOverlay,
  type WorkflowEvaluationResult,
  WorkflowExpressionEvaluator,
} from "./expression_evaluators.ts";
import {
  attachInputsProvenance,
  vouchInherited,
  workflowInputsProvenance,
} from "./input_provenance.ts";
import {
  alignProvenance,
  type DirectInputsProvenance,
  keyPath,
  keySegment,
  methodArgumentPath,
  ProvenanceMap,
  routedGlobalProvenance,
  sentinelIdentityOf,
  sentinelStandInOf,
} from "../expressions/provenance_map.ts";
import {
  attachBindingProvenance,
  bindingProvenanceOf,
  spliceOrigin,
} from "../expressions/splice_origin.ts";
import {
  AUTHORED_DEFINITION,
  type DefinitionPassProvenance,
} from "../expressions/definition_expression_pass.ts";
import { resolveAvailableExpressionsTracked } from "../expressions/available_expression_resolver.ts";
import {
  assertMethodArgumentsEvaluated,
  type FailedExpressions,
} from "../expressions/unresolved_expression_guard.ts";
import { errorPaths, UserError } from "../errors.ts";
import { FAN_OUT_NEEDS_SERVE, refuseFanOutRun } from "./fan_out_job.ts";
import {
  isForeignExpression,
  storedTextRefusal,
  unlistedForeignRootError,
} from "../expressions/swamp_namespaces.ts";
import {
  getRunLogger,
  getSwampLogger,
  getWorkflowRunLogger,
  runFileSink,
} from "../../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import { RunSensitiveValues, SecretRedactor } from "../secrets/mod.ts";
import { VaultService } from "../vaults/vault_service.ts";
import {
  createDataRepositoryAttributeReader,
  liveStepOutputs,
  type ResolvedStepOutputs,
  StepOutputResolver,
} from "./step_output_resolver.ts";
import {
  merge,
  mergeGated,
  mergeWithConcurrency,
  type SharedGate,
  sharedGate,
} from "../../infrastructure/stream/merge.ts";
import { withEventBridge } from "../../infrastructure/stream/event_bridge.ts";
import type { ReportFilterOptions } from "../reports/report_execution_service.ts";
import {
  bindGeneratorToSpan,
  getTracer,
  type Span,
  SpanStatusCode,
} from "../../infrastructure/tracing/mod.ts";
import { extractSensitiveFieldValues } from "../models/sensitive_field_extractor.ts";
import {
  getRemoteStepDispatcher,
  remoteOutputsOf,
} from "../remote/remote_dispatch.ts";
import {
  bindRunProgress,
  currentRunProgress,
  registerRunProgress,
  removeRunProgress,
  type RunProgress,
  trackWorkflowProgress,
} from "../remote/run_progress.ts";
import {
  type ExecutionObservation,
  observeExecution,
} from "../remote/observability.ts";
import { StepStartUnrecordedError } from "./step_start.ts";
import { RunSaveHorizon } from "./run_save_horizon.ts";
import {
  currentVaultAccess,
  runGeneratorWithVaultAccess,
  RunVaultAccess,
} from "../vaults/run_vault_access.ts";

const SCOPED_REFERENCE = /\b(inputs|self|run|steps)\b/;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function inlineUnscopedDeferred<T>(
  data: T,
  records: readonly DeferredExpression[],
  authored: ReadonlySet<string>,
  /** Where data sits in `data`; a reference in data is never inlined. */
  provenance: ProvenanceMap,
): { data: T; authored: ReadonlySet<string>; provenance: ProvenanceMap } {
  const byReference = new Map(
    records.map((record) => [deferredExpressionReference(record.id), record]),
  );
  const values = new Map<string, unknown>();
  const vouched = new Set(authored);
  for (const expr of extractExpressions(data)) {
    const record = byReference.get(expr.raw);
    if (!record || SCOPED_REFERENCE.test(record.expression)) continue;
    if (
      expr.start !== undefined && expr.end !== undefined &&
      provenance.overlapsData(expr.path, expr.start, expr.end)
    ) continue;
    values.set(expr.raw, record.expression);
    vouched.add(record.expression);
  }
  // The inlined text is the parent's authored expression.
  const tracked = replaceExpressionsTracked(
    data,
    values,
    provenance,
    () => ({ map: ProvenanceMap.authored() }),
  );
  return {
    data: tracked.data as T,
    authored: vouched,
    provenance: tracked.provenance,
  };
}

function withTagPlaceholders(
  definition: Definition,
  sensitiveValues: RunSensitiveValues,
): void {
  for (const [key, value] of Object.entries(definition.tags)) {
    const placeholder = sensitiveValues.withPlaceholders(value);
    if (placeholder !== value) definition.setTag(key, placeholder);
  }
}

type TaskArgs = {
  inputs?: Record<string, unknown> | string;
  globalArgs?: Record<string, unknown> | string;
};

function stepInputPair(
  taskArgs: SplicePair<TaskArgs>,
): SplicePair<Record<string, unknown>> {
  const record = (value: TaskArgs["inputs"]) =>
    (value ?? {}) as Record<string, unknown>;
  return new SplicePair(
    record(taskArgs.raw.inputs),
    record(taskArgs.sanitized.inputs),
    taskArgs.rawProvenance.subtree("inputs"),
    taskArgs.sanitizedProvenance.subtree("inputs"),
  );
}

/**
 * coercion changes values by content ("true" becomes a boolean), so a key whose
 * value coercion changed takes the coerced raw value with sensitive values
 * sentinelized, not the uncoerced sanitized one
 */
function sanitizedDirectExecution(
  result: DirectTypeResolveResult,
  taskArgs: SplicePair<TaskArgs>,
): { definition: Definition; methodInputs: Record<string, unknown> } {
  const asRecord = (value: TaskArgs["inputs"]) =>
    (typeof value === "object" && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
  const explicit = taskArgs.raw.globalArgs !== undefined;
  const sanitizedInputs = asRecord(taskArgs.sanitized.inputs);
  const methodInputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.routedMethodInputs)) {
    methodInputs[key] = Object.hasOwn(sanitizedInputs, key)
      ? sanitizedInputs[key]
      : value;
  }

  const definition = Definition.fromData(result.definition.toData());
  const rawSource = asRecord(
    explicit ? taskArgs.raw.globalArgs : taskArgs.raw.inputs,
  );
  const sanitizedSource = asRecord(
    explicit ? taskArgs.sanitized.globalArgs : taskArgs.sanitized.inputs,
  );
  const globals = result.definition.globalArguments as Record<string, unknown>;
  for (const key of Object.keys(rawSource)) {
    if (!explicit && Object.hasOwn(result.routedMethodInputs, key)) continue;
    if (!Object.hasOwn(globals, key)) continue;
    const coerced = globals[key];
    const sanitized = JSON.stringify(rawSource[key]) === JSON.stringify(coerced)
      ? sanitizedSource[key]
      : coerced;
    if (JSON.stringify(sanitized) !== JSON.stringify(coerced)) {
      definition.setGlobalArgument(key, sanitized);
    }
  }
  return { definition, methodInputs };
}

function placementProvenance(
  workflow: Workflow,
  job: Job,
  step: Step,
  workflowMap: ProvenanceMap,
  stepMap: ProvenanceMap,
): ProvenanceMap {
  const jobIndex = workflow.jobs.indexOf(job);
  const jobMap = jobIndex >= 0
    ? workflowMap.subtree(`jobs[${jobIndex}]`)
    : ProvenanceMap.authored();
  let map = ProvenanceMap.authored();
  for (const field of ["target", "labels", "platform"] as const) {
    const level = step.placementFields[field] !== undefined
      ? stepMap
      : job.placementFields[field] !== undefined
      ? jobMap
      : workflowMap;
    map = map.graft(field, level.subtree(field));
  }
  return map;
}

function recordProvenance(
  map: ProvenanceMap,
  task: { inputs?: unknown; globalArgs?: unknown },
  inputs: Record<string, unknown> | undefined,
  globalArgs: Record<string, unknown> | undefined,
  context: Record<string, unknown> | undefined,
): ProvenanceMap {
  let out = map;
  for (
    const [field, source, resolved] of [
      ["inputs", task.inputs, inputs],
      ["globalArgs", task.globalArgs, globalArgs],
    ] as const
  ) {
    if (typeof source !== "string") continue;
    const cel = extractCelExpression(source) ?? "";
    out = out.graft(field, spliceOrigin(cel, context, resolved).map);
  }
  return out;
}

async function resolveRecordExpression(
  value: Record<string, unknown> | string | undefined,
  fieldName: string,
  expressionContext: Record<string, unknown> | undefined,
  /**
   * defined whenever the context is: in a typed run a record that holds a
   * Secret issues into the step's bag
   */
  evaluator: CelExpressionEvaluator | undefined,
  authored: AuthoredExpressions,
  provenance: ProvenanceMap,
): Promise<Record<string, unknown> | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new UserError(
        `${fieldName} must be a record, got ${
          Array.isArray(value) ? "an array" : typeof value
        }`,
      );
    }
    return value;
  }
  const cel = extractCelExpression(value);
  if (!cel) {
    throw new UserError(
      `${fieldName} must be a record, got a string`,
    );
  }
  if (!expressionContext || !evaluator) {
    throw new UserError(
      `${fieldName} expression "$\{{ ${cel} }}" could not be resolved: no expression context available`,
    );
  }
  if (
    partitionAuthoredAt(extractExpressions(value), authored, provenance)
      .length !== 1
  ) {
    throw new UserError(`${fieldName} must be an authored record expression`);
  }
  const resolved = await evaluator.evaluateAsync(cel, expressionContext);
  if (
    resolved === null || resolved === undefined ||
    typeof resolved !== "object" || Array.isArray(resolved)
  ) {
    throw new UserError(
      `${fieldName} expression "$\{{ ${cel} }}" evaluated to ${
        Array.isArray(resolved) ? "an array" : typeof resolved
      }, expected a record`,
    );
  }
  return resolved as Record<string, unknown>;
}

/**
 * a target assembled out of substituted data is refused rather than executed;
 * one interpolating a deferred expression into literal text is resolved
 * expression by expression, as run-start evaluation would
 */
async function resolveScalarExpression(
  value: string | undefined,
  fieldName: string,
  expressionContext: Record<string, unknown> | undefined,
  celEvaluator: CelExpressionEvaluator,
  authored: AuthoredExpressions,
  provenance: ProvenanceMap,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const expressions = extractExpressions(value);
  if (expressions.length === 0) return value;
  if (!expressionContext) {
    throw new UserError(
      `${fieldName} expression "${
        expressions[0].raw
      }" could not be resolved: no expression context available`,
    );
  }
  if (
    partitionAuthoredAt(expressions, authored, provenance).length !==
      expressions.length
  ) {
    throw new UserError(`${fieldName} must be an authored expression`);
  }
  const cel = expressions.length === 1 ? extractCelExpression(value) : null;
  if (!cel) {
    const values = new Map<string, unknown>();
    for (const expression of expressions) {
      values.set(
        expression.raw,
        await celEvaluator.evaluateAsync(
          expression.celExpression,
          expressionContext,
        ),
      );
    }
    return replaceExpressions(value, values) as string;
  }
  const resolved = await celEvaluator.evaluateAsync(cel, expressionContext);
  if (resolved === null || resolved === undefined) return "";
  if (typeof resolved === "object") {
    throw new UserError(
      `${fieldName} expression "$\{{ ${cel} }}" evaluated to ${
        Array.isArray(resolved) ? "an array" : "an object"
      }, expected a name`,
    );
  }
  return String(resolved);
}

/**
 * covers text deferred past run start too (reading self.* or steps.*), which
 * the step-time passes leave raw without a report of their own
 */
function warnForeignTaskArguments(
  workflowName: string,
  foreign: readonly ForeignTaskArgument[],
): void {
  const logger = getSwampLogger(["swamp", "expressions"]);
  for (const { jobName, stepName, path, text, deferred } of foreign) {
    if (deferred) {
      logger
        .warn`Template syntax passed through in workflow ${workflowName}, job ${jobName}, step ${stepName}: ${path} holds ${text}, which reads a name swamp does not provide. Unless it evaluates when the step runs, the step receives it as literal text`;
    } else {
      logger
        .warn`Template syntax passed through in workflow ${workflowName}, job ${jobName}, step ${stepName}: ${path} holds ${text}, which is not a swamp expression, so the step receives it as literal text`;
    }
  }
}

/**
 * covers text run-start evaluation deferred to step time; text that arrived as
 * data, and the result of literal(), are left to the checks on persisting the
 * definition
 */
function assertNoUnlistedForeignArguments(
  field: "inputs" | "globalArgs",
  args: unknown,
  authored: ReadonlySet<string>,
  provenance: ProvenanceMap,
): void {
  for (const expr of extractExpressions(args)) {
    const inData = expr.start === undefined || expr.end === undefined
      ? provenance.hasDataAtOrBelow(expr.path)
      : provenance.overlapsData(expr.path, expr.start, expr.end);
    if (inData || !authored.has(expr.raw)) continue;
    if (!isForeignExpression(expr.celExpression)) continue;
    const unlisted = unlistedForeignRootError(
      expr.celExpression,
      `${field}.${expr.path}`,
    );
    if (unlisted) throw unlisted;
  }
}

function holdsSignalWait(workflow: Workflow): boolean {
  return workflow.jobs.some((job) =>
    job.steps.some((step) => step.task.isWaitForSignal())
  );
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "aborted";
}

/**
 * only supplied keys are checked, each by its value merged over the stored
 * inputs, since a partial nested override is complete only once merged; the run
 * id comes first so serve's 512-character limit cuts the detail
 */
function coerceResumeInputs(
  workflow: Workflow,
  run: WorkflowRun,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  if (!workflow.inputs) return inputs;
  const coerced = coerceInputTypes(inputs, workflow.inputs);
  const merged = deepMerge({ ...run.inputs }, coerced);
  const supplied = Object.fromEntries(
    Object.keys(coerced).map((key) => [key, merged[key]]),
  );
  const { errors } = new InputValidationService().validateProvided(
    supplied,
    workflow.inputs,
  );
  if (errors.length > 0) {
    throw new UserError(
      `Resume inputs do not match the workflow's input schema; run ${run.id} is unchanged: ` +
        errors.map((e) => e.message).join("; "),
      "input_validation_failed",
    );
  }
  return coerced;
}

/**
 * an exception unwinds the generator stack (runStep, runJob, merge, run), since
 * yield travels one frame; also re-detected via run.status after
 * mergeWithConcurrency because merge swallows errors from parallel streams
 */
export class WorkflowSuspendedError extends Error {
  constructor(
    readonly jobId: string,
    readonly stepId: string,
    readonly prompt: string,
    readonly timeout?: number,
  ) {
    super(`Workflow suspended at step "${stepId}" — awaiting manual approval`);
    this.name = "WorkflowSuspendedError";
  }
}

type RunWorkflowLookup =
  | { readonly workflow: Workflow | null }
  | { readonly error: unknown };

/**
 * entered inside the scope a nested run starts from, so a child's list
 * intersects with its parent's
 */
function workflowVaultAccess(
  workflow: Workflow | undefined,
): RunVaultAccess | undefined {
  if (workflow?.vaults === undefined) return undefined;
  return RunVaultAccess.create({
    allowedVaults: workflow.vaults,
    allowListSource: workflow.name,
  });
}

/**
 * an edit to the workflow can narrow a suspended run but never widen it; a run
 * with no recorded list is held to the current list alone
 */
function resumeVaultAccess(
  workflow: Workflow,
  run: WorkflowRun,
): RunVaultAccess | undefined {
  const current = workflowVaultAccess(workflow);
  if (run.allowedVaults === undefined) return current;
  const recorded = RunVaultAccess.create({
    allowedVaults: run.allowedVaults,
    allowListSource: workflow.name,
  });
  return current ? current.narrowedBy(recorded) : recorded;
}

/**
 * for the same spec they merge field by field: each field the step sets wins
 * and the definition supplies the rest
 */
export function mergeDataOutputOverrides(
  definitionResources: ResourceOverrides | undefined,
  stepOverrides: DataOutputOverride[] | undefined,
): DataOutputOverride[] | undefined {
  const defOverrides: DataOutputOverride[] = definitionResources
    ? Object.entries(definitionResources).map(([specName, override]) => ({
      specName,
      lifetime: override.lifetime,
      garbageCollection: override.garbageCollection,
      vaultName: override.vaultName,
    }))
    : [];

  if (defOverrides.length === 0) return stepOverrides;
  if (!stepOverrides || stepOverrides.length === 0) return defOverrides;

  const merged = [...defOverrides];
  for (const stepOvr of stepOverrides) {
    const idx = merged.findIndex((o) => o.specName === stepOvr.specName);
    if (idx >= 0) {
      const set = Object.fromEntries(
        Object.entries(stepOvr).filter(([, value]) => value !== undefined),
      );
      merged[idx] = { ...merged[idx], ...set };
    } else {
      merged.push(stepOvr);
    }
  }
  return merged;
}

export interface StepExecutionContext {
  /** set for a fan-out lane's step: where it runs and whose instance it uses */
  lane?: FanOutLaneContext;
  workflowId: WorkflowId;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  repoDir: string;
  pulledExtensionsRoot?: string;
  signal: AbortSignal;
  expressionContext?: ExpressionContext;
  workflowRun?: WorkflowRun;
  step?: Step;
  emitEvent?: (event: WorkflowExecutionEvent) => void;
  forEachVariable?: ForEachBinding;
  forEachIndex?: number;
  authoredExpressions: ReadonlySet<string>;
  /**
   * a direct-execution step validates the definition built from evaluated
   * arguments, so the template-syntax scan reads the authored arguments from
   * here; absent when unknown, then the definition is scanned
   */
  authoredStep?: Step;
  workflowTags?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  secretRedactor?: SecretRedactor;
  /**
   * The run's record of sensitive values resolved for expressions. Required,
   * so no step can resolve a sensitive value without recording it.
   */
  sensitiveValues: RunSensitiveValues;
  sanitizedTasks?: SanitizedTaskOverlay;
  stepProvenance?: StepProvenanceOverlay;
  /** the run's started writes, waited for when the run is cancelled */
  inFlightDataWrites?: InFlightDataWrites;
  reportFilterOptions?: ReportFilterOptions;
  swampSha?: string;
  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  skipAllChecks?: boolean;
  initiatedBy?: string;
  dataBaseDir?: string;
  datastoreResolver?: DatastorePathResolver;
  catalogStore: CatalogStore;
  /**
   * defaults to SOLO_NAMESPACE when unset, keeping the catalog stamp in
   * lockstep with the namespaced data path
   */
  namespace?: Namespace;
  vaultsDir?: string;
  /**
   * where the step's sensitive outputs land when neither the field, an override
   * nor the spec names a vault
   */
  defaultVaultName?: string;
  autoGc?: boolean;
  runTracker?: RunTrackerRepository;
  ephemeralRepo?: UnifiedDataRepository;
  ephemeralCatalog?: CatalogStore;
  workflowRepo?: WorkflowRepository;
  workflowRunRepo?: WorkflowRunRepository;
  workflowGateService?:
    import("../models/workflow_gate_service.ts").WorkflowGateService;
  workflowPlacement?: import("./placement.ts").PlacementFields;
  placementProvenance?: ProvenanceMap;
  jobPlacement?: import("./placement.ts").PlacementFields;
  affinityKey?: string;
  /**
   * merged workflow, job, step (child wins); true forces
   * fail-instead-of-redispatch on worker disconnect
   */
  declaredWrites?: boolean;
}

export interface StepExecutor {
  execute(step: Step, ctx: StepExecutionContext): Promise<unknown>;
}

/**
 * cleanup steps run with a fresh signal bounded by this timeout so they cannot
 * hang indefinitely
 */
export const CLEANUP_GRACE_TIMEOUT_MS = 30_000;

/**
 * after an abort the job runner stops reading a step's events, so a nested step
 * finishes its child run in the background; wait here so the child saves itself
 * cancelled before the parent records its own
 */
async function awaitNestedRuns(
  pending: ReadonlySet<Promise<void>>,
): Promise<void> {
  if (pending.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLEANUP_GRACE_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.allSettled([...pending]), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * covers the shell executor's kill grace and the save of the cancelled
 * method-run output; stays under serve's abort graces so serve still sees an
 * aborted run finish
 */
export const STEP_STOP_GRACE_MS = 4_000;

/**
 * after an abort the run saves itself cancelled while methods still stop, and a
 * CLI exit would kill them with records left running; the run waits here so
 * each records its own cancellation first
 */
class InFlightMethodRuns {
  readonly dataWrites = new InFlightDataWrites(processDataWrites);
  readonly #pending = new Set<Promise<void>>();
  readonly #signal: AbortSignal | undefined;
  #abortedAt: number | undefined;
  readonly #onAbort = () => {
    this.#abortedAt ??= performance.now();
  };

  constructor(signal: AbortSignal | undefined) {
    this.#signal = signal;
    if (signal?.aborted) {
      this.#onAbort();
    } else {
      signal?.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  track<T>(execution: Promise<T>): Promise<T> {
    const release = () => {
      this.#pending.delete(settled);
    };
    const settled: Promise<void> = execution.then(release, release);
    this.#pending.add(settled);
    return execution;
  }

  /**
   * the deadline counts from the abort, not this call, so serve graces that
   * also start at the abort still see the run finish; a run whose cleanup
   * outlasted the grace does not wait
   */
  async settle(
    graceMs: number,
    options: { readonly quiet?: boolean } = {},
  ): Promise<void> {
    if (this.#pending.size === 0) return;
    const remaining = (this.#abortedAt ?? performance.now()) + graceMs -
      performance.now();
    if (remaining <= 0) return;
    if (options.quiet !== true) {
      getSwampLogger(["workflow", "cancel"]).info(
        "Waiting up to {seconds}s for {count} method(s) to stop",
        {
          seconds: Math.ceil(remaining / 1000),
          count: this.#pending.size,
        },
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    });
    try {
      await Promise.race([Promise.allSettled([...this.#pending]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * counted from the abort like settle; a write started after the run settled
   * is not waited for, as the step lock is released in teardown
   */
  async settleDataWrites(graceMs: number): Promise<void> {
    if (this.dataWrites.size === 0) return;
    const remaining = (this.#abortedAt ?? performance.now()) + graceMs -
      performance.now();
    if (remaining <= 0) return;
    const logger = getSwampLogger(["workflow", "cancel"]);
    logger.info(
      "Waiting up to {seconds}s for {count} data write(s) to finish",
      {
        seconds: Math.ceil(remaining / 1000),
        count: this.dataWrites.size,
      },
    );
    const left = await this.dataWrites.settle(remaining);
    if (left > 0) {
      logger.warn(
        "Stopped waiting for {count} data write(s); their data may not have been saved",
        { count: left },
      );
    }
  }

  dispose(): void {
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }
}

async function awaitInFlightWork(
  nestedRuns: ReadonlySet<Promise<void>>,
  methodRuns: InFlightMethodRuns,
  stepStopGraceMs: number | undefined,
): Promise<void> {
  const graceMs = stepStopGraceMs ?? STEP_STOP_GRACE_MS;
  await Promise.all([
    awaitNestedRuns(nestedRuns),
    methodRuns.settle(graceMs),
  ]);
  const dataGraceMs = graceMs + DATA_WRITE_STOP_GRACE_MS - STEP_STOP_GRACE_MS;
  await methodRuns.settleDataWrites(dataGraceMs);
  // a method whose write just landed still saves its output and reports
  await methodRuns.settle(dataGraceMs, { quiet: true });
}

/**
 * a method that answers after the job failed the step as cancelled must not
 * overwrite the settlement; its method-run record keeps its own outcome
 */
function abandonedByAbort(stepRun: StepRun, options: StepOptions): boolean {
  return (options.signal?.aborted ?? false) && stepRun.status !== "running";
}

/**
 * with the abort fired the step is marked stoppedByAbort: serve's shutdown then
 * interrupts it as unknown rather than leave it failed, where no recovery
 * reopens it
 */
function failInFlightStep(
  stepRun: StepRun,
  error: string,
  options: StepOptions,
  code?: string,
): void {
  if (options.signal?.aborted) {
    stepRun.failStoppedByAbort(error, code);
  } else {
    stepRun.fail(error, code);
  }
}

async function* trackNestedRun<T, R>(
  nestedRuns: Set<Promise<void>> | undefined,
  stream: AsyncGenerator<T, R>,
): AsyncGenerator<T, R> {
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => settle = resolve);
  nestedRuns?.add(settled);
  try {
    return yield* stream;
  } finally {
    nestedRuns?.delete(settled);
    settle();
  }
}

/**
 * splits on the first colon only, so step names that contain colons round-trip
 * without truncation
 */
export function stepNameFromCompositeKey(key: string): string {
  const idx = key.indexOf(":");
  return idx >= 0 ? key.slice(idx + 1) : "";
}

export function jobNameFromCompositeKey(key: string): string {
  const idx = key.indexOf(":");
  return idx >= 0 ? key.slice(0, idx) : key;
}

/**
 * the row must report the outcome the aggregate derived; pending and running
 * map to completed only to keep the switch exhaustive; no default on purpose,
 * so a new status fails the type check
 */
export function trackerStatusForRun(
  status: WorkflowRun["status"],
): ActiveRunStatus {
  switch (status) {
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "suspended":
      return "suspended";
    case "pending":
    case "running":
    case "succeeded":
      return "completed";
  }
}

/**
 * undefined when the registration is missing, unreadable, or names another
 * workflow, key or run than the claim; a failing store is the same, since the
 * step already failed with wait_key_held
 */
async function waitKeyHolderOf(
  store: Pick<SignalWaitStore, "findRegistration">,
  claim: WaitKeyClaim,
): Promise<WaitKeyHolder | undefined> {
  try {
    const stored = await store.findRegistration(claim.waitId);
    if (stored.kind !== "found") return undefined;
    const registration = stored.record;
    if (
      registration.workflowId !== claim.workflowId ||
      registration.key !== claim.key || registration.runId !== claim.runId
    ) return undefined;
    return {
      workflowId: registration.workflowId,
      workflowName: registration.workflowName,
      key: registration.key,
      runId: registration.runId,
      stepName: registration.stepName,
      waitId: registration.waitId,
    };
  } catch (error) {
    getSwampLogger(["workflow", "run"]).debug(
      "Could not read the registration of wait {waitId}, which holds key {key}: {error}",
      {
        waitId: claim.waitId,
        key: claim.key,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
}

function suspendedEventFor(
  run: WorkflowRun,
  workflow: Workflow,
): WorkflowExecutionEvent | undefined {
  const waiting = run.findWaitingApprovalStep();
  if (waiting) {
    const definitionSteps = workflow.jobs
      .find((j) => j.name === waiting.jobName)?.steps;
    const taskData = definitionSteps
      ?.find((s) => s.name === waiting.stepName)?.task.data;
    // the step run holds the prompt and timeout its gate was requested with; a
    // forEach-expanded step has no step of its name in the definition, so the
    // definition answers only for a record without them
    const stepRun = run.getJob(waiting.jobName)?.getStep(waiting.stepName);
    return {
      kind: "suspended",
      run,
      jobId: waiting.jobName,
      stepId: waiting.stepName,
      // The prompt is a resolved expression: shown masked, as the record
      // and the run view show it.
      prompt: run.mask(
        stepRun?.approvalPrompt ??
          (taskData?.type === "manual_approval" ? taskData.prompt : ""),
      ),
      timeout: gateTimeoutSeconds(stepRun, definitionSteps),
    };
  }
  const signalWait = run.findSignalWaits()[0];
  if (signalWait) {
    return {
      kind: "suspended",
      run,
      jobId: signalWait.jobName,
      stepId: signalWait.stepName,
      prompt: "",
      ...(signalWait.wait
        ? {
          wait: {
            id: signalWait.wait.id,
            deadline: signalWait.wait.deadline.toISOString(),
            ...(signalWait.wait.key !== undefined
              ? { key: signalWait.wait.key }
              : {}),
          },
        }
        : {}),
    };
  }
  const nested = run.findNestedWaits()[0];
  if (!nested) return undefined;
  return {
    kind: "suspended",
    run,
    jobId: nested.jobName,
    stepId: nested.stepName,
    prompt: "",
    nested: nested.link.kind === "valid"
      ? {
        workflowName: nested.link.ref.workflowName,
        runId: nested.link.ref.runId,
      }
      : undefined,
  };
}

/**
 * each supplied key is scanned as the author wrote it, since the built
 * definition holds substituted values; kept stored keys are scanned only for an
 * authored definition, never an auto-definition
 */
export function templateScanGlobalArguments(
  definitionGlobals: Record<string, unknown>,
  suppliedKeys: readonly string[],
  authored: Record<string, unknown> | string | undefined,
  scanStored = true,
): Record<string, unknown> {
  const scanned: Record<string, unknown> = scanStored
    ? { ...definitionGlobals }
    : {};
  for (const key of suppliedKeys) {
    if (!Object.hasOwn(definitionGlobals, key)) continue;
    delete scanned[key];
    if (
      typeof authored === "object" && authored !== null &&
      Object.hasOwn(authored, key)
    ) {
      scanned[key] = authored[key];
    }
  }
  return scanned;
}

export interface DirectTypeResolveResult {
  definition: Definition;
  modelType: ModelType;
  created: boolean;
  routedMethodInputs: Record<string, unknown>;
  authoredExpressions?: ReadonlySet<string>;
}

/**
 * a repository's writeSync, passed through unopened to the repositories built
 * here
 */
type DurableWriteSync = FileSystemUnifiedDataRepository["writeSync"];

export type DirectTypeResolver = (
  typeArg: string,
  definitionName: string,
  methodName: string,
  inputs: Record<string, unknown>,
  globalArgs: Record<string, unknown> | undefined,
  authoredExpressions: AuthoredExpressions,
  sensitiveValues?: RunSensitiveValues,
  provenance?: DirectInputsProvenance,
) => Promise<DirectTypeResolveResult>;

/**
 * a step that already failed keeps its own error: a flush that could not
 * publish, or refused to push after losing its lock, is logged instead; any
 * other flush error is thrown
 */
async function flushStepLock(
  flush: (written?: readonly WrittenVersion[]) => Promise<void>,
  written: readonly WrittenVersion[],
  stepFailed: boolean,
  logger: { error: (message: string, props: Record<string, unknown>) => void },
): Promise<void> {
  try {
    await flush(written);
  } catch (error) {
    if (!stepFailed || !isUnpublishedDataError(error)) {
      throw error;
    }
    logger.error("{message}", { message: error.message });
  }
}

export interface StepLockResult {
  flush: (written?: readonly WrittenVersion[]) => Promise<void>;
  /**
   * the step runs inside processLockHolderMarker.runHolding with these nonces
   * so a swamp it starts skips these locks, not parallel steps'; without them
   * that swamp matches locks on pid alone
   */
  heldLockIds?: readonly string[];
  /**
   * used in place of heldLockIds when present, so a swamp left over from a hop
   * that has ended stops skipping them
   */
  lentLocks?: LentLocks;
}

export type StepLockHook = (
  modelType: string,
  modelId: string,
  /** for a hook that judges the step before it starts; a hook may ignore it */
  step?: { readonly methodName: string; readonly behaviorName: string },
  /** stops the wait once the step is cancelled; a hook may ignore it */
  signal?: AbortSignal,
) => Promise<StepLockResult>;

export interface StepExecutorDeps {
  definitionRepo: DefinitionRepository;
  unifiedDataRepo: UnifiedDataRepository;
  dataQueryService: DataQueryService;
  outputRepo: OutputRepository;
  evaluatedDefRepo: YamlEvaluatedDefinitionRepository;
  methodExecutionService: MethodExecutionService;
  vaultService: VaultService;
  expressionEvaluator: ExpressionEvaluationService;
  invocationEvaluator: ExpressionEvaluationService;
  directTypeResolver?: DirectTypeResolver;
  runTracker?: RunTrackerRepository;
  /**
   * such a definition's stored global arguments are not linted as authored
   * text; absent, every definition counts as authored
   */
  isAutoDefinition?: (
    definition: Definition,
    type: ModelType,
  ) => Promise<boolean>;
}

export class DefaultStepExecutor implements StepExecutor {
  private readonly validationService = new DefaultModelValidationService();
  private readonly reportRunner = new MethodReportRunner();
  private readonly _directTypeResolver?: DirectTypeResolver;

  constructor(
    private readonly injectedDeps?: StepExecutorDeps,
    directTypeResolver?: DirectTypeResolver,
    private readonly markDirty?: MarkDirtyHook,
    private readonly stepLockHook?: StepLockHook,
    private readonly hydrateFile?: HydrateFileHook,
    private readonly fetchForeignContent?: ForeignContentFetcher,
    private readonly unreadableContent?: UnreadableContentLookup,
    private readonly durableWriteSync?: DurableWriteSync,
  ) {
    this._directTypeResolver = directTypeResolver;
  }

  static async fromRepoDir(
    repoDir: string,
    opts: {
      dataBaseDir?: string;
      datastoreResolver?: DatastorePathResolver;
      catalogStore: CatalogStore;
      markDirty?: MarkDirtyHook;
      hydrateFile?: HydrateFileHook;
      fetchForeignContent?: ForeignContentFetcher;
      unreadableContent?: UnreadableContentLookup;
      durableWriteSync?: DurableWriteSync;
      namespace?: Namespace;
      vaultsDir?: string;
      defaultVaultName?: string;
      autoGc?: boolean;
    },
  ): Promise<DefaultStepExecutor> {
    return new DefaultStepExecutor(
      await DefaultStepExecutor.buildDeps(repoDir, opts),
    );
  }

  private async resolveDeps(
    ctx: StepExecutionContext,
  ): Promise<StepExecutorDeps> {
    if (this.injectedDeps) return this.injectedDeps;
    const deps = await DefaultStepExecutor.buildDeps(ctx.repoDir, {
      dataBaseDir: ctx.dataBaseDir,
      datastoreResolver: ctx.datastoreResolver,
      catalogStore: ctx.catalogStore,
      markDirty: this.markDirty,
      hydrateFile: this.hydrateFile,
      fetchForeignContent: this.fetchForeignContent,
      unreadableContent: this.unreadableContent,
      durableWriteSync: this.durableWriteSync,
      namespace: ctx.namespace,
      vaultsDir: ctx.vaultsDir,
      defaultVaultName: ctx.defaultVaultName,
      autoGc: ctx.autoGc,
      ephemeralRepo: ctx.ephemeralRepo,
      ephemeralCatalog: ctx.ephemeralCatalog,
    });
    if (this._directTypeResolver) {
      deps.directTypeResolver = this._directTypeResolver;
    }
    if (ctx.runTracker) {
      deps.runTracker = ctx.runTracker;
    }
    return deps;
  }

  private static async buildDeps(
    repoDir: string,
    opts: {
      dataBaseDir?: string;
      datastoreResolver?: DatastorePathResolver;
      catalogStore: CatalogStore;
      markDirty?: MarkDirtyHook;
      hydrateFile?: HydrateFileHook;
      fetchForeignContent?: ForeignContentFetcher;
      unreadableContent?: UnreadableContentLookup;
      durableWriteSync?: DurableWriteSync;
      namespace?: Namespace;
      vaultsDir?: string;
      defaultVaultName?: string;
      autoGc?: boolean;
      ephemeralRepo?: UnifiedDataRepository;
      ephemeralCatalog?: CatalogStore;
    },
  ): Promise<StepExecutorDeps> {
    // Datastore-tier subdirs resolve through the datastore path resolver,
    // as the repository factory does; without one they stay repo-local.
    const dsPath = (subdir: string): string | undefined =>
      opts.datastoreResolver?.resolvePath(subdir);
    const definitionRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      undefined,
      dsPath(SWAMP_SUBDIRS.autoDefinitions),
      opts.markDirty,
    );
    const fsDataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      opts.dataBaseDir,
      opts.catalogStore,
      opts.markDirty,
      opts.hydrateFile,
      opts.namespace ?? SOLO_NAMESPACE,
      opts.autoGc ?? false,
      undefined,
      opts.fetchForeignContent,
      opts.unreadableContent,
      resolveDurableWrites(opts.datastoreResolver?.config()),
      opts.durableWriteSync,
    );
    const unifiedDataRepo: UnifiedDataRepository = opts.ephemeralRepo
      ? new CompositeUnifiedDataRepository(fsDataRepo, opts.ephemeralRepo)
      : fsDataRepo;
    const persistentQueryService = new DataQueryService(
      opts.catalogStore,
      fsDataRepo,
    );
    const dataQueryService: DataQueryService =
      opts.ephemeralRepo && opts.ephemeralCatalog
        ? new CompositeDataQueryService(
          opts.catalogStore,
          fsDataRepo,
          new DataQueryService(opts.ephemeralCatalog, opts.ephemeralRepo),
        )
        : persistentQueryService;
    const vaultService = await VaultService.fromRepository(repoDir, {
      vaultsDir: opts.vaultsDir,
      defaultVaultName: opts.defaultVaultName,
    });
    return {
      definitionRepo,
      unifiedDataRepo,
      dataQueryService,
      outputRepo: new YamlOutputRepository(
        repoDir,
        dsPath(SWAMP_SUBDIRS.outputs),
        opts.markDirty,
      ),
      evaluatedDefRepo: new YamlEvaluatedDefinitionRepository(
        repoDir,
        dsPath(SWAMP_SUBDIRS.definitionsEvaluated),
        opts.markDirty,
      ),
      methodExecutionService: new DefaultMethodExecutionService(),
      vaultService,
      expressionEvaluator: new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
      ),
      invocationEvaluator: new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
        { dataRepo: unifiedDataRepo, dataQueryService, vaultService },
      ),
      // directTypeResolver is not available in the lazy buildDeps path.
      // It must be injected via the WorkflowExecutionService constructor.
      isAutoDefinition: (definition, type) =>
        definitionRepo.isAutoDefinition(definition, type),
    };
  }

  async execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    const task = step.task.data;

    if (task.type === "model_method") {
      return await this.executeModelMethod(task, ctx);
    }

    throw new Error(
      `Unsupported task type for step executor: ${
        (task as { type: string }).type
      }`,
    );
  }

  private async executeModelMethod(
    task: {
      modelIdOrName?: string;
      modelType?: string;
      modelName?: string;
      methodName: string;
      inputs?: Record<string, unknown> | string;
      globalArgs?: Record<string, unknown> | string;
    },
    ctx: StepExecutionContext,
  ): Promise<unknown> {
    const allDeps = await this.resolveDeps(ctx);
    const {
      definitionRepo,
      unifiedDataRepo,
      dataQueryService,
      outputRepo,
      evaluatedDefRepo,
      methodExecutionService: executionService,
      vaultService,
      expressionEvaluator,
      invocationEvaluator,
    } = allDeps;

    if (
      executionService instanceof DefaultMethodExecutionService &&
      !executionService.modelInvocationService
    ) {
      const { ModelInvocationService } = await import(
        "../models/model_invocation_service.ts"
      );
      executionService.modelInvocationService = new ModelInvocationService({
        executionService,
        commonDeps: {
          dataRepository: unifiedDataRepo,
          definitionRepository: definitionRepo,
          vaultService,
          dataQueryService,
          createCelEnvironment: createExtensionCelEnvironment,
        },
        evaluationService: invocationEvaluator,
        repoDir: ctx.repoDir,
        pulledExtensionsRoot: ctx.pulledExtensionsRoot,
      });
    }

    if (
      executionService instanceof DefaultMethodExecutionService &&
      !executionService.workflowGateService &&
      ctx.workflowGateService
    ) {
      executionService.workflowGateService = ctx.workflowGateService;
    }

    // merged after forEach expansion but before expression resolution so
    // inherited fields are available to it; explicit values, including {},
    // override inherited ones
    const effectiveFields = mergePlacementFields(
      mergePlacementFields(ctx.workflowPlacement, ctx.jobPlacement),
      ctx.step?.placementFields,
    );
    let resolvedPlacement = resolvePlacement(effectiveFields);
    let placementMap = ctx.placementProvenance ?? ProvenanceMap.authored();

    // one bag per step, so remote dispatch ships only this step's secrets,
    // while any sentinel the run issued resolves through it
    const stepSecretBag = new VaultSecretBag(ctx.sensitiveValues.sentinels);
    const argumentSanitizer = sensitiveSpliceSanitizer(
      stepSecretBag,
    );
    // The step's task inputs and global arguments twice: raw for CEL
    // contexts, coercion, routing, caching and reports; sanitized for the
    // arguments that execute.
    const overlay = ctx.step
      ? ctx.sanitizedTasks?.forStep(ctx.step, stepSecretBag)
      : undefined;
    const stepMaps = (ctx.stepProvenance ?? StepProvenanceOverlay.authored())
      .forStep(ctx.step);
    let taskProvenance = stepMaps.raw.subtree("task");
    // The overlay's map is in the workflow bag's sentinels; the step reads
    // them re-issued from its own bag. Both copies hold sentinels, so they
    // are compared by what each sentinel references, with no value read.
    const overlayEntry = ctx.step
      ? ctx.sanitizedTasks?.entryFor(ctx.step)
      : undefined;
    const sentinelIdentity = sentinelIdentityOf(ctx.sensitiveValues.sentinels);
    const sanitizedTaskProvenance = overlay && overlayEntry
      ? alignProvenance(
        stepMaps.sanitized.subtree("task"),
        { inputs: overlayEntry.inputs, globalArgs: overlayEntry.globalArgs },
        { inputs: overlay.inputs, globalArgs: overlay.globalArgs },
        sentinelIdentity,
        sentinelIdentity,
      )
      : stepMaps.sanitized.subtree("task");
    let taskArgs = new SplicePair<TaskArgs>(
      { inputs: task.inputs, globalArgs: task.globalArgs },
      overlay
        ? {
          inputs: overlay.inputs as TaskArgs["inputs"],
          globalArgs: overlay.globalArgs as TaskArgs["globalArgs"],
        }
        : { inputs: task.inputs, globalArgs: task.globalArgs },
      taskProvenance,
      sanitizedTaskProvenance,
    );

    // vault/env and step-output kinds are deferred to their dedicated stages;
    // the pass issues into the step's bag, so existing sentinels bind as
    // Secrets and Secret results leave as sentinels delivery loads
    const stepPass = ctx.expressionContext
      ? await expressionEvaluator.passEvaluatorFor(ctx.sensitiveValues, {
        secretBag: stepSecretBag,
        location: ctx.stepName,
      })
      : undefined;
    if (ctx.expressionContext && stepPass) {
      const evaluate = (expr: string, context: Record<string, unknown>) =>
        stepPass.evaluate(expr, context);
      // the pass evaluates synchronously, so content its expressions read
      // through the model map must be local first, and in a typed run the
      // sensitive-field references it can read must be authorized first
      await stepPass.prepare(
        [task, taskArgs.raw, resolvedPlacement],
        ctx.expressionContext,
      );
      const resolvedTask = resolveAvailableExpressionsTracked(
        task,
        taskProvenance,
        ctx.expressionContext,
        evaluate,
        ctx.authoredExpressions,
      );
      task = resolvedTask.data as typeof task;
      taskArgs = resolveAvailableExpressionsPair(
        taskArgs,
        ctx.expressionContext,
        evaluate,
        ctx.authoredExpressions,
        argumentSanitizer,
      );
      task = { ...task, ...taskArgs.raw };
      taskProvenance = resolvedTask.provenance
        .graft("inputs", taskArgs.rawProvenance.subtree("inputs"))
        .graft("globalArgs", taskArgs.rawProvenance.subtree("globalArgs"));
      if (resolvedPlacement) {
        const tracked = resolveAvailableExpressionsTracked(
          resolvedPlacement,
          placementMap,
          ctx.expressionContext,
          evaluate,
          ctx.authoredExpressions,
        );
        resolvedPlacement = tracked.data as typeof resolvedPlacement;
        placementMap = tracked.provenance;
      }
    }

    if (resolvedPlacement) {
      resolvedPlacement = await expressionEvaluator.resolveAllExpressionsInData(
        resolvedPlacement,
        ctx.expressionContext ?? { model: {}, env: {} },
        ctx.secretRedactor,
        ctx.authoredExpressions,
        placementMap,
        {
          secretBag: stepSecretBag,
          destination: "placement",
          location: `${ctx.stepName}.placement`,
        },
      ) as typeof resolvedPlacement;
    }

    if (resolvedPlacement && ctx.affinityKey) {
      resolvedPlacement = {
        ...resolvedPlacement,
        affinityKey: ctx.affinityKey,
      };
    }
    // replaces any placement: a lane never moves off its planned worker
    if (ctx.lane) {
      resolvedPlacement = {
        target: ctx.lane.worker,
        queueTimeoutMs: resolvedPlacement?.queueTimeoutMs,
        lane: { worker: ctx.lane.worker },
      };
    }

    // Resolve selectors only: inputs and arguments keep their existing
    // evaluation/persistence paths. The authored set excludes substituted data.
    const selectors = {
      modelIdOrName: task.modelIdOrName,
      modelType: task.modelType,
      modelName: task.modelName,
      methodName: task.methodName,
    };
    task = {
      ...task,
      ...await expressionEvaluator.resolveRuntimeExpressionsInData(
        selectors,
        ctx.secretRedactor,
        ctx.expressionContext,
        ctx.authoredExpressions,
        taskProvenance,
        {
          secretBag: stepSecretBag,
          destination: "task selector",
          location: `${ctx.stepName}.task`,
        },
      ) as typeof selectors,
    };

    // resolved here, after the guard decided: runStep returns early on a
    // guarded skip and never reaches this executor, so a step that will not run
    // never resolves its target
    const resolveSelector = async (field: keyof typeof selectors) =>
      await resolveScalarExpression(
        task[field],
        `task.${field}`,
        ctx.expressionContext,
        await expressionEvaluator.passEvaluatorFor(ctx.sensitiveValues, {
          secretBag: stepSecretBag,
          destination: "task selector",
          location: `${ctx.stepName}.task.${field}`,
        }),
        ctx.authoredExpressions,
        taskProvenance.subtree(field),
      );
    task = {
      ...task,
      modelIdOrName: await resolveSelector("modelIdOrName"),
      modelName: await resolveSelector("modelName"),
      modelType: await resolveSelector("modelType"),
      methodName: (await resolveSelector("methodName"))!,
    };

    const recordInputs = await resolveRecordExpression(
      task.inputs,
      "task.inputs",
      ctx.expressionContext,
      stepPass,
      ctx.authoredExpressions,
      taskProvenance.subtree("inputs"),
    );
    const recordGlobalArgs = await resolveRecordExpression(
      task.globalArgs,
      "task.globalArgs",
      ctx.expressionContext,
      stepPass,
      ctx.authoredExpressions,
      taskProvenance.subtree("globalArgs"),
    );
    // A whole-field record expression was evaluated just now, so its
    // sanitized counterpart is its result through the sanitizer; otherwise
    // the sanitized member already holds the record.
    const sanitizedRecord = (
      raw: TaskArgs["inputs"],
      resolved: Record<string, unknown> | undefined,
      sanitized: TaskArgs["inputs"],
    ) =>
      typeof raw === "string"
        ? argumentSanitizer.whole(resolved, "") as Record<string, unknown>
        : sanitized;
    const recordMap = recordProvenance(
      taskArgs.rawProvenance,
      task,
      recordInputs,
      recordGlobalArgs,
      ctx.expressionContext,
    );
    taskArgs = new SplicePair<TaskArgs>(
      { inputs: recordInputs, globalArgs: recordGlobalArgs },
      {
        inputs: sanitizedRecord(
          task.inputs,
          recordInputs,
          taskArgs.sanitized.inputs,
        ),
        globalArgs: sanitizedRecord(
          task.globalArgs,
          recordGlobalArgs,
          taskArgs.sanitized.globalArgs,
        ),
      },
    ).withProvenance(
      recordMap,
      alignProvenance(
        recordMap,
        { inputs: recordInputs, globalArgs: recordGlobalArgs },
        {
          inputs: taskArgs.sanitized.inputs,
          globalArgs: taskArgs.sanitized.globalArgs,
        },
        sentinelStandInOf(stepSecretBag.registry),
        sentinelStandInOf(stepSecretBag.registry),
      ),
    );
    taskProvenance = taskProvenance
      .graft("inputs", taskArgs.rawProvenance.subtree("inputs"))
      .graft("globalArgs", taskArgs.rawProvenance.subtree("globalArgs"));
    task = { ...task, inputs: recordInputs, globalArgs: recordGlobalArgs };

    let definitionProvenance: DefinitionPassProvenance = AUTHORED_DEFINITION;
    let originalDefinition: Definition;
    let modelType: ModelType;
    /**
     * only a repository-loaded definition is author-written; a just-created
     * direct-execution one is built from substituted task.inputs, and treating
     * it as a provenance root would re-admit the injected text this gate refuses
     */
    let authoredFromDefinition: ReadonlySet<string> = new Set();

    let authoredForDirect = ctx.authoredExpressions;
    let executedBase: Definition | undefined;
    let sanitizedStepInputs: Record<string, unknown> | undefined;
    let authoredGlobalArguments: Record<string, unknown> | undefined;
    // Whether originalDefinition is the stored file, not a copy holding the
    // real values direct execution resolved.
    let storedDefinition = false;
    const isAutoDefinition = (definition: Definition, type: ModelType) =>
      allDeps.isAutoDefinition?.(definition, type) ?? Promise.resolve(false);
    if (task.modelType && task.modelName) {
      const resolver = allDeps.directTypeResolver;

      if (!resolver) {
        throw new Error(
          "Direct type execution is not supported in this context",
        );
      }

      // A deferred reference needing no parent scope is restored to its
      // authored text; scoped references stay tokens and are refused for global
      // arguments.
      const inlined = inlineUnscopedDeferred(
        { inputs: task.inputs, globalArgs: task.globalArgs },
        ctx.expressionContext?.deferredExpressions ?? [],
        ctx.authoredExpressions,
        taskArgs.rawProvenance,
      );
      const inlinedSanitized = inlineUnscopedDeferred(
        taskArgs.sanitized,
        ctx.expressionContext?.deferredExpressions ?? [],
        ctx.authoredExpressions,
        taskArgs.sanitizedProvenance,
      );
      taskArgs = new SplicePair<TaskArgs>(
        inlined.data,
        inlinedSanitized.data,
        inlined.provenance,
        inlinedSanitized.provenance,
      );
      const { modelType: typeArg, methodName } = task;
      // per worker, so each host has its own locks and data
      const laneAuthoredTask = (ctx.authoredStep ?? ctx.step)?.task.data;
      const modelName = ctx.lane
        ? perWorkerBehaviorName(
          task.modelName,
          ctx.lane.worker,
          laneAuthoredTask?.type === "model_method"
            ? laneAuthoredTask.modelName
            : undefined,
        )
        : task.modelName;
      task = { ...task, ...inlined.data };
      authoredForDirect = inlined.authored;
      for (const field of ["inputs", "globalArgs"] as const) {
        assertNoUnlistedForeignArguments(
          field,
          task[field],
          authoredForDirect,
          taskArgs.rawProvenance.subtree(field),
        );
      }

      const result = await resolver(
        typeArg,
        modelName,
        methodName,
        (task.inputs ?? {}) as Record<string, unknown>,
        task.globalArgs as Record<string, unknown> | undefined,
        authoredForDirect,
        ctx.sensitiveValues,
        {
          inputs: taskArgs.rawProvenance.subtree("inputs"),
          globalArgs: taskArgs.rawProvenance.subtree("globalArgs"),
        },
      );

      originalDefinition = result.definition;
      modelType = result.modelType;
      authoredFromDefinition = result.authoredExpressions ?? new Set();
      const executedDirect = sanitizedDirectExecution(
        result,
        taskArgs,
      );
      executedBase = executedDirect.definition;
      sanitizedStepInputs = executedDirect.methodInputs;

      const authoredTask = ctx.authoredStep?.task.data;
      // a step edited since a cached evaluation can have moved arguments
      // between globalArgs and inputs, so its authored text does not describe
      // the values it runs with; the definition is scanned as it is
      if (
        authoredTask?.type === "model_method" &&
        !task.globalArgs === !authoredTask.globalArgs
      ) {
        // The resolver takes task.globalArgs as the global arguments when
        // given, and otherwise routes task.inputs between global and method
        // arguments by schema.
        const suppliedKeys = task.globalArgs
          ? Object.keys(task.globalArgs)
          : Object.keys(task.inputs ?? {}).filter((key) =>
            !Object.hasOwn(result.routedMethodInputs, key)
          );
        authoredGlobalArguments = templateScanGlobalArguments(
          result.definition.globalArguments,
          suppliedKeys,
          task.globalArgs ? authoredTask.globalArgs : authoredTask.inputs,
          // A definition this step just created holds only keys it supplied.
          result.created ||
            !await isAutoDefinition(result.definition, result.modelType),
        );
      }

      // routed global arguments keep the provenance of the inputs they came
      // from, so self.globalArguments and the definition pass see where data
      // sits in them
      const routedGlobals = routedGlobalProvenance(
        result.definition.globalArguments as Record<string, unknown>,
        (task.globalArgs ?? task.inputs ?? {}) as Record<string, unknown>,
        taskArgs.rawProvenance.subtree(
          task.globalArgs ? "globalArgs" : "inputs",
        ),
      );
      const routedSanitizedGlobals = routedGlobalProvenance(
        executedDirect.definition.globalArguments as Record<string, unknown>,
        (taskArgs.sanitized.globalArgs ?? taskArgs.sanitized.inputs ??
          {}) as Record<string, unknown>,
        taskArgs.sanitizedProvenance.subtree(
          task.globalArgs ? "globalArgs" : "inputs",
        ),
      );
      definitionProvenance = {
        raw: ProvenanceMap.authored().graft("globalArguments", routedGlobals),
        sanitized: ProvenanceMap.authored().graft(
          "globalArguments",
          routedSanitizedGlobals,
        ),
      };
      const methodInputsProvenance = (
        map: ProvenanceMap,
        inputs: Record<string, unknown>,
      ) => {
        let out = ProvenanceMap.authored();
        for (const key of Object.keys(inputs)) {
          out = out.graft(keySegment(key), map.subtree(keyPath("inputs", key)));
        }
        return out;
      };
      task = {
        ...task,
        inputs: result.routedMethodInputs,
      };
      taskArgs = new SplicePair<TaskArgs>(
        { inputs: result.routedMethodInputs, globalArgs: task.globalArgs },
        {
          inputs: sanitizedStepInputs,
          globalArgs: taskArgs.sanitized.globalArgs,
        },
        ProvenanceMap.authored()
          .graft(
            "inputs",
            methodInputsProvenance(
              taskArgs.rawProvenance,
              result.routedMethodInputs,
            ),
          )
          .graft("globalArgs", taskArgs.rawProvenance.subtree("globalArgs")),
        ProvenanceMap.authored()
          .graft(
            "inputs",
            methodInputsProvenance(
              taskArgs.sanitizedProvenance,
              sanitizedStepInputs ?? {},
            ),
          )
          .graft(
            "globalArgs",
            taskArgs.sanitizedProvenance.subtree("globalArgs"),
          ),
      );
    } else if (task.modelIdOrName) {
      const lookupResult = await findDefinitionByIdOrName(
        definitionRepo,
        task.modelIdOrName,
      );
      if (!lookupResult) {
        throw new Error(`Behavior not found: ${task.modelIdOrName}`);
      }
      originalDefinition = lookupResult.definition;
      modelType = lookupResult.type;
      storedDefinition = true;
      authoredFromDefinition = collectAuthoredExpressions(
        originalDefinition.toData(),
      );
      // An auto-definition's global arguments are the evaluated values of
      // the run that wrote it, not authored text; nothing here is authored.
      if (await isAutoDefinition(originalDefinition, modelType)) {
        authoredGlobalArguments = {};
      }
    } else {
      throw new Error(
        "Step task requires either modelIdOrName or modelType + modelName",
      );
    }

    const runLogger = getRunLogger(
      originalDefinition.name,
      task.methodName,
      ctx.workflowRunId,
    );

    runLogger.debug("Found model {name} ({type})", {
      name: originalDefinition.name,
      type: modelType.normalized,
    });
    ctx.emitEvent?.({
      kind: "model_resolved",
      jobId: ctx.jobName,
      stepId: ctx.stepName,
      runId: ctx.workflowRunId,
      modelName: originalDefinition.name,
      modelType: modelType.normalized,
      modelId: originalDefinition.id,
      methodName: task.methodName,
    });

    const envVarUsages = detectEnvVarUsageInDefinition(originalDefinition);
    if (envVarUsages.length > 0) {
      ctx.emitEvent?.({
        kind: "env_var_warning",
        jobId: ctx.jobName,
        stepId: ctx.stepName,
        modelName: originalDefinition.name,
        envVars: envVarUsages,
        message: envVarWarningText().text,
      });
    }

    const modelDef = await resolveModelType(modelType, getAutoResolver());
    if (!modelDef) {
      throw new Error(`Unknown behavior type: ${modelType.normalized}`);
    }

    // Validate the model definition (including expression paths) BEFORE
    // evaluation, as a run of the step's method: another method's problems
    // are not this step's to fail on, as `swamp behavior run` does not.
    const validationResults = await this.validationService.validateModel(
      originalDefinition,
      modelDef,
      definitionRepo,
      undefined,
      // Direct execution refuses a stored literal in resolveOrCreateDefinition.
      {
        authoredGlobalArguments,
        refuseLiteralSensitiveGlobals: storedDefinition,
        method: task.methodName,
      },
    );

    const failures = validationResults.results.filter((r) => !r.passed);
    if (failures.length > 0) {
      const errors = failures.map((f) =>
        f.error?.includes("\n")
          ? `  ${f.name}:\n${f.error.replace(/^/gm, "    ")}`
          : `  ${f.name}: ${f.error}`
      ).join("\n");
      throw new Error(
        `Behavior validation failed for "${originalDefinition.name}":\n${errors}`,
      );
    }

    // hashed over the stored definition as authored, before inputs are written
    // into it, so the hash changes only when the definition does and holds no
    // resolved value; direct execution is hashed below in persisted form
    const isDirectExecution = executedBase !== undefined;
    const storedDefinitionHash = isDirectExecution
      ? undefined
      : await originalDefinition.computeHash();

    let evaluatedDefinition = originalDefinition;
    let executedDefinition = executedBase ?? originalDefinition;
    let failedExpressions: FailedExpressions = new Map();
    let stepInputs = SplicePair.of<Record<string, unknown>>({});
    // task.inputs is not seeded: the evaluator already substituted data into
    // it, and substituted data must not be evaluated again.
    const authoredExpressions = new Set([
      ...authoredForDirect,
      ...authoredFromDefinition,
    ]);
    // another templating system's text in a definition vouches for nothing:
    // matched by raw text against the same literal() output in a step input, it
    // would be evaluated as the author's expression and fail on its root
    const stepInputAuthored = (): ReadonlySet<string> => {
      const fromDefinition = [...authoredExpressions].filter((raw) =>
        !authoredForDirect.has(raw)
      );
      if (fromDefinition.length === 0) return authoredExpressions;
      const vouching = new Set(authoredForDirect);
      for (const raw of fromDefinition) {
        const [expr] = extractExpressions(raw);
        if (
          expr === undefined ||
          storedTextRefusal(expr.celExpression) !== undefined
        ) vouching.add(raw);
      }
      return vouching;
    };

    if (ctx.expressionContext) {
      runLogger.debug("Evaluating expressions");
      const forEachVars: Record<string, unknown> = {};
      if (ctx.forEachVariable && ctx.forEachVariable.name) {
        if (ctx.forEachIndex !== undefined) {
          forEachVars._index = ctx.forEachIndex;
        }
        forEachVars[ctx.forEachVariable.name] = ctx.forEachVariable.value;
      }
      ctx.expressionContext.self = {
        id: originalDefinition.id,
        name: originalDefinition.name,
        version: originalDefinition.version,
        tags: originalDefinition.tags,
        globalArguments: originalDefinition.globalArguments,
        ...forEachVars,
      };
      // A forEach item bound over a definition field keeps its own map:
      // the item's value wins in `self`, so its provenance must too.
      let selfProvenance = (bindingProvenanceOf(ctx.expressionContext).self ??
        ProvenanceMap.authored()).graft(
          "globalArguments",
          definitionProvenance.raw.subtree("globalArguments"),
        );
      if (ctx.forEachVariable?.name) {
        selfProvenance = selfProvenance.graft(
          keySegment(ctx.forEachVariable.name),
          ctx.forEachVariable.provenance ??
            ProvenanceMap.authored(),
        );
      }
      attachBindingProvenance(ctx.expressionContext, { self: selfProvenance });

      if (task.inputs) {
        stepInputs = await expressionEvaluator.evaluateDataPair(
          stepInputPair(taskArgs),
          ctx.expressionContext,
          stepInputAuthored(),
          stepSecretBag,
          "passThrough",
        );
      }

      // Merge step inputs with existing context inputs (step inputs take
      // precedence). The context always holds real values, and carries where
      // data sits in each of them.
      const originalInputs = ctx.expressionContext.inputs ?? {};
      ctx.expressionContext.inputs = { ...originalInputs, ...stepInputs.raw };
      let inputsProvenance =
        bindingProvenanceOf(ctx.expressionContext).inputs ??
          ProvenanceMap.authored();
      for (const key of Object.keys(stepInputs.raw)) {
        inputsProvenance = inputsProvenance.graft(
          keySegment(key),
          stepInputs.rawProvenance.subtree(keySegment(key)),
        );
      }
      attachBindingProvenance(ctx.expressionContext, {
        inputs: inputsProvenance,
      });

      ({
        definition: evaluatedDefinition,
        sanitizedDefinition: executedDefinition,
        failedExpressions,
        provenance: definitionProvenance,
      } = await new DefinitionExpressionEvaluator(
        // the definition pass issues into the step's bag, so a forEach item or
        // an input that is a sentinel binds as a Secret
        await expressionEvaluator.passEvaluatorFor(ctx.sensitiveValues, {
          secretBag: stepSecretBag,
          location: originalDefinition.name,
        }),
      ).evaluate(
        originalDefinition,
        ctx.expressionContext,
        authoredExpressions,
        stepSecretBag,
        executedDefinition,
        definitionProvenance,
      ));
    }

    // copying definition inputs into cached method arguments can leak a
    // sensitive value under an unmarked input name, so only schema-accepted
    // inputs are kept and forwarded aliases of masked arguments are masked
    const cachedDefinition = Definition.fromData(executedDefinition.toData());
    let cachedProvenance = definitionProvenance.raw;
    let cachedExecutedProvenance = definitionProvenance.sanitized;
    const methodSchema = modelDef.methods[task.methodName]?.arguments;
    const cachedInputKeys = new Set(
      Object.keys(stepInputs.raw).filter((key) =>
        methodSchema !== undefined &&
        acceptsMethodArgumentKey(methodSchema, key)
      ),
    );

    // runs after expression evaluation, so task.inputs values take precedence
    // over values resolved from inputs.X expressions
    if (executedDefinition === evaluatedDefinition) {
      executedDefinition = Definition.fromData(evaluatedDefinition.toData());
    }
    for (const [key, value] of Object.entries(stepInputs.raw)) {
      evaluatedDefinition.setMethodArgument(task.methodName, key, value);
      if (cachedInputKeys.has(key)) {
        cachedProvenance = cachedProvenance.graft(
          methodArgumentPath(task.methodName, key),
          stepInputs.rawProvenance.subtree(keySegment(key)),
        );
      }
      definitionProvenance = {
        ...definitionProvenance,
        raw: definitionProvenance.raw.graft(
          methodArgumentPath(task.methodName, key),
          stepInputs.rawProvenance.subtree(keySegment(key)),
        ),
      };
    }
    for (const [key, value] of Object.entries(stepInputs.sanitized)) {
      executedDefinition.setMethodArgument(task.methodName, key, value);
      if (cachedInputKeys.has(key)) {
        cachedDefinition.setMethodArgument(task.methodName, key, value);
        cachedExecutedProvenance = cachedExecutedProvenance.graft(
          methodArgumentPath(task.methodName, key),
          stepInputs.sanitizedProvenance.subtree(keySegment(key)),
        );
      }
      definitionProvenance = {
        ...definitionProvenance,
        sanitized: definitionProvenance.sanitized.graft(
          methodArgumentPath(task.methodName, key),
          stepInputs.sanitizedProvenance.subtree(keySegment(key)),
        ),
      };
    }

    // A failed expression the method is about to receive would otherwise be
    // handed over as its raw ${{ ... }} text. Checked after the step-input
    // overrides above, so an input that replaces the value lets the step run.
    assertMethodArgumentsEvaluated(
      task.methodName,
      evaluatedDefinition.getMethodArguments(task.methodName),
      failedExpressions,
    );

    // the lock covers every write of the step so one flush pushes everything;
    // taking it first means a lock timeout fails the step before any record is
    // left at running
    let flushLock:
      | ((written?: readonly WrittenVersion[]) => Promise<void>)
      | null = null;
    // declared outside try so the catch can record artifacts written before a
    // throw and the lock's flush can publish them
    const savedArtifacts: Array<{
      dataId: string;
      name: string;
      version: number;
      tags: Record<string, string>;
    }> = [];
    // versions a worker wrote before its step failed reach this process only on
    // the error
    const failedRemoteWrites: WrittenVersion[] = [];
    // a failed dispatch's handles are shown on the step but published only
    // through failedRemoteWrites, which leave out ephemeral data
    const unpublishedRemoteHandles = new Set<string>();
    let stepFailed = false;
    // Undefined when a hook took locks without naming them.
    let heldLockIds: readonly string[] | LentLocks | undefined = [];
    if (this.stepLockHook) {
      const lockResult = await this.stepLockHook(
        modelType.normalized,
        originalDefinition.id,
        { methodName: task.methodName, behaviorName: originalDefinition.name },
        ctx.signal,
      );
      flushLock = lockResult.flush;
      heldLockIds = lockResult.lentLocks ?? lockResult.heldLockIds;
    }
    try {
      // a step queued on a sibling's lock must not start its side effect once
      // the run is cancelled; inside the try so the finally still releases
      ctx.signal.throwIfAborted();
      // Save evaluated arguments with runtime expressions still raw and
      // sensitive values masked or referenced, without forwarded input aliases.
      const persisted = persistEvaluatedDefinition(
        cachedDefinition,
        ctx.expressionContext?.deferredExpressions ?? [],
        originalDefinition,
        ctx.sensitiveValues,
        modelDef,
        cachedExecutedProvenance,
        [...cachedInputKeys].map((
          key,
        ) => ["methods", task.methodName, "arguments", key]),
      );
      await evaluatedDefRepo.save(
        modelType,
        persisted.definition,
        // In raw-copy coordinates, which rehydrate restores exactly.
        cachedProvenance,
        authoredExpressions,
        persisted.deferredExpressions,
        persisted.writtenReferences,
        persisted.maskedPaths,
        persisted.persistedProvenance,
      );

      // reports and the completed event show arguments to the user and are
      // persisted with report output, so sensitive values are masked there
      const reportGlobalArgs = ctx.sensitiveValues.masked(
        evaluatedDefinition.globalArguments,
      ) as Record<string, unknown>;
      const reportMethodArgs = ctx.sensitiveValues.masked(
        evaluatedDefinition.getMethodArguments(task.methodName),
      ) as Record<string, unknown>;

      // vault secrets become sentinels the secretBag maps to values; the
      // expression context lets dynamic vault.get() arguments be CEL-evaluated;
      // scoped to the step's method, as every delivery's runtime pass is
      const runtimeResult = await expressionEvaluator
        .resolveRuntimeExpressionsInDefinition(
          executedDefinition,
          ctx.secretRedactor,
          ctx.expressionContext,
          authoredExpressions,
          {
            secretBag: stepSecretBag,
            rawGlobalArguments: evaluatedDefinition.globalArguments,
            provenance: definitionProvenance.sanitized,
            methodName: task.methodName,
          },
        );
      evaluatedDefinition = runtimeResult.definition;
      const secretBag = runtimeResult.secretBag;
      // Definition tags reach data artifacts and the catalog as they are, so a
      // sensitive value in one becomes its placeholder (after the runtime pass,
      // which can also splice one into a tag).
      withTagPlaceholders(evaluatedDefinition, ctx.sensitiveValues);

      const method = modelDef.methods[task.methodName];
      if (!method) {
        const availableMethods = Object.keys(modelDef.methods).join(", ");
        throw new Error(
          `Unknown method '${task.methodName}' for type '${modelType.normalized}'. Available methods: ${
            availableMethods || "none"
          }`,
        );
      }

      const definitionHash = storedDefinitionHash ??
        await persisted.definition.computeHash();
      const output = ModelOutput.create({
        definitionId: originalDefinition.id,
        methodName: task.methodName,
        provenance: {
          definitionHash,
          modelVersion: modelDef.version,
          triggeredBy: "workflow",
          workflowId: ctx.workflowId,
          workflowRunId: ctx.workflowRunId,
          stepName: ctx.stepName,
          initiatedBy: ctx.initiatedBy,
          bundleFingerprint: modelDef.sourceFingerprint,
        },
      });

      output.markRunning(Deno.pid);
      if (ctx.workflowRun?.logFile) {
        output.setLogFile(ctx.workflowRun.logFile);
      }
      await outputRepo.save(modelType, task.methodName, output);

      const { runTracker } = allDeps;
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
      if (runTracker) {
        const activeRun = ActiveRun.createModelMethodRun({
          id: output.id,
          modelType: modelType.normalized,
          definitionId: originalDefinition.id,
          methodName: task.methodName,
          pid: Deno.pid,
          hostname: hostname(),
          initiatedBy: ctx.initiatedBy,
          // A step runs in the process that drives its workflow run, so the
          // row carries that run's serve instance, if serve drives it.
          instanceId: ctx.workflowRun?.instanceId,
        });
        runTracker.register(activeRun);
      }

      if (runTracker) {
        heartbeatInterval = setInterval(() => {
          try {
            runTracker.heartbeat(output.id);
          } catch {
            // Heartbeat failure is non-fatal
          }
        }, 30_000);
      }
      const narrowedTask = task as {
        modelIdOrName?: string;
        modelType?: string;
        modelName?: string;
        methodName: string;
        inputs?: Record<string, unknown>;
      };
      try {
        // A swamp the method starts skips this step's lock, and still
        // waits on the locks parallel steps hold in this process.
        const invoke = () =>
          this.invokeMethod({
            task: narrowedTask,
            ctx,
            executionService,
            unifiedDataRepo,
            definitionRepo,
            dataQueryService,
            vaultService,
            modelType,
            modelDef,
            originalDefinition,
            evaluatedDefinition,
            runLogger,
            secretBag,
            secretLoader: expressionEvaluator.secretLoader(ctx.secretRedactor),
            argumentProvenance: runtimeResult.provenance,
            resolvedPlacement,
          });
        const result = heldLockIds === undefined
          ? await invoke()
          : await processLockHolderMarker.runHolding(heldLockIds, invoke);

        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (runTracker) runTracker.complete(output.id, "completed");

        return await this.handleMethodSuccess({
          task: narrowedTask,
          ctx,
          outputRepo,
          unifiedDataRepo,
          definitionRepo,
          vaultService,
          modelType,
          modelDef,
          originalDefinition,
          evaluatedDefinition,
          runLogger,
          reportGlobalArgs,
          reportMethodArgs,
          result,
          output,
          savedArtifacts,
        });
      } catch (error) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        // As for a standalone method run (`libswamp/models/run.ts`): a method
        // the run's abort stopped was cancelled, not failed.
        const aborted = ctx.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        // What stopped it: a plain abort names no cause, which leaves the
        // tracker row's reason for `swamp model cancel` to fill in.
        const cause = aborted ? cancelCause(ctx.signal) : undefined;
        if (runTracker) {
          runTracker.complete(
            output.id,
            aborted ? "cancelled" : "failed",
            cause,
          );
        }

        // before handleMethodFailure, which adds the handles to savedArtifacts
        // and may throw before returning
        for (const version of writtenVersionsOf(error)) {
          failedRemoteWrites.push(version);
        }
        if (remoteOutputsOf(error).length > 0) {
          for (const handle of recoveredDataHandles(error)) {
            unpublishedRemoteHandles.add(`${handle.dataId}@${handle.version}`);
          }
        }
        await this.handleMethodFailure({
          task: narrowedTask,
          ctx,
          outputRepo,
          unifiedDataRepo,
          definitionRepo,
          modelType,
          modelDef,
          originalDefinition,
          evaluatedDefinition,
          runLogger,
          reportGlobalArgs,
          reportMethodArgs,
          error,
          aborted,
          cancelCause: cause,
          output,
          savedArtifacts,
        });
        stepFailed = true;
        // the step's failure, its events and the run record read the message
        // from what is thrown here
        throw redactedError(error, ctx.secretRedactor);
      }
    } finally {
      if (flushLock) {
        const written: WrittenVersion[] = [
          ...savedArtifacts.filter((artifact) =>
            !unpublishedRemoteHandles.has(
              `${artifact.dataId}@${artifact.version}`,
            )
          ).map((artifact) => ({
            modelType: modelType.normalized,
            modelId: evaluatedDefinition.id,
            dataName: artifact.name,
            version: artifact.version,
          })),
          ...failedRemoteWrites,
        ];
        await flushStepLock(flushLock, written, stepFailed, runLogger);
      }
    }
  }

  private async invokeMethod(args: {
    task: {
      modelIdOrName?: string;
      modelType?: string;
      modelName?: string;
      methodName: string;
      inputs?: Record<string, unknown>;
    };
    ctx: StepExecutionContext;
    executionService: MethodExecutionService;
    unifiedDataRepo: UnifiedDataRepository;
    definitionRepo: DefinitionRepository;
    dataQueryService: DataQueryService;
    vaultService: VaultService;
    modelType: ModelType;
    modelDef: ModelDefinition;
    originalDefinition: Definition;
    evaluatedDefinition: Definition;
    runLogger: ReturnType<typeof getRunLogger>;
    secretBag: ReturnType<
      ExpressionEvaluationService["resolveRuntimeExpressionsInDefinition"]
    > extends Promise<infer R> ? R extends { secretBag: infer S } ? S : never
      : never;
    /** Loads `secretBag`'s vault references at delivery. */
    secretLoader: SecretLoader;
    /** Where data sits in `evaluatedDefinition`, after the runtime pass. */
    argumentProvenance: ProvenanceMap;
    resolvedPlacement?: {
      target?: string;
      labels?: Record<string, string>;
      platform?: string;
      queueTimeoutMs?: number;
      affinityKey?: string;
    };
  }): Promise<MethodResult> {
    const {
      task,
      ctx,
      executionService,
      unifiedDataRepo,
      definitionRepo,
      dataQueryService,
      vaultService,
      modelType,
      modelDef,
      originalDefinition,
      evaluatedDefinition,
      runLogger,
      secretBag,
      secretLoader,
      argumentProvenance,
      resolvedPlacement,
    } = args;

    runLogger.debug("Executing method {method}", { method: task.methodName });

    // tags are filtered by exact string, so a sensitive value in one becomes
    // its placeholder before any writer sees it; source (not type) keeps the
    // original data type
    const workflowTagOverrides: Record<string, string> = {
      ...ctx.sensitiveValues.tagsWithPlaceholders(ctx.workflowTags ?? {}),
      source: "step-output",
      workflow: ctx.workflowName,
      workflowId: ctx.workflowId,
      workflowRunId: ctx.workflowRunId,
      job: ctx.jobName,
      step: ctx.stepName,
      ...(ctx.initiatedBy ? { initiatedBy: ctx.initiatedBy } : {}),
    };

    const stepDataOutputOverrides = ctx.step?.dataOutputOverrides
      ? Array.from(ctx.step.dataOutputOverrides).map((override) => {
        let resolvedVarySuffix: string | undefined;
        if (override.vary && override.vary.length > 0) {
          const inputs = ctx.expressionContext?.inputs ?? {};
          const varyValues = override.vary.map((key) => {
            const val = inputs[key];
            if (val === undefined || val === null) {
              throw new UserError(
                `Vary dimension '${key}' not found in step inputs for spec '${override.specName}'`,
              );
            }
            // A suffix becomes part of a data name: never the secret.
            return coerceToSuffix(
              ctx.sensitiveValues.withPlaceholdersDeep(val),
            );
          });
          resolvedVarySuffix = varyValues.join("-");
        }
        return {
          specName: override.specName,
          lifetime: override.lifetime,
          garbageCollection: override.garbageCollection,
          tags: override.tags
            ? ctx.sensitiveValues.tagsWithPlaceholders(override.tags)
            : override.tags,
          resolvedVarySuffix,
          vaultName: override.vaultName,
        };
      })
      : undefined;

    // a failure before this point (vary-key validation, etc.) is reported via
    // step_failed instead of method_executing, by design
    ctx.emitEvent?.({
      kind: "method_executing",
      jobId: ctx.jobName,
      stepId: ctx.stepName,
      runId: ctx.workflowRunId,
      modelName: originalDefinition.name,
      methodName: task.methodName,
    });

    // register post-vault-resolution values from evaluatedDefinition with the
    // redactor so they are scrubbed from the workflow log
    if (ctx.secretRedactor) {
      const globalArgSchema = modelDef.globalArguments;
      if (globalArgSchema) {
        for (
          const secret of extractSensitiveFieldValues(
            globalArgSchema,
            evaluatedDefinition.globalArguments,
          )
        ) {
          ctx.secretRedactor.addSecret(secret);
        }
      }
      const methodArgSchema = modelDef.methods[task.methodName]?.arguments;
      if (methodArgSchema) {
        for (
          const secret of extractSensitiveFieldValues(
            methodArgSchema,
            evaluatedDefinition.getMethodArguments(task.methodName),
          )
        ) {
          ctx.secretRedactor.addSecret(secret);
        }
      }
    }

    return await executionService.executeWorkflow(
      evaluatedDefinition,
      modelDef,
      task.methodName,
      buildMethodContext(
        {
          dataRepository: unifiedDataRepo,
          definitionRepository: definitionRepo,
          vaultService,
          redactor: ctx.secretRedactor,
          dataQueryService,
          createCelEnvironment: createExtensionCelEnvironment,
        },
        {
          signal: ctx.signal,
          repoDir: ctx.repoDir,
          modelType,
          modelId: evaluatedDefinition.id,
          globalArgs: evaluatedDefinition.globalArguments,
          definition: {
            id: evaluatedDefinition.id,
            name: evaluatedDefinition.name,
            version: evaluatedDefinition.version,
            tags: evaluatedDefinition.tags,
          },
          methodName: task.methodName,
          logger: runLogger,
          tagOverrides: workflowTagOverrides,
          runtimeTags: ctx.runtimeTags,
          dataOutputOverrides: mergeDataOutputOverrides(
            evaluatedDefinition.resources,
            stepDataOutputOverrides,
          ),
          vaultSecrets: secretBag,
          placement: resolvedPlacement,
          declaredWrites: ctx.declaredWrites,
          inFlightDataWrites: ctx.inFlightDataWrites,
          skipCheckNames: ctx.skipCheckNames,
          skipCheckLabels: ctx.skipCheckLabels,
          skipAllChecks: ctx.skipAllChecks,
          extensionFilesRoot: modelDef.extensionFilesRoot,
          onEvent: ctx.emitEvent
            ? (event: MethodExecutionEvent) => {
              if (event.type === "output") {
                ctx.emitEvent!({
                  kind: "method_output",
                  jobId: ctx.jobName,
                  stepId: ctx.stepName,
                  modelName: originalDefinition.name,
                  methodName: task.methodName,
                  stream: event.stream,
                  line: event.line,
                });
              } else if (event.type === "step_queued") {
                ctx.emitEvent!({
                  kind: "step_queued",
                  jobId: ctx.jobName,
                  stepId: ctx.stepName,
                  requirement: event.requirement,
                });
              } else if (event.type === "step_target_disconnected") {
                ctx.emitEvent!({
                  kind: "step_target_disconnected",
                  jobId: ctx.jobName,
                  stepId: ctx.stepName,
                  target: event.target,
                });
              } else {
                ctx.emitEvent!({
                  kind: "method_event",
                  jobId: ctx.jobName,
                  stepId: ctx.stepName,
                  modelName: originalDefinition.name,
                  methodName: task.methodName,
                  event,
                });
              }
            }
            : undefined,
        },
      ),
      {
        secretLoader,
        unreadReferences: ctx.sensitiveValues,
        argumentProvenance,
      },
    );
  }

  private async handleMethodSuccess(args: {
    task: {
      modelIdOrName?: string;
      modelType?: string;
      modelName?: string;
      methodName: string;
      inputs?: Record<string, unknown>;
    };
    ctx: StepExecutionContext;
    outputRepo: OutputRepository;
    unifiedDataRepo: UnifiedDataRepository;
    definitionRepo: DefinitionRepository;
    vaultService: VaultService;
    modelType: ModelType;
    modelDef: ModelDefinition;
    originalDefinition: Definition;
    evaluatedDefinition: Definition;
    runLogger: ReturnType<typeof getRunLogger>;
    reportGlobalArgs: Record<string, unknown>;
    reportMethodArgs: Record<string, unknown>;
    result: MethodResult;
    output: ModelOutput;
    savedArtifacts: Array<{
      dataId: string;
      name: string;
      version: number;
      tags: Record<string, string>;
    }>;
  }): Promise<unknown> {
    const {
      task,
      ctx,
      outputRepo,
      unifiedDataRepo,
      definitionRepo,
      modelType,
      modelDef,
      originalDefinition,
      evaluatedDefinition,
      runLogger,
      reportGlobalArgs,
      reportMethodArgs,
      result,
      output,
      savedArtifacts,
    } = args;

    const resources: Record<string, Record<string, DataRecord>> = {};
    const files: Record<string, Record<string, FileDataRecord>> = {};

    if (result.dataHandles && result.dataHandles.length > 0) {
      for (const handle of result.dataHandles) {
        const artifactRef = {
          dataId: handle.dataId,
          name: handle.name,
          version: handle.version,
          tags: handle.tags,
          ...(handle.sha256 !== undefined ? { sha256: handle.sha256 } : {}),
        };
        output.addDataArtifact(artifactRef);
        savedArtifacts.push(artifactRef);

        const dataPath = unifiedDataRepo.getPath(
          modelType,
          evaluatedDefinition.id,
          handle.name,
          handle.version,
        );
        runLogger.debug("Data saved to {path}", { path: dataPath });

        if (handle.kind === "resource") {
          if (!resources[handle.specName]) {
            resources[handle.specName] = {};
          }
          // in a typed run the record keeps its stored references and tag and
          // no vault is read; the typed evaluator adapts it, so a tagged field
          // is a Secret loaded at delivery
          resources[handle.specName][handle.name] = await fromResourceHandle(
            handle,
            modelType,
            evaluatedDefinition.id,
            evaluatedDefinition.name,
            unifiedDataRepo,
          );
        } else if (handle.kind === "file") {
          const fileRecord = await fromFileHandle(
            handle,
            modelType,
            evaluatedDefinition.id,
            unifiedDataRepo,
          );
          if (fileRecord) {
            if (!files[handle.specName]) files[handle.specName] = {};
            files[handle.specName][handle.name] = fileRecord;
          }
        }
      }
    }

    output.markSucceeded();
    await outputRepo.save(modelType, task.methodName, output);

    runLogger.with({ summary: true }).debug(
      "Method {method} completed on {model}",
      { method: task.methodName, model: originalDefinition.name },
    );

    if (ctx.reportFilterOptions) {
      const reportVarySuffix = ctx.forEachVariable?.value !== undefined
        ? coerceToSuffix(
          ctx.sensitiveValues.withPlaceholdersDeep(ctx.forEachVariable.value),
        )
        : undefined;

      const reportArtifacts = await this.reportRunner.runFor({
        status: "succeeded",
        dataHandles: result.dataHandles ?? [],
        modelType,
        modelDef,
        evaluatedDefinition,
        originalDefinition,
        methodName: task.methodName,
        provenance: output.provenance,
        reportGlobalArgs,
        reportMethodArgs,
        reportFilterOptions: ctx.reportFilterOptions,
        reportVarySuffix,
        repoDir: ctx.repoDir,
        swampSha: ctx.swampSha,
        runLogger,
        unifiedDataRepo,
        definitionRepository: definitionRepo,
        emitEvent: ctx.emitEvent,
        jobName: ctx.jobName,
        stepName: ctx.stepName,
      });
      for (const artifact of reportArtifacts) {
        output.addDataArtifact(artifact);
        savedArtifacts.push(artifact);
      }
    }

    return {
      type: "model_method",
      model: task.modelIdOrName ?? task.modelName ?? "",
      method: task.methodName,
      resources,
      files,
      dataArtifacts: savedArtifacts,
      dataHandles: result.dataHandles ?? [],
    };
  }

  private async handleMethodFailure(args: {
    task: {
      modelIdOrName?: string;
      modelType?: string;
      modelName?: string;
      methodName: string;
      inputs?: Record<string, unknown>;
    };
    ctx: StepExecutionContext;
    outputRepo: OutputRepository;
    unifiedDataRepo: UnifiedDataRepository;
    definitionRepo: DefinitionRepository;
    modelType: ModelType;
    modelDef: ModelDefinition;
    originalDefinition: Definition;
    evaluatedDefinition: Definition;
    runLogger: ReturnType<typeof getRunLogger>;
    reportGlobalArgs: Record<string, unknown>;
    reportMethodArgs: Record<string, unknown>;
    error: unknown;
    aborted: boolean;
    cancelCause?: string;
    output: ModelOutput;
    savedArtifacts: Array<{
      dataId: string;
      name: string;
      version: number;
      tags: Record<string, string>;
    }>;
  }): Promise<void> {
    const {
      task,
      ctx,
      outputRepo,
      unifiedDataRepo,
      definitionRepo,
      modelType,
      modelDef,
      originalDefinition,
      evaluatedDefinition,
      runLogger,
      reportGlobalArgs,
      reportMethodArgs,
      error,
      aborted,
      cancelCause: cause,
      output,
      savedArtifacts,
    } = args;

    // recover handles the model wrote before throwing (e.g. verdict=FAIL); the
    // execution service attaches them to the error
    const errorHandles = recoveredDataHandles(error);
    if (errorHandles.length > 0) {
      for (const handle of errorHandles) {
        const artifactRef = {
          dataId: handle.dataId,
          name: handle.name,
          version: handle.version,
          tags: handle.tags,
          ...(handle.sha256 !== undefined ? { sha256: handle.sha256 } : {}),
        };
        output.addDataArtifact(artifactRef);
        savedArtifacts.push(artifactRef);
      }
    }

    // the record, failed-step report and step error carry the message and stack
    // through the redactor, so a method echoing a sensitive argument in its
    // error leaks it into none of them
    const failure = executionErrorFrom(error, ctx.secretRedactor);
    const errorMessage = failure.message;
    if (aborted) {
      output.markCancelled(cause ?? "aborted");
    } else {
      output.markFailed(failure);
    }
    await outputRepo.save(modelType, task.methodName, output);

    runLogger.debug("Method {method} failed: {error}", {
      method: task.methodName,
      model: originalDefinition.name,
      error: errorMessage,
    });

    // run the method-summary report on failure too so consumers see structured
    // errors; the runner swallows report errors so they never mask the
    // original, and returned artifacts are recorded on the step
    if (ctx.reportFilterOptions) {
      const reportVarySuffix = ctx.forEachVariable?.value !== undefined
        ? coerceToSuffix(
          ctx.sensitiveValues.withPlaceholdersDeep(ctx.forEachVariable.value),
        )
        : undefined;

      const reportArtifacts = await this.reportRunner.runFor({
        status: "failed",
        errorMessage,
        dataHandles: errorHandles,
        modelType,
        modelDef,
        evaluatedDefinition,
        originalDefinition,
        methodName: task.methodName,
        provenance: output.provenance,
        reportGlobalArgs,
        reportMethodArgs,
        reportFilterOptions: ctx.reportFilterOptions,
        reportVarySuffix,
        repoDir: ctx.repoDir,
        swampSha: ctx.swampSha,
        runLogger,
        unifiedDataRepo,
        definitionRepository: definitionRepo,
        emitEvent: ctx.emitEvent,
        jobName: ctx.jobName,
        stepName: ctx.stepName,
      });
      for (const artifact of reportArtifacts) {
        output.addDataArtifact(artifact);
        savedArtifacts.push(artifact);
      }
    }

    // Attach saved artifacts to the error so the outer step loop can
    // record them on the StepRun. A thrown primitive cannot carry them, and
    // assigning to one would replace the real error with a TypeError.
    if (
      savedArtifacts.length > 0 && typeof error === "object" && error !== null
    ) {
      (error as Record<string, unknown>).dataArtifacts = savedArtifacts;
    }
  }
}

export type { WorkflowExecutionEvent } from "./execution_events.ts";
export type { RecoveryAssessment } from "./recovery_assessment.ts";
import type {
  WaitKeyHolder,
  WorkflowExecutionEvent,
} from "./execution_events.ts";
import {
  assessRecoveryForRun,
  findInterruptedRun,
  type RecoveryAssessment,
} from "./recovery_assessment.ts";

export interface FanOutLaneContext {
  readonly worker: string;
}

interface StepOptions {
  /** a fan-out lane's step: pinned to the worker, reading only its lane's steps */
  lane?: FanOutLaneContext & {
    readonly stepOf: (authored: string) => string;
  };
  /**
   * Expressions written in the workflow source. Threaded to every pass that
   * runs after CEL substitution so data content spliced in by evaluation is
   * never evaluated as if the author had written it.
   */
  authoredExpressions: ReadonlySet<string>;
  authoredWorkflow?: Workflow;
  lastEvaluated?: boolean;
  workflowNestingDepth?: number;
  ancestorWorkflowIds?: Set<string>;
  /**
   * The serve instance driving the run, handed to nested runs so a child is
   * owned as its parent is.
   */
  instanceId?: string;
  workflowTags?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  secretRedactor?: SecretRedactor;
  sensitiveValues: RunSensitiveValues;
  sanitizedTasks?: SanitizedTaskOverlay;
  stepProvenance?: StepProvenanceOverlay;
  workflowProvenance?: ProvenanceMap;
  signal?: AbortSignal;
  reportFilterOptions?: ReportFilterOptions;
  swampSha?: string;
  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  skipAllChecks?: boolean;
  assertFailOnSeverity?: AssertSeverity;
  initiatedBy?: string;
  client?: string;
  /**
   * `root.key` binding paths (e.g. `inputs.token`, `self.item`) whose values
   * came from resume-time inputs. Those are audited by key only and must
   * never be copied into durable deferred bindings.
   */
  resumeDerived?: readonly string[];
  /**
   * set on step levels run in cleanup mode after the abort; a step skipped
   * there on dependsOn never ran, so it is marked settledByAbort and a resume
   * evaluates it again
   */
  cleanupStepLevel?: boolean;
  /**
   * set on job levels entered in cleanup mode after the abort; a job skipped
   * there on dependsOn is skipNotStarted, so a resume evaluates it again
   */
  cleanupJobLevel?: boolean;
  /**
   * One promise per nested workflow step of this run still in flight,
   * settled when the step's child run has ended. The run awaits them before
   * recording its own cancellation (see {@link awaitNestedRuns}).
   */
  nestedRuns?: Set<Promise<void>>;
  inFlightMethodRuns?: InFlightMethodRuns;
  stepStopGraceMs?: number;
}

/**
 * marks a job started when first pulled; a job pulled with signal already
 * aborted never starts, though a level holding one job is pulled regardless of
 * the signal
 */
async function* markStarted<T>(
  jobName: string,
  started: Set<string>,
  stream: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncGenerator<T> {
  if (signal?.aborted) return;
  started.add(jobName);
  yield* stream;
}

export class WorkflowExecutionService {
  private readonly sortService = new TopologicalSortService();
  private readonly executor: StepExecutor;
  private readonly definitionRepo: YamlDefinitionRepository;
  private readonly evaluatedDefRepo: YamlEvaluatedDefinitionRepository;
  private readonly evaluatedWorkflowRepo: YamlEvaluatedWorkflowRepository;
  private readonly modelResolver: ModelResolver;
  private readonly dataRepo: UnifiedDataRepository;
  private readonly dataBaseDir?: string;
  private readonly catalogStore: CatalogStore;
  private readonly workflowReportRunner = new WorkflowReportRunner();
  private readonly expressionEvaluator: ExpressionEvaluationService;

  workflowGateService?:
    import("../models/workflow_gate_service.ts").WorkflowGateService;

  runClaims: WorkflowRunClaims = unclaimedRuns;

  /**
   * defaults to unsupported, so a caller that wires no store refuses a wait
   * instead of opening one nothing can signal
   */
  signalWaits: SignalWaitSupport = SIGNAL_WAITS_NOT_CONFIGURED;

  runCheckpointer: RunCheckpointer = NO_RUN_CHECKPOINTS;
  /**
   * runs a step start could not be committed for: no further step starts;
   * shared with nested runs' services, so a stopped child stops its parent
   */
  stoppedRuns = new Set<string>();

  /**
   * stops this executor saving a run another owner has taken over, such as when
   * serve shutdown marks an aborted run interrupted; defaults to never closing
   */
  runWriteFence: RunWriteFence = OPEN_RUN_WRITE_FENCE;

  /** step events queue behind the run loop's saves; one landed save holds them all */
  readonly #runSaveHorizon = new RunSaveHorizon();

  /**
   * the continuation claims a resume of a suspended run takes; unset where the
   * datastore has no store every host reads directly, so a resume there takes
   * none
   */
  continuationClaims?: ContinuationClaims;

  /**
   * checks this host's record of a run against the datastore's for a resume
   * with requireCurrentRecord; unset where every host reads the same record or
   * the datastore cannot be read without replacing the local copy
   */
  runRecordCurrency?: RunRecordCurrency;

  /**
   * The runs this service created. A step of one cannot have registered a
   * wait before, so opening its wait skips the search for one to take over.
   */
  private readonly startedRunIds = new Set<string>();

  /**
   * Whether a process on this host is alive, for refusing a resume while
   * the run's owner still runs the level it suspended in. Without it, or
   * without a run tracker, that resume is not refused.
   */
  ownerLiveness?: OwnerLiveness;

  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly runRepo: WorkflowRunRepository,
    private readonly repoDir: string,
    executor: StepExecutor | undefined,
    dataBaseDir: string | undefined,
    catalogStore: CatalogStore,
    private readonly directTypeResolver?: DirectTypeResolver,
    private readonly markDirty?: MarkDirtyHook,
    private readonly namespace: Namespace = SOLO_NAMESPACE,
    stepLockHook?: StepLockHook,
    private readonly runTracker?: RunTrackerRepository,
    private readonly ephemeralRepo?: UnifiedDataRepository,
    private readonly ephemeralCatalog?: CatalogStore,
    private readonly pulledExtensionsRoot?: string,
    private readonly hydrateFile?: HydrateFileHook,
    private readonly vaultsDir?: string,
    private readonly datastoreResolver?: DatastorePathResolver,
    private readonly autoGc: boolean = false,
    private readonly fetchForeignContent?: ForeignContentFetcher,
    private readonly unreadableContent?: UnreadableContentLookup,
    private readonly defaultVaultName?: string,
    /**
     * how repositories this service builds sync a durable v2 write, per the
     * repository context's own policy; unset, every sync is a full one
     */
    private readonly durableWriteSync?: DurableWriteSync,
  ) {
    this.executor = executor ??
      new DefaultStepExecutor(
        undefined,
        directTypeResolver,
        markDirty,
        stepLockHook,
        hydrateFile,
        fetchForeignContent,
        unreadableContent,
        durableWriteSync,
      );
    this.dataBaseDir = dataBaseDir;
    this.catalogStore = catalogStore;
    // Datastore-tier subdirs resolve through the datastore path resolver,
    // as the repository factory does; without one they stay repo-local.
    const dsPath = (subdir: string): string | undefined =>
      datastoreResolver?.resolvePath(subdir);
    this.definitionRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      undefined,
      dsPath(SWAMP_SUBDIRS.autoDefinitions),
      markDirty,
    );
    this.evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(
      repoDir,
      dsPath(SWAMP_SUBDIRS.definitionsEvaluated),
      markDirty,
    );
    // Loud on an evaluated workflow the v3 read model could not materialise,
    // which only --last-evaluated reads: a run without it evaluates afresh.
    this.evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
      repoDir,
      dsPath(SWAMP_SUBDIRS.workflowsEvaluated),
      markDirty,
      unreadableContent,
    );
    const fsDataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      dataBaseDir,
      catalogStore,
      markDirty,
      hydrateFile,
      namespace,
      autoGc,
      undefined,
      fetchForeignContent,
      unreadableContent,
      resolveDurableWrites(datastoreResolver?.config()),
      durableWriteSync,
    );
    this.dataRepo = ephemeralRepo
      ? new CompositeUnifiedDataRepository(fsDataRepo, ephemeralRepo)
      : fsDataRepo;
    const persistentQueryService = new DataQueryService(
      catalogStore,
      fsDataRepo,
    );
    const dataQueryService: DataQueryService = ephemeralRepo && ephemeralCatalog
      ? new CompositeDataQueryService(
        catalogStore,
        fsDataRepo,
        new DataQueryService(ephemeralCatalog, ephemeralRepo),
      )
      : persistentQueryService;
    this.modelResolver = new ModelResolver(this.definitionRepo, {
      repoDir,
      vaultsDir,
      dataRepo: this.dataRepo,
      dataQueryService,
    });
    this.expressionEvaluator = new ExpressionEvaluationService(
      this.definitionRepo,
      repoDir,
    );
  }

  async *run(
    idOrName: string,
    options?: {
      /**
       * Treat `idOrName` as a workflow id the caller already resolved, and
       * look it up by id only, so the run executes the workflow the caller
       * authorized rather than one named with that id.
       */
      byId?: boolean;
      /**
       * With `byId`, the name the caller authorized: ids are not guaranteed
       * unique, so only a workflow with this name and the id is run.
       */
      expectedName?: string;
      lastEvaluated?: boolean;
      /**
       * the evaluated cache a --last-evaluated run replays, as the caller
       * loaded and superseded on; loaded here when absent, which is safe only
       * for a caller that superseded nothing
       */
      evaluatedCache?: EvaluatedWorkflowCache;
      inputs?: Record<string, unknown>;
      runtimeTags?: Record<string, string>;
      workflowNestingDepth?: number;
      ancestorWorkflowIds?: Set<string>;
      parentRunId?: string;
      parentRun?: ParentRunRef;
      /**
       * The parent run's redactor and sensitive-value record, passed to a
       * nested run so values the parent resolved stay recorded and masked.
       */
      secretRedactor?: SecretRedactor;
      sensitiveValues?: RunSensitiveValues;
      /**
       * Expressions a parent workflow authored and passed through `inputs`
       * unresolved (env, vault). Unioned with this workflow's own source.
       */
      authoredExpressions?: ReadonlySet<string>;
      deferredExpressions?: readonly DeferredExpression[];
      /**
       * where data sits in inputs, when the caller knows; otherwise derived: a
       * value equal to its default or static trigger literal is authored,
       * anything else is data
       */
      inputsProvenance?: ProvenanceMap;
      signal?: AbortSignal;
      reportFilterOptions?: ReportFilterOptions;
      swampSha?: string;
      skipCheckNames?: string[];
      skipCheckLabels?: string[];
      skipAllChecks?: boolean;
      assertFailOnSeverity?: AssertSeverity;
      initiatedBy?: string;
      client?: string;
      startKey?: RunStartKeyData;
      /** an id the caller handed out before the run existed */
      runId?: string;
      instanceId?: string;
      triggerSource?: string;
      references?: Record<string, string>;
      stepStopGraceMs?: number;
    },
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const runSpan = getTracer().startSpan("swamp.workflow.run", {
      attributes: { "workflow.name": idOrName },
    });
    // looked up once at the first step under the run's span so the run is held
    // to its workflow's vaults list; a failed or empty lookup is reported
    // inside the run, so no workflow runs without it
    let lookup: RunWorkflowLookup = { workflow: null };
    yield* trackWorkflowProgress(
      bindGeneratorToSpan(
        runSpan,
        runGeneratorWithVaultAccess(
          async () => {
            try {
              lookup = {
                workflow: await this.findRunWorkflow(idOrName, options),
              };
            } catch (error) {
              lookup = { error };
            }
            return workflowVaultAccess(
              "workflow" in lookup ? lookup.workflow ?? undefined : undefined,
            );
          },
          () => this.runInSpan(runSpan, idOrName, lookup, options),
        ),
      ),
      /^0+$/.test(runSpan.spanContext().traceId)
        ? undefined
        : runSpan.spanContext().traceId,
    );
  }

  private reservedTagLookups(): ReservedTagLookups {
    return {
      findDefinition: async (idOrName) => {
        const found = await findDefinitionByIdOrName(
          this.definitionRepo,
          idOrName,
        );
        return found && {
          name: found.definition.name,
          tags: found.definition.tags,
        };
      },
      findWorkflow: (idOrName) => this.lookupWorkflow(idOrName),
    };
  }

  private async findRunWorkflow(
    idOrName: string,
    options?: { byId?: boolean; expectedName?: string },
  ): Promise<Workflow | null> {
    return options?.byId
      ? await findWorkflowById(
        this.workflowRepo,
        idOrName,
        options.expectedName,
      )
      : await this.lookupWorkflow(idOrName);
  }

  private async *runInSpan(
    runSpan: Span,
    idOrName: string,
    lookup: RunWorkflowLookup,
    options?: Parameters<WorkflowExecutionService["run"]>[1],
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const tracer = getTracer();

    let workflowRun: WorkflowRun | undefined;
    let runStartReported = false;
    // The evaluated workflow the walk settles against, set with workflowRun
    // so a cancel from the catch below settles the same way.
    let settleWorkflow: Workflow | undefined;
    let workflowAffinityKey: string | undefined;
    let workflowLogHandle: string | undefined;
    let wfHeartbeatInterval: ReturnType<typeof setInterval> | undefined;
    const nestedRuns = new Set<Promise<void>>();
    const inFlightMethodRuns = new InFlightMethodRuns(options?.signal);
    try {
      const wfSetupSpan = tracer.startSpan("swamp.workflow.setup");
      let workflow: Workflow;
      let expressionContext: ExpressionContext | undefined;
      let authoredExpressions: ReadonlySet<string> = new Set();
      let inheritedExpressions: ReadonlySet<string> =
        options?.authoredExpressions ?? new Set();
      let authoredWorkflow: Workflow | undefined;
      let deferredExpressions = options?.deferredExpressions ?? [];
      let run: WorkflowRun;
      let workflowLogPath: string;
      let evaluatedWorkflowFingerprint: string | undefined;
      let definitionFingerprint: string | undefined;
      let sanitizedTasks: SanitizedTaskOverlay | undefined;
      let stepProvenance = StepProvenanceOverlay.authored();
      let workflowProvenance = ProvenanceMap.authored();
      let persistedWorkflow: PersistedEvaluatedWorkflow | undefined;
      // a run replaying the evaluated cache adds the inputs the cache was
      // evaluated with, which its steps ran with: what a resume compares an
      // override against
      let runInputs = options?.inputs;
      const secretRedactor = options?.secretRedactor ?? new SecretRedactor();
      const sensitiveValues = options?.sensitiveValues ??
        new RunSensitiveValues(secretRedactor);

      try {
        // The workflow run() looked up, whose vaults list this run is held
        // to; a failed lookup is reported here, as part of the run.
        if ("error" in lookup) throw lookup.error;
        const found = lookup.workflow;
        if (!found) {
          throw new Error(`Workflow not found: ${idOrName}`);
        }
        workflow = found;
        refuseFanOutRun(found, getWorkerPoolReader() !== null);
        // Refused before anything runs: a wait opened where its records
        // cannot be shared would accept a signal nothing ever applies.
        if (holdsSignalWait(found)) await this.openSignalWaits(found.name);
        // refused before any step runs, so a reserved tag a later step supplies
        // cannot fail the run after earlier steps' side effects
        const reservedTag = await reservedWorkflowRunTag(
          found,
          options?.runtimeTags,
          this.reservedTagLookups(),
        );
        if (reservedTag) throw wordedError(reservedTag);

        // collected from the workflow as loaded from disk, not the evaluation:
        // --last-evaluated swaps in a cached workflow already spliced with
        // data; the cache's persisted set is unioned in below
        authoredExpressions = collectWorkflowAuthoredExpressions(
          found,
          new Set(options?.authoredExpressions),
        );
        // in --last-evaluated mode authored text is looked up in the current
        // source; only the template-syntax lint reads it, so an edited source
        // changes that report, never what is evaluated or trusted
        authoredWorkflow = found;

        if (options?.lastEvaluated) {
          const lastEvaluated = options.evaluatedCache ??
            await this.evaluatedWorkflowRepo
              .findByNameWithProvenance(workflow.name);
          if (!lastEvaluated) {
            throw new UserError(
              `No previously evaluated workflow found for "${workflow.name}".\n\n` +
                `Evaluate the workflow first to generate evaluated data:\n` +
                `  swamp workflow evaluate ${workflow.name}`,
            );
          }
          if (mayHoldPlaintextSensitiveValues(lastEvaluated)) {
            throw new UserError(
              `The evaluated workflow cached for "${workflow.name}" was written by an older swamp and may hold sensitive values in plaintext, so it is not replayed. ` +
                `Run the workflow without --last-evaluated to evaluate it again; that rewrites the cache.`,
            );
          }
          // a newer swamp may have written a sensitive value in a form this one
          // does not recognise
          if (isNewerSensitiveFormat(lastEvaluated)) {
            throw new UserError(
              `The evaluated workflow cached for "${workflow.name}" was written by a newer swamp in a format this one cannot read safely, so it is not replayed. ` +
                `Run the workflow without --last-evaluated to evaluate it again; that rewrites the cache. Or upgrade swamp.`,
            );
          }
          if (
            lastEvaluated.provenance === "unreadable" ||
            lastEvaluated.persistedProvenance === "unreadable"
          ) {
            throw new UserError(
              `The evaluated workflow cached for "${workflow.name}" has an unreadable provenance record, so it is not replayed. ` +
                `Run the workflow without --last-evaluated to evaluate it again; that rewrites the cache.`,
            );
          }
          // cached steps run with the inputs the cache was evaluated with, so
          // the run records those and a supplied input must equal its recorded
          // value; the refusal names keys only, values may be secrets
          const replay = replayInputs(lastEvaluated, options?.inputs ?? {});
          if ("refusal" in replay) throw new UserError(replay.refusal);
          runInputs = replay.inputs;
          inheritedExpressions = lastEvaluated.inheritedExpressions ??
            new Set();
          // Restore cached references without reading the vault. Each delivery
          // loads their current values under the current grants.
          const restored = await rehydrateEvaluatedWorkflow({
            sensitiveFormat: lastEvaluated.sensitiveFormat,
            workflow: lastEvaluated.workflow,
            deferredExpressions: lastEvaluated.deferredExpressions,
            writtenReferences: lastEvaluated.writtenReferences,
            persistedProvenance: lastEvaluated.persistedProvenance,
            provenance: lastEvaluated.provenance,
          }, sensitiveValues);
          workflow = restored.workflow;
          refuseFanOutRun(workflow, getWorkerPoolReader() !== null);
          // the cached steps run, not the source's, so their reserved tags are
          // refused before any of them runs too
          const cachedReservedTag = await reservedWorkflowRunTag(
            workflow,
            options?.runtimeTags,
            this.reservedTagLookups(),
          );
          if (cachedReservedTag) throw wordedError(cachedReservedTag);
          sanitizedTasks = restored.sanitizedTasks;
          // a typed replay aligned the cache's persisted-coordinate map onto
          // the restored copy; a cache without provenance predates it and
          // replays as it always did
          const cachedProvenance = restored.provenance ??
            lastEvaluated.provenance ??
            ProvenanceMap.authored();
          workflowProvenance = cachedProvenance;
          stepProvenance = StepProvenanceOverlay.fromWorkflowMaps(
            workflow,
            cachedProvenance,
            alignProvenance(
              cachedProvenance,
              workflow.toData(),
              sanitizedTasks?.sanitizedData ?? workflow.toData(),
              sanitizedTasks
                ? sentinelStandInOf(sanitizedTasks.bag.registry)
                : undefined,
              sanitizedTasks
                ? sentinelStandInOf(sanitizedTasks.bag.registry)
                : undefined,
            ),
          );
          deferredExpressions = [
            ...deferredExpressions,
            ...restored.deferredExpressions,
          ];
          authoredExpressions = new Set([
            ...authoredExpressions,
            ...lastEvaluated.authoredExpressions,
          ]);

          expressionContext = await this.buildRunContext(
            workflow,
            sensitiveValues,
            deferredExpressions,
          );
          if (runInputs) {
            expressionContext.inputs = runInputs;
          }
          attachInputsProvenance(
            expressionContext,
            lastEvaluated.evaluatedInputsProvenance ??
              options?.inputsProvenance ??
              vouchInherited(
                workflowInputsProvenance(runInputs, found, {
                  webhook: options?.triggerSource === "webhook",
                }),
                runInputs,
                inheritedExpressions,
              ),
          );
        } else {
          // Fingerprint the definition as loaded, before evaluation resolves
          // its expressions, so recovery can compare it with the current
          // definition. The evaluated fingerprint also varies with inputs.
          definitionFingerprint = await computeWorkflowFingerprint(found);

          const buildCtxSpan = tracer.startSpan(
            "swamp.workflow.build_context",
          );
          expressionContext = await this.buildRunContext(
            workflow,
            sensitiveValues,
            deferredExpressions,
          );
          buildCtxSpan.end();

          if (options?.inputs) {
            expressionContext.inputs = options.inputs;
          }
          attachInputsProvenance(
            expressionContext,
            options?.inputsProvenance ??
              vouchInherited(
                workflowInputsProvenance(options?.inputs, found, {
                  webhook: options?.triggerSource === "webhook",
                }),
                options?.inputs,
                options?.authoredExpressions ?? new Set(),
              ),
          );

          const evaluation = await this.evaluateWorkflow(
            workflow,
            expressionContext,
            authoredExpressions,
          );
          workflow = evaluation.workflow;
          sanitizedTasks = evaluation.sanitizedTasks;
          stepProvenance = evaluation.stepProvenance;
          workflowProvenance = evaluation.provenance;
          // Written with sensitive values as the vault references they came
          // from; the fingerprint is taken over the same form, so it holds
          // nothing that could be used to guess a secret.
          persistedWorkflow = persistEvaluatedWorkflow(
            workflow,
            sanitizedTasks,
            deferredExpressions,
            sensitiveValues,
            evaluation.provenance,
          );
          await this.evaluatedWorkflowRepo.save(
            persistedWorkflow.workflow,
            // Retain raw-copy coordinates; replay aligns from the persisted map.
            evaluation.provenance,
            authoredExpressions,
            persistedWorkflow.deferredExpressions,
            persistedWorkflow.writtenReferences,
            recordableEvaluatedInputs(options?.inputs ?? {}, sensitiveValues, {
              provenance: bindingProvenanceOf(expressionContext).inputs ??
                ProvenanceMap.authored(),
              inheritedExpressions,
            }),
            persistedWorkflow.persistedProvenance,
          );
          evaluatedWorkflowFingerprint = await computeWorkflowFingerprint(
            persistedWorkflow.workflow,
          );
        }

        expressionContext.deferredExpressions = deferredExpressions;

        const mergedTags: Record<string, string> = {
          ...sensitiveValues.tagsWithPlaceholders(workflow.tags ?? {}),
          ...(options?.runtimeTags ?? {}),
        };
        run = WorkflowRun.create(
          workflow,
          mergedTags,
          options?.initiatedBy,
          options?.triggerSource,
          options?.client,
          await this.assignableRunId(workflow.id, options?.runId),
        );
        if (options?.startKey) run.recordStartKey(options.startKey);
        this.startedRunIds.add(run.id);
        // a serve run records who triggered it, so a resume is held to that
        // principal's vault access, not the resumer's
        const triggeringPrincipal = currentVaultAccess()?.triggeringPrincipal;
        if (triggeringPrincipal) {
          run.recordTriggeringPrincipal(triggeringPrincipal);
        }
        // The vaults list in force (a parent's included) is recorded, so a
        // resume can be narrowed by an edit to the workflow but never widened.
        const allowedVaults = currentVaultAccess()?.allowedVaults;
        if (allowedVaults !== undefined) {
          run.recordAllowedVaults(allowedVaults);
        }
        run.attachSensitiveValues(sensitiveValues);
        if (options?.lastEvaluated) {
          run.recordReplayedEvaluatedCache();
        }
        if (options?.parentRun) {
          run.recordParentRun(options.parentRun);
        }
        if (runInputs) {
          run.captureInputs(runInputs);
          run.captureInputsProvenance(
            bindingProvenanceOf(expressionContext).inputs ??
              ProvenanceMap.authored(),
          );
        }
        // Only what a parent passed in: the run's own source is re-collected
        // on resume, so persisting it would keep deleted expressions vouched.
        if (inheritedExpressions.size) {
          run.captureInheritedExpressions(inheritedExpressions);
        }
        run.captureDeferredExpressions(deferredExpressions);
        if (options?.references) {
          run.setReferences(options.references);
        }
        workflowRun = run;
        settleWorkflow = workflow;
        if (workflow.affinity) {
          workflowAffinityKey = run.id;
        }

        // workflowRunId is set here for backward compat; the structured
        // run namespace is populated after run.start() below so that
        // startedAt is available.
        if (expressionContext) {
          expressionContext.workflowRunId = run.id;
        }

        workflowLogPath = join(
          swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns),
          workflow.id,
          `workflow-run-${run.id}.log`,
        );
        const workflowLogBoundary = swampPath(this.repoDir);
        workflowLogHandle = await runFileSink.register(
          [],
          workflowLogPath,
          secretRedactor,
          workflowLogBoundary,
          { runId: run.id },
        );
        run.setLogFile(workflowLogPath);

        runSpan.setAttribute("workflow.id", workflow.id);
        runSpan.setAttribute("workflow.run_id", run.id);

        if (evaluatedWorkflowFingerprint) {
          await this.evaluatedWorkflowRepo.saveForRun(
            run.id,
            persistedWorkflow?.workflow ?? workflow,
            persistedWorkflow?.writtenReferences,
          );
          run.captureRunPlan(
            evaluatedWorkflowFingerprint,
            run.id,
            definitionFingerprint,
          );
        }

        run.start(Deno.pid, options?.instanceId);

        if (this.runTracker) {
          const wfActiveRun = ActiveRun.createWorkflowRun({
            id: run.id,
            workflowName: workflow.name,
            pid: Deno.pid,
            hostname: hostname(),
            initiatedBy: options?.initiatedBy,
            instanceId: options?.instanceId,
          });
          this.runTracker.register(wfActiveRun);
        }

        if (expressionContext) {
          expressionContext.run = {
            id: run.id,
            workflowId: workflow.id,
            workflowName: workflow.name,
            startedAt: run.startedAt!.toISOString(),
            tags: { ...run.tags },
            initiatedBy: run.initiatedBy,
            inputs: run.inputs,
          };
          expressionContext.steps = {};
        }
      } finally {
        wfSetupSpan.end();
      }

      // saved before started is yielded, so the event's run id always names a
      // recorded run that a client stopping at started (workflow run --detach)
      // can read at once
      await this.saveRun(workflow.id, run);

      runStartReported = true;
      yield {
        kind: "started",
        runId: run.id,
        ...(options?.parentRunId !== undefined
          ? { parentRunId: options.parentRunId }
          : {}),
        workflowName: workflow.name,
        logPath: workflowLogPath,
        jobs: workflow.jobs.map((job) => ({
          id: job.name,
          stepCount: job.steps.length,
          dependsOn: job.getDependencyNames(),
        })),
      };

      if (this.runTracker) {
        const tracker = this.runTracker;
        const runId = run.id;
        wfHeartbeatInterval = setInterval(() => {
          try {
            tracker.heartbeat(runId);
          } catch {
            // Heartbeat failure is non-fatal
          }
        }, 30_000);
      }

      const stepOpts: StepOptions = {
        authoredExpressions,
        authoredWorkflow,
        lastEvaluated: options?.lastEvaluated,
        workflowNestingDepth: options?.workflowNestingDepth,
        ancestorWorkflowIds: options?.ancestorWorkflowIds,
        instanceId: options?.instanceId,
        workflowTags: workflow.tags,
        runtimeTags: options?.runtimeTags,
        initiatedBy: options?.initiatedBy,
        client: options?.client,
        secretRedactor,
        sensitiveValues,
        sanitizedTasks,
        stepProvenance,
        workflowProvenance,
        signal: options?.signal,
        nestedRuns,
        inFlightMethodRuns,
        stepStopGraceMs: options?.stepStopGraceMs,
        // Default so per-step reports run even when the caller doesn't
        // thread CLI report flags — absent filter means "no filtering".
        reportFilterOptions: options?.reportFilterOptions ?? {},
        swampSha: options?.swampSha,
        skipCheckNames: options?.skipCheckNames,
        skipCheckLabels: options?.skipCheckLabels,
        skipAllChecks: options?.skipAllChecks,
        assertFailOnSeverity: options?.assertFailOnSeverity,
      };

      const jobNodes: GraphNode[] = workflow.jobs.map((job) => ({
        name: job.name,
        weight: job.weight,
        dependencies: job.getDependencyNames(),
      }));

      const sortedJobs = this.sortService.sort(jobNodes);

      const jobConcurrency = resolveJobConcurrency(workflow);

      const modelInfoByStep = new Map<
        string,
        {
          modelName: string;
          modelType: string;
          modelId: string;
          methodName: string;
        }
      >();
      const stepStatuses = new Map<
        string,
        "succeeded" | "failed" | "skipped"
      >();
      const dataHandlesByStep = new Map<
        string,
        import("../models/model.ts").DataHandle[]
      >();

      let anyJobFailed = false;
      let afterAbort = false;
      const startedJobs = new Set<string>();
      for (const level of sortedJobs.levels) {
        const entered = this.enterJobLevel(
          workflow,
          run,
          level,
          startedJobs,
          anyJobFailed,
          afterAbort,
          options?.signal,
          stepOpts,
          expressionContext,
        );
        const { levelSignal, abortedBeforeLevel } = entered;
        afterAbort = entered.afterAbort;

        const jobStreams = level.map((jobName) => {
          const jobStepOpts = entered.jobStepOpts(jobName);
          return markStarted(
            jobName,
            startedJobs,
            this.runJob(
              workflow,
              run,
              jobName,
              expressionContext,
              jobStepOpts,
            ),
            jobStepOpts.signal,
          );
        });
        for await (
          const event of mergeWithConcurrency(
            jobStreams,
            jobConcurrency,
            levelSignal,
            // Each started job runs on to its own cleanup and completion, as
            // a job alone in its level does.
            { finishStartedOnAbort: true },
          )
        ) {
          if (event.kind === "model_resolved") {
            const key = `${event.jobId}:${event.stepId}`;
            modelInfoByStep.set(key, {
              modelName: event.modelName,
              modelType: event.modelType,
              modelId: event.modelId,
              methodName: event.methodName,
            });
          } else if (event.kind === "step_started") {
            // Saved so a run whose owner is killed mid-step still shows the
            // step started: `workflow cancel` settles it from this record,
            // and interrupting the run marks it unknown rather than pending.
            await this.saveRunForEvent(workflow.id, run, event);
          } else if (event.kind === "step_completed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "succeeded");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRunForEvent(workflow.id, run, event);
          } else if (event.kind === "step_failed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "failed");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRunForEvent(workflow.id, run, event);
          } else if (event.kind === "step_skipped") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "skipped");
            await this.saveRunForEvent(workflow.id, run, event);
          }
          if (event.kind === "job_completed" && event.status === "failed") {
            anyJobFailed = true;
          }
          yield event;
        }

        anyJobFailed = this.finishJobLevel(
          workflow,
          run,
          level,
          startedJobs,
          anyJobFailed,
          options?.signal,
          levelSignal,
          abortedBeforeLevel,
        );

        await this.saveRun(workflow.id, run);

        if (run.status === "suspended") {
          break;
        }
      }

      currentRunProgress()?.enter("finalizing");
      // Handle suspension: all parallel siblings at the current level have
      // drained, so the persisted run is a consistent checkpoint.
      if (run.status === "suspended") {
        if (wfHeartbeatInterval) clearInterval(wfHeartbeatInterval);
        if (this.runTracker) this.runTracker.complete(run.id, "suspended");
        const suspendedEvent = suspendedEventFor(run, workflow);
        if (suspendedEvent) {
          yield await this.withNestedSignalWaits(
            suspendedEvent,
            run,
            options?.parentRunId,
          );
        }
        runSpan.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      if (options?.signal?.aborted) {
        if (wfHeartbeatInterval) clearInterval(wfHeartbeatInterval);
        await awaitInFlightWork(
          nestedRuns,
          inFlightMethodRuns,
          options.stepStopGraceMs,
        );
        if (this.runTracker) this.runTracker.complete(run.id, "cancelled");
        cancelAndSettle(run, workflow, abortReason(options.signal));
        await this.saveRun(workflow.id, run);
        yield { kind: "cancelled" as const, run };
        runSpan.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      if (wfHeartbeatInterval) clearInterval(wfHeartbeatInterval);
      const wfTeardownSpan = tracer.startSpan("swamp.workflow.teardown");
      try {
        run.complete();
        // After complete(), not before: the aggregate folds the job outcomes
        // into its status there, so a run whose steps failed reaches this line
        // as failed.
        if (this.runTracker) {
          this.runTracker.complete(run.id, trackerStatusForRun(run.status));
        }

        // Execute workflow-scope reports before the completed event so the
        // run aggregate carries the workflow-scope dataArtifacts produced by
        // those reports — required for `swamp data get --workflow` and
        // `swamp data list --workflow` to surface them.
        const wfReportsSpan = tracer.startSpan("swamp.workflow.reports");
        try {
          yield* this.runWorkflowReports(
            workflow,
            run,
            modelInfoByStep,
            stepStatuses,
            dataHandlesByStep,
            options?.reportFilterOptions,
          );
        } finally {
          wfReportsSpan.end();
        }

        yield { kind: "completed", run };
        const wfSaveSpan = tracer.startSpan("swamp.workflow.save_run");
        try {
          await this.saveRun(workflow.id, run);
        } finally {
          wfSaveSpan.end();
        }
      } finally {
        wfTeardownSpan.end();
      }
      runSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      if (wfHeartbeatInterval) clearInterval(wfHeartbeatInterval);
      if (
        workflowRun && currentRunProgress()?.identity.runId === workflowRun.id
      ) {
        currentRunProgress()?.enter("finalizing");
      }
      if (error instanceof WorkflowSuspendedError && workflowRun) {
        if (this.runTracker) {
          this.runTracker.complete(workflowRun.id, "suspended");
        }
        yield await this.withNestedSignalWaits(
          {
            kind: "suspended" as const,
            run: workflowRun,
            jobId: error.jobId,
            stepId: error.stepId,
            prompt: error.prompt,
            timeout: error.timeout,
          },
          workflowRun,
          options?.parentRunId,
        );
        runSpan.setStatus({ code: SpanStatusCode.OK });
        return;
      }
      // the caller was told nothing started, so a retry of its key starts afresh
      if (!runStartReported) workflowRun?.clearStartKey();
      if (
        workflowRun && options?.signal?.aborted
      ) {
        await awaitInFlightWork(
          nestedRuns,
          inFlightMethodRuns,
          options.stepStopGraceMs,
        );
        if (this.runTracker) {
          this.runTracker.complete(workflowRun.id, "cancelled");
        }
        cancelAndSettle(
          workflowRun,
          settleWorkflow,
          abortReason(options.signal),
        );
        await this.saveRun(
          createWorkflowId(workflowRun.workflowId),
          workflowRun,
        );
        yield { kind: "cancelled" as const, run: workflowRun };
        runSpan.setStatus({ code: SpanStatusCode.OK });
        return;
      }
      if (workflowRun) {
        if (this.runTracker) {
          this.runTracker.complete(workflowRun.id, "failed");
        }
        settleStoppedJobs(error, workflowRun);
        workflowRun.complete();
        await this.saveRun(
          createWorkflowId(workflowRun.workflowId),
          workflowRun,
        );
        yield { kind: "completed" as const, run: workflowRun };
      }
      runSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw workflowRun === undefined
        ? error
        : this.#stoppedRunError(error, workflowRun);
    } finally {
      if (workflowAffinityKey) {
        getRemoteStepDispatcher()?.releaseAffinity(workflowAffinityKey);
      }
      // release in finally: early abandonment via generator.return() (e.g. a
      // consumer breaking on socket close) skips cleanup placed after a yield
      runFileSink.unregister(workflowLogHandle);
      inFlightMethodRuns.dispose();
      runSpan.end();
    }
  }

  // an unusable id falls back to a fresh one rather than failing the run
  private async assignableRunId(
    workflowId: WorkflowId,
    requested: string | undefined,
  ): Promise<string | undefined> {
    if (requested === undefined) return undefined;
    const logger = getSwampLogger(["workflow", "run"]);
    if (!RUN_ID_PATTERN.test(requested)) {
      logger.warn`Ignoring assigned run id ${requested}: not a UUID`;
      return undefined;
    }
    let existing: WorkflowRun | null;
    try {
      existing = await this.runRepo.findById(
        workflowId,
        createWorkflowRunId(requested),
      );
    } catch (error) {
      logger.warn`Could not check run ${requested}; starting under a new id: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return undefined;
    }
    if (existing) {
      logger.warn`Run ${requested} already exists; starting under a new id`;
      return undefined;
    }
    return requested;
  }

  async execute(
    idOrName: string,
    options?: {
      lastEvaluated?: boolean;
      inputs?: Record<string, unknown>;
      runtimeTags?: Record<string, string>;
      workflowNestingDepth?: number;
      ancestorWorkflowIds?: Set<string>;
    },
  ): Promise<WorkflowRun> {
    let result: WorkflowRun | undefined;
    for await (const event of this.run(idOrName, options)) {
      if (event.kind === "completed") result = event.run;
      if (event.kind === "suspended") result = event.run;
    }
    if (!result) throw new Error("Workflow run did not complete");
    return result;
  }

  private async takeOverRun(
    workflow: Workflow,
    workflowIdOrName: string,
    runId: string,
    sensitiveValues: RunSensitiveValues,
    options?: {
      inputs?: Record<string, unknown>;
      fromStep?: string;
      fromJob?: string;
      suspendedOnly?: boolean;
      instanceId?: string;
      continuation?: ContinuationMode;
      requireCurrentRecord?: boolean;
    },
  ): Promise<{
    existingRun: WorkflowRun;
    snapshot: WorkflowRunData;
    resumeInputs: Record<string, unknown>;
    claim: ContinuationClaim | undefined;
    resetJobs: ReadonlySet<string>;
    /**
     * The expression-named jobs paired with stored jobs, from the run as
     * taken over, before resume-time inputs are merged into it.
     */
    jobPairs: ReadonlyMap<string, string> | undefined;
  }> {
    const loadedRun = await this.runRepo.findById(
      workflow.id,
      createWorkflowRunId(runId),
    );
    if (!loadedRun) {
      throw new UserError(`Workflow run not found: ${runId}`);
    }
    // a nested run nothing waits on any more is cancelled, not continued, under
    // the run's claim; a run whose owner still saves it is left to the refusal
    // below, as a cancel now would be saved over
    const ownerStillSaves = this.runTracker !== undefined &&
      this.ownerLiveness !== undefined &&
      suspendedRunOwnerStillRuns(
        loadedRun,
        this.runTracker,
        this.ownerLiveness,
      );
    if (!ownerStillSaves) {
      const orphaned = await settleOrphanedNestedRun(
        {
          runRepo: this.runRepo,
          workflowRepo: this.workflowRepo,
          signalWaits: this.signalWaits,
          runTracker: this.runTracker,
          runRecordCurrency: this.runRecordCurrency,
          findEvaluatedWorkflow: (id) =>
            this.evaluatedWorkflowRepo.findByRunId(id),
        },
        loadedRun,
        workflow,
      );
      if (orphaned) throw new OrphanedNestedRunError(orphaned);
    }
    // Derived from the record as stored, before a signal is applied to it:
    // every host holding this record derives the same key.
    const suspensionKey = loadedRun.status === "suspended"
      ? await suspensionKeyOf(loadedRun)
      : undefined;
    // The stored run holds vault references where it held sensitive values;
    // only the entries swamp listed are restored, from stored state alone and
    // before any caller-supplied resume input is merged in.
    const existingRun = await this.rehydrateRun(loadedRun, sensitiveValues);

    const fromStep = options?.fromStep;

    // Every check runs before the first mutation, so a refusal persists
    // nothing and invokes no method.
    if (options?.fromJob !== undefined && !fromStep) {
      throw new UserError(FROM_JOB_WITHOUT_FROM);
    }
    let reset: ResumeReset | undefined;
    if (fromStep) {
      if (existingRun.status !== "failed") {
        throw new UserError(
          `--from requires a failed run, but run ${runId} has status "${existingRun.status}"`,
        );
      }
      reset = planFailedRunResume(workflow, existingRun, {
        step: fromStep,
        job: options?.fromJob,
      });
    } else if (
      existingRun.status === "failed" && !options?.suspendedOnly
    ) {
      reset = planFailedRunResume(workflow, existingRun);
    } else if (existingRun.status !== "suspended") {
      const accepted = options?.suspendedOnly
        ? "is not suspended"
        : "is not suspended or failed";
      throw new RunNotSuspendedError(
        `Run ${runId} ${accepted} (status: ${existingRun.status}).` +
          nextActionForStatus(existingRun.status, workflow.name, runId),
      );
    } else {
      checkSuspendedRunResume(workflow, existingRun);
      const waiting = existingRun.findWaitingApprovalStep();
      if (waiting) {
        throw new UserError(
          `Step "${waiting.stepName}" in job "${waiting.jobName}" is still awaiting approval. ` +
            `Run "swamp workflow approve ${workflowIdOrName} ${waiting.stepName}" first.`,
        );
      }
      // The owner saves the record as suspended before the level it
      // suspended in has drained, and keeps saving it without the claim
      // until then. Taking the run over now would be saved over.
      if (
        this.runTracker && this.ownerLiveness &&
        suspendedRunOwnerStillRuns(
          existingRun,
          this.runTracker,
          this.ownerLiveness,
        )
      ) {
        throw new UserError(
          `Run ${runId} has not finished suspending: the process that started it is still running other steps and still saves the run. ` +
            `Wait for it to finish, then check the run before resuming (swamp workflow history get ${runId}): ` +
            `an approval or rejection made while it was still running may not have been kept and must be given again.`,
        );
      }
      if (existingRun.findSignalWaits().length > 0) {
        // The only place a wait changes the run record: each accepted
        // signal is applied to its step, under the claim.
        const openWait = await applyAcceptedSignals(
          this.signalWaitsForSettling(),
          existingRun,
          new Date(),
        );
        if (openWait && !this.signalWaits.supported) {
          throw new UserError(
            `Step "${openWait.stepName}" in job "${openWait.jobName}" is still waiting for a signal, and this datastore cannot deliver one: ${this.signalWaits.reason}. ` +
              `The wait ends at its deadline, after which a resume fails the step; or cancel the run.`,
          );
        }
        if (openWait) throw new UserError(openSignalWaitMessage(openWait));
      }
      await this.checkNestedWaitsSettled(existingRun);
    }

    // a value not matching its declared type would otherwise fail only once the
    // run is reset, for a forEach input leaving the job running with its
    // iterations pending
    const resumeInputs = coerceResumeInputs(
      workflow,
      existingRun,
      options?.inputs ?? {},
    );
    // a value the run has cannot change under the steps that read it
    checkResumeInputOverrides(workflow, existingRun, resumeInputs);

    // A copy of the run that is behind the datastore's shows a suspension a
    // peer has already ended. Compared under the run's claim, so a peer that
    // changes the run does so before this look or after the save below.
    if (
      options?.requireCurrentRecord && suspensionKey !== undefined &&
      this.runRecordCurrency &&
      !(await this.runRecordCurrency({
        workflowId: workflow.id,
        runId: loadedRun.id,
      }))
    ) {
      throw new RunRecordStaleError(loadedRun.id);
    }

    // the last refusal, after every other check so a refused resume leaves no
    // claim; a resume refused on an open wait changes no step, so the key stays
    // and a kept claim would hold off every later resume
    const claim = suspensionKey === undefined
      ? undefined
      : await this.claimSuspension(
        loadedRun.id,
        suspensionKey,
        options?.continuation ?? { kind: "manual" },
      );

    // Everything from the claim to the save: a throw anywhere in it leaves
    // the stored run suspended and nothing consumed, so the claim goes back.
    let snapshot: WorkflowRunData;
    try {
      // taken before any mutation so a throw after the save and before
      // execution restores the run to this state; from the run as stored, so a
      // restore writes references back, never values
      snapshot = loadedRun.toData();

      // Work the run's abort left unfinished runs now, as it would have had the
      // abort left it pending. Reopened per record before a failed run's reset
      // set is applied.
      existingRun.reopenAbortedWork();
      // This process now drives the run. Recorded before the save below, so
      // cancel sees the live process from the start.
      const owner = { pid: Deno.pid, instanceId: options?.instanceId };
      if (reset) {
        // A reset clears the wait a step held. Closed first, so a signal for
        // the old attempt is answered closed and its wait is not listed.
        if (this.signalWaits.supported) {
          await closeRunWaits(this.signalWaits.store, existingRun, new Date());
        }
        existingRun.resetForResumeFrom(reset.steps, reset.tracked);
        existingRun.resumeFromFailed(owner);
      } else {
        existingRun.resumeFromSuspended(owner);
      }

      // record resume-input key names for audit before the save so the trail
      // persists; a secret is passed as a vault key name, never as an input
      // value
      if (Object.keys(resumeInputs).length > 0) {
        existingRun.recordResumeInputs(Object.keys(resumeInputs));
      }
      // The running status saved here also stops a second resume of this run
      // from starting while this one prepares.
      await this.saveRun(workflow.id, existingRun);
    } catch (error) {
      await this.releaseSuspension(claim);
      throw error;
    }
    const resetJobs = new Set(reset?.steps.map((ref) => ref.jobName) ?? []);
    const jobPairs = reset !== undefined
      ? reset.pairs
      : pairExpressionJobs(workflow, existingRun);
    return { existingRun, snapshot, resumeInputs, claim, resetJobs, jobPairs };
  }

  private async claimSuspension(
    runId: string,
    suspensionKey: string,
    mode: ContinuationMode,
  ): Promise<ContinuationClaim | undefined> {
    const claims = this.continuationClaims;
    if (!claims || (claims.usable && !(await claims.usable()))) {
      return undefined;
    }
    const acquired = await acquireContinuation(
      claims,
      { runId, suspensionKey },
      mode,
      new Date(),
    );
    if (acquired.kind === "acquired") return acquired.claim;
    throw new ContinuationHeldError(
      runId,
      acquired.claim.holder,
      acquired.liveness,
    );
  }

  private async releaseSuspension(
    claim: ContinuationClaim | undefined,
  ): Promise<void> {
    if (!claim || !this.continuationClaims) return;
    try {
      await this.continuationClaims.store.release(claim);
    } catch (error) {
      getSwampLogger(["workflow", "resume"]).warn(
        "Could not release the continuation claim of run {runId}: {error}",
        {
          runId: claim.runId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async *resume(
    workflowIdOrName: string,
    runId: string,
    options?: {
      signal?: AbortSignal;
      runtimeTags?: Record<string, string>;
      reportFilterOptions?: ReportFilterOptions;
      swampSha?: string;
      inputs?: Record<string, unknown>;
      assertFailOnSeverity?: AssertSeverity;
      fromStep?: string;
      /**
       * The job of `fromStep`, as named in the workflow YAML. Needed when the
       * step name is used in more than one job.
       */
      fromJob?: string;
      /**
       * Accept only a suspended run. Auto-resume after an approval sets it so
       * an approval can never start a retry of a failed run.
       */
      suspendedOnly?: boolean;
      /**
       * The serve instance driving this resume. Omitted for a local resume,
       * which clears any instance id the run carried.
       */
      instanceId?: string;
      /**
       * who asks for the suspension's continuation claim; a person, unless
       * serve continues the run by itself
       */
      continuation?: ContinuationMode;
      /**
       * refuse a suspended run whose record here differs from the datastore's,
       * where that can be told; set when serve continues a run by itself from a
       * copy that may be behind
       */
      requireCurrentRecord?: boolean;
      stepStopGraceMs?: number;
      /**
       * the redactor and sensitive-value record the resume runs with, as run takes
       * them; a seam for tests to hand a resume a typed registry, which restores
       * stored references as references. Production callers pass nothing
       */
      secretRedactor?: SecretRedactor;
      sensitiveValues?: RunSensitiveValues;
    },
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const workflow = await this.workflowRepo.findByName(workflowIdOrName) ??
      await this.workflowRepo.findById(createWorkflowId(workflowIdOrName));
    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }
    // Read once so a run that does not exist is refused before anything is
    // claimed, and the claim is taken on the stored run's own id.
    const located = await this.runRepo.findById(
      workflow.id,
      createWorkflowRunId(runId),
    );
    if (!located) {
      throw new UserError(`Workflow run not found: ${runId}`);
    }
    // A resume is held to the workflow's vaults list as a run is, and to the
    // list the run recorded when it started.
    yield* trackWorkflowProgress(runGeneratorWithVaultAccess(
      resumeVaultAccess(workflow, located),
      () =>
        this.resumeWorkflow(
          workflow,
          located,
          workflowIdOrName,
          runId,
          options,
        ),
    ));
  }

  private async *resumeWorkflow(
    workflow: Workflow,
    located: WorkflowRun,
    workflowIdOrName: string,
    runId: string,
    options?: Parameters<WorkflowExecutionService["resume"]>[2],
  ): AsyncGenerator<WorkflowExecutionEvent> {
    // a fan-out job the run has yet to reach plans on resume, so it needs a pool
    refuseFanOutRun(workflow, getWorkerPoolReader() !== null);
    // A resume can reach a wait for the first time. The store is opened
    // before anything runs, as for a new run, so one that turns out
    // unusable refuses here and not after earlier steps have executed.
    if (holdsSignalWait(workflow)) await this.readySignalWaits(workflow.name);
    // so is a reserved tag the remaining steps supply: refused before the run
    // is taken over, a later step's tag cannot fail the resume after earlier
    // steps' side effects
    const reservedTag = await reservedWorkflowRunTag(
      workflow,
      options?.runtimeTags,
      this.reservedTagLookups(),
    );
    if (reservedTag) throw wordedError(reservedTag);
    // Created before anything is resolved, so every sensitive value this
    // resume reads, from the stored run or afterwards, is recorded and
    // redacted from its logs.
    const secretRedactor = options?.secretRedactor ?? new SecretRedactor();
    const sensitiveValues = options?.sensitiveValues ??
      new RunSensitiveValues(secretRedactor);
    // taken over under the run's claim, released before anything executes: a
    // cancel either lands first and is seen here, or finds the run running
    // under this process
    const {
      existingRun,
      snapshot,
      resumeInputs,
      claim,
      resetJobs,
      jobPairs,
    } = await this.runClaims
      .withClaim(
        located.id,
        () =>
          this.takeOverRun(
            workflow,
            workflowIdOrName,
            runId,
            sensitiveValues,
            options,
          ),
      );
    // The tracker row follows at once: a serve boot that found the record
    // running beside a stale row would otherwise interrupt this resume.
    const handBackTrackerRow = this.handOverTrackerRow(
      existingRun,
      workflow.name,
      snapshot.status === "suspended" ? "suspended" : "failed",
      options?.instanceId,
    );
    // The heartbeat starts with the hand-over, so a slow preparation does not
    // leave the row stale. The finally at the end of this method clears it,
    // as does the hand-back of a resume that fails before execution.
    const resumeHeartbeatInterval = this.startResumeHeartbeat(existingRun.id);
    const restore = {
      workflowId: workflow.id,
      snapshot,
      claim,
      handBackTrackerRow: () => {
        if (resumeHeartbeatInterval) clearInterval(resumeHeartbeatInterval);
        handBackTrackerRow();
      },
    };

    const {
      expressionContext,
      sanitizedTasks,
      stepProvenance,
      workflowProvenance,
      authoredExpressions,
      resolvedWorkflow,
      workflowLogPath,
      workflowLogHandle,
    } = await this.restoreRunOnFailure(restore, async () => {
      const expressionContext = await this.buildRunContext(
        workflow,
        sensitiveValues,
        existingRun.deferredExpressions,
      );

      // Merge resume-time inputs over the inputs captured when the run
      // suspended. Resume overrides win on key collision; new keys are
      // additive. Set before evaluation so workflow- and step-level
      // `inputs.*` expressions resolve.
      const effectiveInputs = deepMerge(
        { ...existingRun.inputs },
        resumeInputs,
      );
      expressionContext.inputs = effectiveInputs;
      // The provenance the run recorded when it started; runs recorded
      // before it existed fall back to deriving it. Resume-time inputs come
      // from the caller and are judged like a fresh run's.
      let resumedProvenance = existingRun.inputsProvenance ??
        vouchInherited(
          workflowInputsProvenance(existingRun.inputs, workflow, {
            webhook: existingRun.triggerSource === "webhook",
          }),
          existingRun.inputs,
          new Set(existingRun.inheritedExpressions),
        );
      const resumeProvenance = workflowInputsProvenance(
        resumeInputs,
        workflow,
        {
          webhook: existingRun.triggerSource === "webhook",
        },
      );
      // Resume inputs are deep-merged over the recorded ones, so data in
      // either stays data. A key the resume replaces keeps its old ranges,
      // which are in the old value's offsets: that can only mark more of the
      // new value as data, never less.
      resumedProvenance = resumedProvenance.union(resumeProvenance);
      attachInputsProvenance(expressionContext, resumedProvenance);
      // The run records the inputs its remaining steps run with, not the ones
      // it started with. Captured only once the provenance above is derived:
      // a legacy run derives it from the stored inputs, which must not yet
      // hold the resume's values.
      existingRun.captureInputs({ ...effectiveInputs });
      existingRun.captureInputsProvenance(resumedProvenance);

      expressionContext.workflowRunId = existingRun.id;
      expressionContext.run = {
        id: existingRun.id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        startedAt: existingRun.startedAt!.toISOString(),
        tags: { ...existingRun.tags },
        initiatedBy: existingRun.initiatedBy,
        // the same set inputs.* reads: a step still to run sees one value
        // through either, so an approval showing run.inputs.X shows what the
        // step after it acts on
        inputs: existingRun.inputs,
      };
      expressionContext.steps = {};
      const stepOutputResolver = this.createStepOutputResolver();
      for (const job of existingRun.jobs) {
        for (const step of job.steps) {
          if (
            step.status === "succeeded" || step.status === "failed" ||
            step.status === "skipped" || step.status === "unknown"
          ) {
            const resolved = await stepOutputResolver.resolve(step);
            expressionContext.steps[step.stepName] = attachStepOutputSources(
              { status: step.status, outputs: resolved.outputs },
              resolved.sources,
            );
          }
        }
      }

      // The shared pass binds restored references as Secrets.
      const evaluator = new WorkflowExpressionEvaluator(
        await this.expressionEvaluator.passEvaluatorFor(
          sensitiveValuesOf(expressionContext),
          { location: workflow.name },
        ),
      );
      // collected before evaluation, as in a fresh run: afterwards spliced data
      // is indistinguishable from source; captured inputs may hold a parent's
      // unresolved expression only the persisted inherited set can vouch for
      const authoredExpressions = collectWorkflowAuthoredExpressions(
        workflow,
        new Set(existingRun.inheritedExpressions),
      );
      expressionContext.deferredExpressions = existingRun.deferredExpressions;
      const evaluated = await evaluator.evaluate(
        workflow,
        expressionContext,
        authoredExpressions,
      );
      warnForeignTaskArguments(workflow.name, evaluated.foreignTaskArguments);
      const resolvedWorkflow = evaluated.workflow;
      // an expression-named job the reset reaches must evaluate to its planned
      // stored job, and every one to a job the run has, as resume walks records
      // by evaluated name; refused before execution so the run is restored
      const mismatch = evaluatedJobMismatch(
        workflow,
        resolvedWorkflow,
        existingRun,
        resetJobs,
        jobPairs,
      );
      if (mismatch !== undefined) {
        throw new UserError(
          `${mismatch} Start a new run. See 'swamp workflow history logs ${existingRun.id}'.`,
        );
      }
      const sanitizedTasks = evaluated.sanitizedTasks;
      const stepProvenance = evaluated.stepProvenance;
      const workflowProvenance = evaluated.provenance;

      // append to keep records from earlier attempts; the path is derived again
      // as a run's start gives it, not read from the record, whose writer may
      // not be this process
      const workflowLogPath = join(
        swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns),
        workflow.id,
        `workflow-run-${existingRun.id}.log`,
      );
      const workflowLogHandle = await runFileSink.register(
        [],
        workflowLogPath,
        secretRedactor,
        swampPath(this.repoDir),
        { append: true, runId: existingRun.id },
      );
      return {
        expressionContext,
        sanitizedTasks,
        stepProvenance,
        workflowProvenance,
        authoredExpressions,
        resolvedWorkflow,
        workflowLogPath,
        workflowLogHandle,
      };
    });

    const nestedRuns = new Set<Promise<void>>();
    const inFlightMethodRuns = new InFlightMethodRuns(options?.signal);
    // the try opens right after register, before the started yield, so a client
    // abandoning after started still unwinds the finally that stops the
    // heartbeat and releases the sink
    try {
      yield {
        kind: "started",
        runId: existingRun.id,
        workflowName: resolvedWorkflow.name,
        logPath: workflowLogPath,
        jobs: resolvedWorkflow.jobs.map((job) => ({
          id: job.name,
          stepCount: job.steps.length,
          dependsOn: job.getDependencyNames(),
        })),
      };

      // A nested run resumed on its own keeps its place in the nesting, so
      // the depth limit and cycle detection hold across suspensions.
      const parentLink = existingRun.parentRun?.kind === "valid"
        ? existingRun.parentRun.ref
        : undefined;
      const stepOpts: StepOptions = {
        authoredExpressions,
        authoredWorkflow: workflow,
        workflowNestingDepth: parentLink?.nestingDepth,
        ancestorWorkflowIds: parentLink
          ? new Set(parentLink.ancestorWorkflowNames)
          : undefined,
        instanceId: options?.instanceId,
        workflowTags: resolvedWorkflow.tags,
        runtimeTags: options?.runtimeTags,
        initiatedBy: existingRun.initiatedBy,
        client: existingRun.client,
        secretRedactor,
        sensitiveValues,
        sanitizedTasks,
        stepProvenance,
        workflowProvenance,
        signal: options?.signal,
        nestedRuns,
        inFlightMethodRuns,
        stepStopGraceMs: options?.stepStopGraceMs,
        // Read as `inputs.X` and as `run.inputs.X`; both are kept out of a
        // child's persisted deferred bindings.
        resumeDerived: existingRun.resumeInputs.flatMap((key) => [
          `inputs.${key}`,
          `run.inputs.${key}`,
        ]),
        // workflow resume never receives CLI report flags — default so
        // resumed runs still execute reports instead of silently skipping.
        reportFilterOptions: options?.reportFilterOptions ?? {},
        swampSha: options?.swampSha,
        assertFailOnSeverity: options?.assertFailOnSeverity,
      };

      const jobNodes: GraphNode[] = resolvedWorkflow.jobs.map((job) => ({
        name: job.name,
        weight: job.weight,
        dependencies: job.getDependencyNames(),
      }));
      const sortedJobs = this.sortService.sort(jobNodes);
      const jobConcurrency = resolveJobConcurrency(resolvedWorkflow);

      const modelInfoByStep = new Map<
        string,
        {
          modelName: string;
          modelType: string;
          modelId: string;
          methodName: string;
        }
      >();
      const stepStatuses = new Map<
        string,
        "succeeded" | "failed" | "skipped"
      >();
      const dataHandlesByStep = new Map<
        string,
        import("../models/model.ts").DataHandle[]
      >();

      let anyJobFailed = false;
      let afterAbort = false;
      const startedJobs = new Set<string>();
      for (const level of sortedJobs.levels) {
        const entered = this.enterJobLevel(
          resolvedWorkflow,
          existingRun,
          level,
          startedJobs,
          anyJobFailed,
          afterAbort,
          options?.signal,
          stepOpts,
          expressionContext,
        );
        const { levelSignal, abortedBeforeLevel } = entered;
        afterAbort = entered.afterAbort;

        const jobStreams = level.map((jobName: string) => {
          const jobRun = existingRun.getJob(jobName);
          if (
            jobRun &&
            (jobRun.status === "succeeded" || jobRun.status === "failed" ||
              jobRun.status === "skipped" || jobRun.status === "unknown")
          ) {
            // A job that failed before this resume counts once its level is
            // reached, as its job_completed event did when it failed.
            if (jobRun.status === "failed") anyJobFailed = true;
            return (async function* () {})();
          }
          const jobStepOpts = entered.jobStepOpts(jobName);
          return markStarted(
            jobName,
            startedJobs,
            this.runJob(
              resolvedWorkflow,
              existingRun,
              jobName,
              expressionContext,
              jobStepOpts,
            ),
            jobStepOpts.signal,
          );
        });
        for await (
          const event of mergeWithConcurrency(
            jobStreams,
            jobConcurrency,
            levelSignal,
            { finishStartedOnAbort: true },
          )
        ) {
          if (event.kind === "model_resolved") {
            const key = `${event.jobId}:${event.stepId}`;
            modelInfoByStep.set(key, {
              modelName: event.modelName,
              modelType: event.modelType,
              modelId: event.modelId,
              methodName: event.methodName,
            });
          } else if (event.kind === "step_started") {
            // Saved so a run whose owner is killed mid-step still shows the
            // step started: `workflow cancel` settles it from this record,
            // and interrupting the run marks it unknown rather than pending.
            await this.saveRunForEvent(workflow.id, existingRun, event);
          } else if (event.kind === "step_completed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "succeeded");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRunForEvent(workflow.id, existingRun, event);
          } else if (event.kind === "step_failed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "failed");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRunForEvent(workflow.id, existingRun, event);
          } else if (event.kind === "step_skipped") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "skipped");
            await this.saveRunForEvent(workflow.id, existingRun, event);
          }
          if (event.kind === "job_completed" && event.status === "failed") {
            anyJobFailed = true;
          }
          yield event as WorkflowExecutionEvent;
        }

        // Settled against resolvedWorkflow, the workflow runJob ran: a job
        // whose name is written with an expression exists only under its
        // evaluated name.
        anyJobFailed = this.finishJobLevel(
          resolvedWorkflow,
          existingRun,
          level,
          startedJobs,
          anyJobFailed,
          options?.signal,
          levelSignal,
          abortedBeforeLevel,
        );

        await this.saveRun(workflow.id, existingRun);

        if (existingRun.status === "suspended") {
          break;
        }
      }

      currentRunProgress()?.enter("finalizing");
      if (existingRun.status === "suspended") {
        if (resumeHeartbeatInterval) clearInterval(resumeHeartbeatInterval);
        if (this.runTracker) {
          this.runTracker.complete(existingRun.id, "suspended");
        }
        const suspendedEvent = suspendedEventFor(
          existingRun,
          resolvedWorkflow,
        );
        if (suspendedEvent) {
          yield await this.withNestedSignalWaits(suspendedEvent, existingRun);
        }
        return;
      }

      if (options?.signal?.aborted) {
        await awaitInFlightWork(
          nestedRuns,
          inFlightMethodRuns,
          options.stepStopGraceMs,
        );
        if (this.runTracker) {
          this.runTracker.complete(existingRun.id, "cancelled");
        }
        cancelAndSettle(
          existingRun,
          resolvedWorkflow,
          abortReason(options.signal),
        );
        await this.saveRun(workflow.id, existingRun);
        yield { kind: "cancelled" as const, run: existingRun };
        return;
      }

      existingRun.complete();
      if (this.runTracker) {
        this.runTracker.complete(
          existingRun.id,
          trackerStatusForRun(existingRun.status),
        );
      }

      yield* this.runWorkflowReports(
        resolvedWorkflow,
        existingRun,
        modelInfoByStep,
        stepStatuses,
        dataHandlesByStep,
        options?.reportFilterOptions,
      );

      yield { kind: "completed", run: existingRun };
      await this.saveRun(workflow.id, existingRun);
    } catch (error) {
      if (error instanceof WorkflowSuspendedError) {
        if (this.runTracker) {
          this.runTracker.complete(existingRun.id, "suspended");
        }
        yield await this.withNestedSignalWaits(
          {
            kind: "suspended" as const,
            run: existingRun,
            jobId: error.jobId,
            stepId: error.stepId,
            prompt: error.prompt,
            timeout: error.timeout,
          },
          existingRun,
        );
        return;
      }
      if (options?.signal?.aborted) {
        await awaitInFlightWork(
          nestedRuns,
          inFlightMethodRuns,
          options.stepStopGraceMs,
        );
        if (this.runTracker) {
          this.runTracker.complete(existingRun.id, "cancelled");
        }
        cancelAndSettle(
          existingRun,
          resolvedWorkflow,
          abortReason(options.signal),
        );
        await this.saveRun(workflow.id, existingRun);
        yield { kind: "cancelled" as const, run: existingRun };
        return;
      }
      if (this.runTracker) {
        this.runTracker.complete(existingRun.id, "failed");
      }
      settleStoppedJobs(error, existingRun);
      existingRun.complete();
      await this.saveRun(workflow.id, existingRun);
      yield { kind: "completed" as const, run: existingRun };
      throw this.#stoppedRunError(error, existingRun);
    } finally {
      // stop the heartbeat and release the sink in finally: early abandonment
      // via generator.return() skips cleanup placed after a yield
      if (resumeHeartbeatInterval) clearInterval(resumeHeartbeatInterval);
      runFileSink.unregister(workflowLogHandle);
      inFlightMethodRuns.dispose();
    }
  }

  private async *runJob(
    workflow: Workflow,
    run: WorkflowRun,
    jobName: string,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const jobSpan = getTracer().startSpan("swamp.workflow.job", {
      attributes: { "job.name": jobName },
    });
    yield* bindGeneratorToSpan(
      jobSpan,
      this.runJobInSpan(
        jobSpan,
        workflow,
        run,
        jobName,
        expressionContext,
        options,
      ),
    );
  }

  private async *runJobInSpan(
    jobSpan: Span,
    workflow: Workflow,
    run: WorkflowRun,
    jobName: string,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const stepWaits = new Map<string, ExecutionObservation>();
    const progress = new Map<string, RunProgress>();
    try {
      const job = workflow.getJob(jobName);
      if (!job) {
        throw new Error(`Job not found: ${jobName}`);
      }

      const jobRun = run.getJob(jobName);
      if (!jobRun) {
        throw new Error(`Job run not found: ${jobName}`);
      }

      const shouldRun = shouldJobRun(job, run);
      if (!shouldRun) {
        if (options.cleanupJobLevel) {
          jobRun.skipNotStarted();
        } else {
          jobRun.skip();
        }
        jobSpan.setAttribute("job.status", "skipped");
        yield { kind: "job_skipped", jobId: jobName };
        return;
      }

      if (jobRun.status !== "running") {
        jobRun.start();
      }
      yield { kind: "job_started", jobId: jobName };

      if (job.fanOutPolicy !== undefined) {
        yield* this.runFanOutJob(
          jobSpan,
          workflow,
          run,
          job,
          jobRun,
          expressionContext,
          options,
        );
        return;
      }

      // Expand forEach steps if we have expression context.
      // Runs in all modes including --last-evaluated: forEach expansion
      // is a structural transformation, not expression evaluation.
      let expandedStepsMap: Map<string, ExpandedStep[]> | undefined;
      if (expressionContext) {
        // In a typed run the expansion's evaluator issues into a bag over the
        // run's registry: a Secret in an item or name leaves as a sentinel.
        expandedStepsMap = await new ForEachExpansionService(
          await this.expressionEvaluator.passEvaluatorFor(
            options.sensitiveValues,
            { location: `${job.name}.forEach` },
          ),
        )
          .expand(
            job,
            expressionContext,
            options.authoredExpressions,
            (step) =>
              (options.stepProvenance ?? StepProvenanceOverlay.authored())
                .forStep(step).raw,
          );
        // rewrite the step list to match the expansion: the template StepRun
        // never executes, so leaving it shows as a perpetually pending phantom
        // in history
        for (const step of job.steps) {
          if (!step.forEach) continue;
          const expanded = expandedStepsMap.get(step.name);
          const names = expanded ? expanded.map((e) => e.expandedName) : [];
          jobRun.replaceExpandedSteps(step.name, names);
          jobRun.registerForEachExpansion(step.name, names);
          // an iteration that waited on a nested run but is not produced by the
          // collection is skipped, its link kept; no skip reason, since the
          // enum cannot grow without older binaries refusing the record
          for (const stepRun of jobRun.steps) {
            if (
              stepRun.isNestedWait &&
              stepRun.forEachTemplate === step.name &&
              !names.includes(stepRun.stepName)
            ) {
              stepRun.skip();
            }
          }
        }
      }

      const stepNodes: GraphNode[] = job.steps.map((step) => ({
        name: step.name,
        weight: step.weight,
        dependencies: step.getDependencyNames(),
      }));

      let effectiveNodes = stepNodes;
      if (expandedStepsMap) {
        effectiveNodes = [];
        for (const node of stepNodes) {
          const expanded = expandedStepsMap.get(node.name);
          if (expanded && expanded.length > 0) {
            // create nodes for each expanded step, grouped under the forEach
            // step so its iterations run in list order
            for (const [index, exp] of expanded.entries()) {
              effectiveNodes.push({
                name: exp.expandedName,
                weight: node.weight,
                group: exp.forEachVar.name !== ""
                  ? { key: node.name, index }
                  : undefined,
                dependencies: node.dependencies.flatMap((dep) => {
                  const depExpanded = expandedStepsMap!.get(dep);
                  return depExpanded && depExpanded.length > 0
                    ? depExpanded.map((d) => d.expandedName)
                    : [dep];
                }),
              });
            }
          } else if (!expanded || expanded.length === 0) {
            continue;
          } else {
            effectiveNodes.push(node);
          }
        }
      }

      const sortedSteps = this.sortService.sort(effectiveNodes);
      const globalLimit = readGlobalConcurrencyLimit();

      // Admission is before the level walk: later levels already wait here,
      // even though their generators have not been created yet.
      for (const node of effectiveNodes) {
        const status = jobRun.getStep(node.name)?.status;
        if (
          status === "succeeded" || status === "failed" ||
          status === "skipped" || status === "unknown"
        ) continue;
        progress.set(
          node.name,
          registerRunProgress({
            runId: run.id,
            workflow: workflow.name,
            job: jobName,
            step: node.name,
            traceId: /^0+$/.test(jobSpan.spanContext().traceId)
              ? undefined
              : jobSpan.spanContext().traceId,
          }),
        );
        stepWaits.set(
          node.name,
          observeExecution("step.dependency", {
            "swamp.workflow.run.id": run.id,
            "job.name": jobName,
            "step.name": node.name,
          }),
        );
      }

      let jobFailed = false;
      // Set when the abort leaves a guarded step undecided.
      let jobUndecided = false;
      // Set once a level is reached after the abort with nothing failed. Later
      // levels stay on that rule, so a step settled there does not turn the
      // work behind it into cleanup.
      let jobReachedAfterAbort = false;
      for (const level of sortedSteps.levels) {
        for (const stepName of level) {
          const dependencyWait = stepWaits.get(stepName);
          if (!dependencyWait) continue;
          dependencyWait.end("ok");
          stepWaits.set(
            stepName,
            observeExecution("step.scheduler", {
              "swamp.workflow.run.id": run.id,
              "job.name": jobName,
              "step.name": stepName,
            }),
          );
        }
        // A level reached after abort with nothing failed starts no work; its
        // cleanup steps run under the cleanup signal, the rest are settled.
        const reachedAfterAbort: boolean = (options.signal?.aborted ?? false) &&
          run.status !== "suspended" &&
          (jobReachedAfterAbort || (!jobFailed && !jobUndecided));
        jobReachedAfterAbort = reachedAfterAbort;
        const cleanupMode: boolean = !reachedAfterAbort &&
          (jobFailed || jobUndecided) && (options.signal?.aborted ?? false);
        const cleanupSignal: AbortSignal | undefined =
          cleanupMode || reachedAfterAbort
            ? cleanupGraceSignal(CLEANUP_GRACE_TIMEOUT_MS)
            : undefined;
        const cleanupOptions = {
          ...options,
          signal: cleanupSignal,
          cleanupStepLevel: true,
        };
        const levelOptions = cleanupMode ? cleanupOptions : options;
        let levelStartsCleanup: boolean = cleanupMode;

        if (cleanupMode || reachedAfterAbort) {
          // Mark any steps still in "running" status as failed — the
          // signal aborted their execution but the generators were
          // abandoned before they could record the failure.
          failAbandonedSteps(jobRun);
        }

        // A forEach step's own limit caps its iterations; every other step
        // shares the job, then workflow, limit; the host ceiling caps the level.
        const levelLimits = new Map<string, number>();
        const fallbackConcurrency = job.concurrency ?? workflow.concurrency;
        if (fallbackConcurrency && fallbackConcurrency > 0) {
          levelLimits.set(LEVEL_GATE, fallbackConcurrency);
        }
        if (globalLimit) levelLimits.set(HOST_GATE, globalLimit);
        const levelSteps = new Map<string, Step>();
        const levelIterations = new Set<string>();
        // Settles a step this level will not start, even when its guard
        // leaves the persisted outcome undecided for a future resume.
        const settleLevelStep = (stepName: string): void => {
          // An iteration a resume added to the collection has no record
          // until runStep creates one, as it would have on reaching it.
          if (!jobRun.getStep(stepName) && levelIterations.has(stepName)) {
            jobRun.addExpandedStep(stepName);
          }
          const stepRun = jobRun.getStep(stepName);
          if (stepRun?.status !== "pending") return;
          settleUnstartedStep(levelSteps.get(stepName), stepRun, jobRun);
          // A later cleanup step can read the outcome; an undecided step has
          // none. Keyed by step name alone, so a step that ran in another job
          // keeps its entry.
          if (stepRun.status !== "pending" && expressionContext?.steps) {
            expressionContext.steps[stepName] ??= attachStepOutputSources(
              { status: stepRun.status, outputs: undefined },
              undefined,
            );
          }
          stepWaits.get(stepName)?.end("cancelled");
          stepWaits.delete(stepName);
          const entry = progress.get(stepName);
          if (entry) removeRunProgress(entry);
          progress.delete(stepName);
        };
        const stepStreams = level.map((stepName) => {
          let forEachVar: ForEachBinding | undefined;
          let originalStep: Step | undefined;

          let forEachIndex: number | undefined;
          let forEachTemplate: string | undefined;

          if (expandedStepsMap) {
            for (const [templateName, expanded] of expandedStepsMap) {
              const idx = expanded.findIndex((e) =>
                e.expandedName === stepName
              );
              if (idx >= 0) {
                forEachVar = expanded[idx].forEachVar;
                originalStep = expanded[idx].step;
                if (expanded[idx].forEachVar.name !== "") {
                  forEachIndex = idx;
                  forEachTemplate = templateName;
                }
                break;
              }
            }
          }

          const levelStep = originalStep ?? job.getStep(stepName);
          if (levelStep) levelSteps.set(stepName, levelStep);
          if (forEachVar?.name) levelIterations.add(stepName);

          // Only a step yet to start is decided here: a finished one, or one
          // re-entering a wait, keeps the run's signal.
          let stepOptions: StepOptions = levelOptions;
          const levelStepRun = jobRun.getStep(stepName);
          const yetToStart: boolean = levelStepRun
            ? levelStepRun.status === "pending"
            : levelIterations.has(stepName);
          if (reachedAfterAbort && yetToStart) {
            if (!levelStep || !runsAfterFailure(levelStep, job, jobRun)) {
              settleLevelStep(stepName);
              return undefined;
            }
            levelStartsCleanup = true;
            stepOptions = cleanupOptions;
          }
          // A suspended run keeps such a step pending for its resume, at any
          // level size: merge() would start a lone stream under the abort.
          if (
            run.status === "suspended" && yetToStart &&
            (stepOptions.signal?.aborted ?? false)
          ) {
            if (!levelStepRun) jobRun.addExpandedStep(stepName);
            return undefined;
          }

          const stepConc = originalStep?.concurrency ??
            job.getStep(stepName)?.concurrency;
          let localGate = LEVEL_GATE;
          if (forEachTemplate !== undefined && stepConc && stepConc > 0) {
            localGate = `step:${forEachTemplate}`;
            levelLimits.set(localGate, stepConc);
          }

          const stream = this.runStep(
            workflow,
            run,
            job,
            jobRun,
            stepName,
            originalStep,
            forEachVar,
            expressionContext,
            stepOptions,
            forEachIndex,
            forEachTemplate,
            stepWaits,
            progress.get(stepName),
          );
          return { stream, gates: [localGate, HOST_GATE] };
        }).filter((entry) => entry !== undefined);

        const levelSignal: AbortSignal | undefined = levelStartsCleanup
          ? cleanupSignal
          : options.signal;
        // Only a level the abort interrupted settles its never-started steps.
        const abortedBeforeLevel: boolean = levelSignal?.aborted ?? false;

        for await (
          const event of mergeGated(stepStreams, levelLimits, levelSignal)
        ) {
          yield event;
          if (event.kind === "step_failed" && !event.allowedFailure) {
            jobFailed = true;
          }
        }

        // a step queued behind a concurrency limit when the abort fired would
        // stay pending and a failed or completed condition on it could never be
        // met; settle it as runStep would; a suspended run keeps pending steps
        const interrupted: boolean = !abortedBeforeLevel &&
          (levelSignal?.aborted ?? false) && run.status !== "suspended";
        if (interrupted) {
          for (const stepName of level) settleLevelStep(stepName);
        }

        // When the signal aborts mid-level with parallel steps,
        // mergeGated may exit before step_failed events are
        // consumed. Derive jobFailed from model state so cleanup kicks in.
        if (!jobFailed && options.signal?.aborted) {
          jobFailed = jobRun.steps.some((s) =>
            s.status === "running" || s.status === "failed" ||
            s.status === "unknown"
          );
        }
        // A step that failed before a resume walked its level emits no
        // step_failed here, but it still fails the job unless its failure was
        // allowed, as it did when it failed.
        if (!jobFailed) {
          jobFailed = level.some((name) => {
            const step = jobRun.getStep(name);
            return step?.status === "failed" && !step.allowedFailure;
          });
        }
        // A guarded step the abort left undecided: the job did not finish its
        // work, so later levels run in cleanup mode, but its outcome is
        // ambiguous (see the end of the job).
        if (
          (interrupted || reachedAfterAbort) &&
          level.some((name) => jobRun.getStep(name)?.status === "pending")
        ) {
          jobUndecided = true;
        }

        if (run.status === "suspended") {
          break;
        }
      }

      // The same for steps the abort left running in the job's last level,
      // which no later cleanup level marks.
      if (
        run.status !== "suspended" && options.signal?.aborted &&
        failAbandonedSteps(jobRun)
      ) {
        jobFailed = true;
      }

      // A step a failed-run resume reset that this walk never reached was
      // stranded by a workflow change (for example, an iteration dropped from
      // a smaller forEach collection). Fail it rather than report the job
      // succeeded with the step still pending. Structural: no model fields.
      if (run.status !== "suspended" && !options.signal?.aborted) {
        for (const stranded of jobRun.failStrandedResetSteps()) {
          jobFailed = true;
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: stranded.stepName,
            runId: run.id,
            error: stranded.error ?? "",
            forEachTemplate: stranded.forEachTemplate,
          };
        }
      }

      // A step still waiting for a signal this walk never reached is an
      // iteration a smaller forEach dropped; settle it rather than report the
      // job succeeded.
      if (run.status !== "suspended" && !options.signal?.aborted) {
        for (const dropped of jobRun.steps) {
          if (!dropped.isSignalWait) continue;
          if (
            await settleReenteredWait(
              this.signalWaitsForSettling(),
              run,
              dropped,
              new Date(),
            ) === "open"
          ) continue;
          const allowFailure = job.steps.find((s) =>
            s.name === (dropped.forEachTemplate ?? dropped.stepName)
          )?.allowFailure;
          if (allowFailure) dropped.markAllowedFailure();
          else jobFailed = true;
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: dropped.stepName,
            runId: run.id,
            error: dropped.error ?? "",
            allowedFailure: allowFailure || undefined,
            forEachTemplate: dropped.forEachTemplate,
          };
        }
      }

      // when the run is suspended and the job has non-terminal steps, leave the
      // job running so resume picks it up; otherwise complete it
      const suspendedWithPendingSteps = run.status === "suspended" &&
        jobRun.steps.some((s) =>
          s.status !== "succeeded" && s.status !== "failed" &&
          s.status !== "skipped" && s.status !== "unknown"
        );
      if (suspendedWithPendingSteps) {
        jobSpan.setStatus({ code: SpanStatusCode.OK });
      } else {
        if (jobFailed) {
          jobRun.fail();
          jobSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Job failed",
          });
        } else if (jobUndecided) {
          // only undecided guarded steps are left, so the job outcome is
          // ambiguous: none of succeeded, failed, completed or skipped holds;
          // like other abort-settled work it gets no event
          if (jobRun.status === "running") jobRun.markUnknown();
          jobSpan.setAttribute("job.status", jobRun.status);
          jobSpan.setStatus({ code: SpanStatusCode.OK });
          return;
        } else {
          jobRun.succeed();
          jobSpan.setStatus({ code: SpanStatusCode.OK });
        }
        jobSpan.setAttribute("job.status", jobRun.status);
        yield { kind: "job_completed", jobId: jobName, status: jobRun.status };
      }
    } catch (error) {
      jobSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // A concurrency-limited generator may never start. Its wait still ends
      // when this walk ends, including suspension and consumer abandonment.
      for (const wait of stepWaits.values()) wait.end("closed");
      stepWaits.clear();
      for (const entry of progress.values()) removeRunProgress(entry);
      const job = workflow.getJob(jobName);
      const affinityKey = job &&
        resolveAffinityKey(workflow.affinity, job.affinity, run.id, jobName);
      // The run-wide pin is released when the run ends, not the job.
      if (affinityKey && affinityKey !== run.id) {
        getRemoteStepDispatcher()?.releaseAffinity(affinityKey);
      }
      jobSpan.end();
    }
  }

  /**
   * plans against serve's pool, records the plan and lanes, then runs each
   * lane's step DAG on its own; a lane never waits on another lane's level
   */
  private async *runFanOutJob(
    jobSpan: Span,
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const reader = getWorkerPoolReader();
    if (reader === null) {
      throw new UserError(
        `Workflow '${workflow.name}' has fan-out job '${job.name}': ${FAN_OUT_NEEDS_SERVE}.`,
      );
    }
    const policy = job.fanOutPolicy!;
    const fields = mergePlacementFields(
      workflow.placementFields,
      job.placementFields,
    );
    const selector = { labels: fields?.labels, platform: fields?.platform };
    const pool = await reader.readPool();
    const poolByName = new Map(pool.map((worker) => [worker.name, worker]));
    // a resume never re-plans: the stored plan names the lanes and members
    const stored = jobRun.fanOutPlan;
    const plan = stored === undefined
      ? planFanOut(selector, policy, pool)
      : undefined;

    let refusal: string | undefined;
    let laneSteps: ReadonlyMap<string, { worker: string; authored: string }> =
      new Map();
    let lanes: string[] = stored?.batches.flat() ?? [];
    if (plan?.kind === "refused") {
      refusal = refusedPlanMessage(
        job.name,
        selector,
        plan.live,
        plan.minWorkers,
      );
    } else if (plan !== undefined) {
      const batches = planBatches(plan.members, undefined);
      lanes = batches.flat();
      try {
        laneSteps = planLaneSteps(
          job.name,
          job.steps.map((step) => step.name),
          lanes,
        );
        refuseSharedLaneInstances(
          job.name,
          job.steps.flatMap((step) =>
            step.task.data.type === "model_method" &&
              step.task.data.modelName !== undefined
              ? [step.task.data.modelName]
              : []
          ),
          lanes,
        );
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      if (refusal === undefined) {
        jobRun.recordFanOutPlan(
          plan,
          batches,
          fanOutSnapshot(options.authoredWorkflow, job.name, lanes, poolByName),
        );
        jobRun.expandLanes([...laneSteps.keys()]);
        // the plan is durable before any lane start can be journalled
        await this.saveRun(workflow.id, run);
      }
    }

    // nothing is sent: the authored steps carry the reason, as a stranded
    // step does
    if (refusal !== undefined) {
      for (const stepRun of jobRun.steps) {
        if (stepRun.status !== "pending") continue;
        stepRun.fail(refusal);
        yield {
          kind: "step_failed",
          jobId: job.name,
          stepId: stepRun.stepName,
          runId: run.id,
          error: refusal,
        };
      }
      jobRun.fail();
      jobSpan.setAttribute("job.status", jobRun.status);
      jobSpan.setStatus({ code: SpanStatusCode.ERROR, message: refusal });
      yield { kind: "job_completed", jobId: job.name, status: jobRun.status };
      return;
    }
    const members = plan?.kind === "planned" ? plan.members : stored?.members;
    if (members === undefined) return;

    const laneRerun = (worker: string) =>
      job.steps.some((step) =>
        jobRun.getStep(laneStepName(step.name, worker))?.status === "pending"
      );
    const rerun = lanes.filter(laneRerun);
    yield {
      kind: "job_fanout_planned",
      jobId: job.name,
      selector: {
        ...(selector.labels !== undefined ? { labels: selector.labels } : {}),
        ...(selector.platform !== undefined
          ? { platform: selector.platform }
          : {}),
      },
      offline: policy.offline,
      minWorkers: policy.minWorkers,
      plannedLanes: stored?.plannedLanes ??
        (plan?.kind === "planned" ? plan.plannedLanes : lanes.length),
      members: members.map(fanOutEventMember),
      ...(stored !== undefined
        ? {
          resumed: {
            rerun,
            kept: lanes.filter((worker) => !rerun.includes(worker)),
          },
        }
        : {}),
    };
    const queueTimeoutSeconds = fields?.queueTimeout ??
      (reader.queueTimeoutMs !== undefined
        ? reader.queueTimeoutMs / 1000
        : null);
    const storedScopes = new Map(
      (jobRun.fanOutSnapshot?.workers ?? []).map((
        scope,
      ) => [scope.name, scope]),
    );
    // a lane with no scope to bind fails instead of waiting
    const waiting = stored === undefined
      ? members.filter((member) => member.disposition === "waiting")
        .map((member) => member.worker)
      : rerun.filter((worker) =>
        poolByName.get(worker)?.connected !== true &&
        policy.offline === "wait" &&
        (poolByName.has(worker) || storedScopes.has(worker))
      );
    for (const worker of waiting) {
      yield {
        kind: "job_fanout_waiting",
        jobId: job.name,
        worker,
        queueTimeoutSeconds,
      };
    }
    const globalLimit = readGlobalConcurrencyLimit();
    // one host ceiling for every lane's steps, as one forEach level shares it
    const hostSlots = globalLimit && globalLimit > 0
      ? sharedGate(globalLimit)
      : undefined;
    const laneStreams: AsyncIterable<WorkflowExecutionEvent>[] = [];
    for (const worker of lanes) {
      const stepOf = (authored: string) => laneStepName(authored, worker);
      const live = poolByName.get(worker);
      const scope = live !== undefined
        ? laneWorkerScope(live)
        : storedScopes.get(worker);
      const verdict = stored === undefined
        ? { kind: "run" as const }
        : resumedLaneVerdict(
          job.name,
          worker,
          policy.offline,
          live,
          scope !== undefined,
        );
      if (verdict.kind === "fail" || scope === undefined) {
        const error = verdict.kind === "fail"
          ? verdict.error
          : `Worker '${worker}' of fan-out job '${job.name}' is not in the pool.`;
        for (const step of job.steps) {
          const stepRun = jobRun.getStep(stepOf(step.name));
          if (stepRun?.status !== "pending") continue;
          stepRun.fail(error);
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: stepRun.stepName,
            runId: run.id,
            error,
          };
        }
        continue;
      }
      laneStreams.push(
        this.runFanOutLane(
          workflow,
          run,
          job,
          jobRun,
          { worker, stepOf },
          scope,
          expressionContext,
          options,
          hostSlots,
        ),
      );
    }
    const laneLimit = resolveEffectiveConcurrency(
      job.concurrency ?? workflow.concurrency,
      globalLimit,
    );
    for await (
      const event of mergeWithConcurrency(
        laneStreams,
        laneLimit,
        options.signal,
        { finishStartedOnAbort: true },
      )
    ) {
      yield event;
    }

    // steps the abort left running are failed, as runJobInSpan does; a lane
    // still queued at the abort never started, so it is settled and sends nothing
    if (options.signal?.aborted) {
      failAbandonedSteps(jobRun);
      const levels = this.sortService.sort(
        job.steps.map((step) => ({
          name: step.name,
          weight: step.weight,
          dependencies: step.getDependencyNames(),
        })),
      ).levels;
      for (const worker of lanes) {
        const stepOf = (authored: string) => laneStepName(authored, worker);
        const view = jobRun.laneView(stepOf);
        for (const name of levels.flat()) {
          const stepRun = jobRun.getStep(stepOf(name));
          if (stepRun?.status !== "pending") continue;
          settleUnstartedStep(job.getStep(name), stepRun, jobRun, view);
        }
      }
    }
    const laneRuns = lanes.map((worker) =>
      job.steps.map((step) => jobRun.getStep(laneStepName(step.name, worker))!)
    );
    const failedLanes =
      laneRuns.filter((steps) =>
        laneFailed(steps.map((stepRun) => ({
          status: stepRun.status,
          allowedFailure: stepRun.allowedFailure,
        })))
      ).length;
    const undecided = laneRuns.some((steps) =>
      steps.some((stepRun) =>
        stepRun.status === "pending" || stepRun.status === "unknown"
      )
    );
    const summary: WorkflowExecutionEvent = {
      kind: "job_fanout_summary",
      jobId: job.name,
      matching: members.length,
      lanesSucceeded:
        laneRuns.filter((steps) =>
          laneSucceeded(steps.map((stepRun) => ({
            status: stepRun.status,
            allowedFailure: stepRun.allowedFailure,
            settledByAbort: stepRun.settledByAbort,
          })))
        ).length,
      lanesFailed: failedLanes,
      excluded: membersOf(members, "excluded"),
      skipped: membersOf(members, "skipped"),
      failedAtPlan: membersOf(members, "failed"),
    };
    if (fanOutJobFailed(members, failedLanes)) {
      jobRun.fail();
      jobSpan.setStatus({ code: SpanStatusCode.ERROR, message: "Job failed" });
    } else if (undecided) {
      if (jobRun.status === "running") jobRun.markUnknown();
      jobSpan.setAttribute("job.status", jobRun.status);
      jobSpan.setStatus({ code: SpanStatusCode.OK });
      return;
    } else {
      jobRun.succeed();
      jobSpan.setStatus({ code: SpanStatusCode.OK });
    }
    jobSpan.setAttribute("job.status", jobRun.status);
    yield summary;
    yield { kind: "job_completed", jobId: job.name, status: jobRun.status };
  }

  /**
   * one lane: the job's steps level by level, on the lane's worker, with its
   * own steps map so a lane never reads another lane's outputs
   */
  private async *runFanOutLane(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    lane: NonNullable<StepOptions["lane"]>,
    scope: ReturnType<typeof laneWorkerScope>,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
    hostSlots: SharedGate | undefined,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const laneOptions: StepOptions = { ...options, lane };
    // copies, not the run's maps: a lane's outputs end with the lane
    const laneContext: ExpressionContext | undefined = expressionContext && {
      ...expressionContext,
      steps: { ...expressionContext.steps },
      model: { ...expressionContext.model },
    };
    const binding: ForEachBinding = { name: "worker", value: scope };
    const view = jobRun.laneView(lane.stepOf);
    const levels = this.sortService.sort(
      job.steps.map((step) => ({
        name: step.name,
        weight: step.weight,
        dependencies: step.getDependencyNames(),
      })),
    ).levels;
    const pending = (authored: string) =>
      jobRun.getStep(lane.stepOf(authored))?.status === "pending";
    const settle = (names: readonly string[]) => {
      for (const name of names) {
        if (!pending(name)) continue;
        settleUnstartedStep(
          job.getStep(name),
          jobRun.getStep(lane.stepOf(name))!,
          jobRun,
          view,
        );
      }
    };
    const stepStream = (authored: string, stepOptions: StepOptions) => {
      const stream = this.runStep(
        workflow,
        run,
        job,
        jobRun,
        lane.stepOf(authored),
        job.getStep(authored),
        binding,
        laneContext,
        stepOptions,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      return hostSlots === undefined
        ? stream
        : hostSlots.run(stream, stepOptions.signal);
    };

    let cleanupOptions: StepOptions | undefined;
    for (const level of levels) {
      if (options.signal?.aborted) {
        // as a plain job: after the abort only cleanup steps run, under the
        // cleanup grace signal; the rest are settled
        const runnable = level.filter((name) =>
          pending(name) && runsAfterFailure(job.getStep(name)!, job, view)
        );
        settle(level.filter((name) => !runnable.includes(name)));
        if (runnable.length === 0) continue;
        cleanupOptions ??= {
          ...laneOptions,
          signal: cleanupGraceSignal(CLEANUP_GRACE_TIMEOUT_MS),
          cleanupStepLevel: true,
        };
        for await (
          const event of merge(
            runnable.map((name) => stepStream(name, cleanupOptions!)),
            cleanupOptions.signal,
          )
        ) {
          yield event;
        }
        settle(runnable);
        continue;
      }
      for await (
        const event of merge(
          level.map((name) => stepStream(name, laneOptions)),
          options.signal,
        )
      ) {
        yield event;
      }
      if (options.signal?.aborted) {
        // only this lane's: other lanes' steps may still be finishing
        for (const name of level) {
          const stepRun = jobRun.getStep(lane.stepOf(name));
          if (stepRun?.status === "running") {
            stepRun.failStoppedByAbort(CANCELLED_STEP_ERROR);
          }
        }
        settle(level);
      }
    }
  }

  private async *runStep(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    stepName: string,
    originalStep: Step | undefined,
    forEachVar: ForEachBinding | undefined,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
    forEachIndex?: number,
    forEachTemplate?: string,
    stepWaits?: Map<string, ExecutionObservation>,
    progress?: RunProgress,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    stepWaits?.get(stepName)?.end("ok");
    stepWaits?.delete(stepName);
    const stepSpan = getTracer().startSpan("swamp.workflow.step", {
      attributes: {
        "step.name": stepName,
        "job.name": job.name,
      },
    });
    const generator = this.#stamped(bindGeneratorToSpan(
      stepSpan,
      this.runStepInSpan(
        stepSpan,
        workflow,
        run,
        job,
        jobRun,
        stepName,
        originalStep,
        forEachVar,
        expressionContext,
        options,
        forEachIndex,
        forEachTemplate,
      ),
    ));
    if (!progress) {
      yield* generator;
      return;
    }
    const leave = progress.enter("executing");
    try {
      yield* bindRunProgress(progress, generator);
    } finally {
      leave();
      removeRunProgress(progress);
    }
  }

  private async *runStepInSpan(
    stepSpan: Span,
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    stepName: string,
    originalStep: Step | undefined,
    forEachVar: ForEachBinding | undefined,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
    forEachIndex?: number,
    forEachTemplate?: string,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const step = originalStep ?? job.getStep(stepName);
    if (!step) {
      stepSpan.end();
      throw new Error(`Step not found: ${stepName}`);
    }
    stepSpan.setAttribute("step.task.type", step.task.data.type);

    let stepRun = jobRun.getStep(stepName);
    if (!stepRun && forEachVar && forEachVar.name) {
      jobRun.addExpandedStep(stepName);
      stepRun = jobRun.getStep(stepName);
    }
    // Skip steps that already finished (a resumed run). The job counts one
    // that failed after its level (see runJob).
    if (
      stepRun &&
      (stepRun.status === "succeeded" || stepRun.status === "failed" ||
        stepRun.status === "skipped" || stepRun.status === "unknown")
    ) {
      // Replay assert_result for completed assert steps so renderers
      // (JUnit, console summary) include prior-run results.
      if (stepRun.assertResult) {
        yield {
          kind: "assert_result" as const,
          jobId: job.name,
          stepId: stepName,
          passed: stepRun.assertResult.passed,
          message: stepRun.assertResult.message,
          severity: stepRun.assertResult.severity,
          expr: stepRun.assertResult.expr,
          error: stepRun.assertResult.error,
        };
      }
      // resume() already resolved completed steps into the context; only
      // read the datastore when this step is missing or its status moved.
      const finishedKey = options.lane ? step.name : stepName;
      if (
        expressionContext?.steps &&
        expressionContext.steps[finishedKey]?.status !== stepRun.status
      ) {
        const resolved = await this.createStepOutputResolver().resolve(stepRun);
        expressionContext.steps[finishedKey] = attachStepOutputSources(
          { status: stepRun.status, outputs: resolved.outputs },
          resolved.sources,
        );
      }
      stepSpan.end();
      return;
    }

    if (!stepRun) {
      stepSpan.end();
      throw new Error(`Step run not found: ${stepName}`);
    }

    // a nested workflow step waiting on its child already passed its trigger
    // and guard; re-entering, it reads the child's outcome, and a changed guard
    // or dependsOn must not skip it and strand the child
    const reenterNestedWait = stepRun.isNestedWait;
    // A step waiting for a signal re-enters the same way: it settles the wait
    // it holds, and is never skipped or started again, which would lose the
    // wait's deadline or open a second wait.
    const reenterSignalWait = stepRun.isSignalWait;
    const reenterWait = reenterNestedWait || reenterSignalWait;

    // Check if step's trigger condition is met. A forEach iteration checks its
    // template's dependsOn, so every iteration is gated as a plain step is.
    const conditionView = options.lane
      ? jobRun.laneView(options.lane.stepOf)
      : jobRun;
    if (!reenterWait && !shouldStepRun(step, conditionView)) {
      if (options.cleanupStepLevel) {
        stepRun.skipUnstarted({ kind: "dependency" });
      } else {
        stepRun.skip({ kind: "dependency" });
      }
      stepSpan.setAttribute("step.status", "skipped");
      stepSpan.end();
      yield {
        kind: "step_skipped",
        jobId: job.name,
        stepId: stepName,
        reason: "dependency",
        forEachTemplate,
        forEachIndex,
      };
      return;
    }

    // Build expression context before guard evaluation so self.* is available
    // for forEach-expanded steps.
    let stepExprContext = expressionContext
      ? { ...expressionContext }
      : expressionContext;
    if (stepExprContext && forEachVar && forEachVar.name) {
      const baseSelf = stepExprContext.self ?? {
        id: "",
        name: "",
        version: 1,
        tags: {},
        globalArguments: {},
      };
      stepExprContext = {
        ...stepExprContext,
        self: {
          ...baseSelf,
          ...(forEachIndex !== undefined ? { _index: forEachIndex } : {}),
          [forEachVar.name]: forEachVar.value,
        },
      };
      attachBindingProvenance(stepExprContext, {
        self: (bindingProvenanceOf(stepExprContext).self ??
          ProvenanceMap.authored()).graft(
            keySegment(forEachVar.name),
            forEachVar.provenance ?? ProvenanceMap.authored(),
          ),
      });
      // An item iterated out of a resume-time input carries that input's
      // value, so it is excluded from deferred bindings like the input.
      const resumeKeys = (options.resumeDerived ?? [])
        .filter((path) => path.startsWith("inputs."))
        .map((path) => path.slice("inputs.".length));
      // Read as `inputs.X` or `run.inputs.X`: both hold resume-time values.
      // A collection read whole or by a computed key counts as reading them,
      // so its items are left out rather than risk persisting one.
      const inRefs = inputNamesRead(
        extractCelExpression(step.forEach?.in ?? "") ?? "",
      );
      if (
        resumeKeys.length > 0 &&
        (inRefs.opaque || resumeKeys.some((key) => inRefs.names.has(key)))
      ) {
        options = {
          ...options,
          resumeDerived: [
            ...(options.resumeDerived ?? []),
            `self.${forEachVar.name}`,
          ],
        };
      }
    }

    if (step.guard && !reenterWait) {
      const guardCel = extractCelExpression(step.guard);
      if (!guardCel) {
        stepSpan.end();
        throw new UserError(
          `Step "${stepName}" guard must be a $\{{ }} expression, got: ${step.guard}`,
        );
      }
      const guardLogger = getWorkflowRunLogger(
        workflow.name,
        undefined,
        undefined,
        run.id,
      );
      // if the abort fires while a pending step's guard is evaluated, the step
      // stays pending whatever the guard answers: the level may have moved on
      // and an undecided guard must not look finished
      const abortedBeforeGuard = options.signal?.aborted ?? false;
      const guardedStep = stepRun;
      const statusBeforeGuard = guardedStep.status;
      const settledDuringGuard = (): boolean =>
        guardedStep.status !== statusBeforeGuard;
      const abortedDuringGuard = (): boolean =>
        statusBeforeGuard === "pending" && !abortedBeforeGuard &&
        (options.signal?.aborted ?? false);
      try {
        // a guard is a predicate destination: in a typed run its evaluator
        // binds the run's sentinels as Secrets and refuses a result that holds
        // one, before any load
        const celEvaluator = await this.expressionEvaluator.passEvaluatorFor(
          options.sensitiveValues,
          { location: `${stepName}.guard`, secretResult: "refuse" },
        );
        const guardContext: Record<string, unknown> = {
          ...(stepExprContext ?? {}),
        };
        guardContext["modelMethod"] = this.buildModelMethodDelegate(
          workflow,
          run,
          job,
          stepName,
          "__guard_",
          stepExprContext,
          options,
        );
        if (
          partitionAuthoredAt(
            extractExpressions(step.guard),
            options.authoredExpressions,
            // Guards are skipped by run-start evaluation but not by its
            // substitution, so a guard can hold a spliced value.
            (options.stepProvenance ?? StepProvenanceOverlay.authored())
              .forStep(step).raw.subtree("guard"),
          ).length !== 1
        ) {
          throw new UserError("Guard must be an authored expression");
        }
        const guardResult = await celEvaluator.evaluateAsync(
          guardCel,
          guardContext,
        );
        if (settledDuringGuard() || abortedDuringGuard()) {
          stepSpan.end();
          return;
        }
        if (guardResult) {
          guardLogger
            .debug`Step ${stepName} guard skipped: ${guardCel} → ${guardResult}`;
          stepRun.skip({ kind: "guarded", expression: guardCel });
          stepSpan.setAttribute("step.status", "skipped");
          stepSpan.setAttribute("step.skip.reason", "guarded");
          stepSpan.end();
          yield {
            kind: "step_skipped",
            jobId: job.name,
            stepId: stepName,
            reason: "guarded",
            guardExpression: guardCel,
            // a guard result holding a secret is refused in a typed run; text,
            // lists and maps shown are masked either way, a bare number or
            // boolean is shown as is since the mask would coerce it
            guardResult: typeof guardResult === "number" ||
                typeof guardResult === "boolean"
              ? guardResult
              : options.sensitiveValues.masked(guardResult),
            forEachTemplate,
            forEachIndex,
          };
          return;
        }
        guardLogger
          .debug`Step ${stepName} guard passed: ${guardCel} → ${guardResult}`;
      } catch (error) {
        if (settledDuringGuard() || abortedDuringGuard()) {
          stepSpan.end();
          return;
        }
        stepRun.fail(String(error));
        stepSpan.setAttribute("step.status", "failed");
        stepSpan.end();
        yield {
          kind: "step_failed",
          jobId: job.name,
          stepId: stepName,
          runId: run.id,
          error: `Guard expression failed: ${error}`,
          forEachTemplate,
          forEachIndex,
        };
        return;
      }
    }

    // A run whose step start could not be committed starts no further step;
    // this one stays pending, which is true, since it never ran.
    if (this.stoppedRuns.has(run.id)) {
      stepSpan.end();
      return;
    }

    // Start step. A re-entered wait keeps its start time.
    if (!reenterWait) stepRun.start();

    // This step's `steps.<name>.outputs`, taken from the full output before
    // it is stripped for the run record. Declared here so the finally below
    // sees it for both model_method and workflow steps.
    let liveOutputs:
      | Pick<ResolvedStepOutputs, "outputs" | "sources">
      | undefined;
    try {
      // Yielded inside the try so a consumer that stops here still ends the
      // step span in the finally below.
      yield {
        kind: "step_started",
        jobId: job.name,
        stepId: stepName,
        forEachTemplate,
        forEachIndex,
      };

      const task = step.task.data;

      if (reenterNestedWait) {
        liveOutputs = yield* this.settleNestedWait(
          run,
          job,
          stepRun,
          stepName,
          stepExprContext,
          !!step.allowFailure,
        );
        return;
      }

      // A re-entered signal wait fails once its deadline has passed, so
      // `failed` handlers run; one still open suspends the run on it again.
      if (reenterSignalWait) {
        const unreadable = stepRun.signalWait === undefined;
        const settled = await settleReenteredWait(
          this.signalWaitsForSettling(),
          run,
          stepRun,
          new Date(),
        );
        if (unreadable) {
          getSwampLogger(["workflow", "resume"]).warn(
            "Step {stepName} of run {runId} held a wait that could not be read, so no signal could reach it. The step failed with {error}.",
            {
              stepName,
              runId: run.id,
              error: WAIT_UNREADABLE_STEP_ERROR,
            },
          );
        }
        if (settled === "failed") {
          if (step.allowFailure) stepRun.markAllowedFailure();
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: stepName,
            runId: run.id,
            error: stepRun.error ?? WAIT_TIMEOUT_STEP_ERROR,
            allowedFailure: step.allowFailure || undefined,
            forEachTemplate,
            forEachIndex,
          };
        } else {
          run.suspend(stepExprContext?.inputs);
        }
        return;
      }

      // Handle wait for signal tasks — suspend the workflow, as a manual
      // approval does, until `workflow signal` settles the wait.
      if (task.type === "wait_for_signal") {
        // The schema is captured as data: an expression still in it would be
        // compared with payloads as literal text, and no payload could match.
        const unresolved = schemaExpressions(task.schema);
        if (unresolved.length > 0) {
          const error =
            `The wait_for_signal schema of step "${stepName}" contains an expression that was not resolved: ${
              unresolved[0]
            }. A schema may read inputs.*, but not self, steps or data.`;
          stepRun.fail(error);
          if (step.allowFailure) stepRun.markAllowedFailure();
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: stepName,
            runId: run.id,
            error,
            allowedFailure: step.allowFailure || undefined,
            forEachTemplate,
            forEachIndex,
          };
          return;
        }
        const openedAt = new Date();
        const waits = this.requireSignalWaits(workflow.name);
        // A wait this step registered before its process died, with the run
        // not yet saved, is taken over: a signal may have been accepted for
        // it since, and a new wait would leave that signal unread.
        const earlier = await this.adoptableWait(waits, run, {
          jobName: job.name,
          stepName,
        }, openedAt);
        // A wait taken over keeps the deadline it was registered with.
        const maxTimeout = this.signalWaits.supported
          ? this.signalWaits.maxTimeoutSeconds
          : undefined;
        if (!earlier && maxTimeout !== undefined && task.timeout > maxTimeout) {
          const error =
            `The wait_for_signal timeout of step "${stepName}" is ${task.timeout} seconds, more than the ${maxTimeout} seconds this server allows (--max-signal-wait-timeout).`;
          stepRun.fail(error);
          if (step.allowFailure) stepRun.markAllowedFailure();
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: stepName,
            runId: run.id,
            error,
            allowedFailure: step.allowFailure || undefined,
            forEachTemplate,
            forEachIndex,
          };
          return;
        }
        let wait = earlier
          ? SignalWait.fromData({
            kind: "signal",
            id: earlier.waitId,
            schema: earlier.schema,
            deadline: earlier.deadline,
            ...(earlier.key !== undefined ? { key: earlier.key } : {}),
            ...(earlier.early !== undefined ? { early: earlier.early } : {}),
          })
          : SignalWait.open(
            task.schema,
            task.timeout,
            openedAt,
            maxTimeout,
            task.key,
          );
        // A keyed wait claims its key before registering, so a step finding the
        // key held opens nothing; an unopened wait's claim is settled as
        // cancelled.
        const closeUnopenedWait = async (unopened: SignalWait) => {
          if (unopened.key === undefined) return;
          try {
            await waits.settle(cancelledOutcome({
              waitId: unopened.id,
              workflowId: run.workflowId,
              runId: run.id,
              deadline: unopened.deadline.toISOString(),
            }, new Date()));
          } catch {
            // The store is failing; the error that led here is the one to
            // report.
          }
        };
        if (!earlier && task.key !== undefined) {
          let acquisition: WaitKeyAcquisition;
          try {
            acquisition = await claimWaitKey(waits, {
              workflowId: run.workflowId,
              key: task.key,
              waitId: wait.id,
              runId: run.id,
              jobName: job.name,
              stepName,
              deadline: wait.deadline.toISOString(),
              ...(task.acceptEarly !== undefined
                ? { acceptEarly: task.acceptEarly }
                : {}),
              // read now, not when the step began: finding a wait to take over
              // reads every registration, and an earlier-dated claim would look
              // older than it is to a claimant judging abandonment
            }, new Date());
          } catch (error) {
            // The claim may have been created before the store failed: a
            // create that landed and could not be read back, for one.
            await closeUnopenedWait(wait);
            throw error;
          }
          if (acquisition.kind === "own") {
            // This step claimed the key and its process stopped before the
            // wait was registered. The claim names that wait, so the step
            // opens it now instead of a second one.
            wait = SignalWait.fromData({
              kind: "signal",
              id: acquisition.claim.waitId,
              schema: task.schema,
              deadline: acquisition.claim.deadline,
              key: task.key,
              ...(acquisition.claim.early !== undefined
                ? { early: acquisition.claim.early }
                : {}),
            });
          } else if (acquisition.kind === "acquired") {
            // the wait keeps where its key's pending signal is, so any reader
            // can give it that signal
            if (acquisition.claim.early !== undefined) {
              wait = wait.withEarly(acquisition.claim.early);
            }
          } else {
            getSwampLogger(["workflow", "run"]).warn(
              "Step {stepName} of run {runId} did not open its wait: {reason}. The step failed with {error}.",
              {
                stepName,
                runId: run.id,
                reason: waitKeyRefusal(task.key, acquisition),
                error: WAIT_KEY_HELD_STEP_ERROR,
              },
            );
            stepRun.fail(WAIT_KEY_HELD_STEP_ERROR);
            if (step.allowFailure) stepRun.markAllowedFailure();
            // The run output names the holder; the step's error stays bare.
            const waitKeyHolder = acquisition.kind === "held"
              ? await waitKeyHolderOf(waits, acquisition.claim)
              : undefined;
            yield {
              kind: "step_failed",
              jobId: job.name,
              stepId: stepName,
              runId: run.id,
              error: WAIT_KEY_HELD_STEP_ERROR,
              allowedFailure: step.allowFailure || undefined,
              ...(waitKeyHolder ? { waitKeyHolder } : {}),
              forEachTemplate,
              forEachIndex,
            };
            return;
          }
        }
        // Registered before the step waits, so the wait can be signalled as
        // soon as its id is known, whatever the run record says by then.
        if (!earlier) {
          try {
            await waits.register(
              registrationOf(
                {
                  workflowId: run.workflowId,
                  workflowName: run.workflowName,
                  runId: run.id,
                  jobName: job.name,
                  stepName,
                },
                wait,
                openedAt,
              ),
            );
          } catch (error) {
            await closeUnopenedWait(wait);
            throw error;
          }
        }
        stepRun.waitForSignal(wait);
        // A signal that arrived before the wait opened is taken after the claim
        // and registration, so the step succeeds at once and the run does not
        // suspend.
        const earlyRef = earlyWaitRef(
          waitRefOf(run, stepRun) ?? {
            waitId: wait.id,
            workflowId: run.workflowId,
            runId: run.id,
            deadline: wait.deadline.toISOString(),
          },
        );
        if (earlyRef) {
          let taken: StoredWaitRecord<WaitOutcome> = { kind: "absent" };
          try {
            taken = await takePendingSignal(waits, earlyRef);
          } catch (error) {
            // The wait is open and registered. Whoever settles it next
            // takes the signal, so the step waits instead of failing.
            getSwampLogger(["workflow", "run"]).warn(
              "Step {stepName} of run {runId} could not read the pending signal of its key: {error}. It waits for a signal.",
              {
                stepName,
                runId: run.id,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
          if (
            taken.kind === "found" && taken.record.kind === "accepted" &&
            stepRun.applyWaitOutcome(taken.record)
          ) {
            // What a resume restores for a signalled step, so the steps
            // that follow in this run read the same outputs.
            liveOutputs = {
              outputs: {
                payload: taken.record.payload,
                signal: receiptForCaller(taken.record.receipt),
              },
            };
            stepSpan.setStatus({ code: SpanStatusCode.OK });
            yield {
              kind: "step_completed",
              jobId: job.name,
              stepId: stepName,
              runId: run.id,
              forEachTemplate,
              forEachIndex,
            };
            return;
          }
        }
        yield {
          kind: "signal_wait_requested",
          runId: run.id,
          workflowName: workflow.name,
          jobId: job.name,
          stepId: stepName,
          waitId: wait.id,
          deadline: wait.deadline.toISOString(),
          ...(wait.key !== undefined ? { key: wait.key } : {}),
        };
        run.suspend(stepExprContext?.inputs);
        return;
      }

      if (task.type === "manual_approval") {
        stepRun.waitForApproval(task.prompt, task.timeout);
        yield {
          kind: "approval_requested",
          runId: run.id,
          workflowName: workflow.name,
          jobId: job.name,
          stepId: stepName,
          // A resolved expression, shown masked: in a typed run a secret it
          // holds is a sentinel, which the run's record masks.
          prompt: String(options.sensitiveValues.masked(task.prompt)),
          timeout: task.timeout,
        };
        // Capture the clean workflow-level inputs so steps after the gate
        // resolve inputs.* on resume; return, not throw, so merge() keeps
        // draining siblings.
        run.suspend(stepExprContext?.inputs);
        stepSpan.end();
        return;
      }

      if (task.type === "assert") {
        // the predicate destination, as for a guard
        const celEvaluator = await this.expressionEvaluator.passEvaluatorFor(
          options.sensitiveValues,
          { location: `${stepName}.task.expr`, secretResult: "refuse" },
        );
        const assertContext: Record<string, unknown> = {
          ...(stepExprContext ?? {}),
        };
        assertContext["modelMethod"] = this.buildModelMethodDelegate(
          workflow,
          run,
          job,
          stepName,
          "__assert_",
          stepExprContext,
          options,
        );
        try {
          if (!options.authoredExpressions.has(task.expr)) {
            throw new UserError(
              "Assertion predicate must be authored CEL source",
            );
          }
          const result = await celEvaluator.evaluateAsync(
            task.expr,
            assertContext,
          );
          // A model.method() call that answered after the abort settled the
          // step does not decide the assertion.
          if (abandonedByAbort(stepRun, options)) return;
          const passed = !!result;

          // interpolate ${{ }} in the message; only authored occurrences are
          // resolved and substituted, as run-start evaluation can splice data
          // into the message
          const messageProvenance = (options.stepProvenance ??
            StepProvenanceOverlay.authored()).forStep(step).raw.subtree(
              "task.message",
            );
          // Assert messages are masked destinations: Secret results leave
          // as sentinels the run masks, without loading their values.
          const messageEvaluator = await this.expressionEvaluator
            .passEvaluatorFor(
              options.sensitiveValues,
              { location: `${stepName}.task.message` },
            );
          const messageContext = { model: {}, env: {}, ...assertContext };
          const messageValues = new Map<string, unknown>();
          for (
            const expr of partitionAuthoredAt(
              extractExpressions(task.message),
              options.authoredExpressions,
              messageProvenance,
            )
          ) {
            if (messageValues.has(expr.raw)) continue;
            try {
              const value = await messageEvaluator.evaluateAsync(
                expr.celExpression,
                messageContext,
              );
              messageValues.set(expr.raw, String(value ?? ""));
            } catch {
              // Leave the expression as-is if evaluation fails.
            }
          }
          // Every authored occurrence takes its value, as the per-occurrence
          // replace always did; an occurrence in data stays literal.
          let resolvedMessage = messageValues.size === 0
            ? task.message
            : replaceExpressionSpans(task.message, (span) =>
              !messageValues.has(span.raw) ||
                messageProvenance.overlapsData("", span.start, span.end)
                ? span.raw
                : messageValues.get(span.raw) as string);
          // Mask once, before the message reaches the step error, the
          // events, or the span. Mask issued sentinels through the run's
          // record, then redact any literal sensitive arguments.
          resolvedMessage = String(
            options.sensitiveValues.masked(resolvedMessage),
          );
          resolvedMessage = options.secretRedactor?.redact(resolvedMessage) ??
            resolvedMessage;

          const assertResult = {
            passed,
            expr: task.expr,
            message: resolvedMessage,
            severity: task.severity,
          };
          stepRun.recordAssertResult(assertResult);

          if (passed) {
            stepRun.succeed();
          } else {
            stepRun.fail(resolvedMessage);
          }

          yield {
            kind: "assert_result" as const,
            jobId: job.name,
            stepId: stepName,
            passed,
            message: resolvedMessage,
            severity: task.severity,
            expr: task.expr,
          };

          if (passed) {
            stepSpan.setStatus({ code: SpanStatusCode.OK });
            yield {
              kind: "step_completed",
              jobId: job.name,
              stepId: stepName,
              runId: run.id,
              forEachTemplate,
              forEachIndex,
            };
          } else {
            const belowThreshold = options.assertFailOnSeverity
              ? !severityAtOrAbove(
                task.severity,
                options.assertFailOnSeverity,
              )
              : false;
            const isAllowed = !!step.allowFailure || belowThreshold;
            if (isAllowed) {
              stepRun.markAllowedFailure();
            }
            stepSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: resolvedMessage,
            });
            yield {
              kind: "step_failed",
              jobId: job.name,
              stepId: stepName,
              runId: run.id,
              error: resolvedMessage,
              allowedFailure: isAllowed || undefined,
              forEachTemplate,
              forEachIndex,
            };
          }
        } catch (error) {
          if (abandonedByAbort(stepRun, options)) return;
          const errorMessage = error instanceof Error
            ? error.message
            : String(error);

          const assertResult = {
            passed: false,
            expr: task.expr,
            message: errorMessage,
            severity: task.severity,
            error: errorMessage,
          };
          stepRun.recordAssertResult(assertResult);
          stepRun.fail(errorMessage);
          stepSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMessage,
          });
          yield {
            kind: "assert_result" as const,
            jobId: job.name,
            stepId: stepName,
            passed: false,
            message: errorMessage,
            severity: task.severity,
            expr: task.expr,
            error: errorMessage,
          };
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: stepName,
            runId: run.id,
            error: errorMessage,
            forEachTemplate,
            forEachIndex,
          };
        } finally {
          stepSpan.end();
        }
        return;
      }

      if (task.type === "workflow") {
        liveOutputs = yield* trackNestedRun(
          options.nestedRuns,
          this.runWorkflowStep(
            workflow,
            run,
            job,
            stepRun,
            stepName,
            task,
            stepExprContext,
            options,
            !!step.allowFailure,
            step,
          ),
        );
        return;
      }

      const output = yield* withEventBridge<
        WorkflowExecutionEvent,
        unknown
      >((push) => {
        const ctx: StepExecutionContext = {
          workflowId: workflow.id,
          workflowRunId: run.id,
          workflowName: workflow.name,
          jobName: job.name,
          stepName,
          repoDir: this.repoDir,
          pulledExtensionsRoot: this.pulledExtensionsRoot,
          signal: options.signal ?? new AbortController().signal,
          expressionContext: stepExprContext,
          workflowRun: run,
          step,
          forEachVariable: forEachVar,
          forEachIndex,
          workflowTags: options.workflowTags,
          runtimeTags: options.runtimeTags,
          secretRedactor: options.secretRedactor,
          sensitiveValues: options.sensitiveValues,
          sanitizedTasks: options.sanitizedTasks,
          stepProvenance: options.stepProvenance,
          authoredExpressions: options.authoredExpressions,
          authoredStep: options.authoredWorkflow?.getJob(job.name)?.getStep(
            options.lane ? step.name : forEachTemplate ?? stepName,
          ),
          emitEvent: push,
          reportFilterOptions: options.reportFilterOptions,
          swampSha: options.swampSha,
          skipCheckNames: options.skipCheckNames,
          skipCheckLabels: options.skipCheckLabels,
          skipAllChecks: options.skipAllChecks,
          initiatedBy: options.initiatedBy,
          dataBaseDir: this.dataBaseDir,
          datastoreResolver: this.datastoreResolver,
          catalogStore: this.catalogStore,
          namespace: this.namespace,
          vaultsDir: this.vaultsDir,
          defaultVaultName: this.defaultVaultName,
          autoGc: this.autoGc,
          runTracker: this.runTracker,
          ephemeralRepo: this.ephemeralRepo,
          ephemeralCatalog: this.ephemeralCatalog,
          workflowRepo: this.workflowRepo,
          workflowRunRepo: this.runRepo,
          workflowGateService: this.workflowGateService,
          workflowPlacement: workflow.placementFields,
          jobPlacement: job.placementFields,
          placementProvenance: placementProvenance(
            workflow,
            job,
            step,
            options.workflowProvenance ?? ProvenanceMap.authored(),
            (options.stepProvenance ?? StepProvenanceOverlay.authored())
              .forStep(step).raw,
          ),
          affinityKey: options.lane ? undefined : resolveAffinityKey(
            workflow.affinity,
            job.affinity,
            run.id,
            job.name,
          ),
          lane: options.lane && { worker: options.lane.worker },
          declaredWrites: step.writes ?? job.writes ?? workflow.writes,
        };
        return this.executeMethod(step, ctx, options);
      });

      // A method that finished after the abort settled its step keeps the
      // data it wrote, but not the step's outcome or its outputs.
      const abandoned = abandonedByAbort(stepRun, options);

      let stepDataHandles:
        | import("../models/model.ts").DataHandle[]
        | undefined;
      if (step.task.isModelMethod() && output && typeof output === "object") {
        const taskOutput = output as {
          model?: string;
          resources?: Record<string, Record<string, DataRecord>>;
          files?: Record<string, Record<string, FileDataRecord>>;
          dataArtifacts?: Array<{
            dataId: string;
            name: string;
            version: number;
            tags: Record<string, string>;
          }>;
          dataHandles?: import("../models/model.ts").DataHandle[];
        };
        stepDataHandles = taskOutput.dataHandles;

        if (taskOutput.dataArtifacts) {
          for (const artifact of taskOutput.dataArtifacts) {
            stepRun.addDataArtifact(artifact);
          }
        }

        if (stepExprContext && taskOutput.model && !abandoned) {
          if (!stepExprContext.model[taskOutput.model]) {
            stepExprContext.model[taskOutput.model] = {
              input: {
                id: "",
                name: taskOutput.model,
                version: 1,
                tags: {},
                globalArguments: {},
              },
            };
          }
          const modelData = stepExprContext.model[taskOutput.model];

          if (taskOutput.resources) {
            if (!modelData.resource) modelData.resource = {};
            for (
              const [specName, instances] of Object.entries(
                taskOutput.resources,
              )
            ) {
              if (!modelData.resource[specName]) {
                modelData.resource[specName] = {};
              }
              Object.assign(modelData.resource[specName], instances);
            }
          }
          if (taskOutput.files) {
            if (!modelData.file) modelData.file = {};
            for (
              const [specName, instances] of Object.entries(taskOutput.files)
            ) {
              if (!modelData.file[specName]) {
                modelData.file[specName] = {};
              }
              Object.assign(modelData.file[specName], instances);
            }
          }
        }
      }

      if (abandoned) return;

      // Strip heavy payload from the run record (see stripResourceContent).
      // Outputs are taken first: the stripped record keeps no attributes.
      liveOutputs = liveStepOutputs(output, this.dataRepo.namespace);
      const lightOutput = step.task.isModelMethod() && output &&
          typeof output === "object"
        ? stripResourceContent(output as Record<string, unknown>)
        : output;
      stepRun.succeed(lightOutput);
      stepSpan.setStatus({ code: SpanStatusCode.OK });
      const executor = output && typeof output === "object" &&
          "executor" in output
        ? (output as { executor?: string }).executor
        : undefined;
      yield {
        kind: "step_completed",
        jobId: job.name,
        stepId: stepName,
        runId: run.id,
        dataHandles: stepDataHandles,
        executor,
        forEachTemplate,
        forEachIndex,
      };
    } catch (error) {
      if (
        error instanceof WorkflowSuspendedError ||
        error instanceof StepStartUnrecordedError
      ) {
        stepSpan.end();
        throw error;
      }
      const errorArtifacts = (error as Record<string, unknown>).dataArtifacts as
        | Array<{
          dataId: string;
          name: string;
          version: number;
          tags: Record<string, string>;
        }>
        | undefined;
      if (errorArtifacts) {
        for (const artifact of errorArtifacts) {
          stepRun.addDataArtifact(artifact);
        }
      }
      // The abort already settled the step; keep its settlement.
      if (abandonedByAbort(stepRun, options)) return;

      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      const errorCode = error instanceof UserError ? error.code : undefined;
      failInFlightStep(stepRun, errorMessage, options, errorCode);
      const isAllowed = !!step.allowFailure;
      if (isAllowed) {
        stepRun.markAllowedFailure();
      }
      stepSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });
      // model/method context goes on step_failed only for model-method tasks:
      // the telemetry bridge uses it to synthesize a child entry for failures
      // before method_executing; other failures leave them undefined
      const taskData = step.task.data;
      const failedDataHandles = taskData.type === "model_method"
        ? recoveredDataHandles(error)
        : [];
      const failedErrorPaths = taskData.type === "model_method"
        ? errorPaths(error)
        : [];
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        runId: run.id,
        error: errorMessage,
        ...(errorCode !== undefined ? { errorCode } : {}),
        allowedFailure: isAllowed || undefined,
        modelName: taskData.type === "model_method"
          ? options.sensitiveValues.masked(taskData.modelIdOrName) as
            | string
            | undefined
          : undefined,
        methodName: taskData.type === "model_method"
          ? options.sensitiveValues.masked(taskData.methodName) as string
          : undefined,
        dataHandles: failedDataHandles.length > 0
          ? failedDataHandles
          : undefined,
        errorPaths: failedErrorPaths.length > 0 ? failedErrorPaths : undefined,
        forEachTemplate,
        forEachIndex,
      };
      // Do not re-throw: merge() continues draining all step generators
      // (allSettled semantics). The job generator tracks failure via step_failed events.
    } finally {
      if (
        stepExprContext?.steps &&
        (stepRun.status === "succeeded" || stepRun.status === "failed" ||
          stepRun.status === "skipped" || stepRun.status === "unknown")
      ) {
        // a lane reads its own steps by their authored names
        stepExprContext.steps[options.lane ? step.name : stepName] =
          attachStepOutputSources(
            { status: stepRun.status, outputs: liveOutputs?.outputs },
            liveOutputs?.sources,
          );
      }
      stepSpan.end();
    }
  }

  /**
   * adds the open signal waits held by nested runs to the suspended event so
   * receivers can name them; a nested run's own suspension is left alone;
   * read-only, a failed read leaves the event as it is
   */
  private async withNestedSignalWaits(
    event: WorkflowExecutionEvent,
    run: WorkflowRun,
    parentRunId?: string,
  ): Promise<WorkflowExecutionEvent> {
    if (
      event.kind !== "suspended" || parentRunId !== undefined ||
      run.findNestedWaits().length === 0
    ) return event;
    try {
      const pending = await new NestedRunLink({
        runRepo: this.runRepo,
        workflowRepo: this.workflowRepo,
        signalWaits: this.signalWaits,
      }).pendingWaits(run);
      const nestedSignalWaits = pending.flatMap(({ action }) =>
        action.kind === "signal"
          ? [{
            workflowId: action.target.workflowId,
            workflowName: action.target.workflowName,
            runId: action.target.runId,
            jobId: action.jobName,
            stepId: action.stepName,
            waitId: action.waitId,
            deadline: action.deadline,
            ...(action.key !== undefined ? { key: action.key } : {}),
          }]
          : []
      );
      return nestedSignalWaits.length > 0
        ? { ...event, nestedSignalWaits }
        : event;
    } catch (error) {
      getSwampLogger(["workflow", "run"]).warn(
        "Could not read the signal waits of the nested runs of run {runId}: {error}",
        {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return event;
    }
  }

  private async checkNestedWaitsSettled(run: WorkflowRun): Promise<void> {
    await assertNestedWaitsSettled(
      {
        runRepo: this.runRepo,
        workflowRepo: this.workflowRepo,
        signalWaits: this.signalWaits,
      },
      run,
    );
  }

  /**
   * settles a re-entered nested workflow step from the child's outcome alone:
   * success adopts outputs, a rejected approval or other finished, missing or
   * broken child fails it, an unfinished or unreadable one suspends again
   */
  private async *settleNestedWait(
    run: WorkflowRun,
    job: Job,
    stepRun: StepRun,
    stepName: string,
    expressionContext: ExpressionContext | undefined,
    allowFailure: boolean,
  ): AsyncGenerator<
    WorkflowExecutionEvent,
    Pick<ResolvedStepOutputs, "outputs" | "sources"> | undefined
  > {
    const link = stepRun.nestedRun;
    // The errors below name the nested run; a malformed link's do not.
    const nestedRun = link?.kind === "valid"
      ? {
        nestedRun: {
          workflowId: link.ref.workflowId,
          workflowName: link.ref.workflowName,
        },
      }
      : {};
    const fail = (error: string): WorkflowExecutionEvent => {
      stepRun.fail(error);
      if (allowFailure) stepRun.markAllowedFailure();
      return {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        runId: run.id,
        error,
        allowedFailure: allowFailure || undefined,
        ...nestedRun,
      };
    };
    if (!link) {
      yield fail(`Step "${stepName}" lost the nested run it waited on.`);
      return undefined;
    }
    const resolved = await new NestedRunLink({
      runRepo: this.runRepo,
      workflowRepo: this.workflowRepo,
    }).resolveChild(run, { jobName: job.name, stepName, link });
    if (resolved.kind === "unreadable") {
      // Readable when the resume checked it: whether it finished is unknown
      // now, so wait on it again instead of failing the step for good.
      getWorkflowRunLogger(run.workflowName, job.name, stepName, run.id)
        .warn`Step ${stepName} waits on its nested run again: ${resolved.reason}`;
      stepRun.waitForNestedRun(resolved.ref);
      run.suspend(expressionContext?.inputs);
      return undefined;
    }
    if (resolved.kind !== "resolved") {
      yield fail(`Cannot read the nested run: ${resolved.reason}.`);
      return undefined;
    }
    const child = resolved.child;
    const childLabel =
      `nested run ${child.id} of workflow "${child.workflowName}"`;
    if (resolved.backLinkDropped) {
      getWorkflowRunLogger(run.workflowName, job.name, stepName, run.id)
        .warn`Read ${childLabel} without its link to this run: an older swamp version saved it. Its trigger source, initiator and start time match this step`;
    }

    if (!isFinishedRun(child)) {
      // Moved back to unfinished since the resume checked it (resumed or
      // retried meanwhile): wait on it again.
      stepRun.waitForNestedRun({
        workflowId: child.workflowId,
        workflowName: child.workflowName,
        runId: child.id,
      });
      run.suspend(expressionContext?.inputs);
      return undefined;
    }

    if (child.status === "succeeded") {
      const outputs = await this.createStepOutputResolver().resolveChildOutputs(
        child,
      );
      // Provenance: who could change the child after the parent suspended is
      // governed by the child workflow's own authorization, so record what
      // its resume was given (key names only, never values).
      const resumeInputs = [...child.resumeInputs];
      if (resumeInputs.length > 0) {
        getWorkflowRunLogger(run.workflowName, job.name, stepName, run.id)
          .info`Adopted outputs of ${childLabel}, which was resumed with inputs ${resumeInputs}`;
      }
      stepRun.succeed({
        type: "workflow",
        workflow: child.workflowName,
        workflowId: child.workflowId,
        runId: child.id,
        status: child.status,
        ...(resumeInputs.length > 0 ? { childResumeInputs: resumeInputs } : {}),
      });
      yield {
        kind: "step_completed",
        jobId: job.name,
        stepId: stepName,
        runId: run.id,
      };
      return outputs;
    }

    if (child.status === "cancelled") {
      yield fail(`The ${childLabel} was cancelled.`);
      return undefined;
    }

    const rejected = child.failedSteps().find((s) => s.approvalRejected);
    if (rejected) {
      const decision = child.getJob(rejected.jobName)?.getStep(
        rejected.stepName,
      )?.approvalDecision;
      const error =
        `Approval of step "${rejected.stepName}" in ${childLabel} was rejected.`;
      if (decision) {
        stepRun.rejectNested(decision, error);
        if (allowFailure) stepRun.markAllowedFailure();
        yield {
          kind: "step_failed",
          jobId: job.name,
          stepId: stepName,
          runId: run.id,
          error,
          ...nestedRun,
          allowedFailure: allowFailure || undefined,
        };
      } else {
        yield fail(error);
      }
      return undefined;
    }
    const childStepError = child.jobs
      .flatMap((j) => j.steps)
      .find((s) => s.status === "failed" && !s.allowedFailure)?.error;
    yield fail(childStepError ?? `The ${childLabel} failed.`);
    return undefined;
  }

  private async *runWorkflowStep(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    stepRun: import("./workflow_run.ts").StepRun,
    stepName: string,
    task: {
      workflowIdOrName: string;
      inputs?: Record<string, unknown> | string;
    },
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
    allowFailure: boolean,
    step: Step,
  ): AsyncGenerator<
    WorkflowExecutionEvent,
    Pick<ResolvedStepOutputs, "outputs" | "sources"> | undefined
  > {
    let taskProvenance = (options.stepProvenance ??
      StepProvenanceOverlay.authored()).forStep(step).raw.subtree("task");
    // The step's passes share one rejection report, so each refused
    // expression is logged once for the step. It is entered around each pass
    // rather than the whole body: a scope cannot span this generator's yields.
    const report = createRejectionReport();
    const inStepReport = <T>(fn: () => T): T =>
      runWithRejectionReport(report, fn);
    // Resolve every available expression in the task before the depth guard,
    // cycle detection and child invocation; vault, env and step-output kinds
    // wait.
    const childPass = expressionContext
      ? await this.expressionEvaluator.passEvaluatorFor(
        options.sensitiveValues,
        { location: `${stepName}.task` },
      )
      : undefined;
    if (expressionContext && childPass) {
      // synchronous pass: make what it reads local first, and authorize the
      // sensitive-field references it can read
      await childPass.prepare(task, expressionContext);
      const resolved = inStepReport(() =>
        resolveAvailableExpressionsTracked(
          task,
          taskProvenance,
          expressionContext,
          (expr, context) => childPass.evaluate(expr, context),
          options.authoredExpressions,
        )
      );
      task = resolved.data as typeof task;
      taskProvenance = resolved.provenance;
    }

    const sourceInputs = task.inputs;
    const childReference = {
      secretBag: new VaultSecretBag(options.sensitiveValues.sentinels),
      destination: "child workflow reference",
      location: `${stepName}.task.workflowIdOrName`,
    };
    task = {
      ...task,
      workflowIdOrName: await inStepReport(() =>
        this.expressionEvaluator.resolveRuntimeExpressionsInData(
          task.workflowIdOrName,
          options.secretRedactor,
          expressionContext,
          options.authoredExpressions,
          taskProvenance.subtree("workflowIdOrName"),
          childReference,
        )
      ) as string,
      inputs: await inStepReport(() =>
        resolveRecordExpression(
          task.inputs,
          "task.inputs",
          expressionContext,
          childPass,
          options.authoredExpressions,
          taskProvenance.subtree("inputs"),
        )
      ),
    };
    taskProvenance = recordProvenance(
      taskProvenance,
      { inputs: sourceInputs },
      task.inputs as Record<string, unknown> | undefined,
      undefined,
      expressionContext,
    );

    // the task target survives the passes above when deferred (it reads step
    // output, or its step has a guard); resolve it here, after the guard has
    // decided and earlier steps have written the data it names
    task = {
      ...task,
      workflowIdOrName: await inStepReport(async () =>
        resolveScalarExpression(
          task.workflowIdOrName,
          "task.workflowIdOrName",
          expressionContext,
          await this.expressionEvaluator.passEvaluatorFor(
            options.sensitiveValues,
            childReference,
          ),
          options.authoredExpressions,
          taskProvenance.subtree("workflowIdOrName"),
        )
      ) as string,
    };

    const depth = options.workflowNestingDepth ?? 0;
    if (depth >= MAX_WORKFLOW_NESTING_DEPTH) {
      const errorMessage =
        `Maximum workflow nesting depth (${MAX_WORKFLOW_NESTING_DEPTH}) exceeded. ` +
        `Workflow "${task.workflowIdOrName}" cannot be invoked at depth ${
          depth + 1
        }.`;
      stepRun.fail(errorMessage);
      if (allowFailure) {
        stepRun.markAllowedFailure();
      }
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        runId: run.id,
        error: errorMessage,
        allowedFailure: allowFailure || undefined,
      };
      return;
    }

    const ancestors = options.ancestorWorkflowIds ?? new Set<string>();
    if (ancestors.has(task.workflowIdOrName)) {
      const chain = [...ancestors, task.workflowIdOrName].join(" -> ");
      const errorMessage = `Workflow cycle detected: ${chain}. ` +
        `A workflow cannot invoke itself directly or indirectly.`;
      stepRun.fail(errorMessage);
      if (allowFailure) {
        stepRun.markAllowedFailure();
      }
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        runId: run.id,
        error: errorMessage,
        allowedFailure: allowFailure || undefined,
      };
      return;
    }

    let evaluatedInputs = task.inputs as Record<string, unknown> | undefined;
    let inputsProvenance = taskProvenance.subtree("inputs");
    if (task.inputs && typeof task.inputs !== "string" && expressionContext) {
      // The parent's authored set: the child re-collects its own from its
      // YAML once it re-enters executeWorkflow.
      const inputs = task.inputs;
      const tracked = await inStepReport(() =>
        this.expressionEvaluator.evaluateDataTracked(
          inputs,
          inputsProvenance,
          expressionContext,
          options.authoredExpressions,
          "passThrough",
        )
      );
      evaluatedInputs = tracked.data as Record<string, unknown>;
      inputsProvenance = tracked.provenance;
    }

    // deferred bindings are persisted by the child, so resume-derived values
    // are left out; vault selectors that read them are bound in the parent
    // first, keeping the reference without copying inputs or fetching a secret
    const deferred = expressionContext
      ? inStepReport(() =>
        this.expressionEvaluator.deferChildInputs(
          evaluatedInputs,
          expressionContext,
          options.authoredExpressions,
          options.resumeDerived,
          inputsProvenance,
        )
      )
      : {
        data: evaluatedInputs,
        deferredExpressions: [],
        provenance: inputsProvenance,
      };
    evaluatedInputs = deferred.data as Record<string, unknown> | undefined;
    inputsProvenance = deferred.provenance;

    // Runtime expressions (env, vault) the parent author wrote as child
    // inputs survive evaluateData unresolved. They are legitimate provenance
    // in the child, so carry exactly those across; anything else left in the
    // inputs arrived as data content and stays refused.
    const childInputExpressions = extractExpressions(evaluatedInputs);
    const inheritedExpressions = new Set(
      childInputExpressions.filter((expr) =>
        !(expr.start !== undefined && expr.end !== undefined &&
          inputsProvenance.overlapsData(expr.path, expr.start, expr.end))
      ).map((expr) => expr.raw).filter((expr) =>
        options.authoredExpressions.has(expr) ||
        deferred.deferredExpressions.some(
          (record) => deferredExpressionReference(record.id) === expr,
        )
      ),
    );
    // the parent's constants (such as a literal() call) whose output the child
    // receives, so the child recognises that text as the parent author's; a
    // constant reads no binding, so it grants the child nothing
    for (
      const constant of authoredConstantsProducing(
        options.authoredExpressions,
        childInputExpressions.map((expr) => expr.raw),
      )
    ) {
      inheritedExpressions.add(constant);
    }

    // Apply the child workflow's input defaults — the top-level
    // workflowRun() libswamp layer does this, but nested invocations
    // bypass it entirely and call run() directly.
    const childWorkflow = await this.lookupWorkflow(task.workflowIdOrName);
    if (childWorkflow?.inputs) {
      const validationService = new InputValidationService();
      evaluatedInputs = validationService.applyDefaults(
        evaluatedInputs ?? {},
        childWorkflow.inputs,
      );
    }

    // share the parent's executor so nested workflows reuse its possibly
    // injected deps instead of building a fresh one per nesting level
    const childAncestors = new Set(ancestors);
    childAncestors.add(workflow.name);

    const childService = new WorkflowExecutionService(
      this.workflowRepo,
      this.runRepo,
      this.repoDir,
      this.executor,
      this.dataBaseDir,
      this.catalogStore,
      undefined,
      this.markDirty,
      this.namespace,
      undefined,
      this.runTracker,
      this.ephemeralRepo,
      this.ephemeralCatalog,
      this.pulledExtensionsRoot,
      this.hydrateFile,
      this.vaultsDir,
      this.datastoreResolver,
      this.autoGc,
      this.fetchForeignContent,
      this.unreadableContent,
      this.defaultVaultName,
      this.durableWriteSync,
    );
    childService.signalWaits = this.signalWaits;
    childService.runCheckpointer = this.runCheckpointer;
    childService.runWriteFence = this.runWriteFence;
    childService.stoppedRuns = this.stoppedRuns;

    let childRun: WorkflowRun | undefined;
    // the child's suspended event is the parent step's outcome, as its
    // completed event is: the parent suspends on it and emits its own
    let childSuspended: WorkflowRun | undefined;
    const childEvents = childService.run(task.workflowIdOrName, {
      inputs: evaluatedInputs,
      inputsProvenance,
      authoredExpressions: inheritedExpressions,
      deferredExpressions: deferred.deferredExpressions,
      workflowNestingDepth: depth + 1,
      ancestorWorkflowIds: childAncestors,
      parentRunId: run.id,
      parentRun: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        runId: run.id,
        jobName: job.name,
        stepName,
        nestingDepth: depth + 1,
        ancestorWorkflowNames: [...childAncestors],
      },
      // The child is owned as its parent is, so cancel routes it to the
      // same place (a serve-owned child is never killed by pid from the CLI).
      instanceId: options.instanceId,
      initiatedBy: options.initiatedBy,
      client: options.client,
      signal: options.signal,
      secretRedactor: options.secretRedactor,
      sensitiveValues: options.sensitiveValues,
      stepStopGraceMs: options.stepStopGraceMs,
    });
    let childEnded = false;
    try {
      try {
        while (true) {
          const next = await childEvents.next();
          if (next.done) {
            childEnded = true;
            break;
          }
          const event = next.value;
          if (event.kind === "completed" || event.kind === "cancelled") {
            // The child's terminal event is the parent step's outcome, never
            // the parent run's: the parent emits its own.
            childRun = event.run;
          } else if (event.kind === "suspended") {
            childSuspended = event.run;
          } else if (event.kind === "step_failed" && allowFailure) {
            // When the parent step allows failure, mark child step_failed
            // events as allowed so they don't set jobFailed in the parent
            // job runner. The parent emits its own step_failed with the
            // correct allowedFailure flag after the child finishes.
            yield { ...event, allowedFailure: true };
          } else {
            yield event;
          }
        }
      } finally {
        if (!childEnded) {
          if (options.signal?.aborted) {
            // After an abort the job runner stops reading this step's events
            // and returns it at its next yield. Run the child to its end,
            // without forwarding, so it still saves itself cancelled.
            while (!(await childEvents.next()).done) {
              // Drained without forwarding.
            }
          } else {
            await childEvents.return(undefined);
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      failInFlightStep(stepRun, errorMessage, options);
      // A nested run that stopped on an unrecorded start stops this run too,
      // whatever the step's allowFailure, so no ancestor carries on past it.
      if (error instanceof StepStartUnrecordedError) {
        this.stoppedRuns.add(run.id);
        throw new StepStartUnrecordedError(error.cause, {
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          runId: run.id,
          stepName,
          jobName: job.name,
          nestedRunId: error.start.nestedRunId ?? error.start.runId,
        });
      }
      if (allowFailure) {
        stepRun.markAllowedFailure();
      }
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        runId: run.id,
        error: errorMessage,
        allowedFailure: allowFailure || undefined,
      };
      return;
    }

    if (!childRun && childSuspended) {
      const ref = {
        workflowId: childSuspended.workflowId,
        workflowName: childSuspended.workflowName,
        runId: childSuspended.id,
      };
      // After an abort the job may already have settled this step, and the
      // run is being cancelled: a suspension must not turn that around.
      if (stepRun.status !== "running" || options.signal?.aborted) {
        if (stepRun.status === "running") {
          stepRun.waitForNestedRun(ref);
          stepRun.detachNestedRun(
            `Cancelled while nested run ${ref.runId} of workflow "${ref.workflowName}" suspended. The nested run was left suspended.`,
          );
          if (allowFailure) stepRun.markAllowedFailure();
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: stepName,
            runId: run.id,
            error: stepRun.error ?? CANCELLED_STEP_ERROR,
            allowedFailure: allowFailure || undefined,
            nestedRun: {
              workflowId: ref.workflowId,
              workflowName: ref.workflowName,
            },
          };
        }
        return undefined;
      }
      stepRun.waitForNestedRun(ref);
      // Return instead of throwing, as the manual_approval branch does, so
      // merge() drains parallel siblings; the post-level save captures it.
      run.suspend(expressionContext?.inputs);
      return undefined;
    }

    if (
      !childRun || childRun.status === "failed" ||
      childRun.status === "cancelled"
    ) {
      const childStepError = childRun?.status === "failed"
        ? childRun.jobs
          .flatMap((j) => j.steps)
          .find((s) => s.status === "failed" && !s.allowedFailure)?.error
        : undefined;
      const errorMessage = childStepError ??
        (childRun?.status === "cancelled"
          ? `Nested workflow "${task.workflowIdOrName}" was cancelled.`
          : `Nested workflow "${task.workflowIdOrName}" failed.`);
      // A child that failed on its own is no work the abort stopped, even
      // when the abort fired before the parent read its end.
      if (childRun?.status === "failed") {
        stepRun.fail(errorMessage);
      } else {
        failInFlightStep(stepRun, errorMessage, options);
      }
      if (allowFailure) {
        stepRun.markAllowedFailure();
      }
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        runId: run.id,
        error: errorMessage,
        allowedFailure: allowFailure || undefined,
      };
      return;
    }

    // The child's outputs go to the live context only. The run record keeps
    // the child's ids so they can be resolved again later, never the values.
    const childOutputs = await this.createStepOutputResolver()
      .resolveChildOutputs(childRun);
    // After an abort the job may already have failed this step as abandoned;
    // a child that finished anyway must not flip it back to succeeded.
    if (options.signal?.aborted && stepRun.status !== "running") {
      return childOutputs;
    }
    stepRun.succeed({
      type: "workflow",
      workflow: task.workflowIdOrName,
      workflowId: childRun.workflowId,
      runId: childRun.id,
      status: childRun.status,
    });
    yield {
      kind: "step_completed",
      jobId: job.name,
      stepId: stepName,
      runId: run.id,
    };
    return childOutputs;
  }

  private executeMethod(
    step: Step,
    ctx: StepExecutionContext,
    options: StepOptions,
  ): Promise<unknown> {
    const dataWrites = options.inFlightMethodRuns?.dataWrites;
    const execution = runWithRejectionReport(
      createRejectionReport(),
      () =>
        this.executor.execute(
          step,
          dataWrites ? { ...ctx, inFlightDataWrites: dataWrites } : ctx,
        ),
    );
    return options.inFlightMethodRuns?.track(execution) ?? execution;
  }

  private buildModelMethodDelegate(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    stepName: string,
    prefix: string,
    stepExprContext: ExpressionContext | undefined,
    options: StepOptions,
  ): Record<string, unknown> {
    return {
      method: async (
        modelName: string,
        methodName: string,
        inputs?: Record<string, unknown>,
      ) => {
        // a forEach-expanded name carries its item value and Step.create
        // applies the authored-name rule, so a control character from data is
        // escaped rather than failing the guard or assert
        const syntheticName = escapeControlCharacters(`${prefix}${stepName}`);
        const syntheticStep = Step.create({
          name: syntheticName,
          task: StepTask.model(modelName, methodName, inputs),
        });
        const result = await this.executeMethod(syntheticStep, {
          workflowId: workflow.id,
          workflowRunId: run.id,
          workflowName: workflow.name,
          jobName: job.name,
          stepName: syntheticName,
          repoDir: this.repoDir,
          signal: options.signal ?? new AbortController().signal,
          expressionContext: stepExprContext,
          catalogStore: this.catalogStore,
          dataBaseDir: this.dataBaseDir,
          datastoreResolver: this.datastoreResolver,
          autoGc: this.autoGc,
          runtimeTags: options.runtimeTags,
          secretRedactor: options.secretRedactor,
          sensitiveValues: options.sensitiveValues,
          sanitizedTasks: options.sanitizedTasks,
          stepProvenance: options.stepProvenance,
          authoredExpressions: options.authoredExpressions,
        }, options);
        const methodResult = result as {
          dataHandles?: Array<{
            name: string;
            specName: string;
            kind: string;
          }>;
        };
        if (methodResult?.dataHandles?.length) {
          const resourceHandle = methodResult.dataHandles.find(
            (h) => h.kind === "resource",
          );
          if (resourceHandle) {
            const def = await findDefinitionByIdOrName(
              this.definitionRepo,
              modelName,
            );
            if (def) {
              // Hand the evaluator the stored record so tagged fields adapt as
              // Secrets without loading values; looked up by the handle's name.
              const resource = await modelMethodResourceResult(
                this.dataRepo,
                def.type,
                def.definition.id,
                resourceHandle.name,
                modelName,
              );
              if (resource !== undefined) return resource;
            }
          }
        }
        return result;
      },
    };
  }

  /**
   * restores a stored run's written references as unloaded sentinels that each
   * delivery loads, so the run is written back with references; a run with none
   * is used as stored
   */
  private rehydrateRun(
    run: WorkflowRun,
    sensitiveValues: RunSensitiveValues,
  ): WorkflowRun {
    // a newer swamp may have written a sensitive value in a form this one does
    // not recognise, so the record is not resumed
    if (isNewerSensitiveFormat(run)) {
      throw new UserError(
        `The run record for "${run.workflowName}" was written by a newer swamp in a format this one cannot read safely, so it is not resumed. Upgrade swamp to resume it.`,
      );
    }
    if (run.writtenReferences.length === 0) {
      run.attachSensitiveValues(sensitiveValues);
      return run;
    }
    return rehydrateRunReferences(run, sensitiveValues);
  }

  /**
   * reads step outputs back from the datastore; sensitive fields are
   * vault-resolved to match a live run, but in a typed run they are read as
   * stored, a tagged field being a Secret loaded at delivery
   */
  private createStepOutputResolver(): StepOutputResolver {
    const readAttributes = createDataRepositoryAttributeReader(this.dataRepo);
    return new StepOutputResolver({
      readAttributes,
      findChildRun: (workflowId, runId) =>
        this.runRepo.findById(
          createWorkflowId(workflowId),
          createWorkflowRunId(runId),
        ),
      namespace: this.dataRepo.namespace,
    });
  }

  private enterJobLevel(
    workflow: Workflow,
    run: WorkflowRun,
    level: readonly string[],
    started: ReadonlySet<string>,
    anyJobFailed: boolean,
    alreadyAfterAbort: boolean,
    signal: AbortSignal | undefined,
    stepOpts: StepOptions,
    expressionContext: ExpressionContext | undefined,
  ): {
    levelSignal: AbortSignal | undefined;
    jobStepOpts: (jobName: string) => StepOptions;
    abortedBeforeLevel: boolean;
    afterAbort: boolean;
  } {
    const aborted = signal?.aborted ?? false;
    const afterAbort = aborted && run.status !== "suspended" &&
      (alreadyAfterAbort ||
        (!anyJobFailed &&
          run.jobs.some((j) => j.status === "succeeded") &&
          !run.jobs.some((j) =>
            j.status === "running" || j.status === "failed" ||
            j.status === "unknown"
          )));
    const cleanupMode = !afterAbort && anyJobFailed && aborted;

    if (cleanupMode || afterAbort) {
      for (const jobRun of run.jobs) {
        if (!started.has(jobRun.jobName)) continue;
        failAbandonedSteps(jobRun);
        if (jobRun.status === "running") {
          jobRun.fail();
        }
      }
    }

    const cleanupJobs = new Set<string>();
    if (afterAbort) {
      for (const jobName of level) {
        const job = workflow.getJob(jobName);
        const jobRun = run.getJob(jobName);
        if (!job || jobRun?.status !== "pending") continue;
        if (jobRunsAfterFailure(job, workflow, run)) {
          cleanupJobs.add(jobName);
          continue;
        }
        settleUnstartedJob(job, jobRun, run);
        // A later cleanup step can read the outcome, as it can a started
        // step's. An undecided step has none. The context is keyed by step
        // name alone, so a step that ran in another job keeps its entry: a
        // teardown is there to read what the run really did.
        for (const stepRun of jobRun.steps) {
          if (stepRun.status !== "pending" && expressionContext?.steps) {
            expressionContext.steps[stepRun.stepName] ??=
              attachStepOutputSources(
                { status: stepRun.status, outputs: undefined },
                undefined,
              );
          }
        }
      }
    }

    const cleanupSignal = cleanupMode || cleanupJobs.size > 0
      ? cleanupGraceSignal(CLEANUP_GRACE_TIMEOUT_MS)
      : undefined;
    const levelSignal = cleanupSignal ?? signal;
    const cleanupStepOpts: StepOptions = {
      ...stepOpts,
      signal: cleanupSignal,
      cleanupJobLevel: true,
    };

    // finishJobLevel settles never-started jobs only on a level the abort
    // interrupted: one reached after it was settled above, or starts nothing.
    return {
      levelSignal,
      jobStepOpts: (jobName) =>
        cleanupMode || cleanupJobs.has(jobName) ? cleanupStepOpts : stepOpts,
      abortedBeforeLevel: levelSignal?.aborted ?? false,
      afterAbort,
    };
  }

  private finishJobLevel(
    workflow: Workflow,
    run: WorkflowRun,
    level: readonly string[],
    started: ReadonlySet<string>,
    anyJobFailed: boolean,
    signal: AbortSignal | undefined,
    levelSignal: AbortSignal | undefined,
    abortedBeforeLevel: boolean,
  ): boolean {
    if (
      !abortedBeforeLevel && levelSignal?.aborted &&
      run.status !== "suspended"
    ) {
      for (const jobName of level) {
        const jobRun = run.getJob(jobName);
        if (jobRun?.status !== "pending") continue;
        const job = workflow.getJob(jobName);
        if (!job) continue;
        settleUnstartedJob(job, jobRun, run);
      }
    }

    if (signal?.aborted && run.status !== "suspended") {
      for (const jobName of level) {
        if (started.has(jobName)) continue;
        const jobRun = run.getJob(jobName);
        if (jobRun?.status !== "running") continue;
        const job = workflow.getJob(jobName);
        if (!job) continue;
        settleNotResumedJob(job, jobRun);
      }
    }

    if (!anyJobFailed && signal?.aborted) {
      return run.jobs.some((j) =>
        j.status === "running" || j.status === "failed" ||
        j.status === "unknown"
      );
    }
    return anyJobFailed;
  }

  private async lookupWorkflow(idOrName: string): Promise<Workflow | null> {
    const byName = await this.workflowRepo.findByName(idOrName);
    if (byName) return byName;

    const id = createWorkflowId(idOrName);
    return await this.workflowRepo.findById(id);
  }

  private async buildRunContext(
    workflow: Workflow,
    sensitiveValues: RunSensitiveValues,
    deferredExpressions: readonly DeferredExpression[] = [],
  ): Promise<ExpressionContext> {
    if (requiresModelNamespace([workflow.toData(), deferredExpressions])) {
      return await this.modelResolver.buildContext(sensitiveValues);
    }

    // A dynamic reference names an unknown definition until the step runs, so
    // keep the full context rather than guess.
    const references = extractStepDefinitionReferences(workflow);
    if (references === null) {
      return await this.modelResolver.buildContext(sensitiveValues);
    }

    if (references.length === 0) {
      return this.modelResolver.buildLightContext(sensitiveValues);
    }

    const definitions = await this.definitionRepo.findAllGlobal();
    const needsModelNamespace = references.some((reference: string) => {
      const found = definitions.find(({ definition }) =>
        definition.name === reference || definition.id === reference
      );
      // An unresolved reference fails at step execution; until then, stay
      // conservative.
      return !found || requiresModelNamespace(found.definition.toData());
    });

    return needsModelNamespace
      ? await this.modelResolver.buildContext(
        sensitiveValues,
        undefined,
        undefined,
        undefined,
        definitions,
      )
      : this.modelResolver.buildLightContext(sensitiveValues);
  }

  async assessRecovery(
    workflowIdOrName: string,
    runId?: string,
  ): Promise<RecoveryAssessment> {
    const workflow = await this.lookupWorkflow(workflowIdOrName);
    if (!workflow) {
      return {
        canAutoRecover: false,
        reason: `Workflow not found: ${workflowIdOrName}`,
        guardedSteps: [],
        unguardedSteps: [],
      };
    }

    const run = await findInterruptedRun(workflow, this.runRepo, runId);
    if (!run) {
      return {
        canAutoRecover: false,
        reason: runId
          ? `Interrupted run ${runId} not found`
          : `No interrupted runs found for workflow "${workflow.name}"`,
        guardedSteps: [],
        unguardedSteps: [],
      };
    }

    return assessRecoveryForRun(workflow, run);
  }

  async *recover(
    workflowIdOrName: string,
    options?: {
      runId?: string;
      acknowledgeUnknown?: boolean;
      signal?: AbortSignal;
      instanceId?: string;
    },
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const assessment = await this.assessRecovery(
      workflowIdOrName,
      options?.runId,
    );

    if (assessment.fingerprintMismatch) {
      throw new UserError(assessment.reason!);
    }

    if (
      !assessment.canAutoRecover && !options?.acknowledgeUnknown
    ) {
      throw new UserError(
        `Cannot auto-recover: ${assessment.reason}\n` +
          `Unguarded steps: ${assessment.unguardedSteps.join(", ")}\n` +
          `Use --acknowledge-unknown to accept re-execution risk for unguarded steps.`,
      );
    }

    if (!assessment.runId || !assessment.workflowId) {
      throw new UserError(assessment.reason ?? "No recoverable run found");
    }

    const workflow = await this.lookupWorkflow(workflowIdOrName);
    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }

    const run = await this.runRepo.findById(
      workflow.id,
      createWorkflowRunId(assessment.runId!),
    );
    if (!run || run.status !== "interrupted") {
      throw new UserError(`Run ${assessment.runId} is no longer interrupted`);
    }

    // The resume below refuses while a nested run is unfinished; checked
    // first so a refused recover leaves the run as it was.
    await this.checkNestedWaitsSettled(run);
    refuseFanOutRecover(workflow, run);
    refuseFanOutRun(workflow, getWorkerPoolReader() !== null);

    await this.runRepo.withdrawSettledStepStarts?.(
      workflow.id,
      run.id,
      run.unknownSteps(),
    );
    run.resetUnknownStepsForRecovery();
    await this.saveRun(workflow.id, run);

    yield* this.resume(workflowIdOrName, run.id, {
      signal: options?.signal,
      instanceId: options?.instanceId,
    });
  }

  private async saveRun(
    workflowId: WorkflowId,
    run: WorkflowRun,
  ): Promise<void> {
    // Checked and tracked in one tick, so the owner closing the fence waits
    // for every save that got past it.
    if (this.runWriteFence.isClosed(run.id)) {
      getSwampLogger(["workflow", "run"]).debug(
        "Not saving workflow run {runId}: another owner has taken its record over",
        { runId: run.id },
      );
      return;
    }
    const mark = this.#runSaveHorizon.begin();
    await this.runWriteFence.track(
      run.id,
      (async () => {
        let refused = false;
        await this.runRepo.save(workflowId, run, {
          fence: this.runWriteFence,
          onRefused: () => {
            refused = true;
          },
        });
        // Only a save that wrote nothing: one the fence closed just after it
        // wrote may be the final record of a run the new owner leaves alone,
        // and the owner waits for this checkpoint to land it.
        if (refused) return;
        try {
          await this.runCheckpointer.checkpoint(run);
        } catch (error) {
          if (!(error instanceof StepStartUnrecordedError)) throw error;
          this.stoppedRuns.add(run.id);
          const parent = run.parentRun;
          if (parent?.kind === "valid") this.stoppedRuns.add(parent.ref.runId);
          const { stepName, jobName } = error.start;
          if (stepName !== undefined && jobName !== undefined) {
            run.getJob(jobName)?.getStep(stepName)?.revertUnrecordedStart();
          }
          throw error;
        }
        this.#runSaveHorizon.landed(run, mark);
      })(),
    );
  }

  /** a step event a landed save already holds needs no save of its own */
  private async saveRunForEvent(
    workflowId: WorkflowId,
    run: WorkflowRun,
    event: WorkflowExecutionEvent,
  ): Promise<void> {
    if (this.#runSaveHorizon.covers(run, event)) return;
    await this.saveRun(workflowId, run);
  }

  async *#stamped(
    events: AsyncGenerator<WorkflowExecutionEvent>,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    for await (const event of events) {
      this.#runSaveHorizon.stamp(event);
      yield event;
    }
  }

  /**
   * a stopped run's error, saying whether its failed record committed, which
   * decides whether a resume or a recovery comes next
   */
  #stoppedRunError(error: unknown, run: WorkflowRun): unknown {
    if (!(error instanceof StepStartUnrecordedError)) return error;
    return error.withEnd(
      this.runCheckpointer.committedLatest?.(run.id) ?? false,
    );
  }

  /**
   * the earlier wait this step should take over: one still open or one a signal
   * was accepted for; a wait past its deadline unsignalled is closed so the
   * step opens a fresh one
   */
  private async adoptableWait(
    waits: SignalWaitStore,
    run: WorkflowRun,
    at: { jobName: string; stepName: string },
    now: Date,
  ): Promise<WaitRegistration | undefined> {
    // Only a run taken up again (a resume, or a recover) can hold one, and
    // the search reads every registration in the store.
    if (this.startedRunIds.has(run.id)) return undefined;
    const earlier = await findRegistrationOfStep(waits, {
      workflowId: run.workflowId,
      runId: run.id,
      ...at,
    });
    if (!earlier) return undefined;
    const outcome = await waits.findOutcome(earlier.waitId);
    const accepted = outcome.kind === "found" &&
      outcome.record.kind === "accepted";
    if (
      accepted || (outcome.kind === "absent" && !isWaitExpired(earlier, now))
    ) {
      return earlier;
    }
    if (outcome.kind === "absent") {
      await waits.settle(cancelledOutcome(earlier, now));
    }
    await waits.removeRegistration(earlier.waitId);
    return undefined;
  }

  /**
   * a datastore that cannot hold wait records gets a store that keeps nothing:
   * the run was suspended before those records existed and its waits end at
   * their deadline, so a resume can still fail them with wait_timeout
   */
  private signalWaitsForSettling(): SignalWaitStore {
    return this.signalWaits.supported
      ? this.signalWaits.store
      : UNSHARED_SIGNAL_WAITS;
  }

  private async openSignalWaits(workflowName: string): Promise<void> {
    this.requireSignalWaits(workflowName);
    await this.readySignalWaits(workflowName);
  }

  /**
   * an unusable store is a refusal naming the workflow; any other failure, such
   * as the network, is passed on as it is rather than reported as a missing
   * capability
   */
  private async readySignalWaits(workflowName: string): Promise<void> {
    if (!this.signalWaits.supported || !this.signalWaits.ready) return;
    try {
      await this.signalWaits.ready();
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      throw new UserError(
        `Workflow "${workflowName}" waits for a signal, which this datastore cannot support: ${error.message}.`,
      );
    }
  }

  private requireSignalWaits(workflowName: string): SignalWaitStore {
    if (this.signalWaits.supported) return this.signalWaits.store;
    throw new UserError(
      `Workflow "${workflowName}" waits for a signal, which this datastore cannot support: ${this.signalWaits.reason}.`,
    );
  }

  private async restoreRunOnFailure<T>(
    { workflowId, snapshot, handBackTrackerRow, claim }: {
      workflowId: WorkflowId;
      snapshot: WorkflowRunData;
      handBackTrackerRow: () => void;
      claim?: ContinuationClaim;
    },
    prepare: () => Promise<T>,
  ): Promise<T> {
    try {
      return await prepare();
    } catch (error) {
      try {
        // Under the claim, and only while the record is still the running
        // one this resume saved: a cancel that settled the run while the
        // resume prepared keeps its record.
        await this.runClaims.withClaim(snapshot.id, async () => {
          const stored = await this.runRepo.findById(
            workflowId,
            createWorkflowRunId(snapshot.id),
          );
          if (stored && stored.status !== "running") return;
          await this.saveRun(workflowId, WorkflowRun.fromData(snapshot));
          // The run is suspended again as it was, so its suspension was
          // not consumed and another resume may take it.
          await this.releaseSuspension(claim);
        });
      } catch (restoreError) {
        getSwampLogger(["workflow", "resume"]).warn(
          "Could not restore run {runId} after a failed resume: {error}",
          {
            runId: snapshot.id,
            error: restoreError instanceof Error
              ? restoreError.message
              : String(restoreError),
          },
        );
      }
      try {
        handBackTrackerRow();
      } catch (restoreError) {
        getSwampLogger(["workflow", "resume"]).warn(
          "Could not restore the tracker row of run {runId} after a failed resume: {error}",
          {
            runId: snapshot.id,
            error: restoreError instanceof Error
              ? restoreError.message
              : String(restoreError),
          },
        );
      }
      throw error;
    }
  }

  private startResumeHeartbeat(
    runId: string,
  ): ReturnType<typeof setInterval> | undefined {
    const tracker = this.runTracker;
    if (!tracker) return undefined;
    return setInterval(() => {
      try {
        tracker.heartbeat(runId);
      } catch {
        // Heartbeat failure is non-fatal
      }
    }, 30_000);
  }

  /**
   * never throws: it runs after the run is saved as running and before the
   * restore that undoes that save, and tracker bookkeeping is best-effort, so a
   * failure is logged and the resume goes on
   */
  private handOverTrackerRow(
    run: WorkflowRun,
    workflowName: string,
    priorStatus: ActiveRunStatus,
    instanceId: string | undefined,
  ): () => void {
    const tracker = this.runTracker;
    if (!tracker) return () => {};
    try {
      const prior = tracker.findById(run.id);
      if (tracker.reactivate(run.id, Deno.pid, hostname(), instanceId)) {
        const status = prior?.status ?? priorStatus;
        // complete with the prior reason, so a settled row is not unsettled
        // again
        const reason = prior?.cancelReason ?? undefined;
        return () => tracker.complete(run.id, status, reason);
      }
      if (prior) return () => {};
      tracker.register(ActiveRun.createWorkflowRun({
        id: run.id,
        workflowName,
        pid: Deno.pid,
        hostname: hostname(),
        initiatedBy: run.initiatedBy,
        instanceId,
      }));
      return () => tracker.complete(run.id, priorStatus);
    } catch (error) {
      getSwampLogger(["workflow", "resume"]).warn(
        "Could not hand the tracker row of run {runId} to this resume: {error}",
        {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return () => {};
    }
  }

  private async *runWorkflowReports(
    workflow: Workflow,
    run: WorkflowRun,
    modelInfoByStep: Map<
      string,
      {
        modelName: string;
        modelType: string;
        modelId: string;
        methodName: string;
      }
    >,
    stepStatuses: Map<string, "succeeded" | "failed" | "skipped">,
    dataHandlesByStep: Map<
      string,
      import("../models/model.ts").DataHandle[]
    >,
    reportFilterOptions:
      | import("../reports/report_execution_service.ts").ReportFilterOptions
      | undefined,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    // Callers that don't thread CLI report flags (workflow resume, embedded
    // runs) still execute reports — required reports must not silently
    // skip. An absent filter means "no filtering", not "no reports".
    const filterOptions = reportFilterOptions ?? {};

    const stepExecutions: WorkflowStepExecutionDetail[] = [];
    for (const [key, status] of stepStatuses) {
      const jobName = jobNameFromCompositeKey(key);
      const stepName = stepNameFromCompositeKey(key);
      const info = modelInfoByStep.get(key);

      // A skipped step records why it was skipped so reports can tell a
      // guard-excluded step from one whose group was deselected. Both reach
      // a report as `skipped` otherwise, and the attestation would flatten
      // them into the same count.
      const skipReason = status === "skipped"
        ? run.getJob(jobName)?.getStep(stepName)?.skipReason
        : undefined;

      if (info) {
        if (status === "skipped") {
          stepExecutions.push({
            jobName,
            stepName,
            taskType: "model_method",
            modelName: info.modelName,
            modelType: info.modelType,
            methodName: info.methodName,
            status,
            dataHandles: [],
            methodArgs: {},
            modelId: info.modelId,
            globalArgs: {},
            skipReason,
          });
          continue;
        }

        // The lookup supplies methodArgs and globalArgs only; modelId comes
        // from step execution since the lookup can return a stale definition.
        const modelType = tryCreateModelType(info.modelType);
        let definition: Definition | null = null;
        if (modelType) {
          definition =
            await this.evaluatedDefRepo.findByName(modelType, info.modelName) ??
              await this.definitionRepo.findByName(modelType, info.modelName);
          if (!definition) {
            // the YAML type field wins over the path, and a step that failed
            // before its evaluated definition was saved falls back to source;
            // only the global search finds those, gated on a matching type
            const global = await this.definitionRepo.findByNameGlobal(
              info.modelName,
            );
            if (global?.type.normalized === modelType.normalized) {
              definition = global.definition;
            }
          }
        }

        stepExecutions.push({
          jobName,
          stepName,
          taskType: "model_method",
          modelName: info.modelName,
          modelType: info.modelType,
          methodName: info.methodName,
          status,
          dataHandles: dataHandlesByStep.get(key) ?? [],
          methodArgs: definition
            ? definition.getMethodArguments(info.methodName)
            : {},
          modelId: info.modelId,
          globalArgs: definition ? definition.globalArguments : {},
          errorMessage: status === "failed"
            ? run.getJob(jobName)?.getStep(stepName)?.error
            : undefined,
        });
      } else {
        const wfJob = workflow.jobs.find((j) => j.name === jobName);
        const wfStep = wfJob?.getStep(stepName) ??
          wfJob?.getStep(
            laneStepOf(stepName, run.getJob(jobName)?.fanOutPlan?.lanes)
              ?.authored ?? "",
          );
        const taskType = wfStep?.task.data.type ?? "unknown";
        stepExecutions.push({
          jobName,
          stepName,
          taskType,
          modelName: "",
          modelType: "",
          methodName: "",
          status,
          dataHandles: [],
          methodArgs: {},
          modelId: "",
          globalArgs: {},
          errorMessage: status === "failed"
            ? run.getJob(jobName)?.getStep(stepName)?.error
            : undefined,
          skipReason,
        });
      }
    }

    const bufferedEvents: WorkflowExecutionEvent[] = [];
    const artifacts = await this.workflowReportRunner.runFor({
      workflow,
      workflowRunId: run.id,
      workflowStatus: run.status === "succeeded" ? "succeeded" : "failed",
      inputs: run.maskedInputs(),
      stepExecutions,
      reportFilterOptions: filterOptions,
      repoDir: this.repoDir,
      runLogger: getWorkflowRunLogger(
        workflow.name,
        undefined,
        undefined,
        run.id,
      ),
      unifiedDataRepo: this.dataRepo,
      definitionRepository: this.definitionRepo,
      emitEvent: (event: WorkflowExecutionEvent) => {
        bufferedEvents.push(event);
      },
    });

    for (const ref of artifacts) {
      run.addWorkflowDataArtifact(ref);
    }

    for (const event of bufferedEvents) {
      yield event;
    }
  }

  private async evaluateWorkflow(
    workflow: Workflow,
    context: ExpressionContext,
    authored: AuthoredExpressions,
  ): Promise<WorkflowEvaluationResult> {
    const evalSpan = getTracer().startSpan("swamp.workflow.evaluate", {
      attributes: { "workflow.name": workflow.name },
    });

    try {
      // the run-start pass of a typed run issues into a bag over the run's
      // registry: a data read returning a Secret leaves as a sentinel and loads
      // nothing for a step a guard may later skip
      const result = await new WorkflowExpressionEvaluator(
        await this.expressionEvaluator.passEvaluatorFor(
          sensitiveValuesOf(context),
          { location: workflow.name },
        ),
      ).evaluate(workflow, context, authored);
      evalSpan.setAttribute(
        "workflow.expressions_evaluated",
        result.expressionsEvaluated,
      );
      evalSpan.setAttributes({
        "workflow.expression_occurrences":
          result.diagnostics.expressionOccurrences,
        "workflow.expressions_distinct": result.diagnostics.distinctExpressions,
        "workflow.cel_evaluations": result.diagnostics.celEvaluations,
        "workflow.model_keys": result.diagnostics.modelKeys,
        "workflow.cel_duration_ms": result.diagnostics.celDurationMs,
        "workflow.provenance_duration_ms":
          result.diagnostics.provenanceDurationMs,
      });
      evalSpan.setStatus({ code: SpanStatusCode.OK });
      warnForeignTaskArguments(workflow.name, result.foreignTaskArguments);
      return result;
    } catch (error) {
      evalSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      evalSpan.end();
    }
  }
}

/**
 * strips heavy payload fields from DataRecords and DataHandles: the full data
 * is in the datastore, and keeping it on the run makes the aggregate grow with
 * cumulative output until large workflows run out of memory
 */
function stripResourceContent(
  output: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...output };

  const resources = output.resources as
    | Record<string, Record<string, DataRecord>>
    | undefined;
  if (resources) {
    const lightResources: Record<
      string,
      Record<
        string,
        Omit<DataRecord, "content" | "attributes"> & {
          content: null;
          attributes: null;
        }
      >
    > = {};
    for (const [specName, instances] of Object.entries(resources)) {
      lightResources[specName] = {};
      for (const [instanceName, record] of Object.entries(instances)) {
        lightResources[specName][instanceName] = {
          ...record,
          content: null,
          attributes: null,
        };
      }
    }
    result.resources = lightResources;
  }

  const dataHandles = output.dataHandles as
    | Array<{ attributes?: Record<string, unknown>; [key: string]: unknown }>
    | undefined;
  if (dataHandles) {
    result.dataHandles = dataHandles.map((handle) => {
      if (!handle.attributes) return handle;
      return { ...handle, attributes: null };
    });
  }

  return result;
}

/**
 * model_resolved always carries the type, so this should succeed; an unexpected
 * type string degrades to empty method/global args, as a lookup miss does,
 * instead of failing report assembly for the run
 */
function tryCreateModelType(rawType: string): ModelType | null {
  try {
    return ModelType.create(rawType);
  } catch {
    return null;
  }
}

const LEVEL_GATE = "level";
const HOST_GATE = "host";

function readGlobalConcurrencyLimit(): number | undefined {
  const raw = Deno.env.get("SWAMP_MAX_CONCURRENT_STEPS");
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function resolveJobConcurrency(workflow: Workflow): number | undefined {
  return resolveEffectiveConcurrency(
    workflow.concurrency,
    readGlobalConcurrencyLimit(),
  );
}

function resolveEffectiveConcurrency(
  local: number | undefined,
  global: number | undefined,
): number | undefined {
  const l = local && local > 0 ? local : undefined;
  const g = global && global > 0 ? global : undefined;
  if (l && g) return Math.min(l, g);
  return l ?? g;
}

/**
 * a stopped run's jobs left running hold steps that never started: unknown,
 * so a resume walks them again
 */
function settleStoppedJobs(error: unknown, run: WorkflowRun): void {
  if (!(error instanceof StepStartUnrecordedError)) return;
  for (const job of run.jobs) {
    job.settleNotResumed();
    // a job that ran on past the stop holds steps that never started
    if (
      job.status === "succeeded" &&
      job.steps.some((step) => step.status === "pending")
    ) {
      job.markUnknown();
    }
  }
}
