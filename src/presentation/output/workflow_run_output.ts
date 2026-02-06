import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

/**
 * Artifact data included when --verbose is set.
 */
export interface StepArtifactsData {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  dataAttributes?: Record<string, unknown>;
}

/**
 * Reference to a Data artifact produced by a step.
 */
export interface DataArtifactRefData {
  dataId: string;
  name: string;
  version: number;
  tags: Record<string, string>;
}

export interface StepRunData {
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  error?: string;
  duration?: number;
  /** Dependencies inferred from ${{ }} expressions */
  implicitDependencies?: string[];
  /** Output ID if this step produced an output (for model methods) */
  outputId?: string;
  /** Step artifacts included when --verbose is set */
  artifacts?: StepArtifactsData;
  /** Data artifacts produced by this step */
  dataArtifacts?: DataArtifactRefData[];
}

export interface JobRunData {
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  steps: StepRunData[];
  duration?: number;
}

export interface WorkflowRunData {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "pending" | "running" | "succeeded" | "failed";
  jobs: JobRunData[];
  duration?: number;
  path?: string;
}

export function renderWorkflowRun(
  data: WorkflowRunData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderLogWorkflowRun(data);
  }
}

function renderLogWorkflowRun(data: WorkflowRunData): void {
  const logger = getSwampLogger(["workflow", "run"]);

  logger.info("Workflow: {workflowName} (Run ID: {id})", {
    workflowName: data.workflowName,
    id: data.id,
  });

  for (const job of data.jobs) {
    const durationSuffix = job.duration !== undefined
      ? ` (${job.duration}ms)`
      : "";
    logger.info("  {status} {jobName}{duration}", {
      status: statusIcon(job.status),
      jobName: job.name,
      duration: durationSuffix,
    });

    for (const step of job.steps) {
      const stepDuration = step.duration !== undefined
        ? ` (${step.duration}ms)`
        : "";
      logger.info("    {status} {stepName}{duration}", {
        status: statusIcon(step.status),
        stepName: step.name,
        duration: stepDuration,
      });

      if (step.error) {
        logger.error("      -> {error}", { error: step.error });
      }
    }
  }

  const resultLevel = data.status === "failed" ? "error" : "info";
  const durationSuffix = data.duration !== undefined
    ? ` (${data.duration}ms)`
    : "";
  logger[resultLevel]("Result: {status}{duration}", {
    status: data.status.toUpperCase(),
    duration: durationSuffix,
  });

  if (data.path) {
    logger.info("Saved to: {path}", { path: data.path });
  }
}

function statusIcon(
  status: "pending" | "running" | "succeeded" | "failed" | "skipped",
): string {
  const icons: Record<string, string> = {
    pending: "\u25CB",
    running: "\u25D0",
    succeeded: "\u2713",
    failed: "\u2717",
    skipped: "\u2298",
  };
  return icons[status] ?? "?";
}
