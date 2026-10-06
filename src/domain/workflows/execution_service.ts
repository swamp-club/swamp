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
import { mergePlacementFields, resolvePlacement } from "./placement.ts";
import { StepTask } from "./step_task.ts";
import type { AssertSeverity } from "./step_task.ts";
import { severityAtOrAbove } from "./assert_severity.ts";
import {
  type ExpandedStep,
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
import { unclaimedRuns, type WorkflowRunClaims } from "./run_claim.ts";
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
  openSignalWaitMessage,
  schemaExpressions,
  SignalWait,
  WAIT_TIMEOUT_STEP_ERROR,
  WAIT_UNREADABLE_STEP_ERROR,
} from "./signal_wait.ts";
import {
  cancelAndSettle,
  failAbandonedSteps,
  settleNotResumedJob,
  settleNotStartedJob,
  settleUnstartedStep,
  shouldJobRun,
  shouldStepRun,
} from "./abort_settlement.ts";
import {
  checkSuspendedRunResume,
  planFailedRunResume,
  type ResumeReset,
} from "./resume_reset.ts";
import { nextActionForStatus } from "./suspended_run_resolver.ts";
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
import { processLockHolderMarker } from "../datastore/lock_holder_marker.ts";
import type { OutputRepository } from "../models/repositories.ts";
import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import { ActiveRun, type ActiveRunStatus } from "../models/active_run.ts";
import { hostname } from "node:os";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { MethodExecutionService } from "../models/method_execution_service.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { type Namespace, SOLO_NAMESPACE } from "../data/namespace.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import type {
  HydrateFileHook,
  MarkDirtyHook,
} from "../datastore/datastore_sync_service.ts";
import { DataQueryService } from "../data/data_query_service.ts";
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
import {
  WorkflowReportRunner,
  type WorkflowStepExecutionDetail,
} from "./workflow_report_runner.ts";
import { getAutoResolver } from "../extensions/auto_resolver_context.ts";
import {
  DefaultMethodExecutionService,
  recoveredDataHandles,
} from "../models/method_execution_service.ts";
import { DefaultModelValidationService } from "../models/validation_service.ts";
import { buildMethodContext } from "../models/method_context.ts";
import { detectEnvVarUsageInDefinition } from "../models/env_var_detector.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";
import type { MethodExecutionEvent } from "../models/method_events.ts";
import { ModelOutput } from "../models/model_output.ts";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import type { MethodResult, ModelDefinition } from "../models/model.ts";
import {
  type AuthoredExpressions,
  collectAuthoredExpressions,
  ExpressionEvaluationService,
  partitionAuthored,
} from "../expressions/expression_evaluation_service.ts";
import {
  type DeferredExpression,
  deferredExpressionReference,
} from "../expressions/deferred_expression.ts";
import {
  resolveAvailableExpressions,
  resolveAvailableExpressionsPair,
} from "../expressions/available_expression_resolver.ts";
import {
  sensitiveSpliceSanitizer,
  SplicePair,
} from "../expressions/splice_pair.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  mayHoldPlaintextSensitiveValues,
  persistEvaluatedDefinition,
  rehydrateEvaluatedDefinition,
} from "../expressions/persisted_evaluation.ts";
import {
  type PersistedEvaluatedWorkflow,
  persistEvaluatedWorkflow,
  rehydrateEvaluatedWorkflow,
} from "./persisted_workflow.ts";
import {
  extractCelExpression,
  extractExpressions,
  extractInputReferencesFromCel,
  replaceExpressions,
} from "../expressions/expression_parser.ts";
import { requiresModelNamespace } from "../expressions/dependency_extractor.ts";
import { extractStepDefinitionReferences } from "./model_reference_extractor.ts";
import {
  type DataRecord,
  type ExpressionContext,
  type FileDataRecord,
  ModelResolver,
} from "../expressions/model_resolver.ts";
import {
  CelEvaluator,
  createExtensionCelEnvironment,
} from "../../infrastructure/cel/cel_evaluator.ts";
import {
  collectWorkflowAuthoredExpressions,
  DefinitionExpressionEvaluator,
  type SanitizedTaskOverlay,
  type WorkflowEvaluationResult,
  WorkflowExpressionEvaluator,
} from "./expression_evaluators.ts";
import {
  assertMethodArgumentsEvaluated,
  type FailedExpressions,
} from "../expressions/unresolved_expression_guard.ts";
import { errorPaths, UserError } from "../errors.ts";
import {
  getRunLogger,
  getSwampLogger,
  getWorkflowRunLogger,
  runFileSink,
} from "../../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import {
  rehydratePersistedForm,
  RunSensitiveValues,
  SecretRedactor,
} from "../secrets/mod.ts";
import { VaultService } from "../vaults/vault_service.ts";
import {
  createDataRepositoryAttributeReader,
  liveStepOutputs,
  StepOutputResolver,
} from "./step_output_resolver.ts";
import { mergeWithConcurrency } from "../../infrastructure/stream/merge.ts";
import { withEventBridge } from "../../infrastructure/stream/event_bridge.ts";
import type { ReportFilterOptions } from "../reports/report_execution_service.ts";
import {
  bindGeneratorToSpan,
  getTracer,
  type Span,
  SpanStatusCode,
} from "../../infrastructure/tracing/mod.ts";
import { extractSensitiveFieldValues } from "../models/sensitive_field_extractor.ts";
import { getRemoteStepDispatcher } from "../remote/remote_dispatch.ts";
import { minOf } from "../array_extrema.ts";

/** Parent-scope roots a deferred expression may read; anything else is scope-free. */
const SCOPED_REFERENCE = /\b(inputs|self|run|steps)\b/;

/**
 * Replaces deferred references whose expression reads no parent scope with
 * their authored text and vouches for that text. Scoped references are kept.
 */
function inlineUnscopedDeferred<T>(
  data: T,
  records: readonly DeferredExpression[],
  authored: ReadonlySet<string>,
): { data: T; authored: ReadonlySet<string> } {
  const byReference = new Map(
    records.map((record) => [deferredExpressionReference(record.id), record]),
  );
  const values = new Map<string, unknown>();
  const vouched = new Set(authored);
  for (const expr of extractExpressions(data)) {
    const record = byReference.get(expr.raw);
    if (!record || SCOPED_REFERENCE.test(record.expression)) continue;
    values.set(expr.raw, record.expression);
    vouched.add(record.expression);
  }
  return { data: replaceExpressions(data, values) as T, authored: vouched };
}

/** Replaces sensitive values in a definition's tag values with placeholders. */
function withTagPlaceholders(
  definition: Definition,
  sensitiveValues: RunSensitiveValues,
): void {
  for (const [key, value] of Object.entries(definition.tags)) {
    const placeholder = sensitiveValues.withPlaceholders(value);
    if (placeholder !== value) definition.setTag(key, placeholder);
  }
}

/** A step task's inputs and global arguments, as they move through a pair. */
type TaskArgs = {
  inputs?: Record<string, unknown> | string;
  globalArgs?: Record<string, unknown> | string;
};

/** The step's input records as a pair; absent inputs are empty. */
function stepInputPair(
  taskArgs: SplicePair<TaskArgs>,
): SplicePair<Record<string, unknown>> {
  const record = (value: TaskArgs["inputs"]) =>
    (value ?? {}) as Record<string, unknown>;
  return new SplicePair(
    record(taskArgs.raw.inputs),
    record(taskArgs.sanitized.inputs),
  );
}

/**
 * The executed copy of a direct-execution step's definition. The resolver
 * routed and coerced the raw members; the same key routing applies to the
 * sanitized members. Coercion changes values by content (a `"true"` string
 * becomes a boolean), so a key whose value coercion changed takes the coerced
 * raw value with sensitive values sentinelized, rather than the uncoerced
 * sanitized one.
 */
function sanitizedDirectExecution(
  result: DirectTypeResolveResult,
  taskArgs: SplicePair<TaskArgs>,
  bag: VaultSecretBag,
  sensitiveValues: RunSensitiveValues,
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
  const secrets = sensitiveValues.list().map((entry) => entry.value);
  for (const key of Object.keys(rawSource)) {
    if (!explicit && Object.hasOwn(result.routedMethodInputs, key)) continue;
    if (!Object.hasOwn(globals, key)) continue;
    const coerced = globals[key];
    const sanitized = JSON.stringify(rawSource[key]) === JSON.stringify(coerced)
      ? sanitizedSource[key]
      : bag.sentinelizeValues(coerced, secrets);
    if (JSON.stringify(sanitized) !== JSON.stringify(coerced)) {
      definition.setGlobalArgument(key, sanitized);
    }
  }
  return { definition, methodInputs };
}

/**
 * Resolves a task field that may be a record, an expression string, or a
 * non-record value left behind by resolveAvailableExpressions. Returns a
 * validated Record or undefined. Throws UserError for user-authored mistakes
 * (wrong expression result type, missing context).
 */
