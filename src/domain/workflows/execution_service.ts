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

import { getLogger } from "@logtape/logtape";
import { Workflow, type WorkflowInput } from "./workflow.ts";
import type { Job } from "./job.ts";
import type { Step } from "./step.ts";
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
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { resolveModelType } from "../extensions/extension_auto_resolver.ts";
import { BUILTIN_METHOD_REPORTS } from "../reports/builtin/mod.ts";
import { getAutoResolver } from "../extensions/auto_resolver_context.ts";
import { DefaultMethodExecutionService } from "../models/method_execution_service.ts";
import { DefaultModelValidationService } from "../models/validation_service.ts";
import { buildOutputSpecs } from "../models/output_spec_builder.ts";
import { detectEnvVarUsageInDefinition } from "../models/env_var_detector.ts";
import type { Definition } from "../definitions/definition.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";
import type { MethodExecutionEvent } from "../models/method_events.ts";
import { ModelOutput } from "../models/model_output.ts";
import {
  extractExpressions,
  isTaskInputsPath,
  replaceExpressions,
} from "../expressions/expression_parser.ts";
import {
  containsRuntimeExpression,
  ExpressionEvaluationService,
} from "../expressions/expression_evaluation_service.ts";
import {
  extractDependencies,
  hasStepOutputDependency,
} from "../expressions/dependency_extractor.ts";
import {
  buildEnvContext,
  type DataRecord,
  type ExpressionContext,
  type FileDataRecord,
  ModelResolver,
} from "../expressions/model_resolver.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import { UserError } from "../errors.ts";
import {
  getRunLogger,
  runFileSink,
} from "../../infrastructure/logging/logger.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { join } from "@std/path";
import { SecretRedactor } from "../secrets/mod.ts";
import { VaultService } from "../vaults/vault_service.ts";
import { merge } from "../../infrastructure/stream/merge.ts";
import { withEventBridge } from "../../infrastructure/stream/event_bridge.ts";
import {
  executeReports,
  type ReportEventCallback,
  type ReportFilterOptions,
} from "../reports/report_execution_service.ts";
import { reportRegistry } from "../reports/report_registry.ts";
import type { MethodReportContext } from "../reports/report_context.ts";
import { modelRegistry } from "../models/model.ts";
import { getTracer, SpanStatusCode } from "../../infrastructure/tracing/mod.ts";
import { resolveDriverConfig } from "../drivers/driver_resolution.ts";
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
  /** When true, load previously-evaluated definitions instead of evaluating CEL */
  useLastEvaluated?: boolean;
  /** forEach iteration variable (e.g., { env: "dev" } for self.env) */
  forEachVariable?: { name: string; value: unknown };
  /** Tags from the workflow definition, merged into data writer tag overrides */
  workflowTags?: Record<string, string>;
  /** Runtime tags from --tag CLI flags, passed to method execution context */
  runtimeTags?: Record<string, string>;
  /** Secret redactor for stripping vault secrets from persisted data and logs */
  secretRedactor?: SecretRedactor;
  /** Execution driver override from workflow/CLI level */
  driver?: string;
  /** Execution driver config override from workflow/CLI level */
  driverConfig?: Record<string, unknown>;
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
}

/**
 * Represents an expanded step from a forEach iteration.
 */
