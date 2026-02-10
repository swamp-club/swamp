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
   * Streams logs by tailing the log file using byte offset tracking.
   * Polls every 500ms for smooth streaming.
   *
   * For running/pending steps: polls continuously until the step completes.
   * For completed steps: reads all content, then does extra reads to catch
   * any fire-and-forget writes that haven't flushed to disk yet.
   */
  async *streamLogs(
    target: LogStreamTarget,
  ): AsyncIterableIterator<LogEntry> {
    try {
      let lastStepStatus = target.stepStatus;
      let pollCount = 0;
      const pollIntervalMs = 500;
      const maxPolls = 480; // 4 minutes at 500ms
      let byteOffset = 0;
      let partialLine = "";

      // Build category filter for the target.
      // LogTape text format uses · (middle dot U+00B7) as category separator.
      // Step lines look like: "... workflow·run·wfName·jobName·stepName: message"
      // Job lines look like:  "... workflow·run·wfName·jobName: message"
      const MIDDLE_DOT = "\u00B7";
      const categoryFilter = target.type === "step" && target.stepName
        ? `${MIDDLE_DOT}${target.jobName}${MIDDLE_DOT}${target.stepName}`
        : `${MIDDLE_DOT}${target.jobName}`;

      // Find the log file (retry a few times for steps that haven't started yet)
      let logFile: string | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        logFile = await this.findLogFile({
          type: "job",
          jobName: target.jobName,
          workflowRunId: target.workflowRunId,
        });
        if (logFile) break;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // Helper: read new bytes from the log file and yield filtered lines
      const readNewContent = async function* (): AsyncIterableIterator<
        LogEntry
      > {
        if (!logFile) return;
        try {
          const stat = await Deno.stat(logFile);
          if (stat.size > byteOffset) {
            const file = await Deno.open(logFile, { read: true });
            try {
              await file.seek(byteOffset, Deno.SeekMode.Start);
              const buf = new Uint8Array(stat.size - byteOffset);
              const bytesRead = await file.read(buf);
              if (bytesRead && bytesRead > 0) {
                byteOffset += bytesRead;
                const text = partialLine +
                  new TextDecoder().decode(buf.subarray(0, bytesRead));

                const lines = text.split("\n");
                partialLine = lines.pop() ?? "";

                for (const line of lines) {
                  if (line.trim() && line.includes(categoryFilter)) {
                    yield {
                      message: extractLogMessage(line),
                      timestamp: parseLogTimestamp(line),
                    };
                  }
                }
              }
            } finally {
              file.close();
            }
          }
        } catch {
          // File may not exist yet or be locked
        }
      };

      // Main polling loop
      while (pollCount < maxPolls) {
        // Refresh step status from the workflow run YAML
        if (target.stepName && target.workflowRunId) {
          const currentStepInfo = await this.getCurrentStepInfo(
            target.jobName,
            target.stepName,
            target.workflowRunId,
          );
          if (currentStepInfo) {
            lastStepStatus = currentStepInfo.status;
          }
        }

        // Read and yield new content
        yield* readNewContent();

        const isStepActive = lastStepStatus === "pending" ||
          lastStepStatus === "running";

        if (isStepActive) {
          // Step still running — keep polling
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          pollCount++;
        } else {
          // Step completed — do a few extra reads to catch late-flushing writes
          for (let i = 0; i < 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            yield* readNewContent();
          }

          // Flush remaining partial line
          if (partialLine.trim()) {
            yield {
              message: extractLogMessage(partialLine),
              timestamp: parseLogTimestamp(partialLine),
            };
            partialLine = "";
          }
          break;
        }
      }

      if (pollCount >= maxPolls) {
        yield {
          message: `[INFO] Stopped polling for updates after ${
            Math.round(maxPolls * pollIntervalMs / 1000)
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
        const MIDDLE_DOT = "\u00B7";
        const stepCategoryFilter =
          `${MIDDLE_DOT}${jobName}${MIDDLE_DOT}${stepName}`;
        const content = await Deno.readTextFile(logFile);
        const lines = content.split("\n").filter((line) =>
          line.trim() && line.includes(stepCategoryFilter)
        );
        entries.push({
          message: `[LOG] Streaming logs for step: ${jobName}/${stepName}`,
          timestamp: new Date(),
        });
        for (const line of lines) {
          entries.push({
            message: extractLogMessage(line),
            timestamp: parseLogTimestamp(line),
          });
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
        const MIDDLE_DOT = "\u00B7";
        const jobCategoryFilter = `${MIDDLE_DOT}${jobName}`;
        const content = await Deno.readTextFile(logFile);
        const lines = content.split("\n").filter((line) =>
          line.trim() && line.includes(jobCategoryFilter)
        );
        for (const line of lines) {
          entries.push({
            message: extractLogMessage(line),
            timestamp: parseLogTimestamp(line),
          });
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

/**
 * Regex that matches the LogTape text-formatter prefix:
 *   "YYYY-MM-DD HH:MM:SS.mmm +HH:MM [LVL] category·sub: "
 */
const LOGTAPE_PREFIX_RE =
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+([+-]\d{2}:\d{2})\s+\[\w+\]\s+\S+:\s/;

/**
 * Parses a timestamp from a LogTape-formatted log line.
 * Expected format: "2026-02-10 12:02:38.976 +00:00 [INF] ..."
 * Returns the parsed Date or current time if parsing fails.
 */
function parseLogTimestamp(line: string): Date {
  const match = line.match(LOGTAPE_PREFIX_RE);
  if (match) {
    // Convert "2026-02-10 12:02:38.976 +00:00" → "2026-02-10T12:02:38.976+00:00"
    const dateStr = `${match[1].trim().replace(" ", "T")}${match[2]}`;
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

/**
 * Strips the LogTape prefix (timestamp, level, category) from a log line,
 * returning only the message content. Falls back to the full line.
 */
function extractLogMessage(line: string): string {
  const match = line.match(LOGTAPE_PREFIX_RE);
  return match ? line.slice(match[0].length) : line;
}
