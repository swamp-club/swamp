// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import {
  type EventHandlers,
  extractFirstStepError,
  type WorkflowRunEvent,
  type WorkflowRunView,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import {
  setSystemPipeWidth,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";
import { AUTH_NUDGE_MESSAGE } from "../../domain/auth/auth_nudge.ts";
import { dim, green, red, yellow } from "@std/fmt/colors";
import { type AssertSeverity, severityAtOrAbove } from "../../libswamp/mod.ts";
import {
  type DataArtifact,
  type DataBoxOptions,
  formatDuration,
  formatTimestamp,
  PipeWriter,
  renderDataBox,
  STATUS_COLORS,
  writeBlankLine,
} from "../output/console_writer.ts";

export interface WorkflowRunRenderOpts {
  workflowName: string;
  isAuthenticated?: boolean;
  quiet?: boolean;
  failOnSeverity?: AssertSeverity;
}

export interface WorkflowRunRenderer extends Renderer<WorkflowRunEvent> {
  workflowFailed(): boolean;
}

function isUserFacingArtifact(
  artifact: { name: string },
): boolean {
  if (artifact.name.startsWith("report-")) return false;
  if (artifact.name === "log") return false;
  return true;
}

const QUIET_BUFFER_LIMIT = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;

class ConsoleWorkflowRunRenderer implements WorkflowRunRenderer {
  private workflowName: string;
  private isAuthenticated: boolean;
  private quiet: boolean;
  private failOnSeverity: AssertSeverity;
  private _failed = false;
  private pipe: PipeWriter | null = null;
  private outputBuffers = new Map<string, string[]>();
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private heartbeatCounters = new Map<string, number>();
  private forEachDisplayNames = new Map<string, string>();
  private stepStartTimes = new Map<string, number>();
  private jobStartTimes = new Map<string, number>();
  private pendingJobStarts = new Map<string, string>();
  private pendingStartLine: (() => void) | null = null;
  private assertResults: Array<{
    stepId: string;
    passed: boolean;
    message: string;
    severity: AssertSeverity;
    error?: string;
  }> = [];
  private assertStepIds = new Set<string>();

  constructor(opts: WorkflowRunRenderOpts) {
    this.workflowName = opts.workflowName;
    this.isAuthenticated = opts.isAuthenticated ?? false;
    this.quiet = opts.quiet ?? false;
    this.failOnSeverity = opts.failOnSeverity ?? "low";
  }

  private getDisplayName(jobId: string, stepId: string, event?: {
    forEachTemplate?: string;
    forEachIndex?: number;
  }): string {
    if (
      event?.forEachTemplate !== undefined && event?.forEachIndex !== undefined
    ) {
      const display = `${event.forEachTemplate}[${event.forEachIndex}]`;
      this.forEachDisplayNames.set(`${jobId}:${stepId}`, display);
      return display;
    }
    return this.forEachDisplayNames.get(`${jobId}:${stepId}`) ?? jobId;
  }

  private getJobDisplayName(jobId: string): string {
    return jobId;
  }

  private stepKey(jobId: string, stepId: string): string {
    return `${jobId}:${stepId}`;
  }

  private startHeartbeat(jobId: string, stepId: string): void {
    const key = this.stepKey(jobId, stepId);
    this.heartbeatCounters.set(key, 0);
    this.heartbeatTimers.set(
      key,
      setInterval(() => {
        const count = (this.heartbeatCounters.get(key) ?? 0) + 1;
        this.heartbeatCounters.set(key, count);
        const elapsed = count * (HEARTBEAT_INTERVAL_MS / 1000);
        const displayName = this.forEachDisplayNames.get(key) ?? jobId;
        if (this.pipe) {
          writeOutput(
            this.pipe.line(
              displayName,
              dim(`Still running... [${elapsed}s elapsed]`),
            ),
          );
        }
      }, HEARTBEAT_INTERVAL_MS),
    );
  }

  private resetHeartbeat(jobId: string, stepId: string): void {
    const key = this.stepKey(jobId, stepId);
    this.heartbeatCounters.set(key, 0);
  }

  private clearHeartbeat(jobId: string, stepId: string): void {
    const key = this.stepKey(jobId, stepId);
    const timer = this.heartbeatTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(key);
    }
    this.heartbeatCounters.delete(key);
  }

  private clearAllHeartbeats(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
    this.heartbeatCounters.clear();
  }

  private flushPendingStartLine(): void {
    if (this.pendingStartLine) {
      this.pendingStartLine();
      this.pendingStartLine = null;
    }
  }

  private flushPendingJobStart(jobId: string): void {
    this.flushPendingStartLine();
    const ts = this.pendingJobStarts.get(jobId);
    if (ts && this.pipe) {
      writeOutput(this.pipe.startLine(this.getJobDisplayName(jobId), ts));
      this.pendingJobStarts.delete(jobId);
    }
  }

  private bufferOutput(jobId: string, stepId: string, line: string): void {
    const key = this.stepKey(jobId, stepId);
    let buffer = this.outputBuffers.get(key);
    if (!buffer) {
      buffer = [];
      this.outputBuffers.set(key, buffer);
    }
    buffer.push(line);
    if (buffer.length > QUIET_BUFFER_LIMIT) {
      buffer.shift();
    }
  }

  private replayBuffer(jobId: string, stepId: string): void {
    const key = this.stepKey(jobId, stepId);
    const buffer = this.outputBuffers.get(key);
    if (!buffer || buffer.length === 0) return;
    const displayName = this.forEachDisplayNames.get(key) ?? jobId;
    if (this.pipe) {
      writeOutput(this.pipe.line(displayName, ""));
      writeOutput(
        this.pipe.line(displayName, dim(`─── output from ${stepId} ───`)),
      );
      for (const line of buffer) {
        writeOutput(this.pipe.line(displayName, line));
      }
      writeOutput(
        this.pipe.line(displayName, dim("─────────────────────────────────")),
      );
      writeOutput(this.pipe.line(displayName, ""));
    }
    this.outputBuffers.delete(key);
  }

  private discardBuffer(jobId: string, stepId: string): void {
    this.outputBuffers.delete(this.stepKey(jobId, stepId));
  }

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      validating_inputs: () => {},
      evaluating_workflow: () => {},
      started: (e) => {
        this.workflowName = e.workflowName;
        const jobNames = [...e.jobs.map((j) => j.id), "system"];
        this.pipe = new PipeWriter(jobNames);
        setSystemPipeWidth(this.pipe.maxWidth);
        const ts = formatTimestamp();
        const wfName = e.workflowName;
        this.pendingStartLine = () => {
          if (!this.pipe) return;
          writeOutput(
            this.pipe.statusLine(
              "system",
              "Starting",
              STATUS_COLORS.info,
              `workflow ${wfName}`,
              ts,
            ),
          );
          writeBlankLine();
        };
      },
      job_started: (e) => {
        if (!this.pipe) return;
        this.jobStartTimes.set(e.jobId, Date.now());
        this.pendingJobStarts.set(e.jobId, formatTimestamp());
      },
      job_completed: (e) => {
        if (!this.pipe) return;
        this.flushPendingJobStart(e.jobId);
        const ts = formatTimestamp();
        const name = this.getJobDisplayName(e.jobId);
        const startTime = this.jobStartTimes.get(e.jobId);
        const duration = startTime
          ? formatDuration(Date.now() - startTime)
          : "";
        if (e.status === "failed") {
          writeOutput(this.pipe.failedJobLine(name, ts));
        } else {
          writeOutput(this.pipe.completedLine(name, duration, ts));
        }
      },
      job_skipped: (e) => {
        if (!this.pipe) return;
        writeOutput(
          this.pipe.skippedLine(this.getJobDisplayName(e.jobId)),
        );
      },
      step_started: (e) => {
        if (!this.pipe) return;
        this.stepStartTimes.set(this.stepKey(e.jobId, e.stepId), Date.now());
        const displayName = this.getDisplayName(e.jobId, e.stepId, e);
        if (displayName !== e.jobId) {
          this.pipe.updateWidth([displayName]);
          setSystemPipeWidth(this.pipe.maxWidth);
        }
        this.flushPendingJobStart(e.jobId);
        this.startHeartbeat(e.jobId, e.stepId);
      },
      step_completed: (e) => {
        if (!this.pipe) return;
        const key = this.stepKey(e.jobId, e.stepId);
        if (this.assertStepIds.has(key)) return;
        this.clearHeartbeat(e.jobId, e.stepId);
        if (this.quiet) {
          this.discardBuffer(e.jobId, e.stepId);
        }
        const displayName = this.getDisplayName(e.jobId, e.stepId, e);
        const ts = formatTimestamp();
        const startTime = this.stepStartTimes.get(key);
        const duration = startTime
          ? formatDuration(Date.now() - startTime)
          : "";
        writeOutput(this.pipe.doneLine(displayName, e.stepId, duration, ts));
      },
      step_skipped: (e) => {
        if (!this.pipe) return;
        this.clearHeartbeat(e.jobId, e.stepId);
        const displayName = this.getDisplayName(e.jobId, e.stepId, e);
        writeOutput(this.pipe.skippedLine(displayName, e.reason));
      },
      step_queued: (e) => {
        if (!this.pipe) return;
        const displayName = this.forEachDisplayNames.get(
          this.stepKey(e.jobId, e.stepId),
        ) ?? e.jobId;
        writeOutput(
          this.pipe.line(
            displayName,
            dim(`queued, waiting for worker matching ${e.requirement}`),
          ),
        );
      },
      step_target_disconnected: (e) => {
        if (!this.pipe) return;
        const displayName = this.forEachDisplayNames.get(
          this.stepKey(e.jobId, e.stepId),
        ) ?? e.jobId;
        writeOutput(
          this.pipe.line(
            displayName,
            yellow(`warning`) +
              dim(
                `: target worker '${e.target}' is disconnected; ` +
                  `use workers.connected() to filter dispatchable workers`,
              ),
          ),
        );
      },
      step_failed: (e) => {
        if (!this.pipe) return;
        const key = this.stepKey(e.jobId, e.stepId);
        if (this.assertStepIds.has(key)) return;
        this.clearHeartbeat(e.jobId, e.stepId);
        if (this.quiet) {
          this.replayBuffer(e.jobId, e.stepId);
        }
        const displayName = this.getDisplayName(e.jobId, e.stepId, e);
        const ts = formatTimestamp();
        const startTime = this.stepStartTimes.get(key);
        const duration = startTime
          ? formatDuration(Date.now() - startTime)
          : "";
        writeOutput(
          this.pipe.failedStepLine(displayName, e.stepId, duration, ts),
        );
      },
      approval_requested: (e) => {
        if (!this.pipe) return;
        const name = this.getJobDisplayName(e.jobId);
        writeOutput(
          this.pipe.waitingLine(
            name,
            `approval required: "${e.prompt}"`,
          ),
        );
        writeBlankLine();
        writeOutput(
          this.pipe.line(
            name,
            `${
              yellow("To approve:")
            }  swamp workflow approve ${this.workflowName} ${e.stepId}`,
          ),
        );
        writeOutput(
          this.pipe.line(
            name,
            `${
              yellow("To reject:")
            }   swamp workflow reject ${this.workflowName} ${e.stepId}`,
          ),
        );
      },
      model_resolved: (e) => {
        if (!this.pipe) return;
        const displayName = this.forEachDisplayNames.get(
          this.stepKey(e.jobId, e.stepId),
        ) ?? e.jobId;
        writeOutput(
          this.pipe.stepLine(
            displayName,
            e.stepId,
            e.modelName,
            e.methodName,
            formatTimestamp(),
          ),
        );
      },
      env_var_warning: (e) => {
        if (!this.pipe) return;
        const displayName = this.forEachDisplayNames.get(
          this.stepKey(e.jobId, e.stepId),
        ) ?? e.jobId;
        writeOutput(
          this.pipe.statusLine(
            displayName,
            "warning",
            STATUS_COLORS.warn,
            "Environment variables detected in model definition",
          ),
        );
        for (const detail of e.envVars) {
          writeOutput(
            this.pipe.line(
              displayName,
              `  ${detail.path} uses ${detail.envVar}`,
            ),
          );
        }
        writeOutput(this.pipe.line(displayName, e.message));
      },
      method_executing: () => {},
      method_output: (e) => {
        if (!this.pipe) return;
        const displayName = this.forEachDisplayNames.get(
          this.stepKey(e.jobId, e.stepId),
        ) ?? e.jobId;
        this.resetHeartbeat(e.jobId, e.stepId);
        if (this.quiet) {
          this.bufferOutput(e.jobId, e.stepId, e.line);
        } else {
          writeOutput(this.pipe.line(displayName, e.line));
        }
      },
      method_event: (e) => {
        if (!this.pipe) return;
        const displayName = this.forEachDisplayNames.get(
          this.stepKey(e.jobId, e.stepId),
        ) ?? e.jobId;
        switch (e.event.type) {
          case "vault_secret_stored":
            writeOutput(
              this.pipe.line(
                displayName,
                dim(
                  `stored '${e.event.fieldPath}' in vault '${e.event.vaultName}'`,
                ),
              ),
            );
            break;
          case "schema_validation_warning":
            writeOutput(
              this.pipe.statusLine(
                displayName,
                "warning",
                STATUS_COLORS.warn,
                `Resource '${e.event.specName}' data does not match schema: ${e.event.error}`,
              ),
            );
            break;
          case "vault_single_quote_warning":
            writeOutput(
              this.pipe.statusLine(
                displayName,
                "warning",
                STATUS_COLORS.warn,
                e.event.message,
              ),
            );
            break;
        }
      },
      assert_result: (e) => {
        if (!this.pipe) return;
        const key = this.stepKey(e.jobId, e.stepId);
        this.assertStepIds.add(key);
        this.clearHeartbeat(e.jobId, e.stepId);
        this.assertResults.push({
          stepId: e.stepId,
          passed: e.passed,
          message: e.message,
          severity: e.severity,
          error: e.error,
        });
        const displayName = this.forEachDisplayNames.get(key) ?? e.jobId;
        const startTime = this.stepStartTimes.get(key);
        const duration = startTime
          ? formatDuration(Date.now() - startTime)
          : "";
        const ts = formatTimestamp();
        if (e.passed) {
          writeOutput(
            this.pipe.doneLine(
              displayName,
              `${green("✓")} ${e.stepId}`,
              duration,
              ts,
            ),
          );
        } else {
          writeOutput(
            this.pipe.failedStepLine(
              displayName,
              `${red("✗")} ${e.stepId}`,
              duration,
              ts,
            ),
          );
          writeOutput(
            this.pipe.line(displayName, `  ${e.message}`),
          );
        }
      },
      report_started: () => {},
      report_completed: (e) => {
        if (!this.pipe) return;
        if (e.reportName === "@swamp/method-summary") return;
        if (e.reportName === "@swamp/workflow-summary") return;
        writeBlankLine();
        writeOutput(
          this.pipe.statusLine(
            "system",
            "Report",
            STATUS_COLORS.info,
            e.reportName,
          ),
        );
        const separator = "─".repeat(60);
        writeOutput(
          `── Report: ${e.reportName} ${separator}\n${
            renderMarkdownToTerminal(e.markdown)
          }\n${separator}`,
        );
      },
      report_failed: (e) => {
        if (!this.pipe) return;
        writeOutput(
          this.pipe.statusLine(
            "system",
            "Warning",
            STATUS_COLORS.warn,
            `Report ${e.reportName} failed: ${e.error}`,
          ),
        );
      },
      completed: (e) => {
        this.clearAllHeartbeats();
        if (!this.pipe) return;

        // Render assert summary if any assert steps ran
        if (this.assertResults.length > 0) {
          const passed = this.assertResults.filter((r) => r.passed).length;
          const failed = this.assertResults.filter((r) => !r.passed && !r.error)
            .length;
          const errors = this.assertResults.filter((r) => !!r.error).length;
          const failedAboveThreshold = this.assertResults.filter(
            (r) =>
              !r.passed &&
              severityAtOrAbove(r.severity, this.failOnSeverity),
          ).length;

          writeBlankLine();
          const parts = [`${passed} passed`];
          if (failed > 0) parts.push(`${failed} failed`);
          if (errors > 0) parts.push(`${errors} errored`);
          writeOutput(
            this.pipe.line(
              "system",
              dim(`Assertions: ${parts.join(", ")}`),
            ),
          );

          if (failedAboveThreshold > 0) {
            this._failed = true;
          }
        }

        if (e.run.status === "failed") {
          this._failed = true;
          const stepError = extractFirstStepError(e.run);
          const duration = e.run.duration
            ? ` ${dim(`in ${formatDuration(e.run.duration)}`)}`
            : "";
          writeBlankLine();
          writeOutput(
            this.pipe.statusLine(
              "system",
              "Failed",
              STATUS_COLORS.error,
              `workflow ${this.workflowName}${duration}`,
              formatTimestamp(),
            ),
          );
          writeBlankLine();
          writeOutput(this.pipe.line("system", STATUS_COLORS.error(stepError)));
        } else if (this._failed) {
          const duration = e.run.duration
            ? ` ${dim(`in ${formatDuration(e.run.duration)}`)}`
            : "";
          writeBlankLine();
          writeOutput(
            this.pipe.statusLine(
              "system",
              "Failed",
              STATUS_COLORS.error,
              `workflow ${this.workflowName} — assertion failures at severity ≥ ${this.failOnSeverity}${duration}`,
              formatTimestamp(),
            ),
          );
        } else {
          const duration = e.run.duration
            ? ` ${dim(`in ${formatDuration(e.run.duration)}`)}`
            : "";
          writeBlankLine();
          writeOutput(
            this.pipe.statusLine(
              "system",
              "Completed",
              STATUS_COLORS.success,
              `workflow ${this.workflowName} succeeded${duration}`,
              formatTimestamp(),
            ),
          );
          this.renderDataArtifacts(e.run);
          if (!this.isAuthenticated) {
            writeBlankLine();
            writeOutput(dim(AUTH_NUDGE_MESSAGE));
          }
        }
      },
      cancelled: (e) => {
        this._failed = true;
        this.clearAllHeartbeats();
        if (!this.pipe) return;
        const reason = e.reason ? `: ${e.reason}` : "";
        writeBlankLine();
        writeOutput(
          this.pipe.statusLine(
            "system",
            "Cancelled",
            STATUS_COLORS.warn,
            `workflow ${this.workflowName}${reason}`,
            formatTimestamp(),
          ),
        );
      },
      suspended: (e) => {
        this.clearAllHeartbeats();
        if (!this.pipe) return;
        writeBlankLine();
        writeOutput(
          this.pipe.statusLine(
            "system",
            "Suspended",
            STATUS_COLORS.warn,
            `workflow ${this.workflowName} — awaiting approval on step ${e.stepId}`,
            formatTimestamp(),
          ),
        );
        writeBlankLine();
        writeOutput(
          this.pipe.line(
            "system",
            `${
              yellow("To approve:")
            }  swamp workflow approve ${this.workflowName} ${e.stepId}`,
          ),
        );
        writeOutput(
          this.pipe.line(
            "system",
            `${
              dim("After approval:")
            }  swamp workflow resume ${this.workflowName}`,
          ),
        );
      },
      error: (e) => {
        this.clearAllHeartbeats();
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }

  private renderDataArtifacts(run: WorkflowRunView): void {
    const artifacts: DataArtifact[] = [];
    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.dataArtifacts) {
          for (const artifact of step.dataArtifacts) {
            if (!isUserFacingArtifact(artifact)) continue;
            artifacts.push({
              name: artifact.name,
              attributes: artifact.attributes,
              source: job.name,
            });
          }
        }
      }
    }
    if (run.workflowDataArtifacts) {
      for (const artifact of run.workflowDataArtifacts) {
        if (!isUserFacingArtifact(artifact)) continue;
        artifacts.push({
          name: artifact.name,
          attributes: artifact.attributes,
        });
      }
    }
    const opts: DataBoxOptions = {};
    if (run.inputs && Object.keys(run.inputs).length > 0) {
      opts.globalArguments = run.inputs as Record<string, unknown>;
    }
    if (artifacts.length === 0 && !opts.globalArguments) return;
    const lines = renderDataBox(artifacts, opts);
    for (const line of lines) {
      writeOutput(`  ${line}`);
    }
  }
}

