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

import type { Workflow } from "./workflow.ts";
import type { Job } from "./job.ts";
import type { Step } from "./step.ts";
import {
  type ExpandedStep,
  ForEachExpansionService,
} from "./for_each_expansion_service.ts";
import { coerceToSuffix } from "./data_suffix.ts";
// deno-lint-ignore verbatim-module-syntax
import { JobRun, WorkflowRun } from "./workflow_run.ts";
import {
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";
import { createWorkflowId, type WorkflowId } from "./workflow_id.ts";
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
import type { OutputRepository } from "../models/repositories.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { MethodExecutionService } from "../models/method_execution_service.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../data/data_query_service.ts";
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
import type { ModelType } from "../models/model_type.ts";
import type { MethodResult, ModelDefinition } from "../models/model.ts";
import {
  containsRuntimeExpression,
  ExpressionEvaluationService,
} from "../expressions/expression_evaluation_service.ts";
import {
  buildEnvContext,
  type DataRecord,
  type ExpressionContext,
  type FileDataRecord,
  ModelResolver,
} from "../expressions/model_resolver.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  DefinitionExpressionEvaluator,
  WorkflowExpressionEvaluator,
} from "./expression_evaluators.ts";
import { UserError } from "../errors.ts";
import {
  getRunLogger,
  getWorkflowRunLogger,
  runFileSink,
} from "../../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import { SecretRedactor } from "../secrets/mod.ts";
import { VaultService } from "../vaults/vault_service.ts";
import { mergeWithConcurrency } from "../../infrastructure/stream/merge.ts";
import { withEventBridge } from "../../infrastructure/stream/event_bridge.ts";
import type { ReportFilterOptions } from "../reports/report_execution_service.ts";
import { getTracer, SpanStatusCode } from "../../infrastructure/tracing/mod.ts";
import { DriverPlan } from "../drivers/driver_plan.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { createRepoMarkerLoader } from "../../infrastructure/persistence/repo_marker_loader.ts";
import { extractSensitiveFieldValues } from "../models/sensitive_field_extractor.ts";

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
  /** Tags from the workflow definition, merged into data writer tag overrides */
  workflowTags?: Record<string, string>;
  /** Runtime tags from --tag CLI flags, passed to method execution context */
  runtimeTags?: Record<string, string>;
  /** Secret redactor for stripping vault secrets from persisted data and logs */
  secretRedactor?: SecretRedactor;
  /**
   * Two-stage driver-resolution plan. Pre-definition tiers
   * (cli/step/job/workflow/repo) are filled in at step-construction
   * time; the executor finalizes via `driverPlan.withDefinition({...})`
   * once the evaluated definition is in scope.
   */
  driverPlan?: DriverPlan;
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
  /** Resolved base directory for data storage (S3 cache path) */
  dataBaseDir?: string;
  /** Catalog store for write-through indexing */
  catalogStore: CatalogStore;
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
}

