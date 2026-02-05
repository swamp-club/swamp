import type {
  ExecutionProgressCallback,
  ImplicitDependencyMap,
} from "../../domain/workflows/execution_service.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Creates a progress callback that streams colored output to the terminal.
 * - Green for stdout
 * - Red for stderr
 * - Cyan for lifecycle events (job/step start/complete)
 */
export function createStreamProgressCallback(): ExecutionProgressCallback {
  return {
    onWorkflowStart: (run: WorkflowRun) => {
      console.log(
        `${CYAN}[workflow]${RESET} Starting workflow: ${run.workflowName}`,
      );
    },

    onJobStart: (_run: WorkflowRun, jobName: string) => {
      console.log(`${CYAN}[${jobName}]${RESET} Job started`);
    },

    onJobComplete: (_run: WorkflowRun, jobName: string) => {
      console.log(`${CYAN}[${jobName}]${RESET} Job completed`);
    },

    onJobSkip: (_run: WorkflowRun, jobName: string) => {
      console.log(`${DIM}[${jobName}] Job skipped${RESET}`);
    },

    onStepStart: (_run: WorkflowRun, jobName: string, stepName: string) => {
      console.log(`${CYAN}[${jobName}/${stepName}]${RESET} Step started`);
    },

    onStepComplete: (_run: WorkflowRun, jobName: string, stepName: string) => {
      console.log(`${CYAN}[${jobName}/${stepName}]${RESET} Step completed`);
    },

    onStepSkip: (_run: WorkflowRun, jobName: string, stepName: string) => {
      console.log(`${DIM}[${jobName}/${stepName}] Step skipped${RESET}`);
    },

    onStepFail: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
      error: string,
    ) => {
      console.error(
        `${RED}[${jobName}/${stepName}] Step failed: ${error}${RESET}`,
      );
    },

    onWorkflowComplete: (run: WorkflowRun) => {
      const statusColor = run.status === "failed" ? RED : GREEN;
      console.log(
        `${statusColor}[workflow]${RESET} Workflow ${run.status}: ${run.workflowName}`,
      );
    },

    onImplicitDependencies: (implicitDeps: ImplicitDependencyMap) => {
      if (implicitDeps.size === 0) return;

      console.log(
        `${YELLOW}[workflow]${RESET} Implicit dependencies detected:`,
      );
      for (const [jobName, stepDeps] of implicitDeps) {
        for (const [stepName, deps] of stepDeps) {
          console.log(
            `${DIM}  ${jobName}/${stepName} depends on: ${
              deps.join(", ")
            }${RESET}`,
          );
        }
      }
    },

    onStepStdout: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
      line: string,
    ) => {
      console.log(`${GREEN}[${jobName}/${stepName}]${RESET} ${line}`);
    },

    onStepStderr: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
      line: string,
    ) => {
      console.error(`${RED}[${jobName}/${stepName}]${RESET} ${line}`);
    },
  };
}

/**
 * Creates a simple progress callback for model method runs.
 * Uses format: [model_name/method_name] <output>
 */
export function createModelMethodStreamCallback(
  modelName: string,
  methodName: string,
): { onStdout: (line: string) => void; onStderr: (line: string) => void } {
  const prefix = `[${modelName}/${methodName}]`;

  return {
    onStdout: (line: string) => {
      console.log(`${GREEN}${prefix}${RESET} ${line}`);
    },
    onStderr: (line: string) => {
      console.error(`${RED}${prefix}${RESET} ${line}`);
    },
  };
}
