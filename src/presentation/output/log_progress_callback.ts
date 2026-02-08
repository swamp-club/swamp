import { getWorkflowRunLogger } from "../../infrastructure/logging/logger.ts";
import type {
  ExecutionProgressCallback,
  ImplicitDependencyMap,
} from "../../domain/workflows/execution_service.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";

/**
 * Creates a LogTape-based progress callback for workflow lifecycle events.
 * Stdout/stderr logging is handled by the step executors when enableStepLogging
 * is set, so this callback intentionally omits onStepStdout/onStepStderr.
 */
export function createLogProgressCallback(
  workflowName: string,
): ExecutionProgressCallback {
  const wfLogger = getWorkflowRunLogger(workflowName);

  return {
    onWorkflowStart: () => {
      wfLogger.info("Starting workflow");
    },

    onJobStart: (_run: WorkflowRun, jobName: string) => {
      getWorkflowRunLogger(workflowName, jobName).info("Job started");
    },

    onJobComplete: (_run: WorkflowRun, jobName: string) => {
      getWorkflowRunLogger(workflowName, jobName).info("Job completed");
    },

    onJobSkip: (_run: WorkflowRun, jobName: string) => {
      getWorkflowRunLogger(workflowName, jobName).info("Job skipped");
    },

    onStepStart: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
    ) => {
      getWorkflowRunLogger(workflowName, jobName, stepName).info(
        "Step started",
      );
    },

    onStepComplete: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
    ) => {
      getWorkflowRunLogger(workflowName, jobName, stepName).info(
        "Step completed",
      );
    },

    onStepSkip: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
    ) => {
      getWorkflowRunLogger(workflowName, jobName, stepName).info(
        "Step skipped",
      );
    },

    onStepFail: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
      error: string,
    ) => {
      getWorkflowRunLogger(workflowName, jobName, stepName).error(
        "Step failed: {error}",
        { error },
      );
    },

    onWorkflowComplete: (run: WorkflowRun) => {
      if (run.status === "failed") {
        wfLogger.error("Workflow {status}", { status: run.status });
      } else {
        wfLogger.with({ summary: true }).info("Workflow {status}", {
          status: run.status,
        });
      }
    },

    onImplicitDependencies: (deps: ImplicitDependencyMap) => {
      for (const [jobName, stepDeps] of deps) {
        for (const [stepName, depList] of stepDeps) {
          getWorkflowRunLogger(workflowName, jobName, stepName)
            .info("Implicit dependencies: {deps}", {
              deps: depList.join(", "),
            });
        }
      }
    },
  };
}