export type DirectTypeResolver = (
  typeArg: string,
  definitionName: string,
  methodName: string,
  inputs: Record<string, unknown>,
) => Promise<DirectTypeResolveResult>;

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
      catalogStore: CatalogStore;
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
      catalogStore: ctx.catalogStore,
    });
    if (this._directTypeResolver) {
      deps.directTypeResolver = this._directTypeResolver;
    }
    return deps;
  }

  private static async buildDeps(
    repoDir: string,
    opts: { dataBaseDir?: string; catalogStore: CatalogStore },
  ): Promise<StepExecutorDeps> {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const unifiedDataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      opts.dataBaseDir,
      opts.catalogStore,
    );
    const dataQueryService = new DataQueryService(
      opts.catalogStore,
      unifiedDataRepo,
    );
    return {
      definitionRepo,
      unifiedDataRepo,
      dataQueryService,
      outputRepo: new YamlOutputRepository(repoDir),
      evaluatedDefRepo: new YamlEvaluatedDefinitionRepository(repoDir),
      methodExecutionService: new DefaultMethodExecutionService(),
      vaultService: await VaultService.fromRepository(repoDir),
      expressionEvaluator: new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
      ),
      // directTypeResolver is not available in the lazy buildDeps path.
      // It must be injected via the WorkflowExecutionService constructor.
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
      inputs?: Record<string, unknown>;
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

    // Resolve forEach self.* expressions in modelIdOrName/modelName and methodName
    // before model lookup. The expression context has self populated with
    // the forEach variable by runStep().
    if (ctx.expressionContext) {
      const celEvaluator = new CelEvaluator();
      const resolve = (value: string): string =>
        value.replace(
          /\$\{\{\s*(.+?)\s*\}\}/g,
          (_match: string, expr: string) => {
            if (containsRuntimeExpression(expr)) return _match;
            try {
              return String(
                celEvaluator.evaluate(expr, ctx.expressionContext!),
              );
            } catch {
              return _match;
            }
          },
        );
      task = {
        ...task,
        modelIdOrName: task.modelIdOrName
          ? resolve(task.modelIdOrName)
          : undefined,
        modelName: task.modelName ? resolve(task.modelName) : undefined,
        methodName: resolve(task.methodName),
      };
    }

    let originalDefinition: Definition;
    let modelType: ModelType;

    if (task.modelType && task.modelName) {
      const resolver = allDeps.directTypeResolver;

      if (!resolver) {
        throw new Error(
          "Direct type execution is not supported in this context",
        );
      }

      const result = await resolver(
        task.modelType,
        task.modelName,
        task.methodName,
        task.inputs ?? {},
      );

      originalDefinition = result.definition;
      modelType = result.modelType;

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
    } else {
      throw new Error(
        "Step task requires either modelIdOrName or modelType + modelName",
      );
    }

    // Log via model method run logger (same categories as standalone)
    const runLogger = getRunLogger(originalDefinition.name, task.methodName);

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
    let stepInputs: Record<string, unknown> = {};
    if (ctx.mode === "lastEvaluated") {
      // Load previously-evaluated definition from cache
      runLogger?.debug("Loading last evaluated definition");
      const lastEvaluated = await evaluatedDefRepo.findByName(
        modelType,
        originalDefinition.name,
      );
      if (!lastEvaluated) {
        throw new Error(
          `No previously evaluated definition found for "${originalDefinition.name}". ` +
            `Run the workflow without --last-evaluated first.`,
        );
      }
      evaluatedDefinition = lastEvaluated;

      // Values are already resolved in the pre-evaluated workflow
      if (task.inputs) {
        stepInputs = task.inputs;
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
        ) as Record<string, unknown>;
      }

      // Merge step inputs with existing context inputs (step inputs take precedence)
      const originalInputs = ctx.expressionContext.inputs ?? {};
      ctx.expressionContext.inputs = { ...originalInputs, ...stepInputs };

      evaluatedDefinition = await new DefinitionExpressionEvaluator(
        new CelEvaluator(),
      ).evaluate(originalDefinition, ctx.expressionContext);
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

    // Save evaluated definition (with vault expressions still raw) for --last-evaluated
    await evaluatedDefRepo.save(modelType, evaluatedDefinition);

    // Capture pre-vault args for report context (so vault secrets stay as expressions)
    const reportGlobalArgs = evaluatedDefinition.globalArguments;
    const reportMethodArgs = evaluatedDefinition.getMethodArguments(
      task.methodName,
    );

    // Resolve runtime expressions (vault and env) at runtime (never persisted).
    // Vault secrets become sentinel tokens; the secretBag maps sentinels to raw values.
    const runtimeResult = await expressionEvaluator
      .resolveRuntimeExpressionsInDefinition(
        evaluatedDefinition,
        ctx.secretRedactor,
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
      },
    });

    // Mark as running and save
    output.markRunning();
    // Reference the workflow run's log file for history access
    if (ctx.workflowRun?.logFile) {
      output.setLogFile(ctx.workflowRun.logFile);
    }
    await outputRepo.save(modelType, task.methodName, output);

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

    try {
      const result = await this.invokeMethod({
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
        expressionEvaluator,
      });

      return await this.handleMethodSuccess({
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
      });
    } catch (error) {
      await this.handleMethodFailure({
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
      });
      throw error;
    }
  }

  /**
   * Invoke the model method. Builds the per-call tag overrides,
   * resolves the data-output overrides for vary, finalizes the
   * driver plan, and dispatches to the method execution service.
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
    expressionEvaluator: ExpressionEvaluationService;
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
      expressionEvaluator,
    } = args;

    runLogger.debug("Executing method {method}", { method: task.methodName });

    // Build workflow-specific tag overrides. Use "source" instead of
    // "type" to preserve the original data type (resource/file) while
    // tracking provenance for cross-workflow resolution.
    const workflowTagOverrides: Record<string, string> = {
      ...(ctx.workflowTags ?? {}),
      source: "step-output",
      workflow: ctx.workflowName,
      workflowRunId: ctx.workflowRunId,
      job: ctx.jobName,
      step: ctx.stepName,
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

    // Finalize driver resolution. When no plan was passed (legacy
    // callers, e.g. tests constructing a StepExecutionContext directly),
    // route through an empty plan so the definition tier is still
    // honoured — matches the pre-DriverPlan behaviour where the
    // definition was passed to resolveDriverConfig regardless of whether
    // upper tiers were set.
    const resolvedDriver = (ctx.driverPlan ?? new DriverPlan({}))
      .withDefinition({
        driver: evaluatedDefinition.driver,
        driverConfig: evaluatedDefinition.driverConfig,
      });

    // Resolve CEL (including self.* for forEach) and runtime expressions
    // (env, vault) in the winning tier's driverConfig. WorkflowExpressionEvaluator
    // deliberately skips runtime expressions and self.* during workflow
    // evaluation, and the definition-tier driverConfig is the only tier
    // that already went through resolveRuntimeExpressionsInDefinition; this
    // seam covers workflow/job/step/repo tiers (and is idempotent for the
    // definition tier). Vault values land as raw strings on driver argv;
    // see the workflows manual reference for the visibility caveat.
    const resolved = ctx.expressionContext && resolvedDriver.driverConfig
      ? {
        driver: resolvedDriver.driver,
        driverConfig: (await expressionEvaluator.resolveAllExpressionsInData(
          resolvedDriver.driverConfig,
          ctx.expressionContext,
          ctx.secretRedactor,
        )) as Record<string, unknown>,
      }
      : resolvedDriver;

    // Yield `method_executing` AFTER driver resolution so the resolved
    // driver can ride along on the event for downstream telemetry. Note:
    // any failure between the start of runModelMethodTask and this point
    // (vary-key validation, etc.) becomes a "pre-method-executing"
    // failure and is reported via step_failed instead — by design.
    ctx.emitEvent?.({
      kind: "method_executing",
      jobId: ctx.jobName,
      stepId: ctx.stepName,
      modelName: originalDefinition.name,
      methodName: task.methodName,
      driver: resolved.driver,
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

    // Execute the method with the EVALUATED definition. The logger
    // handles both console and file persistence via RunFileSink. Data
    // is persisted by DataWriter during execution — no double-save.
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
          dataOutputOverrides: stepDataOutputOverrides,
          vaultSecrets: secretBag,
          driver: resolved.driver,
          driverConfig: resolved.driverConfig,
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
    // data then threw on verdict=FAIL). The driver attaches them to
    // the error.
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
import type { WorkflowExecutionEvent } from "./execution_events.ts";

/**
 * Internal options bundle passed through runJob/runStep to reduce parameter count.
 */