class JsonWorkflowRunRenderer implements WorkflowRunRenderer {
  private _failed = false;

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      validating_inputs: () => {},
      evaluating_workflow: () => {},
      started: () => {},
      job_started: () => {},
      job_completed: () => {},
      job_skipped: () => {},
      step_started: () => {},
      step_completed: () => {},
      step_skipped: (e) => {
        if (e.reason === "guarded") {
          console.log(JSON.stringify({
            step: e.stepId,
            job: e.jobId,
            status: "skipped",
            reason: "guarded",
          }));
        }
      },
      step_queued: () => {},
      step_target_disconnected: () => {},
      step_failed: () => {},
      approval_requested: () => {},
      model_resolved: () => {},
      env_var_warning: () => {},
      method_executing: () => {},
      method_output: () => {},
      method_event: (e) => {
        if (e.event.type === "vault_single_quote_warning") {
          console.log(JSON.stringify({
            warning: "vault_single_quote",
            modelName: e.modelName,
            message: e.event.message,
          }));
        }
      },
      assert_result: () => {},
      report_started: () => {},
      report_completed: () => {},
      report_failed: () => {},
      completed: (e) => {
        if (e.run.status === "failed") this._failed = true;
        console.log(JSON.stringify(e.run, null, 2));
      },
      cancelled: (e) => {
        this._failed = true;
        console.log(JSON.stringify(e.run, null, 2));
      },
      suspended: (e) => {
        console.log(JSON.stringify(
          {
            ...e.run,
            approvalRequired: {
              stepId: e.stepId,
              jobId: e.jobId,
              prompt: e.prompt,
              timeout: e.timeout,
            },
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }
}

export function createWorkflowRunRenderer(
  mode: OutputMode,
  opts: WorkflowRunRenderOpts,
): WorkflowRunRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowRunRenderer();
    case "log":
      return new ConsoleWorkflowRunRenderer(opts);
  }
}