interface ExpandedStep {
  step: Step;
  /** The expanded step name after evaluating expressions */
  expandedName: string;
  /** The forEach variable name and value */
  forEachVar: { name: string; value: unknown };
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
 * Default step executor that handles model methods and workflow invocations.
 */
export class DefaultStepExecutor implements StepExecutor {
  private readonly validationService = new DefaultModelValidationService();

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
      modelIdOrName: string;
      methodName: string;
      inputs?: Record<string, unknown>;
    },
    ctx: StepExecutionContext,
  ): Promise<unknown> {
    const definitionRepo = new YamlDefinitionRepository(ctx.repoDir);
    const unifiedDataRepo = new FileSystemUnifiedDataRepository(
      ctx.repoDir,
      ctx.dataBaseDir,
    );
    const outputRepo = new YamlOutputRepository(ctx.repoDir);
    const executionService = new DefaultMethodExecutionService();
    const vaultService = await VaultService.fromRepository(ctx.repoDir);

    // Look up the model definition by ID or name
    const lookupResult = await findDefinitionByIdOrName(
      definitionRepo,
      task.modelIdOrName,
    );
    if (!lookupResult) {
      throw new Error(`Model not found: ${task.modelIdOrName}`);
    }

    // Keep original definition (with expressions)
    const { definition: originalDefinition, type: modelType } = lookupResult;

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
    if (ctx.useLastEvaluated) {
      // Load previously-evaluated definition from cache
      runLogger?.debug("Loading last evaluated definition");
      const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(
        ctx.repoDir,
      );
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
        // Evaluate any expressions in the step task inputs
        const evalService = new ExpressionEvaluationService(
          new YamlDefinitionRepository(ctx.repoDir),
          ctx.repoDir,
        );
        stepInputs = evalService.evaluateData(
          task.inputs,
          ctx.expressionContext,
        ) as Record<string, unknown>;
      }

      // Merge step inputs with existing context inputs (step inputs take precedence)
      const originalInputs = ctx.expressionContext.inputs ?? {};
      ctx.expressionContext.inputs = { ...originalInputs, ...stepInputs };

      evaluatedDefinition = await this.evaluateDefinitionExpressions(
        originalDefinition,
        ctx.expressionContext,
        ctx.repoDir,
      );
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
    const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(ctx.repoDir);
    await evaluatedDefRepo.save(modelType, evaluatedDefinition);

    // Capture pre-vault args for report context (so vault secrets stay as expressions)
    const reportGlobalArgs = evaluatedDefinition.globalArguments;
    const reportMethodArgs = evaluatedDefinition.getMethodArguments(
      task.methodName,
    );

    // Resolve runtime expressions (vault and env) at runtime (never persisted).
    // Vault secrets become sentinel tokens; the secretBag maps sentinels to raw values.
    const evalService = new ExpressionEvaluationService(
      new YamlDefinitionRepository(ctx.repoDir),
      ctx.repoDir,
    );
    const runtimeResult = await evalService
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

    // Track data outputs for context refresh (specName → instanceName → record)
    const resources: Record<string, Record<string, DataRecord>> = {};
    const files: Record<string, Record<string, FileDataRecord>> = {};

    // Declared outside try so the catch block can record artifacts written
    // before a throw (e.g. model writes data then throws on verdict=FAIL).
    const savedArtifacts: Array<{
      dataId: string;
      name: string;
      version: number;
      tags: Record<string, string>;
    }> = [];

    try {
      runLogger.debug("Executing method {method}", {
        method: task.methodName,
      });
      ctx.emitEvent?.({
        kind: "method_executing",
        jobId: ctx.jobName,
        stepId: ctx.stepName,
        modelName: originalDefinition.name,
        methodName: task.methodName,
      });

      // Build workflow-specific tag overrides
      // Use "source" instead of "type" to preserve the original data type
      // (resource/file) while tracking provenance for cross-workflow resolution
      const workflowTagOverrides: Record<string, string> = {
        ...(ctx.workflowTags ?? {}),
        source: "step-output",
        workflow: ctx.workflowName,
        workflowRunId: ctx.workflowRunId,
        step: ctx.stepName,
      };

      // Convert step's dataOutputOverrides to the format expected by writer factories
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

      // Execute the method with EVALUATED definition
      // Logger handles both console and file persistence via RunFileSink
      // Data is persisted by DataWriter during execution — no double-save
      const result = await executionService.executeWorkflow(
        evaluatedDefinition,
        modelDef,
        task.methodName,
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
          dataRepository: unifiedDataRepo,
          definitionRepository: definitionRepo,
          tagOverrides: workflowTagOverrides,
          runtimeTags: ctx.runtimeTags,
          dataOutputOverrides: stepDataOutputOverrides,
          vaultService,
          redactor: ctx.secretRedactor,
          vaultSecrets: secretBag,
          driver: ctx.driver ?? evaluatedDefinition.driver,
          driverConfig: ctx.driverConfig ?? evaluatedDefinition.driverConfig,
          skipCheckNames: ctx.skipCheckNames,
          skipCheckLabels: ctx.skipCheckLabels,
          skipAllChecks: ctx.skipAllChecks,
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
      );

      // Extract artifact info from dataHandles (already persisted by DataWriter)
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

          // Build context data from handles (nested under specName → instanceName)
          if (handle.kind === "resource") {
            let attributes: Record<string, unknown> = {};
            if (handle.metadata.contentType === "application/json") {
              try {
                const content = await unifiedDataRepo.getContent(
                  modelType,
                  evaluatedDefinition.id,
                  handle.name,
                  handle.version,
                );
                if (content) {
                  const text = new TextDecoder().decode(content);
                  attributes = JSON.parse(text) as Record<string, unknown>;
                }
              } catch {
                // Not valid JSON, skip attributes
              }
            }
            if (!resources[handle.specName]) {
              resources[handle.specName] = {};
            }
            resources[handle.specName][handle.name] = {
              id: handle.dataId,
              name: handle.name,
              version: handle.version,
              createdAt: new Date().toISOString(),
              attributes,
              tags: handle.tags,
              modelName: handle.tags["modelName"] ?? evaluatedDefinition.name,
              modelType: modelType.normalized,
              specName: handle.specName,
              dataType: handle.tags["type"] ?? "resource",
              contentType: handle.metadata.contentType,
              lifetime: handle.metadata.lifetime,
              ownerType: handle.metadata.ownerDefinition.ownerType,
              streaming: handle.metadata.streaming,
              size: handle.size,
              content: "",
            };
          } else if (handle.kind === "file") {
            const contentPath = unifiedDataRepo.getContentPath(
              modelType,
              evaluatedDefinition.id,
              handle.name,
              handle.version,
            );
            try {
              const stat = await Deno.stat(contentPath);
              if (!files[handle.specName]) files[handle.specName] = {};
              files[handle.specName][handle.name] = {
                id: handle.dataId,
                version: handle.version,
                createdAt: new Date().toISOString(),
                path: contentPath,
                size: stat.size,
                contentType: handle.metadata.contentType,
              };
            } catch {
              // File not found, skip
            }
          }
        }
      }

      // Mark output as succeeded and save
      output.markSucceeded();
      await outputRepo.save(modelType, task.methodName, output);

      runLogger.with({ summary: true }).debug(
        "Method {method} completed on {model}",
        { method: task.methodName, model: originalDefinition.name },
      );

      // --- Per-step reports (method + model scope) ---
      if (
        reportRegistry.getAll().length > 0 && ctx.reportFilterOptions
      ) {
        const dataHandles = result.dataHandles ?? [];

        // Compute vary suffix from forEach variable
        let reportVarySuffix: string | undefined;
        if (ctx.forEachVariable?.value !== undefined) {
          reportVarySuffix = coerceToSuffix(ctx.forEachVariable.value);
        }

        const reportEventCallbacks: ReportEventCallback = {
          onReportStarted: (name, scope) => {
            ctx.emitEvent?.({
              kind: "report_started",
              reportName: name,
              scope,
              jobId: ctx.jobName,
              stepId: ctx.stepName,
            });
          },
          onReportCompleted: (
            name,
            scope,
            markdown,
            json,
            reportDataHandles,
          ) => {
            ctx.emitEvent?.({
              kind: "report_completed",
              reportName: name,
              scope,
              markdown,
              json,
              jobId: ctx.jobName,
              stepId: ctx.stepName,
            });
            // Track report data artifacts alongside method artifacts
            for (const handle of reportDataHandles) {
              output.addDataArtifact({
                dataId: handle.dataId,
                name: handle.name,
                version: handle.version,
                tags: handle.tags,
              });
              savedArtifacts.push({
                dataId: handle.dataId,
                name: handle.name,
                version: handle.version,
                tags: handle.tags,
              });
            }
          },
          onReportFailed: (name, scope, error) => {
            ctx.emitEvent?.({
              kind: "report_failed",
              reportName: name,
              scope,
              error,
              jobId: ctx.jobName,
              stepId: ctx.stepName,
            });
          },
        };

        // Look up model-type defaults for report filtering
        const stepModelDef = modelRegistry.get(modelType);
        const stepModelTypeReports = [
          ...BUILTIN_METHOD_REPORTS,
          ...(stepModelDef?.reports ?? []),
        ];

        // Method-scope reports
        const methodContext: MethodReportContext = {
          scope: "method",
          repoDir: ctx.repoDir,
          logger: runLogger,
          dataRepository: unifiedDataRepo,
          definitionRepository: definitionRepo,
          swampSha: ctx.swampSha,
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
          methodName: task.methodName,
          executionStatus: "succeeded",
          dataHandles,
          outputSpecs: buildOutputSpecs(modelDef),
        };

        await executeReports(
          reportRegistry,
          methodContext,
          modelType,
          evaluatedDefinition.id,
          originalDefinition.reportSelection,
          ctx.reportFilterOptions,
          reportEventCallbacks,
          task.methodName,
          stepModelTypeReports,
          reportVarySuffix,
        );

        // Model-scope reports
        await executeReports(
          reportRegistry,
          { ...methodContext, scope: "model" },
          modelType,
          evaluatedDefinition.id,
          originalDefinition.reportSelection,
          ctx.reportFilterOptions,
          reportEventCallbacks,
          task.methodName,
          stepModelTypeReports,
          reportVarySuffix,
        );
      }

      return {
        type: "model_method",
        model: task.modelIdOrName,
        method: task.methodName,
        resources,
        files,
        dataArtifacts: savedArtifacts,
        dataHandles: result.dataHandles ?? [],
      };
    } catch (error) {
      // Recover data handles written before the throw (e.g. model wrote data
      // then threw on verdict=FAIL). The driver attaches them to the error.
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

      // Mark output as failed and save
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      output.markFailed({ message: errorMessage, stack: errorStack });
      await outputRepo.save(modelType, task.methodName, output);

      runLogger.debug("Method {method} failed: {error}", {
        method: task.methodName,
        model: originalDefinition.name,
        error: errorMessage,
      });

      // Run method-summary report for failed executions so report consumers
      // see structured error output (matching modelMethodRun failure behavior).
      try {
        if (
          reportRegistry.getAll().length > 0 && ctx.reportFilterOptions
        ) {
          const failedMethodContext: MethodReportContext = {
            scope: "method",
            repoDir: ctx.repoDir,
            logger: runLogger,
            dataRepository: unifiedDataRepo,
            definitionRepository: definitionRepo,
            swampSha: ctx.swampSha,
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
            methodName: task.methodName,
            executionStatus: "failed",
            errorMessage,
            dataHandles: [],
            outputSpecs: buildOutputSpecs(modelDef),
          };

          const stepModelDef = modelRegistry.get(modelType);
          const stepModelTypeReports = [
            ...BUILTIN_METHOD_REPORTS,
            ...(stepModelDef?.reports ?? []),
          ];

          const reportEventCallbacks: ReportEventCallback = {
            onReportStarted: (name, scope) => {
              ctx.emitEvent?.({
                kind: "report_started",
                reportName: name,
                scope,
                jobId: ctx.jobName,
                stepId: ctx.stepName,
              });
            },
            onReportCompleted: (
              name,
              scope,
              markdown,
              json,
            ) => {
              ctx.emitEvent?.({
                kind: "report_completed",
                reportName: name,
                scope,
                markdown,
                json,
                jobId: ctx.jobName,
                stepId: ctx.stepName,
              });
            },
            onReportFailed: (name, scope, reportError) => {
              ctx.emitEvent?.({
                kind: "report_failed",
                reportName: name,
                scope,
                error: reportError,
                jobId: ctx.jobName,
                stepId: ctx.stepName,
              });
            },
          };

          await executeReports(
            reportRegistry,
            failedMethodContext,
            modelType,
            evaluatedDefinition.id,
            originalDefinition.reportSelection,
            ctx.reportFilterOptions,
            reportEventCallbacks,
            task.methodName,
            stepModelTypeReports,
          );
        }
      } catch (reportError) {
        // Don't mask the original execution error with a report error
        runLogger.debug(
          "Failed to run reports for failed method: {error}",
          {
            error: reportError instanceof Error
              ? reportError.message
              : String(reportError),
          },
        );
      }

      // Attach saved artifacts to the error so the outer step loop can
      // record them in the step run even though the step failed.
      if (savedArtifacts.length > 0) {
        (error as Record<string, unknown>).dataArtifacts = savedArtifacts;
      }
      throw error;
    }
  }

  /**
   * Evaluates CEL expressions in a definition, leaving vault expressions raw.
   * Vault expressions are resolved at runtime only.
   */
  private async evaluateDefinitionExpressions(
    definition: Definition,
    context: ExpressionContext,
    _repoDir: string,
  ): Promise<Definition> {
    const celEvaluator = new CelEvaluator();
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    if (expressions.length === 0) {
      return definition;
    }

    // Evaluate CEL-only expressions; skip runtime expressions (vault, env)
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        continue;
      }

      // Skip expressions referencing model resource/file data that isn't
      // available in context (e.g., referenced model was never executed).
      // Unlike inputs, model data is never conditionally accessed in CEL —
      // member access on a missing model ref is always an error.
      let hasMissingModelDep = false;
      const deps = extractDependencies(expr.celExpression);
      for (const dep of deps) {
        if (dep.type === "resource" || dep.type === "file") {
          const modelData = context.model[dep.modelRef];
          if (
            !modelData ||
            (dep.type === "resource" && !modelData.resource) ||
            (dep.type === "file" && !modelData.file)
          ) {
            hasMissingModelDep = true;
            break;
          }
        }
      }

      if (hasMissingModelDep) {
        continue;
      }

      try {
        const value = celEvaluator.evaluate(expr.celExpression, context);
        evaluatedValues.set(expr.raw, value);
      } catch {
        // Leave unresolved — CEL threw because an input referenced directly
        // (not inside a conditional branch) is absent from context.
        // The Proxy on globalArgs will surface a clear error if the method
        // actually needs the unresolved value.
      }
    }

    // Replace only CEL-only expressions with evaluated values
    const evaluatedData = replaceExpressions(definitionData, evaluatedValues);

    // Create new Definition from evaluated data
    const { Definition: DefClass } = await import(
      "../definitions/definition.ts"
    );
    return DefClass.fromData(
      evaluatedData as ReturnType<typeof definition.toData>,
    );
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
 * Result of resolving a forEach step name template.
 */
