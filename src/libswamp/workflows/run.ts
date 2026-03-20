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

import { cancelled, type SwampError } from "../errors.ts";
import type { LibSwampContext } from "../context.ts";
import type {
  WorkflowExecutionEvent,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import type { MethodExecutionEvent } from "../../domain/models/method_events.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { StepRun } from "../../domain/workflows/workflow_run.ts";
import type {
  StepArtifactsData,
  StepRunView,
  WorkflowRunView,
} from "./workflow_run_view.ts";
import type { ReportResultView } from "../models/model_method_run_view.ts";
import { toReportResultView } from "../models/run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  coerceInputTypes,
  type InputValidationError,
  InputValidationService,
} from "../../domain/inputs/mod.ts";
import {
  executeReports,
} from "../../domain/reports/report_execution_service.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import type {
  WorkflowReportContext,
} from "../../domain/reports/report_context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { getWorkflowRunLogger } from "../../infrastructure/logging/logger.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { buildReportDataHandles } from "../../domain/reports/report_data_handles.ts";

/**
 * Events emitted by the libswamp workflow run generator.
 */
export type WorkflowRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "evaluating_workflow" }
  | { kind: "started"; runId: string; workflowName: string }
  | { kind: "job_started"; jobId: string }
  | { kind: "job_completed"; jobId: string; status: string }
  | { kind: "job_skipped"; jobId: string }
  | { kind: "step_started"; jobId: string; stepId: string }
  | { kind: "step_completed"; jobId: string; stepId: string }
  | { kind: "step_skipped"; jobId: string; stepId: string }
  | {
    kind: "step_failed";
    jobId: string;
    stepId: string;
    error: string;
    allowedFailure?: boolean;
  }
  | {
    kind: "model_resolved";
    jobId: string;
    stepId: string;
    modelName: string;
    modelType: string;
    methodName: string;
  }
  | {
    kind: "method_executing";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
  }
  | {
    kind: "method_output";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "method_event";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    event: MethodExecutionEvent;
  }
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
  | { kind: "completed"; run: WorkflowRunView }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies injected into the workflow run generator.
 */
export interface WorkflowRunDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
  repoDir: string;
  lookupWorkflow: (
    repo: WorkflowRepository,
    idOrName: string,
  ) => Promise<Workflow | null>;
  createExecutionService: (
    workflowRepo: WorkflowRepository,
    runRepo: WorkflowRunRepository,
    repoDir: string,
  ) => WorkflowExecutionService;
  dataRepo?: UnifiedDataRepository;
  definitionRepo?: DefinitionRepository;
}

/**
 * Input for the workflow run generator.
 */
export interface WorkflowRunInput {
  workflowIdOrName: string;
  lastEvaluated?: boolean;
  inputs?: Record<string, unknown>;
  runtimeTags?: Record<string, string>;
  verbose?: boolean;
  driver?: string;
  skipAllReports?: boolean;
  skipReportNames?: string[];
  skipReportLabels?: string[];
  reportNames?: string[];
  reportLabels?: string[];
}

/**
 * Extracts artifact data from a step's output for verbose mode.
 */
