import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../../../infrastructure/persistence/paths.ts";
import type {
  JobRunData,
  StepRunData,
  WorkflowRunData,
} from "../../../../domain/workflows/workflow_run.ts";

/**
 * Information about a log stream target.
 */
export interface LogStreamTarget {
  type: "step" | "job";
  jobName: string;
  stepName?: string;
  workflowRunId: string;
  stepStatus?: string;
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
 * Reads .log files written by RunFileSink, falling back to YAML output
 * for backward compatibility.
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
    const logFile = await this.findLogFile(target);
    return logFile !== null;
  }

  /**
   * Gets all available log entries for a target.
   * For steps, returns logs from that specific step.
   * For jobs, reads from the job-level log file.
   */
  async getLogs(target: LogStreamTarget): Promise<LogEntry[]> {
    if (target.type === "step" && target.stepName) {
      return await this.getStepLogs(
        target.jobName,
        target.stepName,
        target.workflowRunId,
        target.stepStatus,
      );
    }

    if (target.type === "job") {
      return await this.getJobLogs(
        target.jobName,
        target.workflowRunId,
      );
    }

    return [];
  }

  /**
   * Streams logs in real-time. Returns an async iterator that yields new log entries.
   * For completed steps, returns all logs immediately.
   * For pending/running steps, polls the log file for updates until completion.
   */
  async *streamLogs(
    target: LogStreamTarget,
    startFrom: number = 0,
  ): AsyncIterableIterator<LogEntry> {
    try {
      let lastLogCount = startFrom;
      let lastStepStatus = target.stepStatus;
      let isComplete = false;
      let pollCount = 0;
      const maxPolls = 120;

      while (!isComplete && pollCount < maxPolls) {
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

        // Get current logs
        const logs = await this.getLogs(currentTarget);

        // Yield only new logs
        for (let i = lastLogCount; i < logs.length; i++) {
          yield logs[i];
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
          await new Promise((resolve) => setTimeout(resolve, 2000));
          pollCount++;
        } else {
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
      const runFile = await this.findWorkflowRunFile(workflowRunId);
      if (!runFile) return null;

      const runFileContent = await Deno.readTextFile(runFile);
      const workflowRun = parseYaml(runFileContent) as WorkflowRunData;

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
   * Gets logs for a specific step.
   * Reads from the job-level .log file produced by RunFileSink,
   * falling back to YAML output for backward compatibility.
   */
  private async getStepLogs(
    jobName: string,
    stepName: string,
    workflowRunId: string,
    stepStatus?: string,
  ): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];

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

    // Try reading from .log file first
    const logFile = await this.findLogFile({
      type: "job",
      jobName,
      workflowRunId,
    });

    if (logFile) {
      try {
        const content = await Deno.readTextFile(logFile);
        const lines = content.split("\n").filter((line) => line.trim());
        entries.push({
          message: `[LOG] Streaming logs for step: ${jobName}/${stepName}`,
          timestamp: new Date(),
        });
        for (const line of lines) {
          entries.push({ message: line, timestamp: new Date() });
        }
        return entries;
      } catch {
        // Fall through to YAML fallback
      }
    }

    // Fallback: read from workflow run YAML (backward compatibility)
    return await this.getStepLogsFromYaml(
      jobName,
      stepName,
      workflowRunId,
    );
  }

  /**
   * Gets logs for a job from the job-level .log file.
   */
  private async getJobLogs(
    jobName: string,
    workflowRunId: string,
  ): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];

    const logFile = await this.findLogFile({
      type: "job",
      jobName,
      workflowRunId,
    });

    if (logFile) {
      try {
        const content = await Deno.readTextFile(logFile);
        const lines = content.split("\n").filter((line) => line.trim());
        for (const line of lines) {
          entries.push({ message: line, timestamp: new Date() });
        }
      } catch {
        entries.push({
          message: `[ERROR] Could not read log file`,
          timestamp: new Date(),
        });
      }
    }

    return entries;
  }

  /**
   * Finds the .log file for a target.
   * Log files are stored as: .swamp/workflow-runs/{workflowId}/workflow-run-{runId}-{jobName}.log
   */
  private async findLogFile(
    target: LogStreamTarget,
  ): Promise<string | null> {
    const baseRunsDir = swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns);

    try {
      // Search through all workflow template directories
      for await (const workflowEntry of Deno.readDir(baseRunsDir)) {
        if (workflowEntry.isDirectory) {
          const workflowDir = join(baseRunsDir, workflowEntry.name);
          const logFileName = `workflow-run-${target.workflowRunId}.log`;
          const potentialPath = join(workflowDir, logFileName);

          try {
            await Deno.stat(potentialPath);
            return potentialPath;
          } catch {
            continue;
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return null;
  }

  /**
   * Finds the workflow run YAML file.
   */
  private async findWorkflowRunFile(
    workflowRunId: string,
  ): Promise<string | null> {
    const baseRunsDir = swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns);

    try {
      for await (const workflowEntry of Deno.readDir(baseRunsDir)) {
        if (workflowEntry.isDirectory) {
          const workflowDir = join(baseRunsDir, workflowEntry.name);
          const targetFileName = `workflow-run-${workflowRunId}.yaml`;
          const potentialFilePath = join(workflowDir, targetFileName);

          try {
            await Deno.stat(potentialFilePath);
            return potentialFilePath;
          } catch {
            continue;
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return null;
  }

  /**
   * Fallback: gets step logs from workflow run YAML (backward compatibility).
   */
  private async getStepLogsFromYaml(
    jobName: string,
    stepName: string,
    workflowRunId: string,
  ): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];

    try {
      const runFile = await this.findWorkflowRunFile(workflowRunId);

      if (!runFile) {
        entries.push({
          message:
            `[INFO] No workflow run data found for run ID: ${workflowRunId}`,
          timestamp: new Date(),
        });
        return entries;
      }

      const runFileContent = await Deno.readTextFile(runFile);
      const workflowRun = parseYaml(runFileContent) as WorkflowRunData;

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

      // Check output for stdout and exit code
      const stepOutput = step.output as
        | { stdout?: string; stderr?: string; exitCode?: number }
        | undefined;

      // Show stdout content if available
      if (stepOutput?.stdout) {
        const lines = stepOutput.stdout.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            entries.push({
              message: line,
              timestamp: step.startedAt ? new Date(step.startedAt) : new Date(),
            });
          }
        }
      }

      // Show stderr if available
      if (stepOutput?.stderr) {
        const lines = stepOutput.stderr.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            entries.push({
              message: `[STDERR] ${line}`,
              timestamp: step.startedAt ? new Date(step.startedAt) : new Date(),
            });
          }
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