export interface ResolvedStepName {
  /** The resolved step name. */
  name: string;
  /** Whether any expression evaluation failed during resolution. */
  hadEvalFailure: boolean;
}

/** Maximum length for a coerced suffix before truncation. */
const MAX_SUFFIX_LENGTH = 64;

/**
 * Safely converts an unknown value to a string suitable for use as a data
 * artifact name suffix. For objects, tries common identifier properties
 * (`key`, `name`, `id`) before falling back to a truncated JSON representation.
 */
export function coerceToSuffix(val: unknown): string {
  if (val === undefined || val === null) {
    return "";
  }
  if (typeof val !== "object") {
    return String(val);
  }
  const obj = val as Record<string, unknown>;
  for (const prop of ["key", "name", "id"]) {
    if (prop in obj && obj[prop] !== undefined && obj[prop] !== null) {
      return String(obj[prop]);
    }
  }
  const json = JSON.stringify(val);
  if (json.length <= MAX_SUFFIX_LENGTH) {
    return json;
  }
  return json.slice(0, MAX_SUFFIX_LENGTH);
}

/**
 * Resolves a forEach step name template by evaluating `${{ }}` expressions,
 * or falls back to appending a suffix when no expressions are present.
 *
 * When expression evaluation fails, the raw expression is preserved and the
 * fallbackSuffix is appended to ensure uniqueness across iterations.
 */
