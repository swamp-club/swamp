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
// deno-lint-ignore verbatim-module-syntax
import { JobRun, WorkflowRun, type WorkflowRunData } from "./workflow_run.ts";
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
import { DefaultMethodExecutionService } from "../models/method_execution_service.ts";
import { DefaultModelValidationService } from "../models/validation_service.ts";
import { buildMethodContext } from "../models/method_context.ts";
import { detectEnvVarUsageInDefinition } from "../models/env_var_detector.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";
import type { MethodExecutionEvent } from "../models/method_events.ts";
import { ModelOutput } from "../models/model_output.ts";
import type { Definition } from "../definitions/definition.ts";
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
import { resolveAvailableExpressions } from "../expressions/available_expression_resolver.ts";
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
  WorkflowExpressionEvaluator,
} from "./expression_evaluators.ts";
import {
  assertMethodArgumentsEvaluated,
  type FailedExpressions,
} from "../expressions/unresolved_expression_guard.ts";
import { UserError } from "../errors.ts";
import {
  getRunLogger,
  getSwampLogger,
  getWorkflowRunLogger,
  runFileSink,
} from "../../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import { SecretRedactor } from "../secrets/mod.ts";
import { VaultService } from "../vaults/vault_service.ts";
import {
  createDataRepositoryAttributeReader,
  liveStepOutputs,
  StepOutputResolver,
} from "./step_output_resolver.ts";
import { mergeWithConcurrency } from "../../infrastructure/stream/merge.ts";
import { withEventBridge } from "../../infrastructure/stream/event_bridge.ts";
import type { ReportFilterOptions } from "../reports/report_execution_service.ts";
import { getTracer, SpanStatusCode } from "../../infrastructure/tracing/mod.ts";
import { extractSensitiveFieldValues } from "../models/sensitive_field_extractor.ts";
import { getRemoteStepDispatcher } from "../remote/remote_dispatch.ts";

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
 * The run id comes before the detail so serve's 200-character error limit
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
 * Maximum nesting depth for workflow-calling-workflow execution.
 */
const MAX_WORKFLOW_NESTING_DEPTH = 10;

/**
 * Grace period for cleanup steps (always/completed dependents) after
 * cancellation. Cleanup steps run with a fresh signal bounded by this
 * timeout so they cannot hang indefinitely.
 */
const CLEANUP_GRACE_TIMEOUT_MS = 30_000;

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
) => Promise<DirectTypeResolveResult>;

