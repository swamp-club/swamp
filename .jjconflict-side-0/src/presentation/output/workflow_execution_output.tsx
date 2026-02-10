// deno-lint-ignore-file verbatim-module-syntax
import process from "node:process";
import React from "react";
import { render } from "ink";
import type { OutputMode } from "./output.ts";
import type { WorkflowData } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  ExecutionProgressCallback,
  ImplicitDependencyMap,
} from "../../domain/workflows/execution_service.ts";
import {
  type JobRunData,
  renderWorkflowRun,
  type StepRunData,
  type WorkflowRunData,
} from "./workflow_run_output.ts";
import {
  type ExecutionAction,
  WorkflowExecutionUI,
} from "./components/workflow_execution/mod.ts";

/**
 * Input for the workflow execution renderer.
 */
export interface WorkflowExecutionInput {
  workflow: WorkflowData;
  workflowYaml: string;
}

/**
 * Converts a WorkflowRun domain object to WorkflowRunData for presentation.
 */
function toRunData(run: WorkflowRun): WorkflowRunData {
  const startTime = run.startedAt?.getTime();
  const endTime = run.completedAt?.getTime();

  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    jobs: run.jobs.map((job): JobRunData => {
      const jobStart = job.startedAt?.getTime();
      const jobEnd = job.completedAt?.getTime();

      return {
        name: job.jobName,
        status: job.status,
        steps: job.steps.map((step): StepRunData => {
          const stepStart = step.startedAt?.getTime();
          const stepEnd = step.completedAt?.getTime();

          return {
            name: step.stepName,
            status: step.status,
            error: step.error,
            duration: stepStart && stepEnd ? stepEnd - stepStart : undefined,
          };
        }),
        duration: jobStart && jobEnd ? jobEnd - jobStart : undefined,
      };
    }),
    duration: startTime && endTime ? endTime - startTime : undefined,
  };
}

/**
 * Creates a progress callback adapter that bridges domain events to React dispatch.
 */
function createProgressAdapter(
  dispatch: React.Dispatch<ExecutionAction>,
): ExecutionProgressCallback {
  return {
    onImplicitDependencies: (deps: ImplicitDependencyMap) => {
      dispatch({ type: "SET_IMPLICIT_DEPENDENCIES", deps });
    },
    onWorkflowStart: (run) => {
      dispatch({ type: "WORKFLOW_START", run: toRunData(run) });
    },
    onJobStart: (run) => {
      dispatch({ type: "WORKFLOW_UPDATE", run: toRunData(run) });
    },
    onJobComplete: (run) => {
      dispatch({ type: "WORKFLOW_UPDATE", run: toRunData(run) });
    },
    onJobSkip: (run) => {
      dispatch({ type: "WORKFLOW_UPDATE", run: toRunData(run) });
    },
    onStepStart: (run) => {
      dispatch({ type: "WORKFLOW_UPDATE", run: toRunData(run) });
    },
    onStepComplete: (run) => {
      dispatch({ type: "WORKFLOW_UPDATE", run: toRunData(run) });
    },
    onStepSkip: (run) => {
      dispatch({ type: "WORKFLOW_UPDATE", run: toRunData(run) });
    },
    onStepFail: (run) => {
      dispatch({ type: "WORKFLOW_UPDATE", run: toRunData(run) });
    },
    onWorkflowComplete: (run) => {
      dispatch({ type: "WORKFLOW_COMPLETE", run: toRunData(run) });
    },
  };
}

/**
 * Result of an interactive workflow execution.
 */
export interface WorkflowExecutionResult {
  run: WorkflowRunData;
  path?: string;
}

/**
 * Renders the workflow execution UI.
 *
 * In JSON mode, executes silently and outputs the final result.
 * In interactive mode, shows a live dashboard with progress updates.
 *
 * @param input - The workflow data and YAML content
 * @param executeWorkflow - Function that executes the workflow with a progress callback
 * @param mode - Output mode (interactive or json)
 * @param path - Optional path where the run is saved
 * @returns Promise that resolves with the final workflow run data
 */
export async function renderWorkflowExecution(
  input: WorkflowExecutionInput,
  executeWorkflow: (
    progress: ExecutionProgressCallback,
  ) => Promise<WorkflowRun>,
  mode: OutputMode,
  path?: string,
): Promise<WorkflowRunData> {
  if (mode === "json") {
    // JSON mode: execute silently, output final result
    const run = await executeWorkflow({});
    const data = toRunData(run);
    if (path) {
      data.path = path;
    }
    renderWorkflowRun(data, mode);
    return data;
  }

  // Interactive mode: show live dashboard
  return await renderInteractiveExecution(input, executeWorkflow, path);
}

// ANSI escape sequences for alternate screen buffer (like vim/htop use)
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";

/**
 * Renders the interactive execution UI with live updates.
 * Uses alternate screen buffer for clean fullscreen rendering.
 */
async function renderInteractiveExecution(
  input: WorkflowExecutionInput,
  executeWorkflow: (
    progress: ExecutionProgressCallback,
  ) => Promise<WorkflowRun>,
  path?: string,
): Promise<WorkflowRunData> {
  let dispatchRef: React.Dispatch<ExecutionAction> | null = null;
  let finalRunData: WorkflowRunData | null = null;

  // Enter alternate screen buffer for clean fullscreen rendering
  process.stdout.write(ENTER_ALT_SCREEN);

  const { waitUntilExit, unmount } = render(
    <WorkflowExecutionUI
      workflow={input.workflow}
      workflowYaml={input.workflowYaml}
      onExit={() => {
        // Resolved when user presses 'q' - finalRunData will be set
      }}
      registerDispatch={(dispatch) => {
        dispatchRef = dispatch;
      }}
    />,
  );

  // Helper to clean up and exit alternate screen
  const cleanup = () => {
    unmount();
    process.stdout.write(EXIT_ALT_SCREEN);
  };

  // Wait a tick for dispatch to be registered
  await new Promise((r) => setTimeout(r, 0));

  if (!dispatchRef) {
    cleanup();
    throw new Error("Dispatch not registered");
  }

  const progress = createProgressAdapter(dispatchRef);

  try {
    const run = await executeWorkflow(progress);
    finalRunData = toRunData(run);
    if (path) {
      finalRunData.path = path;
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  // Wait for user to exit (press 'q')
  await waitUntilExit();

  // Exit alternate screen buffer
  process.stdout.write(EXIT_ALT_SCREEN);

  if (!finalRunData) {
    throw new Error("Workflow execution completed without run data");
  }

  return finalRunData;
}