export function resolveForEachStepName(
  template: string,
  hasExpression: boolean,
  stepContext: Record<string, unknown>,
  celEvaluator: CelEvaluator,
  fallbackSuffix: string,
): ResolvedStepName {
  if (hasExpression) {
    let hadEvalFailure = false;
    const resolved = template.replace(
      /\$\{\{\s*(.+?)\s*\}\}/g,
      (_match, expr) => {
        try {
          return String(
            celEvaluator.evaluate(expr as string, stepContext),
          );
        } catch {
          hadEvalFailure = true;
          return _match as string;
        }
      },
    );
    return {
      name: hadEvalFailure ? `${resolved}-${fallbackSuffix}` : resolved,
      hadEvalFailure,
    };
  }
  return { name: `${template}-${fallbackSuffix}`, hadEvalFailure: false };
}

/**
 * Domain service for workflow execution.
 */
export class WorkflowExecutionService {
  private readonly sortService = new TopologicalSortService();
  private readonly executor: StepExecutor;
  private readonly definitionRepo: YamlDefinitionRepository;
  private readonly modelResolver: ModelResolver;
  private readonly dataRepo: FileSystemUnifiedDataRepository;
  private readonly dataBaseDir?: string;

  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly runRepo: WorkflowRunRepository,
    private readonly repoDir: string,
    executor?: StepExecutor,
    dataBaseDir?: string,
  ) {
    this.executor = executor ?? new DefaultStepExecutor();
    this.dataBaseDir = dataBaseDir;
    this.definitionRepo = new YamlDefinitionRepository(repoDir);
    this.dataRepo = new FileSystemUnifiedDataRepository(repoDir, dataBaseDir);
    this.modelResolver = new ModelResolver(this.definitionRepo, {
      repoDir,
      dataRepo: this.dataRepo,
    });
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

        workflow = this.evaluateWorkflow(
          workflow,
          expressionContext,
        );
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

      // Scope data.findBySpec() to this run so forEach expressions
      // only see data produced during the current workflow run.
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
        for await (const event of merge(jobStreams, options?.signal)) {
          yield event;
        }
        await this.saveRun(workflow.id, run);
      }

      // Complete workflow
      run.complete();
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

      // Expand forEach steps if we have expression context
      let expandedStepsMap: Map<string, ExpandedStep[]> | undefined;
      if (expressionContext && !options.lastEvaluated) {
        expandedStepsMap = this.expandForEachSteps(job, expressionContext);
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

      // Execute steps level by level
      let jobFailed = false;
      for (const level of sortedSteps.levels) {
        if (jobFailed) break;

        // Merge parallel step generators within each level
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

        for await (const event of merge(stepStreams, options.signal)) {
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
   * Expands forEach steps into multiple concrete steps.
   * For steps with forEach, evaluates the `in` expression and creates
   * one expanded step per item in the result.
   *
   * @param job - The job containing steps
   * @param context - Expression context for evaluating forEach.in
   * @returns Map of original step name to expanded steps (or single entry for non-forEach steps)
   */
  private expandForEachSteps(
    job: Job,
    context: ExpressionContext,
  ): Map<string, ExpandedStep[]> {
    const celEvaluator = new CelEvaluator();
    const result = new Map<string, ExpandedStep[]>();

    for (const step of job.steps) {
      if (!step.forEach) {
        // No forEach - use original step as-is
        result.set(step.name, [{
          step,
          expandedName: step.name,
          forEachVar: { name: "", value: undefined },
        }]);
        continue;
      }

      // Evaluate the forEach.in expression
      const inExpression = step.forEach.in;
      const itemName = step.forEach.item;

      // Extract the CEL expression (remove ${{ }})
      const match = inExpression.match(/\$\{\{\s*(.+?)\s*\}\}/);
      if (!match) {
        throw new UserError(
          `Invalid forEach.in expression: ${inExpression}. Must be in $\{{ }} format.`,
        );
      }

      const celExpr = match[1];
      const items = celEvaluator.evaluate(celExpr, context);

      // Handle both arrays and objects
      const expandedSteps: ExpandedStep[] = [];

      const nameHasExpression = /\$\{\{.+?\}\}/.test(step.name);

      if (Array.isArray(items)) {
        // Array iteration: self.{item} = item value
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          // Evaluate the step name with the forEach context
          const stepContext = {
            ...context,
            self: {
              ...context.self,
              [itemName]: item,
            },
          };

          // Resolve step name expressions or fall back to a unique suffix.
          // For the expression-failure path, always use index for uniqueness.
          // For the no-expression path, use item value for primitives, index for objects.
          const fallbackSuffix = nameHasExpression
            ? String(index)
            : (item !== null && typeof item === "object")
            ? String(index)
            : String(item);
          if (
            !nameHasExpression && item !== null && typeof item === "object"
          ) {
            getLogger(["swamp", "workflows"]).warn(
              "forEach step '{stepName}' uses index-based naming because item is an object. " +
                "Consider adding a ${{{{ self.{itemName}.<field> }}}} expression to the step name for better observability.",
              { stepName: step.name, itemName },
            );
          }
          const { name: expandedName, hadEvalFailure } = resolveForEachStepName(
            step.name,
            nameHasExpression,
            stepContext,
            celEvaluator,
            fallbackSuffix,
          );
          if (hadEvalFailure) {
            getLogger(["swamp", "workflows"]).warn(
              "forEach step '{stepName}' has expression(s) that failed to evaluate for item at index {index}. " +
                "Appending index to prevent duplicate names. " +
                "Check that the expression references valid properties on self.{itemName}.",
              { stepName: step.name, index, itemName },
            );
          }

          expandedSteps.push({
            step,
            expandedName,
            forEachVar: { name: itemName, value: item },
          });
        }
      } else if (items && typeof items === "object") {
        // Object iteration: self.{item} = { key, value }
        for (const [key, value] of Object.entries(items)) {
          const objItem = { key, value };

          // Evaluate the step name with the forEach context
          const stepContext = {
            ...context,
            self: {
              ...context.self,
              [itemName]: objItem,
            },
          };

          // Resolve step name expressions or fall back to key suffix
          const { name: expandedName, hadEvalFailure } = resolveForEachStepName(
            step.name,
            nameHasExpression,
            stepContext,
            celEvaluator,
            key,
          );
          if (hadEvalFailure) {
            getLogger(["swamp", "workflows"]).warn(
              "forEach step '{stepName}' has expression(s) that failed to evaluate for key '{key}'. " +
                "Appending key to prevent duplicate names. " +
                "Check that the expression references valid properties on self.{itemName}.",
              { stepName: step.name, key, itemName },
            );
          }

          expandedSteps.push({
            step,
            expandedName,
            forEachVar: { name: itemName, value: objItem },
          });
        }
      } else {
        throw new UserError(
          `forEach.in must evaluate to an array or object, got: ${typeof items}`,
        );
      }

      // If no items, still store empty array
      result.set(step.name, expandedSteps);
    }

    return result;
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
          useLastEvaluated: options.lastEvaluated,
          forEachVariable: forEachVar,
          workflowTags: options.workflowTags,
          runtimeTags: options.runtimeTags,
          secretRedactor: options.secretRedactor,
          ...resolveDriverConfig(
            { driver: options.driver },
            { driver: step.driver, driverConfig: step.driverConfig },
            { driver: job.driver, driverConfig: job.driverConfig },
            { driver: workflow.driver, driverConfig: workflow.driverConfig },
          ),
          emitEvent: push,
          reportFilterOptions: options.reportFilterOptions,
          swampSha: options.swampSha,
          skipCheckNames: options.skipCheckNames,
          skipCheckLabels: options.skipCheckLabels,
          skipAllChecks: options.skipAllChecks,
          dataBaseDir: this.dataBaseDir,
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
      yield {
        kind: "step_failed",
        jobId: job.name,
        stepId: stepName,
        error: errorMessage,
        allowedFailure: isAllowed || undefined,
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

    // Evaluate inputs using the expression context
    let evaluatedInputs = task.inputs;
    if (task.inputs && expressionContext) {
      const evalService = new ExpressionEvaluationService(
        new YamlDefinitionRepository(this.repoDir),
        this.repoDir,
      );
      evaluatedInputs = evalService.evaluateData(
        task.inputs,
        expressionContext,
      ) as Record<string, unknown>;
    }

    // Create a child WorkflowExecutionService with nesting context
    const childAncestors = new Set(ancestors);
    childAncestors.add(workflow.name);

    const childService = new WorkflowExecutionService(
      this.workflowRepo,
      this.runRepo,
      this.repoDir,
      undefined,
      this.dataBaseDir,
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
   * Evaluates CEL expressions in a workflow, leaving vault expressions raw.
   * Vault expressions are resolved at runtime only.
   * forEach-related expressions (self.* and forEach.in) are left raw for
   * runtime expansion.
   */
  private evaluateWorkflow(
    workflow: Workflow,
    context: ExpressionContext,
  ): Workflow {
    const evalSpan = getTracer().startSpan("swamp.workflow.evaluate", {
      attributes: { "workflow.name": workflow.name },
    });

    try {
      const celEvaluator = new CelEvaluator();
      const workflowData = workflow.toData();
      const expressions = extractExpressions(workflowData);

      if (expressions.length === 0) {
        return workflow;
      }

      // Collect forEach.in expressions to skip during evaluation
      const forEachInExpressions = new Set<string>();
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          if (step.forEach) {
            const match = step.forEach.in.match(/\$\{\{\s*(.+?)\s*\}\}/);
            if (match) {
              forEachInExpressions.add(step.forEach.in);
            }
          }
        }
      }

      // Evaluate CEL-only expressions; skip runtime (vault, env), self.*, and forEach.in expressions
      const evaluatedValues = new Map<string, unknown>();
      for (const expr of expressions) {
        if (containsRuntimeExpression(expr.celExpression)) {
          continue;
        }
        // Skip self.* expressions — they reference forEach variables resolved at runtime
        if (expr.celExpression.match(/\bself\./)) {
          continue;
        }
        // Skip forEach.in expressions — they must remain as strings for forEach expansion
        if (forEachInExpressions.has(expr.raw)) {
          continue;
        }
        // Skip task.inputs expressions that depend on step outputs (resource, file, execution, data, file.contents).
        // These are evaluated at step execution time when upstream step outputs are available.
        if (
          isTaskInputsPath(expr.path) &&
          hasStepOutputDependency(expr.celExpression)
        ) {
          continue;
        }

        const value = celEvaluator.evaluate(expr.celExpression, context);
        evaluatedValues.set(expr.raw, value);
      }

      // Replace only CEL-only expressions with evaluated values
      const evaluatedData = replaceExpressions(workflowData, evaluatedValues);

      // Create new Workflow from evaluated data
      const result = Workflow.fromData(evaluatedData as WorkflowInput);
      evalSpan.setAttribute(
        "workflow.expressions_evaluated",
        evaluatedValues.size,
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
