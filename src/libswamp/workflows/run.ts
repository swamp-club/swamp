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
import type { EnvVarUsageDetail } from "../../domain/models/validation_service.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { StepRun } from "../../domain/workflows/workflow_run.ts";
import type {
  StepArtifactsData,
  StepRunView,
  WorkflowRunView,
} from "./workflow_run_view.ts";
import type { ReportResultView } from "../models/model_method_run_view.ts";
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
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { WorkflowTelemetryBridge } from "./telemetry_bridge.ts";

/**
 * Events emitted by the libswamp workflow run generator.
 */
/**
 * Lightweight job metadata included in the `started` event so renderers
 * can display the full tree skeleton before any jobs begin executing.
 */
export interface WorkflowRunJobInfo {
  id: string;
  stepCount: number;
  dependsOn: string[];
}

export type WorkflowRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "evaluating_workflow" }
  | {
    kind: "started";
    runId: string;
    workflowName: string;
    driver?: string;
    jobs: WorkflowRunJobInfo[];
  }
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
    /**
     * Populated only when the failing step is a model-method task. The
     * telemetry bridge uses these to synthesize a child entry for
     * failures that occurred before `method_executing` was yielded.
     */
    modelName?: string;
    methodName?: string;
    driver?: string;
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
    kind: "env_var_warning";
    jobId: string;
    stepId: string;
    modelName: string;
    envVars: EnvVarUsageDetail[];
    message: string;
  }
  | {
    kind: "method_executing";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    /**
     * Resolved driver from the DriverPlan tier resolution. Optional:
     * undefined when no driver is explicitly configured at any tier.
     */
    driver?: string;
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
    jobId?: string;
    stepId?: string;
  }
  | {
    kind: "report_completed";
    reportName: string;
    scope: string;
    markdown: string;
    json: Record<string, unknown>;
    jobId?: string;
    stepId?: string;
  }
  | {
    kind: "report_failed";
    reportName: string;
    scope: string;
    error: string;
    jobId?: string;
    stepId?: string;
  }
  | { kind: "completed"; run: WorkflowRunView }
  | { kind: "error"; error: SwampError };

/**
 * Narrow callback shape for emitting per-method-invocation telemetry from
 * inside a workflow run. The CLI binds this to TelemetryService's
 * recordChildInvocation; non-CLI consumers (UI, tests, scripts) pass
 * `undefined` for `telemetrySink` to no-op.
 *
 * Lives in libswamp (not domain.telemetry) so libswamp can stay free of
 * direct domain.telemetry imports beyond plain DTO shapes.
 */
export interface WorkflowTelemetrySink {
  recordChildInvocation(
    invocation:
      import("../../domain/telemetry/command_invocation.ts").CommandInvocationData,
    startedAt: Date,
    completedAt: Date,
    error: Error | null,
    parentInvocationId: string,
    workflowContext:
      import("../../domain/telemetry/workflow_context.ts").WorkflowContextData,
  ): Promise<void>;
  /**
   * Pre-allocated id of the parent CLI invocation. Children reference
   * this id via `parentInvocationId` so analytics can join children to
   * the parent without timestamp guessing.
   */
  readonly parentInvocationId: string;
}

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
    catalogStore: CatalogStore,
  ) => WorkflowExecutionService;
  catalogStore: CatalogStore;
  dataRepo?: UnifiedDataRepository;
  definitionRepo?: DefinitionRepository;
  telemetrySink?: WorkflowTelemetrySink;
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
  swampSha?: string;
  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  skipAllChecks?: boolean;
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
    workflowDataArtifacts: run.workflowDataArtifacts &&
        run.workflowDataArtifacts.length > 0
      ? run.workflowDataArtifacts.map((a) => ({
        dataId: a.dataId,
        name: a.name,
        version: a.version,
        tags: a.tags,
      }))
      : undefined,
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
        driver: event.driver,
        jobs: event.jobs.map((j) => ({
          id: j.id,
          stepCount: j.stepCount,
          dependsOn: j.dependsOn,
        })),
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
    case "env_var_warning":
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
  yield* withGeneratorSpan(
    "swamp.workflow.run.command",
    { "workflow.id_or_name": input.workflowIdOrName },
    (async function* () {
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
        deps.catalogStore,
      );

      // Per-method-invocation telemetry bridge. Constructed once per
      // stream consumption and finalized in the outer try/finally so
      // any in-flight invocations on cancellation / throw are still
      // recorded as error child entries.
      const telemetryBridge = deps.telemetrySink
        ? new WorkflowTelemetryBridge(deps.telemetrySink)
        : undefined;

      try {
        // Aggregate report results from both method-scope (yielded during
        // step execution) and workflow-scope (yielded by the execution
        // service after run.complete()). All report_completed and
        // report_failed events arrive before the completed event, so the
        // accumulated list is attached to the run view at that point.
        const reportResults: ReportResultView[] = [];

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
            swampSha: resolvedInput.swampSha,
            skipCheckNames: resolvedInput.skipCheckNames,
            skipCheckLabels: resolvedInput.skipCheckLabels,
            skipAllChecks: resolvedInput.skipAllChecks,
          })
        ) {
          if (event.kind === "report_completed") {
            reportResults.push({
              name: event.reportName,
              scope: event.scope,
              success: true,
              markdown: event.markdown,
              json: event.json,
            });
          } else if (event.kind === "report_failed") {
            reportResults.push({
              name: event.reportName,
              scope: event.scope,
              success: false,
              error: event.error,
            });
          }

          let mapped = mapEvent(event, deps, resolvedInput);

          // Per-method telemetry observer — runs alongside existing
          // event handling. Skipped when telemetry is disabled.
          if (telemetryBridge) {
            await telemetryBridge.observe(mapped);
          }

          if (mapped.kind === "completed" && reportResults.length > 0) {
            mapped = {
              ...mapped,
              run: { ...mapped.run, reports: reportResults },
            };
          }

          yield mapped;
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
      } finally {
        // Drain any in-flight method invocations as error entries. Runs
        // on every stream termination — normal completion, thrown
        // errors, and AbortSignal cancellation — so methods that
        // started but never received a terminal event don't disappear
        // from telemetry.
        if (telemetryBridge) {
          await telemetryBridge.finalize();
        }
      }
    })(),
  );
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