async function resolveRecordExpression(
  value: Record<string, unknown> | string | undefined,
  fieldName: string,
  expressionContext: Record<string, unknown> | undefined,
  authored: AuthoredExpressions,
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
  if (!expressionContext) {
    throw new UserError(
      `${fieldName} expression "$\{{ ${cel} }}" could not be resolved: no expression context available`,
    );
  }
  if (partitionAuthored(extractExpressions(value), authored).length !== 1) {
    throw new UserError(`${fieldName} must be an authored record expression`);
  }
  const celEvaluator = new CelEvaluator();
  const resolved = await celEvaluator.evaluateAsync(cel, expressionContext);
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
 * Resolves a scalar expression that survived `resolveAvailableExpressions` —
 * the task target, deferred past run-start evaluation when it reads step
 * output or when its step carries a guard.
 *
 * The record sibling above cannot serve: a target evaluates to a name, not a
 * record. Provenance is checked the same way, so a target assembled out of
 * substituted data is refused rather than executed. A target interpolating a
 * deferred expression into literal text (`stage-${{ data.latest(...) }}`) is
 * resolved expression by expression, as run-start evaluation would have.
 */
async function resolveScalarExpression(
  value: string | undefined,
  fieldName: string,
  expressionContext: Record<string, unknown> | undefined,
  authored: AuthoredExpressions,
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
  if (partitionAuthored(expressions, authored).length !== expressions.length) {
    throw new UserError(`${fieldName} must be an authored expression`);
  }
  const celEvaluator = new CelEvaluator();
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
 * Extracts a human-readable reason from an AbortSignal. Returns the
 * Error message when the reason is an Error, or "aborted" otherwise.
 */
function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "aborted";
}

/**
 * Coerces resume override inputs to their declared types and checks them
 * against the workflow's input schema, as `workflow run` does for a fresh
 * run. Only the supplied keys are checked, each by its value merged over the
 * run's stored inputs: a partial nested override (`--input creds.key=new`)
 * is complete only once merged. Keys not supplied are not re-checked. Throws
 * a UserError coded `input_validation_failed`, the code `workflow run` uses.
 * The run id comes before the detail so serve's 512-character error limit
 * cuts the detail.
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
 * Thrown when a manual_approval step suspends the workflow. Uses an
 * exception for control flow because the generator stack (runStep →
 * runJob → merge → run) has no other way to unwind cleanly — yield
 * can only travel one frame up, but suspension must exit the entire
 * execution. Caught by run() and resume() to yield the terminal
 * suspended event. Also re-detected after mergeWithConcurrency via
 * run.status === "suspended" since merge() swallows errors from
 * parallel streams.
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

function mergeDataOutputOverrides(
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
      merged[idx] = stepOvr;
    } else {
      merged.push(stepOvr);
    }
  }
  return merged;
}

/**
 * Context for step execution.
 */
export interface StepExecutionContext {
  workflowId: WorkflowId;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  repoDir: string;
  pulledExtensionsRoot?: string;
  /** Cancellation signal threaded from the libswamp entry point. */
  signal: AbortSignal;
  /** Expression context for evaluating ${{ }} expressions */
  expressionContext?: ExpressionContext;
  /** Current workflow run (for log file references in model outputs) */
  workflowRun?: WorkflowRun;
  /** The step being executed (for accessing data output overrides) */
  step?: Step;
  /** Callback to emit events into the parent event stream */
  emitEvent?: (event: WorkflowExecutionEvent) => void;
  /**
   * Evaluation mode for the step:
   * - `"fresh"` (default): evaluate CEL expressions against the current
   *   expression context, then cache the evaluated definition.
   * - `"lastEvaluated"`: skip CEL evaluation; load the previously-cached
   *   evaluated definition. Used when `--last-evaluated` is passed at
   *   the CLI to re-run a workflow without re-evaluating expressions.
   *
   * Both modes still require `expressionContext` because runtime
   * expressions (vault, env) and step-output tracking need it.
   */
  mode?: "fresh" | "lastEvaluated";
  /** forEach iteration variable (e.g., { env: "dev" } for self.env) */
  forEachVariable?: { name: string; value: unknown };
  /** Zero-based forEach iteration index, exposed as self._index */
  forEachIndex?: number;
  /**
   * Expressions written in the workflow source, unioned with the executing
   * model's own source definition before every post-substitution pass.
   * See {@link collectAuthoredExpressions}.
   */
  authoredExpressions: ReadonlySet<string>;
  /**
   * The step as written in the workflow source, before the workflow evaluator
   * substituted values into it. A direct-execution step validates the
   * definition it builds from its evaluated arguments, so the template-syntax
   * scan reads the authored arguments from here instead (swamp-club#2496).
   * Absent when the source step is not known; validation then scans the
   * definition as it is.
   */
  authoredStep?: Step;
  /** Tags from the workflow definition, merged into data writer tag overrides */
  workflowTags?: Record<string, string>;
  /** Runtime tags from --tag CLI flags, passed to method execution context */
  runtimeTags?: Record<string, string>;
  /** Secret redactor for stripping vault secrets from persisted data and logs */
  secretRedactor?: SecretRedactor;
  /**
   * The run's record of sensitive values resolved for expressions. Required,
   * so no step can resolve a sensitive value without recording it.
   */
  sensitiveValues: RunSensitiveValues;
  /**
   * Task inputs and global arguments as each step should execute them, where
   * workflow evaluation spliced sensitive values into them.
   */
  sanitizedTasks?: SanitizedTaskOverlay;
  /** Report filter options for per-step report execution */
  reportFilterOptions?: ReportFilterOptions;
  /** The git commit sha of the swamp repo at execution time */
  swampSha?: string;
  /** Check names to skip during pre-flight checks */
  skipCheckNames?: string[];
  /** Skip checks that have any of these labels */
  skipCheckLabels?: string[];
  /** Skip all pre-flight checks */
  skipAllChecks?: boolean;
  /** Identity of the user who initiated this run */
  initiatedBy?: string;
  /** Resolved base directory for data storage (S3 cache path) */
  dataBaseDir?: string;
  /**
   * Resolves the datastore-tier subdirs (outputs, evaluated definitions,
   * auto-definitions) the step's repositories read and write. Unset keeps
   * them under the repo-local `.swamp/`.
   */
  datastoreResolver?: DatastorePathResolver;
  /** Catalog store for write-through indexing */
  catalogStore: CatalogStore;
  /**
   * Giga-swamp namespace stamped on data this step writes. Defaults to
   * SOLO_NAMESPACE when unset, keeping the catalog stamp in lockstep with the
   * namespaced data path.
   */
  namespace?: Namespace;
  /** Resolved vault config directory (managed config tier or local vaults/) */
  vaultsDir?: string;
  runTracker?: RunTrackerRepository;
  ephemeralRepo?: UnifiedDataRepository;
  ephemeralCatalog?: CatalogStore;
  workflowRepo?: WorkflowRepository;
  workflowRunRepo?: WorkflowRunRepository;
  workflowGateService?:
    import("../models/workflow_gate_service.ts").WorkflowGateService;
  /** Workflow-level placement defaults (inherited by all steps unless overridden) */
  workflowPlacement?: import("./placement.ts").PlacementFields;
  /** Job-level placement defaults (inherited by steps in this job unless overridden) */
  jobPlacement?: import("./placement.ts").PlacementFields;
  /**
   * Worker affinity key. When set, all steps sharing this key are pinned
   * to the same remote worker. Computed from workflow/job affinity settings.
   */
  affinityKey?: string;
  /**
   * Effective `writes` declaration, merged workflow → job → step (child wins).
   * When true, forces fail-instead-of-redispatch on worker disconnect.
   */
  declaredWrites?: boolean;
}

/**
 * Executor interface for running step tasks.
 */
export interface StepExecutor {
  /**
   * Executes a step task.
   *
   * @param step - The step to execute
   * @param ctx - Execution context
   * @returns The step output
   */
  execute(step: Step, ctx: StepExecutionContext): Promise<unknown>;
}

/**
 * Grace period for cleanup steps (always/completed dependents) after
 * cancellation. Cleanup steps run with a fresh signal bounded by this
 * timeout so they cannot hang indefinitely.
 */
export const CLEANUP_GRACE_TIMEOUT_MS = 30_000;

/**
 * Waits, at most {@link CLEANUP_GRACE_TIMEOUT_MS}, for the nested workflow
 * steps still in flight to settle. After an abort the job runner stops reading
 * a step's events, so a nested step finishes its child run in the background;
 * the parent waits here so the child saves itself cancelled before the parent
 * records its own cancellation.
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
 * How long after its abort a cancelled run waits for the model methods it
 * started to stop (see {@link InFlightMethodRuns}). It covers the shell
 * executor's 3 s SIGTERM-to-SIGKILL grace (an aborted step skips the pipe
 * drain) and the save of the cancelled method-run output; the method-summary
 * report and lock flush that follow the save may take longer. It stays under
 * serve's 5 s abort graces, so serve still sees an aborted run finish.
 */
export const STEP_STOP_GRACE_MS = 4_000;

/**
 * The model-method executions of one run still in flight, and when the run's
 * signal aborted.
 *
 * After an abort a level of several steps stops reading them, and the run
 * settles and saves itself cancelled while their methods are still stopping.
 * The CLI then exits and kills them before they save their method-run records,
 * which stay `running` (swamp-club#2918). The run waits here, until
 * `stepStopGraceMs` after the abort, so each method records its own
 * cancellation first.
 */
class InFlightMethodRuns {
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

  /** Holds `execution` until it settles, and returns it. */
  track<T>(execution: Promise<T>): Promise<T> {
    const release = () => {
      this.#pending.delete(settled);
    };
    const settled: Promise<void> = execution.then(release, release);
    this.#pending.add(settled);
    return execution;
  }

  /**
   * Waits for the executions in flight, until `graceMs` after the abort. The
   * deadline counts from the abort, not from this call, so the serve graces
   * that also start at the abort still see the run finish; a run whose
   * cleanup outlasted the grace does not wait at all.
   */
  async settle(graceMs: number): Promise<void> {
    if (this.#pending.size === 0) return;
    const remaining = (this.#abortedAt ?? performance.now()) + graceMs -
      performance.now();
    if (remaining <= 0) return;
    getSwampLogger(["workflow", "cancel"]).info(
      "Waiting up to {seconds}s for {count} model method(s) to stop",
      {
        seconds: Math.ceil(remaining / 1000),
        count: this.#pending.size,
      },
    );
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

  /** Stops listening to the run's signal. */
  dispose(): void {
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }
}

/**
 * Waits for the work a cancelled run left in flight before the run records
 * its cancellation: its nested workflow steps (see {@link awaitNestedRuns})
 * and its model methods (see {@link InFlightMethodRuns}).
 */
async function awaitInFlightWork(
  nestedRuns: ReadonlySet<Promise<void>>,
  methodRuns: InFlightMethodRuns,
  stepStopGraceMs: number | undefined,
): Promise<void> {
  await Promise.all([
    awaitNestedRuns(nestedRuns),
    methodRuns.settle(stepStopGraceMs ?? STEP_STOP_GRACE_MS),
  ]);
}

/**
 * Whether the run's abort already settled this step while it ran: a level of
 * several steps stops reading them, and the job fails the ones still running
 * as cancelled (failAbandonedSteps). A method that answers after that must
 * not overwrite the settlement; its method-run record keeps its own outcome.
 */
function abandonedByAbort(stepRun: StepRun, options: StepOptions): boolean {
  return (options.signal?.aborted ?? false) && stepRun.status !== "running";
}

/**
 * Runs a nested workflow step's stream, holding a promise in `nestedRuns`
 * until the stream ends so the run can wait for it (see
 * {@link awaitNestedRuns}).
 */
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
 * Decode the step-name segment of a `${jobId}:${stepName}` composite key.
 *
 * Splits on the FIRST colon only, so step names that themselves contain
 * colons (e.g. `docker:build`) round-trip without truncation. Returns ""
 * when the key has no colon.
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
 * Translate a {@link WorkflowRun} status into the tracker's vocabulary.
 *
 * The run tracker is a projection of the aggregate, so its row must report
 * the outcome the aggregate derived — not merely that the process finished.
 * `pending`, `running` and `succeeded` all map to `completed`: the first two
 * cannot reach a completion path, and they are listed only to keep the switch
 * exhaustive. There is no `default` on purpose — a status added to the
 * aggregate later fails the type check here instead of being read as success.
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
 * The suspended event for a run that suspended at a level checkpoint: its
 * waiting approval gate, or else the nested workflow step waiting on a
 * suspended child run (swamp-club#2736). Undefined when neither waits.
 */
function suspendedEventFor(
  run: WorkflowRun,
  workflow: Workflow,
): WorkflowExecutionEvent | undefined {
  const waiting = run.findWaitingApprovalStep();
  if (waiting) {
    const taskData = workflow.jobs
      .find((j) => j.name === waiting.jobName)?.steps
      .find((s) => s.name === waiting.stepName)?.task.data;
    return {
      kind: "suspended",
      run,
      jobId: waiting.jobName,
      stepId: waiting.stepName,
      prompt: taskData?.type === "manual_approval" ? taskData.prompt : "",
      timeout: taskData?.type === "manual_approval"
        ? taskData.timeout
        : undefined,
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
 * The global arguments the template-syntax scan reads for a definition that a
 * direct-execution step built from its own arguments (swamp-club#2496).
 *
 * Such a definition holds the values after the workflow evaluator substituted
 * them, so a CEL concatenation that builds `{{env.name}}`, or a workflow input
 * carrying it, would read as a `${{` with its `$` dropped. Each key this step
 * supplied is scanned as the author wrote it instead. When the step wrote its
 * arguments as one whole-field expression, evaluation produced every key, so
 * none of them is scanned. Keys the step did not supply, kept from a stored
 * definition, are scanned as stored when an author wrote that definition, and
 * not at all when it is an auto-definition, whose stored values are another
 * run's evaluated arguments. A supplied key the definition does not hold
 * never reaches the method, so it is not scanned at all.
 *
 * @param definitionGlobals - The built definition's global arguments
 * @param suppliedKeys - The global argument keys this step supplied
 * @param authored - The step's authored arguments those keys came from: its
 *   `globalArgs`, or its `inputs` when they were routed to global arguments
 * @param scanStored - Whether keys the step did not supply are authored text
 *   to scan: true for a definition in `models/`, false for an auto-definition
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

/**
 * Infrastructure dependencies the {@link DefaultStepExecutor} needs to
 * run a model method. Inject this for tests so the executor can be
 * exercised without disk, real vaults, or YAML on the filesystem.
 *
 * In production, callers either build deps explicitly via
 * {@link DefaultStepExecutor.fromRepoDir} or rely on the no-arg
 * constructor's lazy per-call construction (today's behaviour).
 */
export interface DirectTypeResolveResult {
  definition: Definition;
  modelType: ModelType;
  created: boolean;
  routedMethodInputs: Record<string, unknown>;
  /** Expressions written in the stored definition; empty when created. */
  authoredExpressions?: ReadonlySet<string>;
}

export type DirectTypeResolver = (
  typeArg: string,
  definitionName: string,
  methodName: string,
  inputs: Record<string, unknown>,
  globalArgs: Record<string, unknown> | undefined,
  /** Expressions written in the workflow source; see {@link AuthoredExpressions}. */
  authoredExpressions: AuthoredExpressions,
  /**
   * The run's record, so sensitive values routed into the stored definition
   * are written as the vault references they came from.
   */
  sensitiveValues?: RunSensitiveValues,
) => Promise<DirectTypeResolveResult>;

export interface StepLockResult {
  flush: () => Promise<void>;
  /**
   * The nonces of the lock files the hook took. The step runs inside
   * `processLockHolderMarker.runHolding` with them, so a swamp the step
   * starts skips these locks and not those of parallel steps. A hook that
   * leaves it out runs the step outside any scope, so that swamp matches
   * this process's locks on the pid alone and never waits on the step's
   * own lock.
   */
  heldLockIds?: readonly string[];
}

export type StepLockHook = (
  modelType: string,
  modelId: string,
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
  directTypeResolver?: DirectTypeResolver;
  runTracker?: RunTrackerRepository;
  /**
   * Whether a definition `definitionRepo` returned was loaded from the
   * auto-definitions directory, which swamp writes from a run's evaluated
   * arguments. Its stored global arguments are then not linted as authored
   * text (swamp-club#2496). Absent, every definition counts as authored.
   */
  isAutoDefinition?: (
    definition: Definition,
    type: ModelType,
  ) => Promise<boolean>;
}

/**
 * Default step executor that handles model methods and workflow invocations.
 */
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
  ) {
    this._directTypeResolver = directTypeResolver;
  }

  /**
   * Build a fully-wired DefaultStepExecutor for production use. Performs
   * the same construction the no-arg path does at execute() time, just
   * once at the seam — so callers that have a repoDir at construction
   * time can avoid per-call rebuild of repos and the vault service.
   */
  static async fromRepoDir(
    repoDir: string,
    opts: {
      dataBaseDir?: string;
      datastoreResolver?: DatastorePathResolver;
      catalogStore: CatalogStore;
      markDirty?: MarkDirtyHook;
      hydrateFile?: HydrateFileHook;
      namespace?: Namespace;
      vaultsDir?: string;
    },
  ): Promise<DefaultStepExecutor> {
    return new DefaultStepExecutor(
      await DefaultStepExecutor.buildDeps(repoDir, opts),
    );
  }

  /**
   * Construct deps either from the injected set (tests) or per-call
   * from the StepExecutionContext (production no-arg path — today's
   * behaviour preserved exactly).
   */
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
      namespace: ctx.namespace,
      vaultsDir: ctx.vaultsDir,
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
      namespace?: Namespace;
      vaultsDir?: string;
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
      vaultService: await VaultService.fromRepository(repoDir, {
        vaultsDir: opts.vaultsDir,
      }),
      expressionEvaluator: new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
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

    // Compute effective placement by merging workflow → job → step defaults.
    // Each level inherits from its parent; explicit values (including {})
    // override inherited ones. The merge happens here — after forEach
    // expansion but before expression resolution — so inherited fields are
    // available for expression resolution.
    const effectiveFields = mergePlacementFields(
      mergePlacementFields(ctx.workflowPlacement, ctx.jobPlacement),
      ctx.step?.placementFields,
    );
    let resolvedPlacement = resolvePlacement(effectiveFields);

    // This step's bag. Sensitive data values spliced into the step's
    // arguments become its sentinels: from the workflow-level overlay, the
    // step-input passes, the definition pass and the runtime pass. One bag
    // per step, so remote dispatch ships only this step's secrets.
    const stepSecretBag = new VaultSecretBag();
    const argumentSanitizer = sensitiveSpliceSanitizer(
      ctx.sensitiveValues,
      stepSecretBag,
    );
    // The step's task inputs and global arguments twice: raw for CEL
    // contexts, coercion, routing, caching and reports; sanitized for the
    // arguments that execute.
    const overlay = ctx.step
      ? ctx.sanitizedTasks?.forStep(ctx.step, stepSecretBag)
      : undefined;
    let taskArgs = new SplicePair<TaskArgs>(
      { inputs: task.inputs, globalArgs: task.globalArgs },
      overlay
        ? {
          inputs: overlay.inputs as TaskArgs["inputs"],
          globalArgs: overlay.globalArgs as TaskArgs["globalArgs"],
        }
        : { inputs: task.inputs, globalArgs: task.globalArgs },
    );

    // Resolve every available expression (self.* from the forEach variable,
    // run.*, etc.) anywhere in the task and placement fields before model
    // lookup. The expression context has self populated with the forEach
    // variable by runStep(). resolveAvailableExpressions defers vault/env and
    // step-output kinds to their dedicated stages — see
    // available_expression_resolver.ts.
    if (ctx.expressionContext) {
      const celEvaluator = new CelEvaluator();
      const evaluate = (expr: string, context: Record<string, unknown>) =>
        celEvaluator.evaluate(expr, context);
      task = resolveAvailableExpressions(
        task,
        ctx.expressionContext,
        evaluate,
        ctx.authoredExpressions,
      ) as typeof task;
      taskArgs = resolveAvailableExpressionsPair(
        taskArgs,
        ctx.expressionContext,
        evaluate,
        ctx.authoredExpressions,
        argumentSanitizer,
      );
      task = { ...task, ...taskArgs.raw };
      if (resolvedPlacement) {
        resolvedPlacement = resolveAvailableExpressions(
          resolvedPlacement,
          ctx.expressionContext,
          evaluate,
          ctx.authoredExpressions,
        ) as typeof resolvedPlacement;
      }
    }

    if (resolvedPlacement) {
      resolvedPlacement = await expressionEvaluator.resolveAllExpressionsInData(
        resolvedPlacement,
        ctx.expressionContext ?? { model: {}, env: {} },
        ctx.secretRedactor,
        ctx.authoredExpressions,
      ) as typeof resolvedPlacement;
    }

    if (resolvedPlacement && ctx.affinityKey) {
      resolvedPlacement = {
        ...resolvedPlacement,
        affinityKey: ctx.affinityKey,
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
      ) as typeof selectors,
    };

    // The task target survives resolveAvailableExpressions when it was
    // deferred past run-start evaluation — a target reading step output, or
    // any dynamic target on a guarded step. Resolve it here, after the guard
    // has already decided: runStep returns early on a guarded skip and never
    // reaches this executor, so a step that will not run never resolves the
    // target it would have used.
    task = {
      ...task,
      modelIdOrName: await resolveScalarExpression(
        task.modelIdOrName,
        "task.modelIdOrName",
        ctx.expressionContext,
        ctx.authoredExpressions,
      ),
      modelName: await resolveScalarExpression(
        task.modelName,
        "task.modelName",
        ctx.expressionContext,
        ctx.authoredExpressions,
      ),
    };

    // Resolve whole-field expression strings for inputs/globalArgs that survived
    // resolveAvailableExpressions (e.g., deferred step-output dependencies).
    const recordInputs = await resolveRecordExpression(
      task.inputs,
      "task.inputs",
      ctx.expressionContext,
      ctx.authoredExpressions,
    );
    const recordGlobalArgs = await resolveRecordExpression(
      task.globalArgs,
      "task.globalArgs",
      ctx.expressionContext,
      ctx.authoredExpressions,
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
    );
    task = { ...task, inputs: recordInputs, globalArgs: recordGlobalArgs };

    let originalDefinition: Definition;
    let modelType: ModelType;
    /**
     * Expressions contributed by the model's own source definition.
     * Only a definition loaded from the repository is author-written: a
     * direct-execution definition that was just created is synthesised from
     * `task.inputs`, which the workflow evaluator has already substituted data
     * into, so treating it as a provenance root would re-admit exactly the
     * injected text this gate exists to refuse. When direct execution reuses
     * a stored definition, the resolver reports that definition's expressions
     * as collected before caller-supplied global arguments were applied —
     * sound because direct execution refuses to persist any expression text
     * the caller cannot vouch for, so nothing stored is substituted content.
     */
    let authoredFromDefinition: ReadonlySet<string> = new Set();

    let authoredForDirect = ctx.authoredExpressions;
    // The definition the executed copy starts from when a direct-execution
    // step routed sanitized values into it; otherwise the loaded definition.
    let executedBase: Definition | undefined;
    let sanitizedStepInputs: Record<string, unknown> | undefined;
    // Global arguments the template-syntax scan reads in place of a
    // definition's evaluated ones; see templateScanGlobalArguments.
    let authoredGlobalArguments: Record<string, unknown> | undefined;
    const isAutoDefinition = (definition: Definition, type: ModelType) =>
      allDeps.isAutoDefinition?.(definition, type) ?? Promise.resolve(false);
    if (task.modelType && task.modelName) {
      const resolver = allDeps.directTypeResolver;

      if (!resolver) {
        throw new Error(
          "Direct type execution is not supported in this context",
        );
      }

      // Direct execution may persist these values into a definition. A
      // deferred reference whose expression needs no parent scope (env,
      // literal vault.get) is restored to its authored text, which persists
      // and resolves exactly as it did before deferral. Scoped references
      // stay as tokens and are refused by resolveOrCreateDefinition if they
      // route to global arguments.
      const inlined = inlineUnscopedDeferred(
        { inputs: task.inputs, globalArgs: task.globalArgs },
        ctx.expressionContext?.deferredExpressions ?? [],
        ctx.authoredExpressions,
      );
      const inlinedSanitized = inlineUnscopedDeferred(
        taskArgs.sanitized,
        ctx.expressionContext?.deferredExpressions ?? [],
        ctx.authoredExpressions,
      );
      taskArgs = new SplicePair<TaskArgs>(inlined.data, inlinedSanitized.data);
      const { modelType: typeArg, modelName, methodName } = task;
      task = { ...task, ...inlined.data };
      authoredForDirect = inlined.authored;

      const result = await resolver(
        typeArg,
        modelName,
        methodName,
        (task.inputs ?? {}) as Record<string, unknown>,
        task.globalArgs as Record<string, unknown> | undefined,
        authoredForDirect,
        ctx.sensitiveValues,
      );

      originalDefinition = result.definition;
      modelType = result.modelType;
      authoredFromDefinition = result.authoredExpressions ?? new Set();
      const executedDirect = sanitizedDirectExecution(
        result,
        taskArgs,
        stepSecretBag,
        ctx.sensitiveValues,
      );
      executedBase = executedDirect.definition;
      sanitizedStepInputs = executedDirect.methodInputs;

      const authoredTask = ctx.authoredStep?.task.data;
      // A step edited since a cached evaluation (--last-evaluated) can have
      // moved its arguments between globalArgs and inputs; its authored text
      // then no longer describes the values it runs with, so the definition
      // is scanned as it is.
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
      );
    } else if (task.modelIdOrName) {
      // Standard path: look up existing definition
      const lookupResult = await findDefinitionByIdOrName(
        definitionRepo,
        task.modelIdOrName,
      );
      if (!lookupResult) {
        throw new Error(`Model not found: ${task.modelIdOrName}`);
      }
      originalDefinition = lookupResult.definition;
      modelType = lookupResult.type;
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

    // Log via model method run logger (same categories as standalone)
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

    // --- Check for env var usage and warn ---
    const envVarUsages = detectEnvVarUsageInDefinition(originalDefinition);
    if (envVarUsages.length > 0) {
      ctx.emitEvent?.({
        kind: "env_var_warning",
        jobId: ctx.jobName,
        stepId: ctx.stepName,
        modelName: originalDefinition.name,
        envVars: envVarUsages,
        message:
          "Data stored under this model will vary depending on these environment variables at runtime. Consider using separate models per environment, or vault.get() for sensitive values.",
      });
    }

    // Get the model definition from registry (auto-resolve if needed)
    const modelDef = await resolveModelType(modelType, getAutoResolver());
    if (!modelDef) {
      throw new Error(`Unknown model type: ${modelType.normalized}`);
    }

    // Validate the model definition (including expression paths) BEFORE evaluation
    const validationResults = await this.validationService.validateModel(
      originalDefinition,
      modelDef,
      definitionRepo,
      undefined,
      { authoredGlobalArguments },
    );

    // Fail fast if validation fails
    const failures = validationResults.results.filter((r) => !r.passed);
    if (failures.length > 0) {
      // A multi-line error goes under its check name, every line indented.
      const errors = failures.map((f) =>
        f.error?.includes("\n")
          ? `  ${f.name}:\n${f.error.replace(/^/gm, "    ")}`
          : `  ${f.name}: ${f.error}`
      ).join("\n");
      throw new Error(
        `Model validation failed for "${originalDefinition.name}":\n${errors}`,
      );
    }

    // Evaluate CEL expressions (vault left raw for persistence)
    let evaluatedDefinition = originalDefinition;
    // The copy that executes: evaluatedDefinition's splices with sensitive
    // data values in its arguments replaced by sentinels from stepSecretBag.
    let executedDefinition = executedBase ?? originalDefinition;
    let failedExpressions: FailedExpressions = new Map();
    let stepInputs = SplicePair.of<Record<string, unknown>>({});
    // Provenance for every pass from here on. Union the workflow source's
    // authored expressions with the model's own, where the model has an
    // authored source at all. Anything else in task.inputs or the evaluated
    // definition arrived through CEL data substitution and must not be
    // evaluated again — not by the step-input pass below, not by the
    // definition pass, and not by the runtime pass.
    //
    // task.inputs is deliberately NOT seeded here: by this point the workflow
    // evaluator has already substituted data into it. Author-written step
    // inputs are covered by the workflow-source set, collected before that ran.
    const authoredExpressions = new Set([
      ...authoredForDirect,
      ...authoredFromDefinition,
    ]);

    if (ctx.mode === "lastEvaluated") {
      // Load previously-evaluated definition from cache
      runLogger?.debug("Loading last evaluated definition");
      const lastEvaluated = await evaluatedDefRepo.findByNameWithProvenance(
        modelType,
        originalDefinition.name,
      );
      if (!lastEvaluated) {
        throw new Error(
          `No previously evaluated definition found for "${originalDefinition.name}". ` +
            `Run the workflow without --last-evaluated first.`,
        );
      }
      if (mayHoldPlaintextSensitiveValues(lastEvaluated)) {
        throw new UserError(
          `The evaluated definition cached for "${originalDefinition.name}" was written by an older swamp and may hold sensitive values in plaintext, so it is not replayed. ` +
            `Run the workflow without --last-evaluated to evaluate it again; that rewrites the cache.`,
        );
      }
      // Sensitive values are cached as vault references; restore them, real
      // values into evaluatedDefinition and sentinels into the executed copy.
      const restored = await rehydrateEvaluatedDefinition(
        lastEvaluated,
        (vaultName, key) =>
          vaultService.get(vaultName, key, "evaluated-cache:replay"),
        ctx.sensitiveValues,
        stepSecretBag,
      );
      evaluatedDefinition = restored.definition;
      executedDefinition = restored.executedDefinition;
      if (ctx.expressionContext) {
        // The workflow cache may already have supplied the same records;
        // de-dup by id so the definition cache does not grow per replay.
        ctx.expressionContext.deferredExpressions = [
          ...new Map(
            [
              ...(ctx.expressionContext.deferredExpressions ?? []),
              ...restored.deferredExpressions,
            ].map((record) => [record.id, record]),
          ).values(),
        ];
      }
      for (const expression of lastEvaluated.authoredExpressions) {
        authoredExpressions.add(expression);
      }

      // Resolve deferred expressions (data.*, file.contents) that were
      // skipped during workflow evaluate.  evaluateData only touches
      // remaining ${{ }} markers; already-resolved values pass through.
      if (task.inputs && ctx.expressionContext) {
        stepInputs = await expressionEvaluator.evaluateDataPair(
          stepInputPair(taskArgs),
          ctx.expressionContext,
          authoredExpressions,
          stepSecretBag,
        );
      } else if (task.inputs) {
        stepInputs = stepInputPair(taskArgs);
      }
    } else if (ctx.expressionContext) {
      runLogger.debug("Evaluating expressions");
      // Set self context for this specific model before evaluating
      // Preserve any forEach variables that were set by the workflow engine
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

      // Evaluate step task inputs and merge into context
      if (task.inputs) {
        stepInputs = await expressionEvaluator.evaluateDataPair(
          stepInputPair(taskArgs),
          ctx.expressionContext,
          authoredExpressions,
          stepSecretBag,
        );
      }

      // Merge step inputs with existing context inputs (step inputs take
      // precedence). The context always holds real values.
      const originalInputs = ctx.expressionContext.inputs ?? {};
      ctx.expressionContext.inputs = { ...originalInputs, ...stepInputs.raw };

      ({
        definition: evaluatedDefinition,
        sanitizedDefinition: executedDefinition,
        failedExpressions,
      } = await new DefinitionExpressionEvaluator(
        new CelEvaluator(),
      ).evaluate(
        originalDefinition,
        ctx.expressionContext,
        authoredExpressions,
        stepSecretBag,
        executedDefinition,
      ));
    }

    // Forward all step inputs as method arguments.
    // This runs after expression evaluation, so task.inputs values
    // take precedence over any values resolved from ${{ inputs.X }} expressions.
    if (executedDefinition === evaluatedDefinition) {
      executedDefinition = Definition.fromData(evaluatedDefinition.toData());
    }
    for (const [key, value] of Object.entries(stepInputs.raw)) {
      evaluatedDefinition.setMethodArgument(task.methodName, key, value);
    }
    for (const [key, value] of Object.entries(stepInputs.sanitized)) {
      executedDefinition.setMethodArgument(task.methodName, key, value);
    }

    // A failed expression the method is about to receive would otherwise be
    // handed over as its raw ${{ ... }} text. Checked after the step-input
    // overrides above, so an input that replaces the value lets the step run.
    assertMethodArgumentsEvaluated(
      task.methodName,
      evaluatedDefinition.getMethodArguments(task.methodName),
      failedExpressions,
    );

    // Acquire the per-step lock before the step writes anything. The lock
    // covers the evaluated definition, the running output and run-tracker
    // row, the method execution (result + log data) AND report generation
    // (report data), so a single flush pushes everything to the remote
    // datastore. Taking it first also means a lock timeout fails the step
    // before any record is left at running.
    let flushLock: (() => Promise<void>) | null = null;
    // Undefined when a hook took locks without naming them.
    let heldLockIds: readonly string[] | undefined = [];
    if (this.stepLockHook) {
      const lockResult = await this.stepLockHook(
        modelType.normalized,
        originalDefinition.id,
      );
      flushLock = lockResult.flush;
      heldLockIds = lockResult.heldLockIds;
    }
    try {
      // Save evaluated definition (with vault expressions still raw) for
      // --last-evaluated. Built from the executed copy, so sensitive values are
      // written as the vault references they came from, never in plaintext.
      const persisted = persistEvaluatedDefinition(
        executedDefinition,
        ctx.expressionContext?.deferredExpressions ?? [],
        originalDefinition,
        ctx.sensitiveValues,
        stepSecretBag,
      );
      await evaluatedDefRepo.save(
        modelType,
        persisted.definition,
        authoredExpressions,
        persisted.deferredExpressions,
        persisted.writtenReferences,
      );

      // Capture pre-vault args for report context (so vault secrets stay as expressions)
      // Reports and the completed event show arguments to the user and are
      // persisted with report output, so sensitive values are masked there.
      const reportGlobalArgs = ctx.sensitiveValues.masked(
        evaluatedDefinition.globalArguments,
      ) as Record<string, unknown>;
      const reportMethodArgs = ctx.sensitiveValues.masked(
        evaluatedDefinition.getMethodArguments(task.methodName),
      ) as Record<string, unknown>;

      // Resolve runtime expressions (vault and env) at runtime (never persisted).
      // Vault secrets become sentinel tokens; the secretBag maps sentinels to raw values.
      // The expression context is passed so that dynamic vault.get() arguments
      // (e.g. vault.get(inputs.vaultName, inputs.secretKey)) can be CEL-evaluated.
      const runtimeResult = await expressionEvaluator
        .resolveRuntimeExpressionsInDefinition(
          executedDefinition,
          ctx.secretRedactor,
          ctx.expressionContext,
          authoredExpressions,
          {
            secretBag: stepSecretBag,
            rawGlobalArguments: evaluatedDefinition.globalArguments,
          },
        );
      evaluatedDefinition = runtimeResult.definition;
      const secretBag = runtimeResult.secretBag;
      // Definition tags reach data artifacts and the catalog as they are, so a
      // sensitive value in one becomes its placeholder (after the runtime pass,
      // which can also splice one into a tag).
      withTagPlaceholders(evaluatedDefinition, ctx.sensitiveValues);

      // Validate method exists on the model
      const method = modelDef.methods[task.methodName];
      if (!method) {
        const availableMethods = Object.keys(modelDef.methods).join(", ");
        throw new Error(
          `Unknown method '${task.methodName}' for type '${modelType.normalized}'. Available methods: ${
            availableMethods || "none"
          }`,
        );
      }

      // Create ModelOutput for tracking
      // Over the persisted form (before the runtime pass): stable across runs
      // and free of secrets. Provenance only; nothing compares it.
      const definitionHash = await persisted.definition.computeHash();
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
          bundleFingerprint: modelDef.sourceFingerprint,
        },
      });

      // Mark as running and save
      output.markRunning(Deno.pid);
      // Reference the workflow run's log file for history access
      if (ctx.workflowRun?.logFile) {
        output.setLogFile(ctx.workflowRun.logFile);
      }
      await outputRepo.save(modelType, task.methodName, output);

      // Register with the run tracker (if available).
      const { runTracker } = allDeps;
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
      if (runTracker) {
        const activeRun = ActiveRun.createModelMethodRun({
          id: output.id,
          modelType: modelType.normalized,
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

      // Declared outside try so the catch block can record artifacts written
      // before a throw (e.g. model writes data then throws on verdict=FAIL).
      // Each phase owns its mutations of this list; the orchestrator only
      // creates and threads it.
      const savedArtifacts: Array<{
        dataId: string;
        name: string;
        version: number;
        tags: Record<string, string>;
      }> = [];
      // Start heartbeat inside try so it's always cleaned up on error.
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
        if (runTracker) {
          runTracker.complete(output.id, aborted ? "cancelled" : "failed");
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
          output,
          savedArtifacts,
        });
        throw error;
      }
    } finally {
      if (flushLock) {
        await flushLock();
      }
    }
  }

  /**
   * Invoke the model method. Builds the per-call tag overrides,
   * resolves the data-output overrides for vary, and dispatches to
   * the method execution service.
   * Returns the raw method execution result.
   */
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
      resolvedPlacement,
    } = args;

    runLogger.debug("Executing method {method}", { method: task.methodName });

    // Build workflow-specific tag overrides. Use "source" instead of
    // "type" to preserve the original data type (resource/file) while
    // tracking provenance for cross-workflow resolution.
    // Tags are identifiers readers filter by exact string; a sensitive value
    // in one becomes its placeholder before any writer sees it.
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

    // Resolve vary suffixes per output spec from current step inputs.
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
        };
      })
      : undefined;

    // Note: any failure between the start of runModelMethodTask and this
    // point (vary-key validation, etc.) becomes a "pre-method-executing"
    // failure and is reported via step_failed instead — by design.
    ctx.emitEvent?.({
      kind: "method_executing",
      jobId: ctx.jobName,
      stepId: ctx.stepName,
      runId: ctx.workflowRunId,
      modelName: originalDefinition.name,
      methodName: task.methodName,
    });

    // Register sensitive argument values with the workflow redactor so they
    // are scrubbed from the workflow log file. Must use post-vault-resolution
    // values from evaluatedDefinition.
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
    );
  }

  /**
   * Success-path handler. Owns all mutations of `output` and
   * `savedArtifacts` for the success case: appends method artifacts,
   * appends report artifacts, marks the output as succeeded, persists.
   * Returns the orchestrator's final result tuple.
   */
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
    } = args;

    // Track data outputs for context refresh (specName → instanceName → record).
    const resources: Record<string, Record<string, DataRecord>> = {};
    const files: Record<string, Record<string, FileDataRecord>> = {};

    // Append method artifacts to output and savedArtifacts; build the
    // resources/files maps used by downstream steps' expression context.
    if (result.dataHandles && result.dataHandles.length > 0) {
      for (const handle of result.dataHandles) {
        const artifactRef = {
          dataId: handle.dataId,
          name: handle.name,
          version: handle.version,
          tags: handle.tags,
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
          resources[handle.specName][handle.name] = await fromResourceHandle(
            handle,
            modelType,
            evaluatedDefinition.id,
            evaluatedDefinition.name,
            unifiedDataRepo,
            ctx.sensitiveValues,
            vaultService,
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

    // Per-step reports. Vary suffix derived from forEach variable.
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

  /**
   * Failure-path handler. Owns all mutations of `output` and
   * `savedArtifacts` for the failure case: recovers handles attached
   * to the error (partial-write artifacts), marks the output as failed,
   * persists, runs failure-path reports (errors swallowed by the runner),
   * and attaches savedArtifacts to the error so the outer step loop
   * records them on the step run. Caller is expected to rethrow.
   */
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
    /** Whether the run's abort stopped the method; it is then cancelled. */
    aborted: boolean;
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
      output,
      savedArtifacts,
    } = args;

    // Recover data handles written before the throw (e.g. model wrote
    // data then threw on verdict=FAIL). The execution service attaches
    // them to the error.
    const errorHandles = recoveredDataHandles(error);
    if (errorHandles.length > 0) {
      for (const handle of errorHandles) {
        const artifactRef = {
          dataId: handle.dataId,
          name: handle.name,
          version: handle.version,
          tags: handle.tags,
        };
        output.addDataArtifact(artifactRef);
        savedArtifacts.push(artifactRef);
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    if (aborted) {
      output.markCancelled("aborted");
    } else {
      output.markFailed({ message: errorMessage, stack: errorStack });
    }
    await outputRepo.save(modelType, task.methodName, output);

    runLogger.debug("Method {method} failed: {error}", {
      method: task.methodName,
      model: originalDefinition.name,
      error: errorMessage,
    });

    // Run method-summary report for failed executions so report
    // consumers see structured error output (matching modelMethodRun
    // failure behavior). The runner's internal try/catch ensures
    // report errors don't mask the original execution error. The
    // artifacts it returns are recorded on the failed step, exactly as
    // for a successful step.
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

// Re-export from dedicated file for backward compatibility
export type { WorkflowExecutionEvent } from "./execution_events.ts";
export type { RecoveryAssessment } from "./recovery_assessment.ts";
import type { WorkflowExecutionEvent } from "./execution_events.ts";
import {
  assessRecoveryForRun,
  findInterruptedRun,
  type RecoveryAssessment,
} from "./recovery_assessment.ts";

/**
 * Internal options bundle passed through runJob/runStep to reduce parameter count.
 */
interface StepOptions {
  /**
   * Expressions written in the workflow source. Threaded to every pass that
   * runs after CEL substitution so data content spliced in by evaluation is
   * never evaluated as if the author had written it.
   */
  authoredExpressions: ReadonlySet<string>;
  /**
   * The workflow as loaded, before evaluation, from which each step's
   * authored task is looked up. See {@link StepExecutionContext.authoredStep}.
   */
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
  signal?: AbortSignal;
  reportFilterOptions?: ReportFilterOptions;
  /** The git commit sha of the swamp repo at execution time */
  swampSha?: string;
  /** Check names to skip during pre-flight checks */
  skipCheckNames?: string[];
  /** Skip checks that have any of these labels */
  skipCheckLabels?: string[];
  /** Skip all pre-flight checks */
  skipAllChecks?: boolean;
  /** Minimum assert severity that fails the run (default: all failures fail) */
  assertFailOnSeverity?: AssertSeverity;
  /** Identity of the user who initiated this run */
  initiatedBy?: string;
  /**
   * `root.key` binding paths (e.g. `inputs.token`, `self.item`) whose values
   * came from resume-time inputs. Those are audited by key only and must
   * never be copied into durable deferred bindings.
   */
  resumeDerived?: readonly string[];
  /**
   * Set on the step levels a job runs in cleanup mode after the run's abort
   * (see runJob). A step skipped there on its dependsOn never ran, and may
   * depend on work the abort settled, so it is marked `settledByAbort` and a
   * resume evaluates it again.
   */
  cleanupStepLevel?: boolean;
  /**
   * Set on the job levels a run enters in cleanup mode after its abort. A job
   * skipped there on its dependsOn is skipped as one the abort never started
   * (`JobRun.skipNotStarted`), so a resume evaluates it again.
   */
  cleanupJobLevel?: boolean;
  /**
   * One promise per nested workflow step of this run still in flight,
   * settled when the step's child run has ended. The run awaits them before
   * recording its own cancellation (see {@link awaitNestedRuns}).
   */
  nestedRuns?: Set<Promise<void>>;
  /**
   * The run's model-method executions still in flight, which the run awaits
   * before recording its own cancellation (see {@link InFlightMethodRuns}).
   */
  inFlightMethodRuns?: InFlightMethodRuns;
  /**
   * How long after its abort the run waits for them; defaults to
   * {@link STEP_STOP_GRACE_MS}. Passed on to nested runs.
   */
  stepStopGraceMs?: number;
}

/**
 * Adds `jobName` to `started` once `stream` is first pulled, which
 * mergeWithConcurrency does only when the job gets a permit. A job first
 * pulled with `signal` already aborted never starts: a level holding one job
 * is pulled whatever the signal, where a level holding several starts none.
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

/**
 * Domain service for workflow execution.
 */
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
  /** Evaluator for sub-workflow input expressions. Per-instance, not per-call. */
  private readonly expressionEvaluator: ExpressionEvaluationService;

  workflowGateService?:
    import("../models/workflow_gate_service.ts").WorkflowGateService;

  /**
   * Claims a run while a resume takes it over. Defaults to no claim, for a
   * caller that already keeps other writers off the run.
   */
  runClaims: WorkflowRunClaims = unclaimedRuns;

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
  ) {
    this.executor = executor ??
      new DefaultStepExecutor(
        undefined,
        directTypeResolver,
        markDirty,
        stepLockHook,
        hydrateFile,
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
    this.evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
      repoDir,
      dsPath(SWAMP_SUBDIRS.workflowsEvaluated),
      markDirty,
    );
    const fsDataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      dataBaseDir,
      catalogStore,
      markDirty,
      hydrateFile,
      namespace,
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

  /**
   * Executes a workflow by ID or name, yielding progress events.
   */
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
      inputs?: Record<string, unknown>;
      runtimeTags?: Record<string, string>;
      workflowNestingDepth?: number;
      ancestorWorkflowIds?: Set<string>;
      /** The run whose nested workflow step starts this run. */
      parentRunId?: string;
      /** The parent step that starts this run, recorded on the run. */
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
      signal?: AbortSignal;
      /** Report filter options for per-step report execution */
      reportFilterOptions?: ReportFilterOptions;
      /** The git commit sha of the swamp repo at execution time */
      swampSha?: string;
      /** Check names to skip during pre-flight checks */
      skipCheckNames?: string[];
      /** Skip checks that have any of these labels */
      skipCheckLabels?: string[];
      /** Skip all pre-flight checks */
      skipAllChecks?: boolean;
      /** Minimum assert severity that fails the run */
      assertFailOnSeverity?: AssertSeverity;
      /** Identity of the user who initiated this run */
      initiatedBy?: string;
      /** Serve instance identity for cross-machine reconciliation */
      instanceId?: string;
      /** How this run was triggered (schedule, webhook, api) */
      triggerSource?: string;
      /** Optional metadata linking the run to external systems */
      references?: Record<string, string>;
      /**
       * How long after an abort the run waits for its model methods to stop
       * before recording its cancellation; defaults to
       * {@link STEP_STOP_GRACE_MS}.
       */
      stepStopGraceMs?: number;
    },
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const runSpan = getTracer().startSpan("swamp.workflow.run", {
      attributes: { "workflow.name": idOrName },
    });
    yield* bindGeneratorToSpan(
      runSpan,
      this.runInSpan(runSpan, idOrName, options),
    );
  }

  /**
   * Body of {@link run}, executed with `runSpan` as the active span so job
   * spans (and everything under them) nest beneath it. Ends `runSpan`.
   */
  private async *runInSpan(
    runSpan: Span,
    idOrName: string,
    options?: Parameters<WorkflowExecutionService["run"]>[1],
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const tracer = getTracer();

    let workflowRun: WorkflowRun | undefined;
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
      let authoredWorkflow: Workflow | undefined;
      let deferredExpressions = options?.deferredExpressions ?? [];
      let run: WorkflowRun;
      let workflowLogPath: string;
      let evaluatedWorkflowFingerprint: string | undefined;
      let definitionFingerprint: string | undefined;
      let sanitizedTasks: SanitizedTaskOverlay | undefined;
      let persistedWorkflow: PersistedEvaluatedWorkflow | undefined;
      const secretRedactor = options?.secretRedactor ?? new SecretRedactor();
      const sensitiveValues = options?.sensitiveValues ??
        new RunSensitiveValues(secretRedactor);

      try {
        // Look up workflow
        const found = options?.byId
          ? await findWorkflowById(
            this.workflowRepo,
            idOrName,
            options.expectedName,
          )
          : await this.lookupWorkflow(idOrName);
        if (!found) {
          throw new Error(`Workflow not found: ${idOrName}`);
        }
        workflow = found;

        // Provenance for the runtime pass, collected from the workflow as
        // loaded from disk. Taken here rather than from the evaluation below
        // because --last-evaluated swaps in a cached workflow that already has
        // data content spliced into it and never runs the evaluator at all.
        // The set persisted with that cache is unioned in below, so a source
        // edited since it was evaluated cannot orphan the cached expressions.
        authoredExpressions = collectWorkflowAuthoredExpressions(
          found,
          new Set(options?.authoredExpressions),
        );
        // In --last-evaluated mode the steps run from the cached evaluation,
        // but their authored text is looked up in the source as loaded now.
        // Only the template-syntax lint reads it, so a source edited since
        // the cache was written can change what that lint reports, never
        // what is evaluated or trusted.
        authoredWorkflow = found;

        if (options?.lastEvaluated) {
          // Load previously evaluated workflow from cache
          const lastEvaluated = await this.evaluatedWorkflowRepo
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
          // Sensitive values are cached as vault references: restore real
          // values into the workflow and sentinels into the step overlay.
          const vaultService = lastEvaluated.writtenReferences.length > 0
            ? await VaultService.fromRepository(this.repoDir, {
              vaultsDir: this.vaultsDir,
            })
            : undefined;
          const restored = await rehydrateEvaluatedWorkflow(
            lastEvaluated,
            (vaultName, key) =>
              vaultService!.get(vaultName, key, "evaluated-cache:replay"),
            sensitiveValues,
          );
          // Use the fully evaluated workflow (forEach expanded, expressions resolved)
          workflow = restored.workflow;
          sanitizedTasks = restored.sanitizedTasks;
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
            true,
            deferredExpressions,
          );
          if (options?.inputs) {
            expressionContext.inputs = options.inputs;
          }
        } else {
          // Fingerprint the definition as loaded, before evaluation resolves
          // its expressions, so recovery can compare it with the current
          // definition. The evaluated fingerprint also varies with inputs.
          definitionFingerprint = await computeWorkflowFingerprint(found);

          // Build expression context and evaluate workflow
          const buildCtxSpan = tracer.startSpan(
            "swamp.workflow.build_context",
          );
          expressionContext = await this.buildRunContext(
            workflow,
            sensitiveValues,
            false,
            deferredExpressions,
          );
          buildCtxSpan.end();

          // Add workflow inputs to context
          if (options?.inputs) {
            expressionContext.inputs = options.inputs;
          }

          const evaluation = await this.evaluateWorkflow(
            workflow,
            expressionContext,
            authoredExpressions,
          );
          workflow = evaluation.workflow;
          sanitizedTasks = evaluation.sanitizedTasks;
          // Written with sensitive values as the vault references they came
          // from; the fingerprint is taken over the same form, so it holds
          // nothing that could be used to guess a secret.
          persistedWorkflow = persistEvaluatedWorkflow(
            workflow,
            found,
            sanitizedTasks,
            deferredExpressions,
            sensitiveValues,
          );
          await this.evaluatedWorkflowRepo.save(
            persistedWorkflow.workflow,
            authoredExpressions,
            persistedWorkflow.deferredExpressions,
            persistedWorkflow.writtenReferences,
          );
          evaluatedWorkflowFingerprint = await computeWorkflowFingerprint(
            persistedWorkflow.workflow,
          );
        }

        expressionContext.deferredExpressions = deferredExpressions;

        // Create workflow run with merged tags (runtime tags take precedence)
        const mergedTags: Record<string, string> = {
          ...sensitiveValues.tagsWithPlaceholders(workflow.tags ?? {}),
          ...(options?.runtimeTags ?? {}),
        };
        run = WorkflowRun.create(
          workflow,
          mergedTags,
          options?.initiatedBy,
          options?.triggerSource,
        );
        run.attachSensitiveValues(sensitiveValues);
        if (options?.parentRun) {
          run.recordParentRun(options.parentRun);
        }
        if (options?.inputs) {
          run.captureInputs(options.inputs);
        }
        // Only what a parent passed in: the run's own source is re-collected
        // on resume, so persisting it would keep deleted expressions vouched.
        if (options?.authoredExpressions?.size) {
          run.captureInheritedExpressions(options.authoredExpressions);
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

        // Register run file sink target for the workflow log output
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

        // Enrich span with resolved workflow metadata
        runSpan.setAttribute("workflow.id", workflow.id);
        runSpan.setAttribute("workflow.run_id", run.id);

        // Capture the evaluated workflow fingerprint for recovery
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

        // Start execution
        run.start(Deno.pid, options?.instanceId);

        // Register workflow run with the tracker
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

      await this.saveRun(workflow.id, run);

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
        secretRedactor,
        sensitiveValues,
        sanitizedTasks,
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

      // Sort jobs topologically
      const jobNodes: GraphNode[] = workflow.jobs.map((job) => ({
        name: job.name,
        weight: job.weight,
        dependencies: job.getDependencyNames(),
      }));

      const sortedJobs = this.sortService.sort(jobNodes);

      const jobConcurrency = resolveJobConcurrency(workflow);

      // Track per-step model info and data handles for the workflow-scope
      // report context. Built up by intercepting the events the service
      // emits as steps execute.
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

      // Execute jobs level by level
      let anyJobFailed = false;
      const startedJobs = new Set<string>();
      for (const level of sortedJobs.levels) {
        const { levelSignal, levelStepOpts, abortedBeforeLevel } = this
          .enterJobLevel(
            run,
            startedJobs,
            anyJobFailed,
            options?.signal,
            stepOpts,
          );

        // Merge parallel job generators within each level
        const jobStreams = level.map((jobName) =>
          markStarted(
            jobName,
            startedJobs,
            this.runJob(
              workflow,
              run,
              jobName,
              expressionContext,
              levelStepOpts,
            ),
            levelSignal,
          )
        );
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
            await this.saveRun(workflow.id, run);
          } else if (event.kind === "step_completed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "succeeded");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRun(workflow.id, run);
          } else if (event.kind === "step_failed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "failed");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRun(workflow.id, run);
          } else if (event.kind === "step_skipped") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "skipped");
            await this.saveRun(workflow.id, run);
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

      // Handle suspension: all parallel siblings at the current level have
      // drained, so the persisted run is a consistent checkpoint.
      if (run.status === "suspended") {
        if (wfHeartbeatInterval) clearInterval(wfHeartbeatInterval);
        if (this.runTracker) this.runTracker.complete(run.id, "suspended");
        const suspendedEvent = suspendedEventFor(run, workflow);
        if (suspendedEvent) yield suspendedEvent;
        runSpan.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Check if the run was cancelled via abort signal
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

      // Complete workflow
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
      if (error instanceof WorkflowSuspendedError && workflowRun) {
        if (this.runTracker) {
          this.runTracker.complete(workflowRun.id, "suspended");
        }
        yield {
          kind: "suspended" as const,
          run: workflowRun,
          jobId: error.jobId,
          stepId: error.stepId,
          prompt: error.prompt,
          timeout: error.timeout,
        };
        runSpan.setStatus({ code: SpanStatusCode.OK });
        return;
      }
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
      throw error;
    } finally {
      if (workflowAffinityKey) {
        getRemoteStepDispatcher()?.releaseAffinity(workflowAffinityKey);
      }
      // Always release the per-run log file sink when the generator is
      // disposed — including early abandonment via generator.return() (e.g. a
      // streaming consumer that breaks on socket close). Cleanup placed after a
      // yield would be skipped on .return(); only finally blocks unwind.
      runFileSink.unregister(workflowLogHandle);
      inFlightMethodRuns.dispose();
      runSpan.end();
    }
  }

  /**
   * Executes a workflow by ID or name.
   * Convenience wrapper around run() that drains the event stream
   * and returns the final WorkflowRun.
   */
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

  /**
   * Loads the run a resume names, checks it may be resumed, records this
   * process as its owner and saves it as running. The caller holds the run's
   * claim for the whole call, so the checks are made on the run as stored and
   * nothing saves between the load and the save. Returns the run, the
   * record as it was stored, and the coerced resume inputs.
   */
  private async takeOverRun(
    workflow: Workflow,
    workflowIdOrName: string,
    runId: string,
    sensitiveValues: RunSensitiveValues,
    options?: {
      inputs?: Record<string, unknown>;
      fromStep?: string;
      suspendedOnly?: boolean;
      instanceId?: string;
    },
  ): Promise<{
    existingRun: WorkflowRun;
    snapshot: WorkflowRunData;
    resumeInputs: Record<string, unknown>;
  }> {
    const loadedRun = await this.runRepo.findById(
      workflow.id,
      createWorkflowRunId(runId),
    );
    if (!loadedRun) {
      throw new UserError(`Workflow run not found: ${runId}`);
    }
    // The stored run holds vault references where it held sensitive values;
    // only the entries swamp listed are restored, from stored state alone and
    // before any caller-supplied resume input is merged in.
    const existingRun = await this.rehydrateRun(loadedRun, sensitiveValues);

    const fromStep = options?.fromStep;

    // Every check runs before the first mutation, so a refusal persists
    // nothing and invokes no method.
    let reset: ResumeReset | undefined;
    if (fromStep) {
      if (existingRun.status !== "failed") {
        throw new UserError(
          `--from requires a failed run, but run ${runId} has status "${existingRun.status}"`,
        );
      }
      reset = planFailedRunResume(workflow, existingRun, fromStep);
    } else if (
      existingRun.status === "failed" && !options?.suspendedOnly
    ) {
      // Retry: reset the entry template of every failed step, and each
      // template's dependents, through the same path as --from.
      reset = planFailedRunResume(workflow, existingRun);
    } else if (existingRun.status !== "suspended") {
      const accepted = options?.suspendedOnly
        ? "is not suspended"
        : "is not suspended or failed";
      throw new UserError(
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
      const openWait = existingRun.findOpenSignalWait(new Date());
      if (openWait) throw new UserError(openSignalWaitMessage(openWait));
      await this.checkNestedWaitsSettled(existingRun);
    }

    // A value that does not match its declared type would otherwise fail
    // only once the run is reset, for a forEach input leaving the job running
    // with its iterations pending (swamp-club#2502).
    const resumeInputs = coerceResumeInputs(
      workflow,
      existingRun,
      options?.inputs ?? {},
    );

    // Taken before any mutation. If anything throws after the save below and
    // before execution starts, the run is restored to exactly this state
    // rather than left running with nothing driving it. Taken from the run as
    // stored, so a restore writes references back, never restored values.
    const snapshot = loadedRun.toData();

    // Work the run's abort left unfinished runs now, as it would have had the
    // abort left it pending. Reopened per record before a failed run's reset
    // set, which resets by name in every job.
    existingRun.reopenAbortedWork();
    // This process now drives the run. Recorded before the save below, so
    // cancel sees the live process from the start.
    const owner = { pid: Deno.pid, instanceId: options?.instanceId };
    if (reset) {
      existingRun.resetForResumeFrom(reset.steps, reset.tracked);
      existingRun.resumeFromFailed(owner);
    } else {
      existingRun.resumeFromSuspended(owner);
    }

    // Record the key names of any resume-time inputs for audit (never the
    // values — they may be secrets such as a freshly minted auth key). Done
    // before the save below so the audit trail persists immediately.
    if (Object.keys(resumeInputs).length > 0) {
      existingRun.recordResumeInputs(Object.keys(resumeInputs));
    }
    // The running status saved here also stops a second resume of this run
    // from starting while this one prepares.
    await this.saveRun(workflow.id, existingRun);
    return { existingRun, snapshot, resumeInputs };
  }

  /**
   * Resumes a workflow run, keeping its run ID and completed step results.
   *
   * - A suspended run continues once every approval gate is decided, unless
   *   the workflow changed shape since the run (see
   *   {@link checkSuspendedRunResume}).
   * - A failed run with `fromStep` re-enters at that step and its dependents.
   * - A failed run without `fromStep` retries: every failed step's entry
   *   template and its dependents are reset (see {@link planFailedRunResume}).
   *
   * Terminal steps outside the reset set are skipped and their outputs are
   * restored into `steps.*`. Override `inputs` are coerced to their declared
   * types and checked against the workflow's input schema, as `workflow run`
   * does; a mismatch is a refusal (see {@link coerceResumeInputs}). A
   * refusal changes nothing; a failure after the run is marked running but
   * before execution starts restores the run.
   */
  async *resume(
    workflowIdOrName: string,
    runId: string,
    options?: {
      signal?: AbortSignal;
      runtimeTags?: Record<string, string>;
      reportFilterOptions?: ReportFilterOptions;
      swampSha?: string;
      /** Additional/override inputs supplied at resume time (CLI --input). */
      inputs?: Record<string, unknown>;
      /** Minimum assert severity that fails the run */
      assertFailOnSeverity?: AssertSeverity;
      /** Re-enter the DAG at this step (template name from the workflow YAML). */
      fromStep?: string;
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
       * How long after an abort the resume waits for its model methods to
       * stop before recording its cancellation; defaults to
       * {@link STEP_STOP_GRACE_MS}.
       */
      stepStopGraceMs?: number;
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
    // Created before anything is resolved, so every sensitive value this
    // resume reads, from the stored run or afterwards, is recorded and
    // redacted from its logs.
    const secretRedactor = new SecretRedactor();
    const sensitiveValues = new RunSensitiveValues(secretRedactor);
    // Taken over under the run's claim, which is released before anything
    // executes: a cancel either lands first and is seen here, or finds the
    // run running under this process (swamp-club#2919).
    const { existingRun, snapshot, resumeInputs } = await this.runClaims
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
      handBackTrackerRow: () => {
        if (resumeHeartbeatInterval) clearInterval(resumeHeartbeatInterval);
        handBackTrackerRow();
      },
    };

    const {
      expressionContext,
      sanitizedTasks,
      authoredExpressions,
      resolvedWorkflow,
      workflowLogPath,
      workflowLogHandle,
    } = await this.restoreRunOnFailure(restore, async () => {
      const expressionContext = await this.buildRunContext(
        workflow,
        sensitiveValues,
        false,
        existingRun.deferredExpressions,
      );

      // Merge resume-time inputs over the inputs captured when the run
      // suspended. Resume overrides win on key collision; new keys are
      // additive. Set before evaluation so workflow- and step-level
      // `inputs.*` expressions resolve.
      expressionContext.inputs = deepMerge(
        { ...existingRun.inputs },
        resumeInputs,
      );

      expressionContext.workflowRunId = existingRun.id;
      expressionContext.run = {
        id: existingRun.id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        startedAt: existingRun.startedAt!.toISOString(),
        tags: { ...existingRun.tags },
        initiatedBy: existingRun.initiatedBy,
        inputs: existingRun.inputs,
      };
      expressionContext.steps = {};
      const stepOutputResolver = this.createStepOutputResolver(
        sensitiveValues,
      );
      for (const job of existingRun.jobs) {
        for (const step of job.steps) {
          if (
            step.status === "succeeded" || step.status === "failed" ||
            step.status === "skipped" || step.status === "unknown"
          ) {
            expressionContext.steps[step.stepName] = {
              status: step.status,
              outputs: (await stepOutputResolver.resolve(step)).outputs,
            };
          }
        }
      }

      const evaluator = new WorkflowExpressionEvaluator(
        new CelEvaluator(),
      );
      // Collected before evaluation, for the same reason as the fresh-run
      // seam: afterwards, spliced data content is indistinguishable from
      // source. The run's captured inputs may still hold a parent's
      // unresolved runtime expression, which only the persisted inherited
      // set can vouch for.
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
      const resolvedWorkflow = evaluated.workflow;
      const sanitizedTasks = evaluated.sanitizedTasks;

      // Re-register the log file sink so resume output is captured.
      // Append to preserve records from earlier attempts.
      const workflowLogPath = existingRun.logFile ??
        join(
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
        authoredExpressions,
        resolvedWorkflow,
        workflowLogPath,
        workflowLogHandle,
      };
    });

    const nestedRuns = new Set<Promise<void>>();
    const inFlightMethodRuns = new InFlightMethodRuns(options?.signal);
    // The try opens immediately after register() — before the "started"
    // yield — so early consumer abandonment (a client that receives
    // "started" then disconnects) still unwinds the finally, which stops the
    // heartbeat and releases the log sink.
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
        secretRedactor,
        sensitiveValues,
        sanitizedTasks,
        signal: options?.signal,
        nestedRuns,
        inFlightMethodRuns,
        stepStopGraceMs: options?.stepStopGraceMs,
        resumeDerived: existingRun.resumeInputs.map((key) => `inputs.${key}`),
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
      const startedJobs = new Set<string>();
      for (const level of sortedJobs.levels) {
        const { levelSignal, levelStepOpts, abortedBeforeLevel } = this
          .enterJobLevel(
            existingRun,
            startedJobs,
            anyJobFailed,
            options?.signal,
            stepOpts,
          );

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
          return markStarted(
            jobName,
            startedJobs,
            this.runJob(
              resolvedWorkflow,
              existingRun,
              jobName,
              expressionContext,
              levelStepOpts,
            ),
            levelSignal,
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
            await this.saveRun(workflow.id, existingRun);
          } else if (event.kind === "step_completed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "succeeded");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRun(workflow.id, existingRun);
          } else if (event.kind === "step_failed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "failed");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRun(workflow.id, existingRun);
          } else if (event.kind === "step_skipped") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "skipped");
            await this.saveRun(workflow.id, existingRun);
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

      if (existingRun.status === "suspended") {
        if (resumeHeartbeatInterval) clearInterval(resumeHeartbeatInterval);
        if (this.runTracker) {
          this.runTracker.complete(existingRun.id, "suspended");
        }
        const suspendedEvent = suspendedEventFor(
          existingRun,
          resolvedWorkflow,
        );
        if (suspendedEvent) yield suspendedEvent;
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
        yield {
          kind: "suspended" as const,
          run: existingRun,
          jobId: error.jobId,
          stepId: error.stepId,
          prompt: error.prompt,
          timeout: error.timeout,
        };
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
      existingRun.complete();
      await this.saveRun(workflow.id, existingRun);
      yield { kind: "completed" as const, run: existingRun };
      throw error;
    } finally {
      // Always stop the heartbeat and release the per-run log sink when the
      // generator is disposed — including early abandonment via
      // generator.return() (e.g. a streaming consumer that breaks on socket
      // close). Cleanup placed after a yield would be skipped on .return();
      // only finally blocks unwind.
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

  /**
   * Body of {@link runJob}, executed with `jobSpan` as the active span so step
   * spans nest beneath it. Ends `jobSpan`.
   */
  private async *runJobInSpan(
    jobSpan: Span,
    workflow: Workflow,
    run: WorkflowRun,
    jobName: string,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    try {
      const job = workflow.getJob(jobName);
      if (!job) {
        throw new Error(`Job not found: ${jobName}`);
      }

      const jobRun = run.getJob(jobName);
      if (!jobRun) {
        throw new Error(`Job run not found: ${jobName}`);
      }

      // Check if job's trigger condition is met
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

      // Start job (skip if already running from a resumed suspended run)
      if (jobRun.status !== "running") {
        jobRun.start();
      }
      yield { kind: "job_started", jobId: jobName };

      // Expand forEach steps if we have expression context.
      // Runs in all modes including --last-evaluated: forEach expansion
      // is a structural transformation, not expression evaluation.
      let expandedStepsMap: Map<string, ExpandedStep[]> | undefined;
      if (expressionContext) {
        expandedStepsMap = await new ForEachExpansionService(new CelEvaluator())
          .expand(job, expressionContext, options.authoredExpressions);
        // Rewrite the jobRun's step list to match the expansion. The
        // template StepRun (the step as written in the workflow) never
        // executes once forEach expands, so leaving it in place makes it
        // show up in history as a perpetually-pending phantom. When the
        // original step is *not* a forEach, the expansion map reports a
        // single entry whose expandedName equals the template — that's a
        // no-op for replaceExpandedSteps.
        for (const step of job.steps) {
          if (!step.forEach) continue;
          const expanded = expandedStepsMap.get(step.name);
          const names = expanded ? expanded.map((e) => e.expandedName) : [];
          jobRun.replaceExpandedSteps(step.name, names);
          jobRun.registerForEachExpansion(step.name, names);
          // An iteration that waited on a nested run but that the collection
          // no longer produces is never walked again. The resume checked its
          // child already finished, so it is skipped and its link kept for
          // history (swamp-club#2736). No skip reason: the reason enum cannot
          // grow without older binaries refusing the record.
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

      // Build step graph nodes from explicit dependencies
      const stepNodes: GraphNode[] = job.steps.map((step) => ({
        name: step.name,
        weight: step.weight,
        dependencies: step.getDependencyNames(),
      }));

      // If we have expanded steps, update the graph nodes
      let effectiveNodes = stepNodes;
      if (expandedStepsMap) {
        effectiveNodes = [];
        for (const node of stepNodes) {
          const expanded = expandedStepsMap.get(node.name);
          if (expanded && expanded.length > 0) {
            // Create nodes for each expanded step
            for (const exp of expanded) {
              effectiveNodes.push({
                name: exp.expandedName,
                weight: node.weight,
                // Map dependencies to all expanded step names
                dependencies: node.dependencies.flatMap((dep) => {
                  const depExpanded = expandedStepsMap!.get(dep);
                  return depExpanded && depExpanded.length > 0
                    ? depExpanded.map((d) => d.expandedName)
                    : [dep];
                }),
              });
            }
          } else if (!expanded || expanded.length === 0) {
            // Skip steps that expanded to empty (e.g., empty array)
            continue;
          } else {
            effectiveNodes.push(node);
          }
        }
      }

      const sortedSteps = this.sortService.sort(effectiveNodes);
      const globalLimit = readGlobalConcurrencyLimit();

      // Execute steps level by level
      let jobFailed = false;
      // Set when an interrupted level leaves a guarded step undecided.
      let jobUndecided = false;
      for (const level of sortedSteps.levels) {
        // After a step failure with an aborted signal, give subsequent
        // levels a fresh cleanup signal so always/completed dependents
        // can run. shouldStepRun() handles condition-based filtering —
        // steps whose conditions aren't met are skipped naturally.
        const cleanupMode: boolean = (jobFailed || jobUndecided) &&
          (options.signal?.aborted ?? false);
        const levelSignal: AbortSignal | undefined = cleanupMode
          ? AbortSignal.timeout(CLEANUP_GRACE_TIMEOUT_MS)
          : options.signal;
        const levelOptions = cleanupMode
          ? { ...options, signal: levelSignal, cleanupStepLevel: true }
          : options;
        // Only a level the abort interrupted settles its never-started steps.
        const abortedBeforeLevel: boolean = levelSignal?.aborted ?? false;

        if (cleanupMode) {
          // Mark any steps still in "running" status as failed — the
          // signal aborted their execution but the generators were
          // abandoned before they could record the failure.
          failAbandonedSteps(jobRun);
        }

        // Merge parallel step generators within each level
        const stepConcurrencies: number[] = [];
        const levelSteps = new Map<string, Step>();
        const levelIterations = new Set<string>();
        const stepStreams = level.map((stepName) => {
          // Find the expanded step info if applicable
          let forEachVar: { name: string; value: unknown } | undefined;
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

          // Collect step-level concurrency for this level
          const stepConc = originalStep?.concurrency ??
            job.getStep(stepName)?.concurrency;
          if (stepConc && stepConc > 0) {
            stepConcurrencies.push(stepConc);
          }
          const levelStep = originalStep ?? job.getStep(stepName);
          if (levelStep) levelSteps.set(stepName, levelStep);
          if (forEachVar?.name) levelIterations.add(stepName);

          return this.runStep(
            workflow,
            run,
            job,
            jobRun,
            stepName,
            originalStep,
            forEachVar,
            expressionContext,
            levelOptions,
            forEachIndex,
            forEachTemplate,
          );
        });

        // Resolve: step (min across level) > job > workflow > global
        const levelStepConc = minOf(stepConcurrencies);
        const stepConcurrency = resolveEffectiveConcurrency(
          levelStepConc ?? job.concurrency ?? workflow.concurrency,
          globalLimit,
        );

        for await (
          const event of mergeWithConcurrency(
            stepStreams,
            stepConcurrency,
            levelSignal,
          )
        ) {
          yield event;
          if (event.kind === "step_failed" && !event.allowedFailure) {
            jobFailed = true;
          }
        }

        // A step this level never started (queued behind a concurrency limit
        // when the abort fired) would stay pending, so a failed or completed
        // condition on it could never be met. Settle it as runStep would have
        // on reaching it (settleUnstartedStep). A suspended run keeps its
        // pending steps to resume.
        const interrupted: boolean = !abortedBeforeLevel &&
          (levelSignal?.aborted ?? false) && run.status !== "suspended";
        if (interrupted) {
          for (const stepName of level) {
            // An iteration a resume added to the collection has no record
            // until runStep creates one, as it would have on reaching it.
            if (!jobRun.getStep(stepName) && levelIterations.has(stepName)) {
              jobRun.addExpandedStep(stepName);
            }
            const stepRun = jobRun.getStep(stepName);
            if (stepRun?.status !== "pending") continue;
            settleUnstartedStep(levelSteps.get(stepName), stepRun, jobRun);
          }
        }

        // When the signal aborts mid-level with parallel steps,
        // mergeWithConcurrency may exit before step_failed events are
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
        // A guarded step the interrupted level left undecided: the job did
        // not finish its work, so later levels run in cleanup mode, but its
        // outcome is ambiguous (see the end of the job).
        if (
          interrupted &&
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

      // A step still waiting for a signal that this walk never reached is an
      // iteration a smaller forEach collection dropped. A resume refuses an
      // open wait, so its deadline has passed or it cannot be read. Settle
      // it as re-entering it would have, rather than report the job
      // succeeded with the step still waiting.
      if (run.status !== "suspended" && !options.signal?.aborted) {
        for (const dropped of jobRun.steps) {
          if (!dropped.isSignalWait) continue;
          const unreadable = dropped.failUnreadableWait();
          if (!unreadable && !dropped.timeOutWait(new Date())) continue;
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

      // When the run is suspended and this job still has non-terminal steps
      // (pending or waiting_approval), leave the job running so resume picks
      // it up. In all other cases — normal completion or failure — complete
      // the job.
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
          // Only undecided guarded steps are left, so the job's outcome is
          // ambiguous: neither `succeeded`, `failed`, `completed` nor
          // `skipped` holds for it. Like other work an abort settles, it gets
          // no event. A job no longer running keeps its status.
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
      const job = workflow.getJob(jobName);
      if (job?.affinity && !workflow.affinity) {
        getRemoteStepDispatcher()?.releaseAffinity(
          `${run.id}:${jobName}`,
        );
      }
      jobSpan.end();
    }
  }

  /**
   * Executes a step (regular or forEach-expanded), yielding events.
   * Catches errors internally to preserve allSettled semantics via merge().
   */
  private async *runStep(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    stepName: string,
    originalStep: Step | undefined,
    forEachVar: { name: string; value: unknown } | undefined,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
    forEachIndex?: number,
    forEachTemplate?: string,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const stepSpan = getTracer().startSpan("swamp.workflow.step", {
      attributes: {
        "step.name": stepName,
        "job.name": job.name,
      },
    });
    yield* bindGeneratorToSpan(
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
    );
  }

  /**
   * Body of {@link runStep}, executed with `stepSpan` as the active span so
   * the model method span (and the traceparent handed to it) nests beneath
   * it. Ends `stepSpan`.
   */
  private async *runStepInSpan(
    stepSpan: Span,
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    stepName: string,
    originalStep: Step | undefined,
    forEachVar: { name: string; value: unknown } | undefined,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
    forEachIndex?: number,
    forEachTemplate?: string,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    // For forEach-expanded steps, use the original step but create a dynamic step run
    const step = originalStep ?? job.getStep(stepName);
    if (!step) {
      stepSpan.end();
      throw new Error(`Step not found: ${stepName}`);
    }
    stepSpan.setAttribute("step.task.type", step.task.data.type);

    // For forEach-expanded steps, we need to dynamically create the step run
    let stepRun = jobRun.getStep(stepName);
    if (!stepRun && forEachVar && forEachVar.name) {
      // This is a forEach-expanded step - add it to the job run
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
      if (
        expressionContext?.steps &&
        expressionContext.steps[stepName]?.status !== stepRun.status
      ) {
        expressionContext.steps[stepName] = {
          status: stepRun.status,
          outputs: (await this.createStepOutputResolver(options.sensitiveValues)
            .resolve(stepRun)).outputs,
        };
      }
      stepSpan.end();
      return;
    }

    if (!stepRun) {
      stepSpan.end();
      throw new Error(`Step run not found: ${stepName}`);
    }

    // A nested workflow step waiting on its child run already passed its
    // trigger and guard when it started the child: re-entering, it reads the
    // child's outcome, and a guard or dependsOn that changed since must not
    // skip it and strand the child (swamp-club#2736).
    const reenterNestedWait = stepRun.isNestedWait;
    // A step waiting for a signal re-enters the same way: it settles the wait
    // it holds, and is never skipped or started again, which would lose the
    // wait's deadline or open a second wait.
    const reenterSignalWait = stepRun.isSignalWait;
    const reenterWait = reenterNestedWait || reenterSignalWait;

    // Check if step's trigger condition is met. A forEach iteration checks its
    // template's dependsOn, so every iteration is gated as a plain step is.
    if (!reenterWait && !shouldStepRun(step, jobRun)) {
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
      // An item iterated out of a resume-time input carries that input's
      // value, so it is excluded from deferred bindings like the input.
      const resumeKeys = (options.resumeDerived ?? [])
        .filter((path) => path.startsWith("inputs."))
        .map((path) => path.slice("inputs.".length));
      const inRefs = extractInputReferencesFromCel(
        extractCelExpression(step.forEach?.in ?? "") ?? "",
      );
      if (resumeKeys.some((key) => inRefs.has(key))) {
        options = {
          ...options,
          resumeDerived: [
            ...(options.resumeDerived ?? []),
            `self.${forEachVar.name}`,
          ],
        };
      }
    }

    // Evaluate guard expression — truthy means the step is already done
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
      // When the abort fires while a pending step's guard is evaluated, the
      // step does not start and stays pending whatever the guard answers:
      // the level may already have settled and moved on, and a step whose
      // guard did not decide in time must not look finished. A step reached
      // after the abort, or recorded running, runs as before.
      const abortedBeforeGuard = options.signal?.aborted ?? false;
      const guardedStep = stepRun;
      const statusBeforeGuard = guardedStep.status;
      const settledDuringGuard = (): boolean =>
        guardedStep.status !== statusBeforeGuard;
      const abortedDuringGuard = (): boolean =>
        statusBeforeGuard === "pending" && !abortedBeforeGuard &&
        (options.signal?.aborted ?? false);
      try {
        const celEvaluator = new CelEvaluator();
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
          partitionAuthored(
            extractExpressions(step.guard),
            options.authoredExpressions,
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
            guardResult,
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

    // Start step. A re-entered wait keeps its start time.
    if (!reenterWait) stepRun.start();

    // This step's `steps.<name>.outputs`, taken from the full output before
    // it is stripped for the run record. Declared here so the finally below
    // sees it for both model_method and workflow steps.
    let liveOutputs: Record<string, unknown> | undefined;
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
          options,
          !!step.allowFailure,
        );
        return;
      }

      // A re-entered signal wait fails once its deadline has passed, so
      // `failed` handlers run; one still open suspends the run on it again.
      if (reenterSignalWait) {
        const unreadable = stepRun.failUnreadableWait();
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
        if (unreadable || stepRun.timeOutWait(new Date())) {
          if (step.allowFailure) stepRun.markAllowedFailure();
          yield {
            kind: "step_failed",
            jobId: job.name,
            stepId: stepName,
            runId: run.id,
            error: unreadable
              ? WAIT_UNREADABLE_STEP_ERROR
              : WAIT_TIMEOUT_STEP_ERROR,
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
        const wait = SignalWait.open(task.schema, task.timeout, new Date());
        stepRun.waitForSignal(wait);
        yield {
          kind: "signal_wait_requested",
          runId: run.id,
          workflowName: workflow.name,
          jobId: job.name,
          stepId: stepName,
          waitId: wait.id,
          deadline: wait.deadline.toISOString(),
        };
        run.suspend(stepExprContext?.inputs);
        return;
      }

      // Handle manual approval tasks — suspend the workflow
      if (task.type === "manual_approval") {
        stepRun.waitForApproval(task.prompt);
        yield {
          kind: "approval_requested",
          runId: run.id,
          workflowName: workflow.name,
          jobId: job.name,
          stepId: stepName,
          prompt: task.prompt,
          timeout: task.timeout,
        };
        // Capture the effective workflow inputs so steps after the gate can
        // resolve `inputs.*` once the run is resumed. This is the manual_approval
        // branch, which runs before any step-level input augmentation, so
        // `inputs` here is the clean workflow-level set.
        //
        // Return instead of throwing WorkflowSuspendedError so that merge()
        // continues draining parallel sibling generators to completion. The
        // post-level save in run()/resume() captures the consistent state.
        run.suspend(stepExprContext?.inputs);
        stepSpan.end();
        return;
      }

      // Handle assert tasks — evaluate CEL predicate, record pass/fail
      if (task.type === "assert") {
        const celEvaluator = new CelEvaluator();
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

          // Interpolate ${{ }} expressions in the message
          let resolvedMessage = task.message;
          for (
            const expr of partitionAuthored(
              extractExpressions(task.message),
              options.authoredExpressions,
            )
          ) {
            try {
              const value = await this.expressionEvaluator
                .resolveAllExpressionsInData(
                  expr.raw,
                  { model: {}, env: {}, ...assertContext },
                  options.secretRedactor,
                  options.authoredExpressions,
                );
              resolvedMessage = resolvedMessage.replace(
                expr.raw,
                () => String(value ?? ""),
              );
            } catch {
              // Leave the expression as-is if evaluation fails.
            }
          }
          // Redact once, before the message reaches the step error, the
          // events, or the span; a vault.get() in the message resolves to
          // plaintext above.
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

      // Handle workflow tasks inline to forward nested workflow events
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
          ),
        );
        return;
      }

      // Model method tasks delegate to the step executor.
      // withEventBridge lets the executor push events via callback
      // while we yield them into the parent stream.
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
          mode: options.lastEvaluated ? "lastEvaluated" : "fresh",
          forEachVariable: forEachVar,
          forEachIndex,
          workflowTags: options.workflowTags,
          runtimeTags: options.runtimeTags,
          secretRedactor: options.secretRedactor,
          sensitiveValues: options.sensitiveValues,
          sanitizedTasks: options.sanitizedTasks,
          authoredExpressions: options.authoredExpressions,
          authoredStep: options.authoredWorkflow?.getJob(job.name)?.getStep(
            forEachTemplate ?? stepName,
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
          runTracker: this.runTracker,
          ephemeralRepo: this.ephemeralRepo,
          ephemeralCatalog: this.ephemeralCatalog,
          workflowRepo: this.workflowRepo,
          workflowRunRepo: this.runRepo,
          workflowGateService: this.workflowGateService,
          workflowPlacement: workflow.placementFields,
          jobPlacement: job.placementFields,
          affinityKey: workflow.affinity
            ? run.id
            : job.affinity
            ? `${run.id}:${job.name}`
            : undefined,
          declaredWrites: step.writes ?? job.writes ?? workflow.writes,
        };
        return this.executeMethod(step, ctx, options);
      });

      // A method that finished after the abort settled its step keeps the
      // data it wrote, but not the step's outcome or its outputs.
      const abandoned = abandonedByAbort(stepRun, options);

      // Track data artifacts and update expression context if this was a model method
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

        // Track data artifacts in step run
        if (taskOutput.dataArtifacts) {
          for (const artifact of taskOutput.dataArtifacts) {
            stepRun.addDataArtifact(artifact);
          }
        }

        // Update expression context for subsequent steps (only when not using --last-evaluated)
        if (stepExprContext && taskOutput.model && !abandoned) {
          // Create model entry if it doesn't exist
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

          // Update resource context (specName → instanceName → record)
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
          // Update file context (specName → instanceName → record)
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
      liveOutputs = liveStepOutputs(output);
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
      if (error instanceof WorkflowSuspendedError) {
        stepSpan.end();
        throw error;
      }
      // Record data artifacts that were written before the throw so they
      // survive in the workflow run record for later data get --workflow.
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
      stepRun.fail(errorMessage);
      const isAllowed = !!step.allowFailure;
      if (isAllowed) {
        stepRun.markAllowedFailure();
      }
      stepSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });
      // Populate model/method context on step_failed only for
      // model-method tasks. The libswamp telemetry bridge keys off these
      // fields to synthesize a child invocation entry for failures that
      // occurred before `method_executing` was yielded. Workflow-task
      // steps (which short-circuit via runWorkflowStep above) and other
      // structural failures leave them undefined.
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
        allowedFailure: isAllowed || undefined,
        modelName: taskData.type === "model_method"
          ? taskData.modelIdOrName
          : undefined,
        methodName: taskData.type === "model_method"
          ? taskData.methodName
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
        stepExprContext.steps[stepName] = {
          status: stepRun.status,
          outputs: liveOutputs,
        };
      }
      stepSpan.end();
    }
  }

  /**
   * Refuses, changing nothing, while a nested workflow step of the run waits
   * on a child run that has not finished (swamp-club#2736).
   */
  private async checkNestedWaitsSettled(run: WorkflowRun): Promise<void> {
    await assertNestedWaitsSettled(
      { runRepo: this.runRepo, workflowRepo: this.workflowRepo },
      run,
    );
  }

  /**
   * Settles a nested workflow step re-entered while it waits on its child
   * run, from the child's outcome alone: the parent never drives the child
   * (swamp-club#2736). A succeeded child's outputs are adopted; a child
   * whose approval was rejected fails the step as a rejected approval; any
   * other finished child, a missing one or a broken link fails the step; an
   * unfinished child suspends the run on it again.
   */
  private async *settleNestedWait(
    run: WorkflowRun,
    job: Job,
    stepRun: StepRun,
    stepName: string,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
    allowFailure: boolean,
  ): AsyncGenerator<
    WorkflowExecutionEvent,
    Record<string, unknown> | undefined
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
      const outputs = await this.createStepOutputResolver(
        options.sensitiveValues,
      ).resolveChildOutputs(child);
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

  /**
   * Handles a workflow task step, forwarding child workflow events
   * to the parent stream. Returns the child's outputs for the parent's
   * `steps.<name>.outputs` when the child succeeds.
   */
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
  ): AsyncGenerator<
    WorkflowExecutionEvent,
    Record<string, unknown> | undefined
  > {
    // Resolve every available expression (self.* from the forEach variable,
    // run.*, etc.) in the task BEFORE the recursion-depth guard, cycle
    // detection, ancestor-set additions, and the child invocation, so they all
    // operate on the resolved workflowIdOrName rather than a literal `${{ }}`.
    // Vault/env and step-output kinds are deferred to their dedicated stages;
    // the inputs evaluateData pass below still resolves the rest.
    if (expressionContext) {
      const celEvaluator = new CelEvaluator();
      task = resolveAvailableExpressions(
        task,
        expressionContext,
        (expr, context) => celEvaluator.evaluate(expr, context),
        options.authoredExpressions,
      ) as typeof task;
    }

    // Resolve whole-field expression string for inputs that survived
    // resolveAvailableExpressions (e.g., deferred step-output dependencies).
    task = {
      ...task,
      workflowIdOrName: await this.expressionEvaluator
        .resolveRuntimeExpressionsInData(
          task.workflowIdOrName,
          options.secretRedactor,
          expressionContext,
          options.authoredExpressions,
        ) as string,
      inputs: await resolveRecordExpression(
        task.inputs,
        "task.inputs",
        expressionContext,
        options.authoredExpressions,
      ),
    };

    // The task target survives the passes above when it was deferred past
    // run-start evaluation — it reads step output, or its step carries a
    // guard. Resolve it here, after the guard has decided and after earlier
    // steps have written the data it names (swamp-club#2351).
    task = {
      ...task,
      workflowIdOrName: await resolveScalarExpression(
        task.workflowIdOrName,
        "task.workflowIdOrName",
        expressionContext,
        options.authoredExpressions,
      ) as string,
    };

    // Recursion guard
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

    // Cycle detection
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

    // Evaluate inputs using the expression context. Reuse the
    // per-instance evaluator (was previously constructed per call).
    let evaluatedInputs = task.inputs as Record<string, unknown> | undefined;
    if (task.inputs && typeof task.inputs !== "string" && expressionContext) {
      // The parent's authored set: the child re-collects its own from its
      // YAML once it re-enters executeWorkflow.
      evaluatedInputs = await this.expressionEvaluator.evaluateData(
        task.inputs,
        expressionContext,
        options.authoredExpressions,
      ) as Record<string, unknown>;
    }

    // Deferred bindings are persisted by the child, so resume-derived values
    // (audited by key, never by value) are left out. A parent runtime
    // expression that references one fails to resolve in the child instead
    // of persisting the secret or silently using a stale pre-resume value.
    const deferred = expressionContext
      ? this.expressionEvaluator.deferChildInputs(
        evaluatedInputs,
        expressionContext,
        options.authoredExpressions,
        options.resumeDerived,
      )
      : { data: evaluatedInputs, deferredExpressions: [] };
    evaluatedInputs = deferred.data as Record<string, unknown> | undefined;

    // Runtime expressions (env, vault) the parent author wrote as child
    // inputs survive evaluateData unresolved. They are legitimate provenance
    // in the child, so carry exactly those across; anything else left in the
    // inputs arrived as data content and stays refused.
    const inheritedExpressions = new Set(
      [...collectAuthoredExpressions(evaluatedInputs)].filter((expr) =>
        options.authoredExpressions.has(expr) ||
        deferred.deferredExpressions.some(
          (record) => deferredExpressionReference(record.id) === expr,
        )
      ),
    );

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

    // Create a child WorkflowExecutionService with nesting context.
    // Share the parent's executor so child workflows reuse its
    // (possibly injected) deps — without this, every level of nesting
    // forces a fresh executor with its own per-call construction.
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
    );

    let childRun: WorkflowRun | undefined;
    // The child's suspended event is the parent step's outcome, as its
    // completed event is: the parent suspends on it and emits its own
    // (swamp-club#2736).
    let childSuspended: WorkflowRun | undefined;
    const childEvents = childService.run(task.workflowIdOrName, {
      inputs: evaluatedInputs,
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

    // The child's outputs go to the live context only. The run record keeps
    // the child's ids so they can be resolved again later, never the values.
    const childOutputs = await this.createStepOutputResolver(
      options.sensitiveValues,
    ).resolveChildOutputs(childRun);
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

  /**
   * Runs a model method on the step executor, held in the run's in-flight
   * set until it settles so a cancelled run waits for it to record itself
   * (see {@link InFlightMethodRuns}).
   */
  private executeMethod(
    step: Step,
    ctx: StepExecutionContext,
    options: StepOptions,
  ): Promise<unknown> {
    const execution = this.executor.execute(step, ctx);
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
        // A forEach-expanded name carries whatever its item value held, and
        // Step.create applies the authored-name rule, so a control character
        // from data is escaped rather than failing the guard or assert
        // (swamp-club#3027).
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
          signal: options.signal ?? AbortSignal.timeout(30_000),
          expressionContext: stepExprContext,
          catalogStore: this.catalogStore,
          dataBaseDir: this.dataBaseDir,
          datastoreResolver: this.datastoreResolver,
          runtimeTags: options.runtimeTags,
          secretRedactor: options.secretRedactor,
          sensitiveValues: options.sensitiveValues,
          sanitizedTasks: options.sanitizedTasks,
          authoredExpressions: options.authoredExpressions,
        }, options);
        const methodResult = result as {
          dataHandles?: Array<{
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
              const raw = await this.dataRepo.getContent(
                def.type,
                def.definition.id,
                resourceHandle.specName,
              );
              if (raw) {
                try {
                  return JSON.parse(new TextDecoder().decode(raw));
                } catch {
                  return new TextDecoder().decode(raw);
                }
              }
            }
          }
        }
        return result;
      },
    };
  }

  /**
   * Restores the values behind a stored run's written references and
   * attaches the run's record, so the run carries real values in memory and
   * is written back with references. A run with no references (or one
   * written before sensitive values were kept off disk) is used as stored.
   */
  private async rehydrateRun(
    run: WorkflowRun,
    sensitiveValues: RunSensitiveValues,
  ): Promise<WorkflowRun> {
    if (run.writtenReferences.length === 0) {
      run.attachSensitiveValues(sensitiveValues);
      return run;
    }
    const vaultService = await VaultService.fromRepository(this.repoDir, {
      vaultsDir: this.vaultsDir,
    });
    const {
      writtenReferences,
      sensitiveFormat: _format,
      ...stored
    } = run.toData();
    const { raw } = await rehydratePersistedForm(
      stored,
      writtenReferences ?? [],
      (vaultName, key) => vaultService.get(vaultName, key, "workflow-resume"),
      sensitiveValues,
    );
    const rehydrated = WorkflowRun.fromData(raw);
    rehydrated.attachSensitiveValues(sensitiveValues);
    return rehydrated;
  }

  /**
   * Builds the resolver that reads step outputs back from the datastore for
   * steps whose full output is no longer in memory (resume, replay, child
   * runs). Sensitive fields are vault-resolved so these values match what a
   * live run exposes.
   */
  private createStepOutputResolver(
    sensitiveValues: RunSensitiveValues,
  ): StepOutputResolver {
    let vaultService: Promise<VaultService> | undefined;
    return new StepOutputResolver({
      readAttributes: createDataRepositoryAttributeReader(this.dataRepo, {
        getVaultService: () =>
          vaultService ??= VaultService.fromRepository(this.repoDir, {
            vaultsDir: this.vaultsDir,
          }),
        sensitiveValues,
      }),
      findChildRun: (workflowId, runId) =>
        this.runRepo.findById(
          createWorkflowId(workflowId),
          createWorkflowRunId(runId),
        ),
    });
  }

  /**
   * Prepares one job level of a run or resume. After a job failure with an
   * aborted signal, the level runs in cleanup mode: a fresh cleanup signal so
   * always/completed job dependents can run (shouldJobRun() handles
   * filtering), and any job this walk started that is still "running" is
   * marked failed with its running steps — the signal aborted their execution
   * but the generators were abandoned before they could record the failure.
   * A job a resume inherited as running from a suspension is in flight only
   * once this walk starts it, so it runs when its level is reached; one the
   * abort kept from starting was settled when its level finished
   * (finishJobLevel).
   */
  private enterJobLevel(
    run: WorkflowRun,
    started: ReadonlySet<string>,
    anyJobFailed: boolean,
    signal: AbortSignal | undefined,
    stepOpts: StepOptions,
  ): {
    levelSignal: AbortSignal | undefined;
    levelStepOpts: StepOptions;
    abortedBeforeLevel: boolean;
  } {
    const cleanupMode = anyJobFailed && (signal?.aborted ?? false);
    const levelSignal = cleanupMode
      ? AbortSignal.timeout(CLEANUP_GRACE_TIMEOUT_MS)
      : signal;
    const levelStepOpts = cleanupMode
      ? { ...stepOpts, signal: levelSignal, cleanupJobLevel: true }
      : stepOpts;

    if (cleanupMode) {
      for (const jobRun of run.jobs) {
        if (!started.has(jobRun.jobName)) continue;
        failAbandonedSteps(jobRun);
        if (jobRun.status === "running") {
          jobRun.fail();
        }
      }
    }

    // Only a level the abort interrupted settles its never-started jobs.
    return {
      levelSignal,
      levelStepOpts,
      abortedBeforeLevel: levelSignal?.aborted ?? false,
    };
  }

  /**
   * Finishes one job level of a run or resume after its jobs drained, and
   * returns whether a job has failed so the next level enters cleanup mode.
   *
   * A job this level never started (queued behind workflow concurrency when
   * the abort fired) would stay pending, so a failed or completed condition on
   * it could never be met. It is settled as runJob would have: skipped when
   * its dependsOn is unmet, otherwise from its steps (settleNotStartedJob). A
   * suspended run keeps its pending jobs to resume.
   *
   * A job a resume inherited as running (the job the run was suspended in,
   * or one a failed run left running) that this walk never started, the abort
   * having fired before the level or while the job was queued, is settled the
   * same way, whether or not the abort interrupted the level or the job
   * shares it (markStarted): its pending
   * steps as a never-started job's, then the job from its steps' outcome
   * (settleNotResumedJob). Its approved work never ran, so a dependent gated
   * on it must not see it still running.
   *
   * When the signal aborts mid-level with parallel jobs, mergeWithConcurrency
   * may exit before job_completed events are consumed, so a failure is also
   * derived from model state, after the settling above: a job it ended failed
   * or unknown sends later levels into cleanup mode, so an always or
   * completed dependent runs only once the job is settled.
   */
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
        if (!shouldJobRun(job, run)) {
          jobRun.skipNotStarted();
        } else {
          settleNotStartedJob(job, jobRun);
        }
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
    // Try by name first
    const byName = await this.workflowRepo.findByName(idOrName);
    if (byName) return byName;

    // Try by ID
    const id = createWorkflowId(idOrName);
    return await this.workflowRepo.findById(id);
  }

  /**
   * Builds the expression context for a workflow run or resume.
   *
   * Only expressions reading the model or file namespaces need every model
   * definition loaded. The workflow YAML is checked first, then the stored
   * definitions of the steps that will be evaluated against this context.
   * Cached runs inspect evaluated definitions, including direct-type steps.
   * Fresh direct-type steps carry what the workflow YAML supplied. Nested
   * workflow steps build their own context when they run.
   */
  private async buildRunContext(
    workflow: Workflow,
    sensitiveValues: RunSensitiveValues,
    lastEvaluated = false,
    deferredExpressions: readonly DeferredExpression[] = [],
  ): Promise<ExpressionContext> {
    if (requiresModelNamespace([workflow.toData(), deferredExpressions])) {
      return await this.modelResolver.buildContext(sensitiveValues);
    }

    if (lastEvaluated) {
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          const task = step.task.data;
          if (task.type !== "model_method") continue;
          const reference = task.modelIdOrName ?? task.modelName;
          if (
            !reference || reference.includes("${{") ||
            task.modelType?.includes("${{")
          ) {
            return await this.modelResolver.buildContext(sensitiveValues);
          }
          // Match the definition the executor will load, using the source
          // only to identify stored targets, never to inspect cached expressions.
          let type: ModelType;
          let name = reference;
          if (task.modelType && task.modelName) {
            try {
              type = ModelType.create(task.modelType);
            } catch {
              // Invalid targets still fail at step execution.
              return await this.modelResolver.buildContext(sensitiveValues);
            }
          } else {
            const found = await findDefinitionByIdOrName(
              this.definitionRepo,
              reference,
            );
            if (!found) {
              return await this.modelResolver.buildContext(sensitiveValues);
            }
            type = found.type;
            name = found.definition.name;
          }
          const cached = await this.evaluatedDefRepo.findByNameWithProvenance(
            type,
            name,
          );
          if (
            !cached ||
            requiresModelNamespace([
              cached.definition.toData(),
              cached.deferredExpressions,
            ])
          ) {
            return await this.modelResolver.buildContext(sensitiveValues);
          }
        }
      }
      return this.modelResolver.buildLightContext(sensitiveValues);
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

  /**
   * Assesses whether an interrupted run can be automatically recovered.
   * Returns which unknown steps are auto-recoverable (have guards) and
   * which require operator acknowledgement.
   */
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

  /**
   * Recovers an interrupted run by resetting unknown steps to pending and
   * re-entering the executor. Requires either all unknown steps to have
   * guards (auto-recovery) or explicit operator acknowledgement.
   */
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

    // Reset unknown steps to pending for re-execution
    run.resetUnknownStepsForRecovery();
    await this.saveRun(workflow.id, run);

    // Re-enter the executor via the existing resume path
    yield* this.resume(workflowIdOrName, run.id, {
      signal: options?.signal,
      instanceId: options?.instanceId,
    });
  }

  private async saveRun(
    workflowId: WorkflowId,
    run: WorkflowRun,
  ): Promise<void> {
    await this.runRepo.save(workflowId, run);
  }

  /**
   * Runs `prepare`; if it throws, saves the run back as `snapshot`, hands its
   * tracker row back, and rethrows. A failed restore is logged and the
   * original error still wins.
   */
  private async restoreRunOnFailure<T>(
    { workflowId, snapshot, handBackTrackerRow }: {
      workflowId: WorkflowId;
      snapshot: WorkflowRunData;
      handBackTrackerRow: () => void;
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

  /**
   * Heartbeats the run's tracker row every 30 seconds, when there is a
   * tracker. The caller clears the returned interval.
   */
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
   * Hands the run's tracker row to this process: a suspended, failed or
   * interrupted row becomes running under this pid and `instanceId`, and a
   * row that retention purged is registered again. A row in any other status
   * is left alone. Returns a function that puts the row back to its prior
   * status (`priorStatus` for a row this call registered), for a resume that
   * fails before execution starts.
   *
   * Never throws: it runs after the run is saved as running and before the
   * restore that would undo that save, and tracker bookkeeping is
   * best-effort, so a tracker failure is logged and the resume goes on.
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
        // With the prior reason, so a settled row is not unsettled again
        // (swamp-club#2917).
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

  /**
   * Runs workflow-scope reports after the workflow completes and appends
   * their data artifacts to the WorkflowRun aggregate so the `--workflow`
   * retrieval path can resolve them.
   *
   * Buffers report events emitted by the runner so they can be yielded
   * back through the service's event stream in order.
   */
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

        // Look up the definition for methodArgs and globalArgs only.
        // The modelId comes from step execution time (info.modelId),
        // NOT from this lookup — the lookup can return a stale or
        // different definition for auto-created models.
        //
        // The step already knows its model's type: `model_resolved` carries the
        // resolved definition's own name and type together. Scoping by that type
        // keeps each lookup inside one type directory instead of recursively
        // parsing every definition in the repo once per step, and it cannot
        // match a same-named definition of another type the way a global name
        // search can.
        const modelType = tryCreateModelType(info.modelType);
        let definition: Definition | null = null;
        if (modelType) {
          definition =
            await this.evaluatedDefRepo.findByName(modelType, info.modelName) ??
              await this.definitionRepo.findByName(modelType, info.modelName);
          if (!definition) {
            // A source definition may sit outside the directory its type
            // implies — the YAML `type` field wins over the path — and a step
            // that failed before its evaluated definition was saved falls back
            // to the source repository. Only the global search finds those, so
            // it stays as a last resort, gated on the type matching so it can
            // still never pick up a same-named definition of another type.
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
        const wfStep = workflow.jobs
          .find((j) => j.name === jobName)?.getStep(stepName);
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

  /**
   * Evaluates CEL expressions in a workflow via WorkflowExpressionEvaluator,
   * carrying the tracing span this orchestrator opened around the call.
   */
  private async evaluateWorkflow(
    workflow: Workflow,
    context: ExpressionContext,
    authored: AuthoredExpressions,
  ): Promise<WorkflowEvaluationResult> {
    const evalSpan = getTracer().startSpan("swamp.workflow.evaluate", {
      attributes: { "workflow.name": workflow.name },
    });

    try {
      const result = await new WorkflowExpressionEvaluator(
        new CelEvaluator(),
      ).evaluate(workflow, context, authored);
      evalSpan.setAttribute(
        "workflow.expressions_evaluated",
        result.expressionsEvaluated,
      );
      evalSpan.setStatus({ code: SpanStatusCode.OK });
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
 * Create a lightweight copy of step output, stripping heavy payload fields
 * from DataRecords (`resources`) and DataHandles (`dataHandles`). The full
 * data is already persisted in the datastore; keeping it on the WorkflowRun
 * causes the run aggregate to grow proportionally to cumulative step
 * output, which triggers OOM on large workflows (swamp-club#1673).
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
 * Builds a ModelType from a step's recorded type string, or null if it cannot.
 *
 * `model_resolved` always carries `modelType.normalized`, so this should always
 * succeed. It exists so a step with an unexpected type string degrades to empty
 * method/global args — the same result a lookup miss already produces — instead
 * of throwing and failing report assembly for the whole run.
 */
function tryCreateModelType(rawType: string): ModelType | null {
  try {
    return ModelType.create(rawType);
  } catch {
    return null;
  }
}

function readGlobalConcurrencyLimit(): number | undefined {
  const raw = Deno.env.get("SWAMP_MAX_CONCURRENT_STEPS");
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Effective job-level concurrency for a workflow: `workflow.concurrency`
 * capped by SWAMP_MAX_CONCURRENT_STEPS. Fresh runs and resumes share it so
 * both bound a level's parallel jobs the same way.
 */
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