export interface StepLockResult {
  flush: () => Promise<void>;
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
    task = {
      ...task,
      inputs: await resolveRecordExpression(
        task.inputs,
        "task.inputs",
        ctx.expressionContext,
        ctx.authoredExpressions,
      ),
      globalArgs: await resolveRecordExpression(
        task.globalArgs,
        "task.globalArgs",
        ctx.expressionContext,
        ctx.authoredExpressions,
      ),
    };

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
      );

      originalDefinition = result.definition;
      modelType = result.modelType;
      authoredFromDefinition = result.authoredExpressions ?? new Set();

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
      const errors = failures.map((f) => `  ${f.name}: ${f.error}`).join("\n");
      throw new Error(
        `Model validation failed for "${originalDefinition.name}":\n${errors}`,
      );
    }

    // Evaluate CEL expressions (vault left raw for persistence)
    let evaluatedDefinition = originalDefinition;
    let failedExpressions: FailedExpressions = new Map();
    let stepInputs: Record<string, unknown> = {};
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
      evaluatedDefinition = lastEvaluated.definition;
      if (ctx.expressionContext) {
        // The workflow cache may already have supplied the same records;
        // de-dup by id so the definition cache does not grow per replay.
        ctx.expressionContext.deferredExpressions = [
          ...new Map(
            [
              ...(ctx.expressionContext.deferredExpressions ?? []),
              ...lastEvaluated.deferredExpressions,
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
        stepInputs = await expressionEvaluator.evaluateData(
          task.inputs,
          ctx.expressionContext,
          authoredExpressions,
        ) as Record<string, unknown>;
      } else if (task.inputs) {
        stepInputs = task.inputs as Record<string, unknown>;
      }
    } else if (ctx.expressionContext) {
      runLogger.debug("Evaluating expressions");
      // Set self context for this specific model before evaluating
      // Preserve any forEach variables that were set by the workflow engine
      const forEachVars: Record<string, unknown> = {};
      if (ctx.forEachVariable && ctx.forEachVariable.name) {
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
        stepInputs = await expressionEvaluator.evaluateData(
          task.inputs,
          ctx.expressionContext,
          authoredExpressions,
        ) as Record<string, unknown>;
      }

      // Merge step inputs with existing context inputs (step inputs take precedence)
      const originalInputs = ctx.expressionContext.inputs ?? {};
      ctx.expressionContext.inputs = { ...originalInputs, ...stepInputs };

      ({ definition: evaluatedDefinition, failedExpressions } =
        await new DefinitionExpressionEvaluator(
          new CelEvaluator(),
        ).evaluate(
          originalDefinition,
          ctx.expressionContext,
          authoredExpressions,
        ));
    }

    // Forward all step inputs as method arguments.
    // This runs after expression evaluation, so task.inputs values
    // take precedence over any values resolved from ${{ inputs.X }} expressions.
    if (Object.keys(stepInputs).length > 0) {
      for (const [key, value] of Object.entries(stepInputs)) {
        evaluatedDefinition.setMethodArgument(
          task.methodName,
          key,
          value,
        );
      }
    }

    // A failed expression the method is about to receive would otherwise be
    // handed over as its raw ${{ ... }} text. Checked after the step-input
    // overrides above, so an input that replaces the value lets the step run.
    assertMethodArgumentsEvaluated(
      task.methodName,
      evaluatedDefinition.getMethodArguments(task.methodName),
      failedExpressions,
    );

    // Save evaluated definition (with vault expressions still raw) for --last-evaluated
    await evaluatedDefRepo.save(
      modelType,
      evaluatedDefinition,
      authoredExpressions,
      ctx.expressionContext?.deferredExpressions,
    );

    // Capture pre-vault args for report context (so vault secrets stay as expressions)
    const reportGlobalArgs = evaluatedDefinition.globalArguments;
    const reportMethodArgs = evaluatedDefinition.getMethodArguments(
      task.methodName,
    );

    // Resolve runtime expressions (vault and env) at runtime (never persisted).
    // Vault secrets become sentinel tokens; the secretBag maps sentinels to raw values.
    // The expression context is passed so that dynamic vault.get() arguments
    // (e.g. vault.get(inputs.vaultName, inputs.secretKey)) can be CEL-evaluated.
    const runtimeResult = await expressionEvaluator
      .resolveRuntimeExpressionsInDefinition(
        evaluatedDefinition,
        ctx.secretRedactor,
        ctx.expressionContext,
        authoredExpressions,
      );
    evaluatedDefinition = runtimeResult.definition;
    const secretBag = runtimeResult.secretBag;

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
    const definitionHash = await evaluatedDefinition.computeHash();
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

    // Acquire per-step lock before method execution. The lock covers
    // both the method execution (which writes result + log data) AND
    // report generation (which writes report data), ensuring a single
    // flush pushes everything to the remote datastore.
    let flushLock: (() => Promise<void>) | null = null;
    if (this.stepLockHook) {
      const lockResult = await this.stepLockHook(
        modelType.normalized,
        originalDefinition.id,
      );
      flushLock = lockResult.flush;
    }
    try {
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
        const result = await this.invokeMethod({
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
        if (runTracker) runTracker.complete(output.id, "failed");

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
    const workflowTagOverrides: Record<string, string> = {
      ...(ctx.workflowTags ?? {}),
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
            return coerceToSuffix(val);
          });
          resolvedVarySuffix = varyValues.join("-");
        }
        return {
          specName: override.specName,
          lifetime: override.lifetime,
          garbageCollection: override.garbageCollection,
          tags: override.tags,
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
            vaultService,
            ctx.secretRedactor,
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
        ? coerceToSuffix(ctx.forEachVariable.value)
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
      output,
      savedArtifacts,
    } = args;

    // Recover data handles written before the throw (e.g. model wrote
    // data then threw on verdict=FAIL). The execution service attaches
    // them to the error.
    const errorHandles = (error as Record<string, unknown>).dataHandles as
      | import("../models/model.ts").DataHandle[]
      | undefined;
    if (errorHandles && errorHandles.length > 0) {
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
    output.markFailed({ message: errorMessage, stack: errorStack });
    await outputRepo.save(modelType, task.methodName, output);

    runLogger.debug("Method {method} failed: {error}", {
      method: task.methodName,
      model: originalDefinition.name,
      error: errorMessage,
    });

    // Run method-summary report for failed executions so report
    // consumers see structured error output (matching modelMethodRun
    // failure behavior). The runner's internal try/catch ensures
    // report errors don't mask the original execution error.
    if (ctx.reportFilterOptions) {
      await this.reportRunner.runFor({
        status: "failed",
        errorMessage,
        dataHandles: [],
        modelType,
        modelDef,
        evaluatedDefinition,
        originalDefinition,
        methodName: task.methodName,
        reportGlobalArgs,
        reportMethodArgs,
        reportFilterOptions: ctx.reportFilterOptions,
        repoDir: ctx.repoDir,
        swampSha: ctx.swampSha,
        runLogger,
        unifiedDataRepo,
        definitionRepository: definitionRepo,
        emitEvent: ctx.emitEvent,
        jobName: ctx.jobName,
        stepName: ctx.stepName,
      });
    }

    // Attach saved artifacts to the error so the outer step loop can
    // record them on the StepRun.
    if (savedArtifacts.length > 0) {
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
  workflowTags?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  secretRedactor?: SecretRedactor;
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
      lastEvaluated?: boolean;
      inputs?: Record<string, unknown>;
      runtimeTags?: Record<string, string>;
      workflowNestingDepth?: number;
      ancestorWorkflowIds?: Set<string>;
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
    },
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const tracer = getTracer();
    const runSpan = tracer.startSpan("swamp.workflow.run", {
      attributes: { "workflow.name": idOrName },
    });

    let workflowRun: WorkflowRun | undefined;
    let workflowAffinityKey: string | undefined;
    let workflowLogHandle: string | undefined;
    let wfHeartbeatInterval: ReturnType<typeof setInterval> | undefined;
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
      const secretRedactor = new SecretRedactor();

      try {
        // Look up workflow
        const found = await this.lookupWorkflow(idOrName);
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
          // Use the fully evaluated workflow (forEach expanded, expressions resolved)
          workflow = lastEvaluated.workflow;
          deferredExpressions = [
            ...deferredExpressions,
            ...lastEvaluated.deferredExpressions,
          ];
          authoredExpressions = new Set([
            ...authoredExpressions,
            ...lastEvaluated.authoredExpressions,
          ]);

          expressionContext = await this.buildRunContext(
            workflow,
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
            false,
            deferredExpressions,
          );
          buildCtxSpan.end();

          // Add workflow inputs to context
          if (options?.inputs) {
            expressionContext.inputs = options.inputs;
          }

          workflow = await this.evaluateWorkflow(
            workflow,
            expressionContext,
            authoredExpressions,
          );
          await this.evaluatedWorkflowRepo.save(
            workflow,
            authoredExpressions,
            deferredExpressions,
          );
          evaluatedWorkflowFingerprint = await computeWorkflowFingerprint(
            workflow,
          );
        }

        expressionContext.deferredExpressions = deferredExpressions;

        // Create workflow run with merged tags (runtime tags take precedence)
        const mergedTags: Record<string, string> = {
          ...(workflow.tags ?? {}),
          ...(options?.runtimeTags ?? {}),
        };
        run = WorkflowRun.create(
          workflow,
          mergedTags,
          options?.initiatedBy,
          options?.triggerSource,
        );
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
          await this.evaluatedWorkflowRepo.saveForRun(run.id, workflow);
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
        workflowTags: workflow.tags,
        runtimeTags: options?.runtimeTags,
        initiatedBy: options?.initiatedBy,
        secretRedactor,
        signal: options?.signal,
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

      // Resolve effective job-level concurrency:
      // workflow.concurrency capped by SWAMP_MAX_CONCURRENT_STEPS
      const jobConcurrency = resolveEffectiveConcurrency(
        workflow.concurrency,
        readGlobalConcurrencyLimit(),
      );

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
      for (const level of sortedJobs.levels) {
        // After a job failure with an aborted signal, give subsequent
        // levels a fresh cleanup signal so always/completed job
        // dependents can run. shouldJobRun() handles filtering.
        const cleanupMode = anyJobFailed &&
          (options?.signal?.aborted ?? false);
        const levelSignal = cleanupMode
          ? AbortSignal.timeout(CLEANUP_GRACE_TIMEOUT_MS)
          : options?.signal;
        const levelStepOpts = cleanupMode
          ? { ...stepOpts, signal: levelSignal }
          : stepOpts;

        if (cleanupMode) {
          // Mark any jobs/steps still in "running" status as failed —
          // the signal aborted their execution but the generators were
          // abandoned before they could record the failure.
          for (const jobRun of run.jobs) {
            for (const step of jobRun.steps) {
              if (step.status === "running") {
                step.fail("cancelled");
              }
            }
            if (jobRun.status === "running") {
              jobRun.fail();
            }
          }
        }

        // Merge parallel job generators within each level
        const jobStreams = level.map((jobName) =>
          this.runJob(
            workflow,
            run,
            jobName,
            expressionContext,
            levelStepOpts,
          )
        );
        for await (
          const event of mergeWithConcurrency(
            jobStreams,
            jobConcurrency,
            levelSignal,
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
          } else if (event.kind === "step_completed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "succeeded");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRun(workflow.id, run);
          } else if (event.kind === "step_failed") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "failed");
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

        // When the signal aborts mid-level with parallel jobs,
        // mergeWithConcurrency may exit before job_completed events are
        // consumed. Derive anyJobFailed from model state.
        if (!anyJobFailed && options?.signal?.aborted) {
          anyJobFailed = run.jobs.some((j) =>
            j.status === "running" || j.status === "failed" ||
            j.status === "unknown"
          );
        }

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
        const waiting = run.findWaitingApprovalStep();
        if (waiting) {
          const wfStep = workflow.jobs
            .find((j) => j.name === waiting.jobName)?.steps
            .find((s) => s.name === waiting.stepName);
          const taskData = wfStep?.task.data;
          yield {
            kind: "suspended" as const,
            run,
            jobId: waiting.jobName,
            stepId: waiting.stepName,
            prompt: taskData?.type === "manual_approval" ? taskData.prompt : "",
            timeout: taskData?.type === "manual_approval"
              ? taskData.timeout
              : undefined,
          };
        }
        runSpan.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Check if the run was cancelled via abort signal
      if (options?.signal?.aborted) {
        if (wfHeartbeatInterval) clearInterval(wfHeartbeatInterval);
        if (this.runTracker) this.runTracker.complete(run.id, "cancelled");
        run.cancel(
          abortReason(options.signal),
        );
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
        if (this.runTracker) {
          this.runTracker.complete(workflowRun.id, "cancelled");
        }
        workflowRun.cancel(
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
    },
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const workflow = await this.workflowRepo.findByName(workflowIdOrName) ??
      await this.workflowRepo.findById(createWorkflowId(workflowIdOrName));
    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }

    const existingRun = await this.runRepo.findById(
      workflow.id,
      createWorkflowRunId(runId),
    );
    if (!existingRun) {
      throw new UserError(`Workflow run not found: ${runId}`);
    }

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
    // rather than left running with nothing driving it.
    const snapshot = existingRun.toData();

    if (reset) {
      existingRun.resetForResumeFrom(reset.steps, reset.tracked);
      existingRun.resumeFromFailed();
    } else {
      existingRun.resumeFromSuspended();
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

    const {
      expressionContext,
      secretRedactor,
      authoredExpressions,
      resolvedWorkflow,
      workflowLogPath,
      workflowLogHandle,
    } = await this.restoreRunOnFailure(workflow.id, snapshot, async () => {
      const expressionContext = await this.buildRunContext(
        workflow,
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
      // Declared here so vault values resolved into prior step outputs below
      // are redacted from this resume's logs.
      const secretRedactor = new SecretRedactor();

      expressionContext.steps = {};
      const stepOutputResolver = this.createStepOutputResolver(secretRedactor);
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
        secretRedactor,
        authoredExpressions,
        resolvedWorkflow,
        workflowLogPath,
        workflowLogHandle,
      };
    });

    // Declared before the try so the finally at the end of this method can
    // clear it. The try opens immediately after register() — before the
    // "started" yield — so early consumer abandonment (a client that receives
    // "started" then disconnects) still unwinds the finally and releases the
    // log sink.
    let resumeHeartbeatInterval: ReturnType<typeof setInterval> | undefined;
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

      const stepOpts: StepOptions = {
        authoredExpressions,
        authoredWorkflow: workflow,
        workflowTags: resolvedWorkflow.tags,
        runtimeTags: options?.runtimeTags,
        initiatedBy: existingRun.initiatedBy,
        secretRedactor,
        signal: options?.signal,
        resumeDerived: existingRun.resumeInputs.map((key) => `inputs.${key}`),
        // workflow resume never receives CLI report flags — default so
        // resumed runs still execute reports instead of silently skipping.
        reportFilterOptions: options?.reportFilterOptions ?? {},
        swampSha: options?.swampSha,
        assertFailOnSeverity: options?.assertFailOnSeverity,
      };

      // Hand the tracker row to this process (suspended, failed, or
      // interrupted → running) and start heartbeat
      if (this.runTracker) {
        this.runTracker.reactivate(existingRun.id, Deno.pid, hostname());
        const tracker = this.runTracker;
        const runId = existingRun.id;
        resumeHeartbeatInterval = setInterval(() => {
          try {
            tracker.heartbeat(runId);
          } catch {
            // Heartbeat failure is non-fatal
          }
        }, 30_000);
      }

      const jobNodes: GraphNode[] = resolvedWorkflow.jobs.map((job) => ({
        name: job.name,
        weight: job.weight,
        dependencies: job.getDependencyNames(),
      }));
      const sortedJobs = this.sortService.sort(jobNodes);
      const jobConcurrency = resolvedWorkflow.concurrency;

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

      for (const level of sortedJobs.levels) {
        const jobStreams = level.map((jobName: string) => {
          const jobRun = existingRun.getJob(jobName);
          if (
            jobRun &&
            (jobRun.status === "succeeded" || jobRun.status === "failed" ||
              jobRun.status === "skipped" || jobRun.status === "unknown")
          ) {
            return (async function* () {})();
          }
          return this.runJob(
            resolvedWorkflow,
            existingRun,
            jobName,
            expressionContext,
            stepOpts,
          );
        });
        for await (
          const event of mergeWithConcurrency(
            jobStreams,
            jobConcurrency,
            options?.signal,
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
          } else if (event.kind === "step_completed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "succeeded");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
            await this.saveRun(workflow.id, existingRun);
          } else if (event.kind === "step_failed") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "failed");
            await this.saveRun(workflow.id, existingRun);
          } else if (event.kind === "step_skipped") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "skipped");
            await this.saveRun(workflow.id, existingRun);
          }
          yield event as WorkflowExecutionEvent;
        }
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
        const waiting = existingRun.findWaitingApprovalStep();
        if (waiting) {
          const wfStep = resolvedWorkflow.jobs
            .find((j) => j.name === waiting.jobName)?.steps
            .find((s) => s.name === waiting.stepName);
          const taskData = wfStep?.task.data;
          yield {
            kind: "suspended" as const,
            run: existingRun,
            jobId: waiting.jobName,
            stepId: waiting.stepName,
            prompt: taskData?.type === "manual_approval" ? taskData.prompt : "",
            timeout: taskData?.type === "manual_approval"
              ? taskData.timeout
              : undefined,
          };
        }
        return;
      }

      if (options?.signal?.aborted) {
        if (this.runTracker) {
          this.runTracker.complete(existingRun.id, "cancelled");
        }
        existingRun.cancel(
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
        if (this.runTracker) {
          this.runTracker.complete(existingRun.id, "cancelled");
        }
        existingRun.cancel(
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
    }
  }

  private async *runJob(
    workflow: Workflow,
    run: WorkflowRun,
    jobName: string,
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const tracer = getTracer();
    const jobSpan = tracer.startSpan("swamp.workflow.job", {
      attributes: { "job.name": jobName },
    });

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
      const shouldRun = this.shouldJobRun(job, run);
      if (!shouldRun) {
        jobRun.skip();
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
      for (const level of sortedSteps.levels) {
        // After a step failure with an aborted signal, give subsequent
        // levels a fresh cleanup signal so always/completed dependents
        // can run. shouldStepRun() handles condition-based filtering —
        // steps whose conditions aren't met are skipped naturally.
        const cleanupMode = jobFailed && (options.signal?.aborted ?? false);
        const levelSignal = cleanupMode
          ? AbortSignal.timeout(CLEANUP_GRACE_TIMEOUT_MS)
          : options.signal;
        const levelOptions = cleanupMode
          ? { ...options, signal: levelSignal }
          : options;

        if (cleanupMode) {
          // Mark any steps still in "running" status as failed — the
          // signal aborted their execution but the generators were
          // abandoned before they could record the failure.
          for (const step of jobRun.steps) {
            if (step.status === "running") {
              step.fail("cancelled");
            }
          }
        }

        // Merge parallel step generators within each level
        const stepConcurrencies: number[] = [];
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
        const levelStepConc = stepConcurrencies.length > 0
          ? Math.min(...stepConcurrencies)
          : undefined;
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

        // When the signal aborts mid-level with parallel steps,
        // mergeWithConcurrency may exit before step_failed events are
        // consumed. Derive jobFailed from model state so cleanup kicks in.
        if (!jobFailed && options.signal?.aborted) {
          jobFailed = jobRun.steps.some((s) =>
            s.status === "running" || s.status === "failed" ||
            s.status === "unknown"
          );
        }

        if (run.status === "suspended") {
          break;
        }
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
            error: stranded.error ?? "",
            forEachTemplate: stranded.forEachTemplate,
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
    // Skip steps that already completed (during resume from suspended state)
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
          outputs: (await this.createStepOutputResolver(options.secretRedactor)
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

    // Check if step's trigger condition is met. A forEach iteration checks its
    // template's dependsOn, so every iteration is gated as a plain step is.
    if (!this.shouldStepRun(step, jobRun)) {
      stepRun.skip({ kind: "dependency" });
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
    if (step.guard) {
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
        stepRun.fail(String(error));
        stepSpan.setAttribute("step.status", "failed");
        stepSpan.end();
        yield {
          kind: "step_failed",
          jobId: job.name,
          stepId: stepName,
          error: `Guard expression failed: ${error}`,
          forEachTemplate,
          forEachIndex,
        };
        return;
      }
    }

    // Start step
    stepRun.start();
    yield {
      kind: "step_started",
      jobId: job.name,
      stepId: stepName,
      forEachTemplate,
      forEachIndex,
    };

    // This step's `steps.<name>.outputs`, taken from the full output before
    // it is stripped for the run record. Declared here so the finally below
    // sees it for both model_method and workflow steps.
    let liveOutputs: Record<string, unknown> | undefined;
    try {
      const task = step.task.data;

      // Handle manual approval tasks — suspend the workflow
      if (task.type === "manual_approval") {
        stepRun.waitForApproval(task.prompt);
        yield {
          kind: "approval_requested",
          runId: run.id,
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
              error: resolvedMessage,
              allowedFailure: isAllowed || undefined,
              forEachTemplate,
              forEachIndex,
            };
          }
        } catch (error) {
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
        liveOutputs = yield* this.runWorkflowStep(
          workflow,
          job,
          stepRun,
          stepName,
          task,
          stepExprContext,
          options,
          !!step.allowFailure,
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
          workflowTags: options.workflowTags,
          runtimeTags: options.runtimeTags,
          secretRedactor: options.secretRedactor,
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
        return this.executor.execute(step, ctx);
      });

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
        if (stepExprContext && taskOutput.model) {
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
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        error: errorMessage,
        allowedFailure: isAllowed || undefined,
        modelName: taskData.type === "model_method"
          ? taskData.modelIdOrName
          : undefined,
        methodName: taskData.type === "model_method"
          ? taskData.methodName
          : undefined,
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
   * Handles a workflow task step, forwarding child workflow events
   * to the parent stream. Returns the child's outputs for the parent's
   * `steps.<name>.outputs` when the child succeeds.
   */
  private async *runWorkflowStep(
    workflow: Workflow,
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
    try {
      for await (
        const event of childService.run(task.workflowIdOrName, {
          inputs: evaluatedInputs,
          authoredExpressions: inheritedExpressions,
          deferredExpressions: deferred.deferredExpressions,
          workflowNestingDepth: depth + 1,
          ancestorWorkflowIds: childAncestors,
        })
      ) {
        if (event.kind === "completed") {
          childRun = event.run;
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
        error: errorMessage,
        allowedFailure: allowFailure || undefined,
      };
      return;
    }

    if (!childRun || childRun.status === "failed") {
      const childStepError = childRun?.jobs
        .flatMap((j) => j.steps)
        .find((s) => s.status === "failed" && !s.allowedFailure)?.error;
      const errorMessage = childStepError ??
        `Nested workflow "${task.workflowIdOrName}" failed.`;
      stepRun.fail(errorMessage);
      if (allowFailure) {
        stepRun.markAllowedFailure();
      }
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        error: errorMessage,
        allowedFailure: allowFailure || undefined,
      };
      return;
    }

    // The child's outputs go to the live context only. The run record keeps
    // the child's ids so they can be resolved again later, never the values.
    const childOutputs = await this.createStepOutputResolver(
      options.secretRedactor,
    ).resolveChildOutputs(childRun);
    stepRun.succeed({
      type: "workflow",
      workflow: task.workflowIdOrName,
      workflowId: childRun.workflowId,
      runId: childRun.id,
      status: childRun.status,
    });
    yield { kind: "step_completed", jobId: job.name, stepId: stepName };
    return childOutputs;
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
        const syntheticName = `${prefix}${stepName}`;
        const syntheticStep = Step.create({
          name: syntheticName,
          task: StepTask.model(modelName, methodName, inputs),
        });
        const result = await this.executor.execute(syntheticStep, {
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
          authoredExpressions: options.authoredExpressions,
        });
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
   * Builds the resolver that reads step outputs back from the datastore for
   * steps whose full output is no longer in memory (resume, replay, child
   * runs). Sensitive fields are vault-resolved so these values match what a
   * live run exposes.
   */
  private createStepOutputResolver(
    redactor: SecretRedactor | undefined,
  ): StepOutputResolver {
    let vaultService: Promise<VaultService> | undefined;
    return new StepOutputResolver({
      readAttributes: createDataRepositoryAttributeReader(this.dataRepo, {
        getVaultService: () =>
          vaultService ??= VaultService.fromRepository(this.repoDir, {
            vaultsDir: this.vaultsDir,
          }),
        redactor,
      }),
      findChildRun: (workflowId, runId) =>
        this.runRepo.findById(
          createWorkflowId(workflowId),
          createWorkflowRunId(runId),
        ),
    });
  }

  private shouldJobRun(job: Job, run: WorkflowRun): boolean {
    // If no dependencies, always run
    if (job.dependsOn.length === 0) {
      return true;
    }

    // Check all dependency conditions
    for (const dep of job.dependsOn) {
      if (!dep.condition.evaluate(run, dep.job)) {
        return false;
      }
    }

    return true;
  }

  private shouldStepRun(step: Step, jobRun: JobRun): boolean {
    // If no dependencies, always run
    if (step.dependsOn.length === 0) {
      return true;
    }

    // Check all dependency conditions
    for (const dep of step.dependsOn) {
      if (!dep.condition.evaluate(jobRun, dep.step)) {
        return false;
      }
    }

    return true;
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
    lastEvaluated = false,
    deferredExpressions: readonly DeferredExpression[] = [],
  ): Promise<ExpressionContext> {
    if (requiresModelNamespace([workflow.toData(), deferredExpressions])) {
      return await this.modelResolver.buildContext();
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
            return await this.modelResolver.buildContext();
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
              return await this.modelResolver.buildContext();
            }
          } else {
            const found = await findDefinitionByIdOrName(
              this.definitionRepo,
              reference,
            );
            if (!found) return await this.modelResolver.buildContext();
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
            return await this.modelResolver.buildContext();
          }
        }
      }
      return this.modelResolver.buildLightContext();
    }

    // A dynamic reference names an unknown definition until the step runs, so
    // keep the full context rather than guess.
    const references = extractStepDefinitionReferences(workflow);
    if (references === null) {
      return await this.modelResolver.buildContext();
    }

    if (references.length === 0) {
      return this.modelResolver.buildLightContext();
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
        undefined,
        undefined,
        undefined,
        definitions,
      )
      : this.modelResolver.buildLightContext();
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

    // Reset unknown steps to pending for re-execution
    run.resetUnknownStepsForRecovery();
    await this.saveRun(workflow.id, run);

    // Re-enter the executor via the existing resume path
    yield* this.resume(workflowIdOrName, run.id, {
      signal: options?.signal,
    });
  }

  private async saveRun(
    workflowId: WorkflowId,
    run: WorkflowRun,
  ): Promise<void> {
    await this.runRepo.save(workflowId, run);
  }

  /**
   * Runs `prepare`; if it throws, saves the run back as `snapshot` and
   * rethrows. A failed restore is logged and the original error still wins.
   */
  private async restoreRunOnFailure<T>(
    workflowId: WorkflowId,
    snapshot: WorkflowRunData,
    prepare: () => Promise<T>,
  ): Promise<T> {
    try {
      return await prepare();
    } catch (error) {
      try {
        await this.saveRun(workflowId, WorkflowRun.fromData(snapshot));
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
      throw error;
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
      inputs: run.inputs,
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
  ): Promise<Workflow> {
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
      return result.workflow;
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

function resolveEffectiveConcurrency(
  local: number | undefined,
  global: number | undefined,
): number | undefined {
  const l = local && local > 0 ? local : undefined;
  const g = global && global > 0 ? global : undefined;
  if (l && g) return Math.min(l, g);
  return l ?? g;
}