interface StepOptions {
  lastEvaluated?: boolean;
  workflowNestingDepth?: number;
  ancestorWorkflowIds?: Set<string>;
  workflowTags?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  secretRedactor?: SecretRedactor;
  signal?: AbortSignal;
  driver?: string;
  reportFilterOptions?: ReportFilterOptions;
  /** The git commit sha of the swamp repo at execution time */
  swampSha?: string;
  /** Check names to skip during pre-flight checks */
  skipCheckNames?: string[];
  /** Skip checks that have any of these labels */
  skipCheckLabels?: string[];
  /** Skip all pre-flight checks */
  skipAllChecks?: boolean;
}

/**
 * Domain service for workflow execution.
 */
export class WorkflowExecutionService {
  private readonly sortService = new TopologicalSortService();
  private readonly executor: StepExecutor;
  private readonly definitionRepo: YamlDefinitionRepository;
  private readonly evaluatedDefRepo: YamlEvaluatedDefinitionRepository;
  private readonly modelResolver: ModelResolver;
  private readonly dataRepo: FileSystemUnifiedDataRepository;
  private readonly dataBaseDir?: string;
  private readonly catalogStore: CatalogStore;
  private readonly markerRepo = new RepoMarkerRepository();
  private readonly workflowReportRunner = new WorkflowReportRunner();
  /**
   * Promise-memoized loader for `.swamp.yaml`. Instance-scoped so a
   * long-running serve process creates a fresh loader per request and
   * picks up marker edits between requests.
   */
  private readonly loadRepoMarker: () => Promise<RepoMarkerData | null>;
  /** Evaluator for sub-workflow input expressions. Per-instance, not per-call. */
  private readonly expressionEvaluator: ExpressionEvaluationService;

  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly runRepo: WorkflowRunRepository,
    private readonly repoDir: string,
    executor: StepExecutor | undefined,
    dataBaseDir: string | undefined,
    catalogStore: CatalogStore,
    private readonly directTypeResolver?: DirectTypeResolver,
  ) {
    this.executor = executor ??
      new DefaultStepExecutor(undefined, directTypeResolver);
    this.dataBaseDir = dataBaseDir;
    this.catalogStore = catalogStore;
    this.definitionRepo = new YamlDefinitionRepository(repoDir);
    this.evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(repoDir);
    this.dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      dataBaseDir,
      catalogStore,
    );
    const dataQueryService = new DataQueryService(catalogStore, this.dataRepo);
    this.modelResolver = new ModelResolver(this.definitionRepo, {
      repoDir,
      dataRepo: this.dataRepo,
      dataQueryService,
    });
    this.expressionEvaluator = new ExpressionEvaluationService(
      this.definitionRepo,
      repoDir,
    );
    this.loadRepoMarker = createRepoMarkerLoader(this.markerRepo, repoDir);
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
      /** Execution driver override (from CLI --driver flag) */
      driver?: string;
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
    },
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const tracer = getTracer();
    const runSpan = tracer.startSpan("swamp.workflow.run", {
      attributes: { "workflow.name": idOrName },
    });

    try {
      // Load repo marker early so the `repo` tier of resolveDriverConfig
      // (populated below at every step) uses the memoized value.
      await this.loadRepoMarker();

      // Look up workflow
      let workflow = await this.lookupWorkflow(idOrName);
      if (!workflow) {
        throw new Error(`Workflow not found: ${idOrName}`);
      }

      let expressionContext: ExpressionContext | undefined;

      if (options?.lastEvaluated) {
        // Load previously evaluated workflow from cache
        const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
          this.repoDir,
        );
        const lastEvaluated = await evaluatedWorkflowRepo.findByName(
          workflow.name,
        );
        if (!lastEvaluated) {
          throw new UserError(
            `No previously evaluated workflow found for "${workflow.name}".\n\n` +
              `Evaluate the workflow first to generate evaluated data:\n` +
              `  swamp workflow evaluate ${workflow.name}`,
          );
        }
        // Use the fully evaluated workflow (forEach expanded, expressions resolved)
        workflow = lastEvaluated;

        // Build a minimal expression context so step outputs can be tracked
        // and deferred expressions (e.g. model.previous.resource.*) can be
        // evaluated at step execution time.
        expressionContext = {
          model: {},
          env: buildEnvContext(),
        };
        if (options?.inputs) {
          expressionContext.inputs = options.inputs;
        }
      } else {
        // Build expression context and evaluate workflow
        expressionContext = await this.modelResolver.buildContext();

        // Add workflow inputs to context
        if (options?.inputs) {
          expressionContext.inputs = options.inputs;
        }

        workflow = await this.evaluateWorkflow(workflow, expressionContext);
        const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
          this.repoDir,
        );
        await evaluatedWorkflowRepo.save(workflow);
      }

      // Create workflow run with merged tags (runtime tags take precedence)
      const mergedTags: Record<string, string> = {
        ...(workflow.tags ?? {}),
        ...(options?.runtimeTags ?? {}),
      };
      const run = WorkflowRun.create(workflow, mergedTags);

      // workflowRunId is set here for backward compat; the structured
      // run namespace is populated after run.start() below so that
      // startedAt is available.
      if (expressionContext) {
        expressionContext.workflowRunId = run.id;
      }

      // Create secret redactor — populated during vault resolution, used by log sink and data writers
      const secretRedactor = new SecretRedactor();

      // Register run file sink target for the workflow log output
      const workflowLogPath = join(
        swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns),
        workflow.id,
        `workflow-run-${run.id}.log`,
      );
      const workflowLogCategory: string[] = [];
      const workflowLogBoundary = swampPath(this.repoDir);
      await runFileSink.register(
        workflowLogCategory,
        workflowLogPath,
        secretRedactor,
        workflowLogBoundary,
      );
      run.setLogFile(workflowLogPath);

      // Enrich span with resolved workflow metadata
      runSpan.setAttribute("workflow.id", workflow.id);
      runSpan.setAttribute("workflow.run_id", run.id);

      // Start execution
      run.start();

      if (expressionContext) {
        expressionContext.run = {
          id: run.id,
          workflowId: workflow.id,
          workflowName: workflow.name,
          startedAt: run.startedAt!.toISOString(),
          tags: { ...run.tags },
        };
      }

      yield {
        kind: "started",
        runId: run.id,
        workflowName: workflow.name,
        logPath: workflowLogPath,
        driver: workflow.driver,
        jobs: workflow.jobs.map((job) => ({
          id: job.name,
          stepCount: job.steps.length,
          dependsOn: job.getDependencyNames(),
        })),
      };

      await this.saveRun(workflow.id, run);

      const stepOpts: StepOptions = {
        lastEvaluated: options?.lastEvaluated,
        workflowNestingDepth: options?.workflowNestingDepth,
        ancestorWorkflowIds: options?.ancestorWorkflowIds,
        workflowTags: workflow.tags,
        runtimeTags: options?.runtimeTags,
        secretRedactor,
        signal: options?.signal,
        driver: options?.driver,
        reportFilterOptions: options?.reportFilterOptions,
        swampSha: options?.swampSha,
        skipCheckNames: options?.skipCheckNames,
        skipCheckLabels: options?.skipCheckLabels,
        skipAllChecks: options?.skipAllChecks,
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
        { modelName: string; modelType: string; methodName: string }
      >();
      const stepStatuses = new Map<
        string,
        "succeeded" | "failed" | "skipped"
      >();
      const stepJobNames = new Map<string, string>();
      const dataHandlesByStep = new Map<
        string,
        import("../models/model.ts").DataHandle[]
      >();

      // Execute jobs level by level
      for (const level of sortedJobs.levels) {
        // Merge parallel job generators within each level
        const jobStreams = level.map((jobName) =>
          this.runJob(
            workflow,
            run,
            jobName,
            expressionContext,
            stepOpts,
          )
        );
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
              methodName: event.methodName,
            });
            stepJobNames.set(key, event.jobId);
          } else if (event.kind === "step_completed") {
            const key = `${event.jobId}:${event.stepId}`;
            stepStatuses.set(key, "succeeded");
            if (event.dataHandles) {
              dataHandlesByStep.set(key, event.dataHandles);
            }
          } else if (event.kind === "step_failed") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "failed");
          } else if (event.kind === "step_skipped") {
            stepStatuses.set(`${event.jobId}:${event.stepId}`, "skipped");
          }
          yield event;
        }
        await this.saveRun(workflow.id, run);
      }

      // Complete workflow
      run.complete();

      // Execute workflow-scope reports before the completed event so the
      // run aggregate carries the workflow-scope dataArtifacts produced by
      // those reports — required for `swamp data get --workflow` and
      // `swamp data list --workflow` to surface them.
      yield* this.runWorkflowReports(
        workflow,
        run,
        modelInfoByStep,
        stepStatuses,
        stepJobNames,
        dataHandlesByStep,
        options?.reportFilterOptions,
      );

      yield { kind: "completed", run };
      await this.saveRun(workflow.id, run);

      // Unregister workflow log file sink
      runFileSink.unregister(workflowLogCategory);

      runSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      runSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
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
    }
    if (!result) throw new Error("Workflow run did not complete");
    return result;
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

      // Start job
      jobRun.start();
      yield { kind: "job_started", jobId: jobName };

      // Expand forEach steps if we have expression context.
      // Runs in all modes including --last-evaluated: forEach expansion
      // is a structural transformation, not expression evaluation.
      let expandedStepsMap: Map<string, ExpandedStep[]> | undefined;
      if (expressionContext) {
        expandedStepsMap = await new ForEachExpansionService(new CelEvaluator())
          .expand(job, expressionContext);
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
        if (jobFailed) break;

        // Merge parallel step generators within each level
        const stepConcurrencies: number[] = [];
        const stepStreams = level.map((stepName) => {
          // Find the expanded step info if applicable
          let forEachVar: { name: string; value: unknown } | undefined;
          let originalStep: Step | undefined;

          if (expandedStepsMap) {
            for (const [, expanded] of expandedStepsMap) {
              const found = expanded.find((e) => e.expandedName === stepName);
              if (found) {
                forEachVar = found.forEachVar;
                originalStep = found.step;
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
            options,
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
            options.signal,
          )
        ) {
          yield event;
          if (event.kind === "step_failed" && !event.allowedFailure) {
            jobFailed = true;
          }
        }
      }

      // Complete job
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
    } catch (error) {
      jobSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
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
    if (!stepRun) {
      stepSpan.end();
      throw new Error(`Step run not found: ${stepName}`);
    }

    // Check if step's trigger condition is met (skip for forEach-expanded steps
    // as they don't have the same dependencies structure)
    if (!forEachVar || !forEachVar.name) {
      const shouldRun = this.shouldStepRun(step, jobRun);
      if (!shouldRun) {
        stepRun.skip();
        stepSpan.setAttribute("step.status", "skipped");
        stepSpan.end();
        yield { kind: "step_skipped", jobId: job.name, stepId: stepName };
        return;
      }
    }

    // Start step
    stepRun.start();
    yield { kind: "step_started", jobId: job.name, stepId: stepName };

    // Declared outside the try so the step_failed yield in the catch
    // block can populate `driver` when the failure occurred AFTER the
    // DriverPlan was constructed but BEFORE method_executing was yielded
    // (e.g. vault expression resolution failure inside the executor).
    let driverPlan: DriverPlan | undefined;

    try {
      // Build the expression context with forEach variable
      let stepExprContext = expressionContext;
      if (expressionContext && forEachVar && forEachVar.name) {
        const baseSelf = expressionContext.self ?? {
          id: "",
          name: "",
          version: 1,
          tags: {},
          globalArguments: {},
        };
        stepExprContext = {
          ...expressionContext,
          self: {
            ...baseSelf,
            [forEachVar.name]: forEachVar.value,
          },
        };
      }

      const task = step.task.data;

      // Handle workflow tasks inline to forward nested workflow events
      if (task.type === "workflow") {
        yield* this.runWorkflowStep(
          workflow,
          job,
          stepRun,
          stepName,
          task,
          stepExprContext,
          options,
        );
        return;
      }

      // Model method tasks delegate to the step executor.
      // withEventBridge lets the executor push events via callback
      // while we yield them into the parent stream.
      const repoMarker = await this.loadRepoMarker();
      // Build the DriverPlan; assign to the outer-scoped `driverPlan`
      // so the catch block can populate `driver` on step_failed events
      // for failures that occur BEFORE method_executing was yielded
      // (model lookup, input validation, vault expression resolution).
      driverPlan = new DriverPlan({
        cli: { driver: options.driver },
        step: { driver: step.driver, driverConfig: step.driverConfig },
        job: { driver: job.driver, driverConfig: job.driverConfig },
        workflow: {
          driver: workflow.driver,
          driverConfig: workflow.driverConfig,
        },
        repo: {
          driver: repoMarker?.defaultDriver,
          driverConfig: repoMarker?.defaultDriverConfig,
        },
      });
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
          signal: options.signal ?? new AbortController().signal,
          expressionContext: stepExprContext,
          workflowRun: run,
          step,
          mode: options.lastEvaluated ? "lastEvaluated" : "fresh",
          forEachVariable: forEachVar,
          workflowTags: options.workflowTags,
          runtimeTags: options.runtimeTags,
          secretRedactor: options.secretRedactor,
          driverPlan,
          emitEvent: push,
          reportFilterOptions: options.reportFilterOptions,
          swampSha: options.swampSha,
          skipCheckNames: options.skipCheckNames,
          skipCheckLabels: options.skipCheckLabels,
          skipAllChecks: options.skipAllChecks,
          dataBaseDir: this.dataBaseDir,
          catalogStore: this.catalogStore,
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

      stepRun.succeed(output);
      stepSpan.setStatus({ code: SpanStatusCode.OK });
      yield {
        kind: "step_completed",
        jobId: job.name,
        stepId: stepName,
        dataHandles: stepDataHandles,
      };
    } catch (error) {
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
      // Populate model/method/driver context on step_failed only for
      // model-method tasks. The libswamp telemetry bridge keys off these
      // fields to synthesize a child invocation entry for failures that
      // occurred before `method_executing` was yielded. Workflow-task
      // steps (which short-circuit via runWorkflowStep above) and other
      // structural failures leave them undefined.
      //
      // Driver resolution at catch time uses an empty definition tier
      // because we may not have an evaluated definition yet — for
      // pre-method-executing failures the driver reflects the upstream
      // tiers (cli > step > job > workflow > repo) only. This is the
      // analytically relevant tier for "what driver was the user asking
      // this step to use".
      const taskData = step.task.data;
      const isModelMethodTask = taskData.type === "model_method";
      const failureDriver = isModelMethodTask && driverPlan
        ? driverPlan.withDefinition({}).driver
        : undefined;
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
        driver: failureDriver,
      };
      // Do not re-throw: merge() continues draining all step generators
      // (allSettled semantics). The job generator tracks failure via step_failed events.
    } finally {
      stepSpan.end();
    }
  }

  /**
   * Handles a workflow task step, forwarding child workflow events
   * to the parent stream.
   */
  private async *runWorkflowStep(
    workflow: Workflow,
    job: Job,
    stepRun: import("./workflow_run.ts").StepRun,
    stepName: string,
    task: { workflowIdOrName: string; inputs?: Record<string, unknown> },
    expressionContext: ExpressionContext | undefined,
    options: StepOptions,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    // Recursion guard
    const depth = options.workflowNestingDepth ?? 0;
    if (depth >= MAX_WORKFLOW_NESTING_DEPTH) {
      const errorMessage =
        `Maximum workflow nesting depth (${MAX_WORKFLOW_NESTING_DEPTH}) exceeded. ` +
        `Workflow "${task.workflowIdOrName}" cannot be invoked at depth ${
          depth + 1
        }.`;
      stepRun.fail(errorMessage);
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        error: errorMessage,
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
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        error: errorMessage,
      };
      return;
    }

    // Evaluate inputs using the expression context. Reuse the
    // per-instance evaluator (was previously constructed per call).
    let evaluatedInputs = task.inputs;
    if (task.inputs && expressionContext) {
      evaluatedInputs = await this.expressionEvaluator.evaluateData(
        task.inputs,
        expressionContext,
      ) as Record<string, unknown>;
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
    );

    let childRun: WorkflowRun | undefined;
    try {
      for await (
        const event of childService.run(task.workflowIdOrName, {
          inputs: evaluatedInputs,
          workflowNestingDepth: depth + 1,
          ancestorWorkflowIds: childAncestors,
        })
      ) {
        if (event.kind === "completed") {
          childRun = event.run;
        } else {
          yield event; // Forward child events to parent stream
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      stepRun.fail(errorMessage);
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        error: errorMessage,
      };
      return;
    }

    if (!childRun || childRun.status === "failed") {
      const errorMessage = `Nested workflow "${task.workflowIdOrName}" failed.`;
      stepRun.fail(errorMessage);
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        error: errorMessage,
      };
      return;
    }

    stepRun.succeed({
      type: "workflow",
      workflow: task.workflowIdOrName,
      runId: childRun.id,
      status: childRun.status,
    });
    yield { kind: "step_completed", jobId: job.name, stepId: stepName };
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

  private async saveRun(
    workflowId: WorkflowId,
    run: WorkflowRun,
  ): Promise<void> {
    await this.runRepo.save(workflowId, run);
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
      { modelName: string; modelType: string; methodName: string }
    >,
    stepStatuses: Map<string, "succeeded" | "failed" | "skipped">,
    stepJobNames: Map<string, string>,
    dataHandlesByStep: Map<
      string,
      import("../models/model.ts").DataHandle[]
    >,
    reportFilterOptions:
      | import("../reports/report_execution_service.ts").ReportFilterOptions
      | undefined,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    if (!reportFilterOptions) {
      return;
    }

    const stepExecutions: WorkflowStepExecutionDetail[] = [];
    for (const [key, info] of modelInfoByStep) {
      const status = stepStatuses.get(key) ?? "failed";
      const jobName = stepJobNames.get(key) ?? "";
      const stepName = key.split(":")[1] ?? "";

      // Prefer the evaluated definition (post-CEL) so report templates see
      // resolved expression values. Fall back to the raw definition.
      let lookupResult = await this.evaluatedDefRepo.findByNameGlobal(
        info.modelName,
      );
      if (!lookupResult) {
        lookupResult = await findDefinitionByIdOrName(
          this.definitionRepo,
          info.modelName,
        );
      }

      if (!lookupResult || status === "skipped") {
        stepExecutions.push({
          jobName,
          stepName,
          modelName: info.modelName,
          modelType: info.modelType,
          methodName: info.methodName,
          status,
          dataHandles: [],
          methodArgs: {},
          modelId: "",
          globalArgs: {},
        });
        continue;
      }

      const { definition } = lookupResult;
      stepExecutions.push({
        jobName,
        stepName,
        modelName: info.modelName,
        modelType: info.modelType,
        methodName: info.methodName,
        status,
        dataHandles: dataHandlesByStep.get(key) ?? [],
        methodArgs: definition.getMethodArguments(info.methodName),
        modelId: definition.id,
        globalArgs: definition.globalArguments,
      });
    }

    const bufferedEvents: WorkflowExecutionEvent[] = [];
    const artifacts = await this.workflowReportRunner.runFor({
      workflow,
      workflowRunId: run.id,
      workflowStatus: run.status === "succeeded" ? "succeeded" : "failed",
      stepExecutions,
      reportFilterOptions,
      repoDir: this.repoDir,
      runLogger: getWorkflowRunLogger(workflow.name),
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
  ): Promise<Workflow> {
    const evalSpan = getTracer().startSpan("swamp.workflow.evaluate", {
      attributes: { "workflow.name": workflow.name },
    });

    try {
      const result = await new WorkflowExpressionEvaluator(
        new CelEvaluator(),
      ).evaluate(workflow, context);
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
