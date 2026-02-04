import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import type {
  JobRunData,
  StepRunData,
  WorkflowRunData,
} from "../../../../domain/workflows/workflow_run.ts";

/**
 * Step output structure from workflow runs
 */
interface StepOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * Information about a log stream target.
 */
export interface LogStreamTarget {
  type: "step" | "job";
  jobName: string;
  stepName?: string;
  workflowRunId: string;
  stepStatus?: string; // Add step status to determine if logs should be shown
}

/**
 * A single log entry with metadata.
 */
export interface LogEntry {
  message: string;
  timestamp?: Date;
}

/**
 * Service for streaming logs from workflow step executions.
 * Reads log files from the .swamp/logs/ directory structure.
 */
export class LogStreamService {
  private repoDir: string;

  constructor(repoDir: string = ".") {
    this.repoDir = repoDir;
  }

  /**
   * Checks if logs exist for a given step or job.
   */
  async hasLogs(target: LogStreamTarget): Promise<boolean> {
    const logPath = this.getLogPath(target);
    try {
      const stat = await Deno.stat(logPath);
      return stat.isDirectory;
    } catch {
      return false;
    }
  }

  /**
   * Gets all available log entries for a target.
   * For steps, returns logs from that specific step.
   * For jobs, aggregates logs from all steps in the job.
   */
  async getLogs(target: LogStreamTarget): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];

    if (target.type === "step" && target.stepName) {
      const stepLogs = await this.getStepLogsFromWorkflowRun(
        target.jobName,
        target.stepName,
        target.workflowRunId,
        target.stepStatus,
      );
      entries.push(...stepLogs);
    }

    return entries;
  }

  /**
   * Streams logs in real-time. Returns an async iterator that yields new log entries.
   * For completed steps, returns all logs immediately.
   * For pending/running steps, polls for updates until completion.
   */
  async *streamLogs(target: LogStreamTarget): AsyncIterableIterator<LogEntry> {
    try {
      let lastLogCount = 0;
      let lastStepStatus = target.stepStatus;
      let isComplete = false;
      let pollCount = 0;
      const maxPolls = 120; // Poll for up to 2 minutes (120 * 1 second)

      while (!isComplete && pollCount < maxPolls) {
        // Create a new target with updated status for polling
        const currentTarget = { ...target };

        // Get current step status by re-reading the workflow run file
        if (target.stepName && target.workflowRunId) {
          const currentStepInfo = await this.getCurrentStepInfo(
            target.jobName,
            target.stepName,
            target.workflowRunId,
          );
          if (currentStepInfo) {
            currentTarget.stepStatus = currentStepInfo.status;
          }
        }

        // Get current logs with updated target
        let logs: LogEntry[] = [];
        if (currentTarget.stepName && currentTarget.workflowRunId) {
          logs = await this.getStepLogsFromWorkflowRun(
            currentTarget.jobName,
            currentTarget.stepName,
            currentTarget.workflowRunId,
            currentTarget.stepStatus,
          );
        }

        // Yield only new logs (ones we haven't seen before)
        for (let i = lastLogCount; i < logs.length; i++) {
          yield logs[i];
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        lastLogCount = logs.length;

        // Check if step status changed
        if (lastStepStatus !== currentTarget.stepStatus) {
          yield {
            message:
              `[INFO] Step status changed: ${lastStepStatus} → ${currentTarget.stepStatus}`,
            timestamp: new Date(),
          };
          lastStepStatus = currentTarget.stepStatus;
        }

        // Check if we should continue polling
        if (
          currentTarget.stepStatus === "pending" ||
          currentTarget.stepStatus === "running"
        ) {
          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Poll every 2 seconds
          pollCount++;
        } else {
          // Step is completed, succeeded, failed, or skipped - no need to poll
          isComplete = true;
        }
      }

      if (pollCount >= maxPolls) {
        yield {
          message: `[INFO] Stopped polling for updates after ${
            maxPolls * 2
          } seconds`,
          timestamp: new Date(),
        };
      }
    } catch (error) {
      yield {
        message: `[ERROR] Streaming error: ${error}`,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Gets current step information (status) by re-reading the workflow run file.
   */
  private async getCurrentStepInfo(
    jobName: string,
    stepName: string,
    workflowRunId: string,
  ): Promise<{ status: string } | null> {
    try {
      // Find the workflow run file
      const baseRunsDir = join(this.repoDir, ".swamp", "workflow-runs");
      let runFile: string | null = null;

      // Search through all workflow template directories
      for await (const workflowEntry of Deno.readDir(baseRunsDir)) {
        if (workflowEntry.isDirectory) {
          const workflowDir = join(baseRunsDir, workflowEntry.name);
          const targetFileName = `workflow-run-${workflowRunId}.yaml`;
          const potentialFilePath = join(workflowDir, targetFileName);

          try {
            await Deno.stat(potentialFilePath);
            runFile = potentialFilePath;
            break;
          } catch {
            continue;
          }
        }
      }

      if (!runFile) {
        return null;
      }

      // Read and parse the workflow run file
      const runFileContent = await Deno.readTextFile(runFile);
      const workflowRun = parseYaml(runFileContent) as WorkflowRunData;

      // Find the specific job and step
      const job = workflowRun.jobs?.find((j: JobRunData) =>
        j.jobName === jobName
      );
      if (!job) return null;

      const step = job.steps?.find((s: StepRunData) => s.stepName === stepName);
      if (!step) return null;

      return { status: step.status };
    } catch {
      return null;
    }
  }

  /**
   * Gets the base log path for a target.
   */
  private getLogPath(_target: LogStreamTarget): string {
    // Logs are stored in .swamp/logs/{type}/{id}/
    // For workflow steps, we need to map to model outputs
    return join(this.repoDir, ".swamp", "logs");
  }

  /**
   * Gets logs for a specific step by reading from workflow run files.
   */
  private async getStepLogsFromWorkflowRun(
    jobName: string,
    stepName: string,
    workflowRunId: string,
    stepStatus?: string,
  ): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];

    // Only show logs for steps that have started execution
    if (stepStatus === "pending") {
      entries.push({
        message: `[INFO] Step ${jobName}/${stepName} has not started yet`,
        timestamp: new Date(),
      });
      entries.push({
        message: `[INFO] Waiting for dependencies to complete...`,
        timestamp: new Date(),
      });
      return entries;
    }

    if (stepStatus === "skipped") {
      entries.push({
        message: `[INFO] Step ${jobName}/${stepName} was skipped`,
        timestamp: new Date(),
      });
      return entries;
    }

    try {
      // Find the workflow run file by searching all workflow directories
      // File structure: .swamp/workflow-runs/{workflowTemplateId}/workflow-run-{runInstanceId}.yaml
      const baseRunsDir = join(this.repoDir, ".swamp", "workflow-runs");
      let runFile: string | null = null;

      try {
        // Search through all workflow template directories
        for await (const workflowEntry of Deno.readDir(baseRunsDir)) {
          if (workflowEntry.isDirectory) {
            const workflowDir = join(baseRunsDir, workflowEntry.name);
            const targetFileName = `workflow-run-${workflowRunId}.yaml`;
            const potentialFilePath = join(workflowDir, targetFileName);

            try {
              // Check if this workflow run file exists
              await Deno.stat(potentialFilePath);
              runFile = potentialFilePath;
              break;
            } catch {
              // File doesn't exist in this workflow directory, continue searching
              continue;
            }
          }
        }
      } catch (error) {
        entries.push({
          message:
            `[ERROR] Could not search workflow runs directories: ${error}`,
          timestamp: new Date(),
        });
        return entries;
      }

      if (!runFile) {
        entries.push({
          message:
            `[INFO] No workflow run data found for run ID: ${workflowRunId}`,
          timestamp: new Date(),
        });
        return entries;
      }

      // Read and parse the workflow run file
      const runFileContent = await Deno.readTextFile(runFile);
      const workflowRun = parseYaml(runFileContent) as WorkflowRunData;

      // Find the specific job and step
      const job = workflowRun.jobs?.find((j: JobRunData) =>
        j.jobName === jobName
      );
      if (!job) {
        entries.push({
          message: `[ERROR] Job ${jobName} not found in workflow run`,
          timestamp: new Date(),
        });
        return entries;
      }

      const step = job.steps?.find((s: StepRunData) => s.stepName === stepName);
      if (!step) {
        entries.push({
          message: `[ERROR] Step ${stepName} not found in job ${jobName}`,
          timestamp: new Date(),
        });
        return entries;
      }

      // Add step execution info
      entries.push({
        message: `[LOG] Streaming logs for step: ${jobName}/${stepName}`,
        timestamp: new Date(),
      });

      if (step.startedAt) {
        entries.push({
          message: `[INFO] Step started at: ${step.startedAt}`,
          timestamp: new Date(step.startedAt),
        });
      }

      // Type guard for step output
      const stepOutput = step.output as StepOutput | undefined;

      // Add actual stdout logs if available
      if (stepOutput?.stdout) {
        const stdoutLines = stepOutput.stdout.split("\n").filter((
          line: string,
        ) => line.trim());
        for (const line of stdoutLines) {
          entries.push({
            message: line,
            timestamp: step.startedAt ? new Date(step.startedAt) : new Date(),
          });
        }
      }

      // Add stderr logs if available
      if (stepOutput?.stderr) {
        const stderrLines = stepOutput.stderr.split("\n").filter((
          line: string,
        ) => line.trim());
        for (const line of stderrLines) {
          entries.push({
            message: `[STDERR] ${line}`,
            timestamp: step.startedAt ? new Date(step.startedAt) : new Date(),
          });
        }
      }

      if (step.completedAt) {
        entries.push({
          message: `[INFO] Step completed at: ${step.completedAt} (exit code: ${
            stepOutput?.exitCode ?? "unknown"
          })`,
          timestamp: new Date(step.completedAt),
        });
      }
    } catch (error) {
      entries.push({
        message: `[ERROR] Failed to load logs: ${error}`,
        timestamp: new Date(),
      });
    }

    return entries;
  }
}