export function extractStepArtifacts(
  step: StepRun,
): StepArtifactsData | undefined {
  if (step.output === undefined || step.output === null) {
    return undefined;
  }

  const output = step.output as Record<string, unknown>;

  // Shell command output: { stdout, exitCode }
  if (
    typeof output.stdout === "string" || typeof output.exitCode === "number"
  ) {
    const artifacts: StepArtifactsData = {};
    if (output.stdout) artifacts.stdout = output.stdout as string;
    if (output.stderr) artifacts.stderr = output.stderr as string;
    if (typeof output.exitCode === "number") {
      artifacts.exitCode = output.exitCode;
    }
    return Object.keys(artifacts).length > 0 ? artifacts : undefined;
  }

  // Model method output: { type, model, method, resourceId, resourcePath, resourceAttributes }
  if (output.type === "model_method") {
    const attrs = output.resourceAttributes as
      | Record<string, unknown>
      | undefined;
    if (attrs && Object.keys(attrs).length > 0) {
      return { dataAttributes: attrs };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Converts a WorkflowRun to WorkflowRunData for presentation.
 */
export function toRunData(
  run: WorkflowRun,
  path?: string,
  verbose?: boolean,
): WorkflowRunView {
  const startTime = run.startedAt?.getTime();
  const endTime = run.completedAt?.getTime();

  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    jobs: run.jobs.map((job) => {
      const jobStart = job.startedAt?.getTime();
      const jobEnd = job.completedAt?.getTime();

      return {
        name: job.jobName,
        status: job.status,
        steps: job.steps.map((step) => {
          const stepStart = step.startedAt?.getTime();
          const stepEnd = step.completedAt?.getTime();

          const stepData: StepRunView = {
            name: step.stepName,
            status: step.status,
            error: step.error,
            duration: stepStart && stepEnd ? stepEnd - stepStart : undefined,
          };

          if (verbose) {
            const artifacts = extractStepArtifacts(step);
            if (artifacts) {
              stepData.artifacts = artifacts;
            }
          }

          if (step.dataArtifacts && step.dataArtifacts.length > 0) {
            stepData.dataArtifacts = step.dataArtifacts.map((a) => ({
              dataId: a.dataId,
              name: a.name,
              version: a.version,
              tags: a.tags,
            }));
          }

          if (step.allowedFailure) {
            stepData.allowedFailure = true;
          }

          return stepData;
        }),
        duration: jobStart && jobEnd ? jobEnd - jobStart : undefined,
      };
    }),
    duration: startTime && endTime ? endTime - startTime : undefined,
    path,
  };
}

/**
 * Maps a domain WorkflowExecutionEvent to a libswamp WorkflowRunEvent.
 */
function mapEvent(
  event: WorkflowExecutionEvent,
  deps: WorkflowRunDeps,
  input: WorkflowRunInput,
): WorkflowRunEvent {
  switch (event.kind) {
    case "started":
      return {
        kind: "started",
        runId: event.runId,
        workflowName: event.workflowName,
      };
    case "completed": {
      const path = deps.runRepo.getPath(
        createWorkflowId(event.run.workflowId),
        createWorkflowRunId(event.run.id),
      );
      const data = toRunData(event.run, path, input.verbose);
      return { kind: "completed", run: data };
    }
    case "job_started":
    case "job_completed":
    case "job_skipped":
    case "step_started":
    case "step_completed":
    case "step_skipped":
    case "step_failed":
    case "model_resolved":
    case "method_executing":
    case "method_output":
    case "method_event":
    case "report_started":
    case "report_completed":
    case "report_failed":
      return event;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Executes a workflow, yielding progress events as a libswamp stream.
 */
export async function* workflowRun(
  ctx: LibSwampContext,
  deps: WorkflowRunDeps,
  input: WorkflowRunInput,
): AsyncGenerator<WorkflowRunEvent> {
  let resolvedInput = input;

  yield { kind: "validating_inputs" };

  // Look up workflow
  const workflow = await deps.lookupWorkflow(
    deps.workflowRepo,
    input.workflowIdOrName,
  );
  if (!workflow) {
    yield {
      kind: "error",
      error: workflowNotFound(input.workflowIdOrName),
    };
    return;
  }

  // Coerce and validate inputs
  if (workflow.inputs && !input.lastEvaluated) {
    const coercedInputs = coerceInputTypes(
      input.inputs ?? {},
      workflow.inputs,
    );
    const validationService = new InputValidationService();
    const inputsWithDefaults = validationService.applyDefaults(
      coercedInputs,
      workflow.inputs,
    );
    const result = validationService.validate(
      inputsWithDefaults,
      workflow.inputs,
    );
    if (!result.valid) {
      yield { kind: "error", error: inputValidationFailed(result.errors) };
      return;
    }
    resolvedInput = { ...input, inputs: inputsWithDefaults };
  } else if (workflow.inputs) {
    // lastEvaluated: still coerce types but skip validation
    resolvedInput = {
      ...input,
      inputs: coerceInputTypes(input.inputs ?? {}, workflow.inputs),
    };
  }

  yield { kind: "evaluating_workflow" };

  const service = deps.createExecutionService(
    deps.workflowRepo,
    deps.runRepo,
    deps.repoDir,
  );

  // Track model info from events for post-run reports
  const modelInfoByStep = new Map<
    string,
    { modelName: string; modelType: string; methodName: string }
  >();
  // Track step statuses from events
  const stepStatuses = new Map<string, "succeeded" | "failed" | "skipped">();
  // Track step job names
  const stepJobNames = new Map<string, string>();

  try {
    let completedEvent: WorkflowRunEvent | undefined;

    // Collect per-step report results from execution service events
    const perStepReportResults: ReportResultView[] = [];

    for await (
      const event of service.run(resolvedInput.workflowIdOrName, {
        lastEvaluated: resolvedInput.lastEvaluated,
        inputs: resolvedInput.inputs,
        runtimeTags: resolvedInput.runtimeTags,
        signal: ctx.signal,
        driver: resolvedInput.driver,
        reportFilterOptions: {
          skipAllReports: resolvedInput.skipAllReports,
          skipReportNames: resolvedInput.skipReportNames,
          skipReportLabels: resolvedInput.skipReportLabels,
          reportNames: resolvedInput.reportNames,
          reportLabels: resolvedInput.reportLabels,
        },
      })
    ) {
      // Track model_resolved events for report context
      if (event.kind === "model_resolved") {
        const key = `${event.jobId}:${event.stepId}`;
        modelInfoByStep.set(key, {
          modelName: event.modelName,
          modelType: event.modelType,
          methodName: event.methodName,
        });
        stepJobNames.set(key, event.jobId);
      }
      if (event.kind === "step_completed") {
        stepStatuses.set(`${event.jobId}:${event.stepId}`, "succeeded");
      }
      if (event.kind === "step_failed") {
        stepStatuses.set(`${event.jobId}:${event.stepId}`, "failed");
      }
      if (event.kind === "step_skipped") {
        stepStatuses.set(`${event.jobId}:${event.stepId}`, "skipped");
      }

      // Collect per-step report results from execution service events
      if (event.kind === "report_completed") {
        perStepReportResults.push({
          name: event.reportName,
          scope: event.scope,
          success: true,
          markdown: event.markdown,
          json: event.json,
        });
      }
      if (event.kind === "report_failed") {
        perStepReportResults.push({
          name: event.reportName,
          scope: event.scope,
          success: false,
          error: event.error,
        });
      }

      const mapped = mapEvent(event, deps, resolvedInput);

      // Intercept the completed event to run reports first
      if (mapped.kind === "completed") {
        completedEvent = mapped;
        continue;
      }

      yield mapped;
    }

    // Execute post-run reports (workflow-scope only) before yielding the completed event
    if (completedEvent && completedEvent.kind === "completed") {
      const reportResults: ReportResultView[] = [...perStepReportResults];
      yield* executePostRunReports(
        deps,
        resolvedInput,
        workflow,
        completedEvent.run,
        modelInfoByStep,
        stepStatuses,
        stepJobNames,
        reportResults,
      );
      if (reportResults.length > 0) {
        completedEvent = {
          ...completedEvent,
          run: { ...completedEvent.run, reports: reportResults },
        };
      }
      yield completedEvent;
    }
  } catch (error) {
    if (
      error instanceof DOMException && error.name === "AbortError"
    ) {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    yield {
      kind: "error",
      error: workflowExecutionFailed(error),
    };
  }
}

/**
 * Executes post-run reports (workflow-scope only) after a workflow completes.
 *
 * Method-scope and model-scope reports are now executed inline during
 * `executeModelMethod()` in the execution service, where the forEach
 * variable is in scope for computing vary suffixes.
 */
async function* executePostRunReports(
  deps: WorkflowRunDeps,
  input: WorkflowRunInput,
  workflow: Workflow,
  runView: WorkflowRunView,
  modelInfoByStep: Map<
    string,
    { modelName: string; modelType: string; methodName: string }
  >,
  stepStatuses: Map<string, "succeeded" | "failed" | "skipped">,
  stepJobNames: Map<string, string>,
  reportResults: ReportResultView[],
): AsyncGenerator<WorkflowRunEvent> {
  // Reports require dataRepo and definitionRepo; skip if not provided
  if (!deps.dataRepo || !deps.definitionRepo) {
    return;
  }

  if (reportRegistry.getAll().length === 0) {
    return;
  }

  const filterOptions = {
    skipAllReports: input.skipAllReports,
    skipReportNames: input.skipReportNames,
    skipReportLabels: input.skipReportLabels,
    reportNames: input.reportNames,
    reportLabels: input.reportLabels,
  };

  const noopEvents = {
    onReportStarted: () => {},
    onReportCompleted: () => {},
    onReportFailed: () => {},
  };

  // Build workflow-scope step executions context
  const stepExecutions: WorkflowReportContext["stepExecutions"] = [];

  // Prefer evaluated definitions (post-CEL) over raw definitions
  const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(deps.repoDir);

  for (const [key, info] of modelInfoByStep) {
    const status = stepStatuses.get(key) ?? "failed";
    const jobName = stepJobNames.get(key) ?? "";
    // Extract step name from key (format: jobId:stepId)
    const stepName = key.split(":")[1] ?? "";

    // Look up the evaluated definition first, then fall back to raw
    let lookupResult = await evaluatedDefRepo.findByNameGlobal(info.modelName);
    if (!lookupResult) {
      lookupResult = await findDefinitionByIdOrName(
        deps.definitionRepo as YamlDefinitionRepository,
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
        status: status as "succeeded" | "failed" | "skipped",
        dataHandles: [],
        methodArgs: {},
        modelId: "",
        globalArgs: {},
      });
      continue;
    }

    const { definition, type: modelType } = lookupResult;

    // Build data handles from persisted data repository
    const stepDataHandles = await buildReportDataHandles(
      deps.dataRepo,
      modelType,
      definition.id,
    );

    stepExecutions.push({
      jobName,
      stepName,
      modelName: info.modelName,
      modelType: info.modelType,
      methodName: info.methodName,
      status: status as "succeeded" | "failed" | "skipped",
      dataHandles: stepDataHandles,
      methodArgs: definition.getMethodArguments(info.methodName),
      modelId: definition.id,
      globalArgs: definition.globalArguments,
    });
  }

  // Workflow-scope reports
  const wfContext: WorkflowReportContext = {
    scope: "workflow",
    repoDir: deps.repoDir,
    logger: getWorkflowRunLogger(workflow.name),
    dataRepository: deps.dataRepo,
    definitionRepository: deps.definitionRepo,
    workflowId: workflow.id,
    workflowRunId: runView.id,
    workflowName: workflow.name,
    workflowStatus: runView.status === "succeeded" ? "succeeded" : "failed",
    stepExecutions,
  };

  const wfSummary = await executeReports(
    reportRegistry,
    wfContext,
    ModelType.create("workflow"),
    workflow.id,
    workflow.reportSelection,
    filterOptions,
    noopEvents,
  );

  for (const result of wfSummary.results) {
    yield {
      kind: "report_started",
      reportName: result.name,
      scope: result.scope,
    };
    if (result.success) {
      yield {
        kind: "report_completed",
        reportName: result.name,
        scope: result.scope,
        markdown: result.markdown!,
        json: result.json!,
      };
    } else {
      yield {
        kind: "report_failed",
        reportName: result.name,
        scope: result.scope,
        error: result.error!,
      };
    }
    reportResults.push(toReportResultView(result));
  }
}

/**
 * Creates a SwampError for a missing workflow.
 */
export function workflowNotFound(idOrName: string): SwampError {
  return {
    code: "workflow_not_found",
    message: `Workflow not found: ${idOrName}`,
  };
}

/**
 * Creates a SwampError for input validation failure.
 */
export function inputValidationFailed(
  errors: InputValidationError[],
): SwampError {
  const messages = errors.map((e) => `  ${e.message}`).join("\n");
  return {
    code: "input_validation_failed",
    message: `Input validation failed:\n${messages}`,
    details: errors,
  };
}

/**
 * Creates a SwampError for a workflow execution failure.
 */
export function workflowExecutionFailed(cause: unknown): SwampError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "workflow_execution_failed",
    message: `Workflow execution failed: ${message}`,
    cause: cause instanceof Error ? cause : undefined,
  };
}
