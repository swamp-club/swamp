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

  try {
    for await (
      const event of service.run(resolvedInput.workflowIdOrName, {
        lastEvaluated: resolvedInput.lastEvaluated,
        inputs: resolvedInput.inputs,
        runtimeTags: resolvedInput.runtimeTags,
        signal: ctx.signal,
        driver: resolvedInput.driver,
      })
    ) {
      yield mapEvent(event, deps, resolvedInput);
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
