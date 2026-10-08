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

import type { EventHandlers } from "../../libswamp/stream.ts";
import {
  extractFirstStepError,
  type WorkflowRunView,
} from "../../libswamp/workflows/workflow_run_view.ts";
import type {
  NestedSignalWaitData,
  WorkflowRunEvent,
} from "../../libswamp/workflows/run.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import {
  setSystemPipeWidth,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";
import { containsExpression } from "../../domain/expressions/expression_parser.ts";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import { unguardedConsole } from "../../domain/models/console_guard.ts";
import { formatReportFrame } from "../output/report_frame.ts";
import { getTerminalColumns } from "../output/terminal_size.ts";
import { dim, green, red, yellow } from "@std/fmt/colors";
import type { AssertSeverity } from "../../domain/workflows/step_task.ts";
import { severityAtOrAbove } from "../../domain/workflows/assert_severity.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
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
import { platformCertStoreHint } from "../output/error_output.ts";

export interface WorkflowRunRenderOpts {
  workflowName: string;
  quiet?: boolean;
  /** Also frame reports whose markdown is empty. */
  verbose?: boolean;
  failOnSeverity?: AssertSeverity;
  /**
   * Appended to every follow-up command the renderer prints, so it targets
   * the same server or repository (for example " --server ws://host:9000").
   */
  commandTarget?: string;
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
  private quiet: boolean;
  private verbose: boolean;
  private failOnSeverity: AssertSeverity;
  private commandTarget: string;
  // Runs, nested ones included, whose wait for a signal was shown.
  private readonly runsWaitingForSignal = new Set<string>();
  // The waits shown, so a suspension does not print one a second time.
  private readonly waitsShown = new Set<string>();
  // Whether any gate was shown in this stream. A remote stream carries
  // gates, and a nested run's signal wait only in the suspended event.
  private gateShown = false;
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
  private pendingSupersededRuns: (() => void) | null = null;
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
    this.quiet = opts.quiet ?? false;
    this.verbose = opts.verbose ?? false;
    this.failOnSeverity = opts.failOnSeverity ?? "low";
    this.commandTarget = opts.commandTarget ?? "";
  }

  private getDisplayName(jobId: string, stepId: string, event?: {
    forEachTemplate?: string;
    forEachIndex?: number;
  }): string {
    if (
      event?.forEachTemplate !== undefined && event?.forEachIndex !== undefined
    ) {
      // A templated name (`deploy-${{ self.env }}`) reads as the raw
      // expression; its expanded step name is the label a reader can match.
      const display = containsExpression(event.forEachTemplate)
        ? stepId
        : `${event.forEachTemplate}[${event.forEachIndex}]`;
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
      superseded_runs: (e) => {
        const emitSuperseded = () => {
          if (!this.pipe) return;
          for (const runId of e.cancelledRunIds) {
            writeOutput(
              this.pipe.statusLine(
                "system",
                "Superseded",
                STATUS_COLORS.warn,
                `cancelled suspended run ${runId} (matching inputs)`,
                formatTimestamp(),
              ),
            );
          }
          for (const skipped of e.skippedRuns ?? []) {
            writeOutput(
              this.pipe.statusLine(
                "system",
                "Kept",
                STATUS_COLORS.warn,
                `suspended run ${skipped.runId} (matching inputs) still waits for a signal${
                  skipped.waitIds.length > 0
                    ? `: ${skipped.waitIds.join(", ")}`
                    : ""
                }`,
                formatTimestamp(),
              ),
            );
          }
          for (const detached of e.detachedNestedRuns ?? []) {
            writeOutput(
              this.pipe.statusLine(
                "system",
                "Detached",
                STATUS_COLORS.warn,
                `nested run ${detached.runId} of workflow ${detached.workflowName} left unfinished — cancel it with ${detached.cancelCommand}`,
                formatTimestamp(),
              ),
            );
          }
        };
        if (this.pipe) {
          emitSuperseded();
        } else {
          this.pendingSupersededRuns = emitSuperseded;
        }
      },
      evaluating_workflow: () => {},
      started: (e) => {
        if (!this.pipe) {
          this.workflowName = e.workflowName;
        }
        const jobNames = [...e.jobs.map((j) => j.id), "system"];
        this.pipe = new PipeWriter(jobNames);
        setSystemPipeWidth(this.pipe.maxWidth);
        if (this.pendingSupersededRuns) {
          this.pendingSupersededRuns();
          this.pendingSupersededRuns = null;
        }
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
        writeOutput(
          this.pipe.skippedStepLine(
            displayName,
            e.stepId,
            e.reason,
            e.guardExpression,
          ),
        );
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
        this.gateShown = true;
        if (!this.pipe) return;
        const name = this.getJobDisplayName(e.jobId);
        // A nested workflow's gate is decided on the nested run, under its
        // own workflow (swamp-club#2736).
        const gateWorkflow = e.workflowName ?? this.workflowName;
        writeOutput(
          this.pipe.waitingLine(
            name,
            gateWorkflow === this.workflowName
              ? `approval required: "${e.prompt}"`
              : `approval required in nested workflow ${
                escapeControlCharacters(gateWorkflow)
              }: "${e.prompt}"`,
          ),
        );
        writeBlankLine();
        writeOutput(
          this.pipe.line(
            name,
            `${yellow("To approve:")}  swamp workflow approve ${
              quoteShellWord(gateWorkflow)
            } ${
              quoteShellWord(e.stepId)
            } --run ${e.runId}${this.commandTarget}`,
          ),
        );
        writeOutput(
          this.pipe.line(
            name,
            `${yellow("To reject:")}   swamp workflow reject ${
              quoteShellWord(gateWorkflow)
            } ${
              quoteShellWord(e.stepId)
            } --run ${e.runId}${this.commandTarget}`,
          ),
        );
      },
      signal_wait_requested: (e) => {
        this.runsWaitingForSignal.add(e.runId);
        this.waitsShown.add(e.waitId);
        if (!this.pipe) return;
        const name = this.getJobDisplayName(e.jobId);
        const waitWorkflow = e.workflowName ?? this.workflowName;
        writeOutput(
          this.pipe.waitingLine(
            name,
            waitWorkflow === this.workflowName
              ? `signal required on step ${e.stepId} until ${e.deadline}`
              : `signal required on step ${e.stepId} in nested workflow ${waitWorkflow} until ${e.deadline}`,
          ),
        );
        writeBlankLine();
        writeOutput(
          this.pipe.line(
            name,
            `${
              yellow("To signal:")
            }  swamp workflow signal ${e.waitId} --payload '<json>'${this.commandTarget}`,
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
          case "sensitive_value_in_command_line":
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
        const frame = formatReportFrame(
          e.reportName,
          e.markdown,
          getTerminalColumns(),
          { showEmpty: this.verbose },
        );
        if (frame === undefined) return;
        writeBlankLine();
        writeOutput(
          this.pipe.statusLine(
            "system",
            "Report",
            STATUS_COLORS.info,
            e.reportName,
          ),
        );
        writeOutput(frame);
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
          // This renderer prints the run's error itself instead of throwing
          // it to renderError, so it carries the cert-store hint too.
          const certStoreHint = platformCertStoreHint(stepError);
          if (certStoreHint) {
            writeBlankLine();
            writeOutput(this.pipe.line("system", yellow("Hint:")));
            for (const line of certStoreHint.split("\n")) {
              writeOutput(this.pipe.line("system", dim(line)));
            }
          }
          writeBlankLine();
          for (const line of this.nextActionForFailedRun(e.run)) {
            writeOutput(this.pipe.line("system", line));
          }
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
        if (e.nested) {
          // Waiting on a nested run: its gate was shown when it was
          // requested, under the nested workflow (swamp-club#2736).
          writeOutput(
            this.pipe.statusLine(
              "system",
              "Suspended",
              STATUS_COLORS.warn,
              `workflow ${this.workflowName} — step ${e.stepId} waits on nested workflow ${e.nested.workflowName} run ${e.nested.runId}`,
              formatTimestamp(),
            ),
          );
          writeBlankLine();
          const deeperWait = this.writeNestedSignalWaits(
            e.nestedSignalWaits,
            e.nested.runId,
          );
          writeOutput(
            this.pipe.line(
              "system",
              `${yellow("Nested run:")}  ${
                this.runsWaitingForSignal.has(e.nested.runId)
                  ? "signal its wait as shown above, then"
                  // The wait is further down: the run that holds it is
                  // resumed first, as shown with its signal command.
                  : deeperWait && !this.gateShown
                  ? "once the run it waits on finishes,"
                  : this.gateShown
                  ? "approve its gate as shown above, then"
                  // Nothing was shown: a server that predates
                  // nestedSignalWaits, or a nested run that neither waits
                  // for a signal nor has a gate requested in this stream.
                  : "approve its gate or signal its wait, then"
              }  swamp workflow resume ${e.nested.workflowName} --run ${e.nested.runId}${this.commandTarget}`,
            ),
          );
          writeOutput(
            this.pipe.line(
              "system",
              `${
                dim("Once it finishes:")
              }  swamp workflow resume ${this.workflowName} --run ${e.run.id}${this.commandTarget}`,
            ),
          );
          return;
        }
        if (waitsOnNestedRun(e)) {
          // The step waits on a nested run this caller is not shown: there
          // is no gate of this run to approve. A wait further down that the
          // caller may read is still named (swamp-club#3110).
          writeOutput(
            this.pipe.statusLine(
              "system",
              "Suspended",
              STATUS_COLORS.warn,
              `workflow ${escapeControlCharacters(this.workflowName)} — step ${
                escapeControlCharacters(e.stepId)
              } waits on a nested run`,
              formatTimestamp(),
            ),
          );
          writeBlankLine();
          this.writeNestedSignalWaits(e.nestedSignalWaits, undefined);
          writeOutput(
            this.pipe.line(
              "system",
              `${dim("Once it finishes:")}  swamp workflow resume ${
                quoteShellWord(this.workflowName)
              } --run ${e.run.id}${this.commandTarget}`,
            ),
          );
          return;
        }
        if (e.wait) {
          writeOutput(
            this.pipe.statusLine(
              "system",
              "Suspended",
              STATUS_COLORS.warn,
              `workflow ${this.workflowName} — step ${e.stepId} waits for signal ${e.wait.id}`,
              formatTimestamp(),
            ),
          );
          writeBlankLine();
          writeOutput(
            this.pipe.line(
              "system",
              `${
                yellow("To signal:")
              }  swamp workflow signal ${e.wait.id} --payload '<json>'${this.commandTarget}`,
            ),
          );
          writeOutput(
            this.pipe.line(
              "system",
              `${dim("After the signal:")}  swamp workflow resume ${
                quoteShellWord(this.workflowName)
              } --run ${e.run.id}${this.commandTarget}`,
            ),
          );
          this.writeNestedSignalWaits(e.nestedSignalWaits);
          return;
        }
        writeOutput(
          this.pipe.statusLine(
            "system",
            "Suspended",
            STATUS_COLORS.warn,
            `workflow ${
              escapeControlCharacters(this.workflowName)
            } — awaiting approval on step ${escapeControlCharacters(e.stepId)}`,
            formatTimestamp(),
          ),
        );
        writeBlankLine();
        writeOutput(
          this.pipe.line(
            "system",
            `${yellow("To approve:")}  swamp workflow approve ${
              quoteShellWord(this.workflowName)
            } ${
              quoteShellWord(e.stepId)
            } --run ${e.run.id}${this.commandTarget}`,
          ),
        );
        writeOutput(
          this.pipe.line(
            "system",
            `${dim("After approval:")}  swamp workflow resume ${
              quoteShellWord(this.workflowName)
            } --run ${e.run.id}${this.commandTarget}`,
          ),
        );
        this.writeNestedSignalWaits(e.nestedSignalWaits);
      },
      error: (e) => {
        this.clearAllHeartbeats();
        throw userErrorFromSwampError(e.error);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }

  /**
   * Shows the open waits of nested runs that a suspension names and this
   * stream has not shown: every one of them for a run on a server, which is
   * not sent a wait as it is requested, and for a resume that found a nested
   * run still waiting (swamp-club#3110). A wait held further down than
   * `directRunId`, the run the suspended step waits on, also gets the resume
   * of the run that holds it, which has to come before any run above it.
   * Returns whether such a wait was named.
   */
  private writeNestedSignalWaits(
    waits: readonly NestedSignalWaitData[] | undefined,
    directRunId?: string,
  ): boolean {
    if (!this.pipe) return false;
    let deeper = false;
    for (const wait of waits ?? []) {
      this.runsWaitingForSignal.add(wait.runId);
      const further = wait.runId !== directRunId;
      deeper ||= further;
      const shown = this.waitsShown.has(wait.waitId);
      if (shown && !further) continue;
      if (!shown) {
        this.waitsShown.add(wait.waitId);
        writeOutput(
          this.pipe.waitingLine(
            "system",
            `signal required on step ${
              escapeControlCharacters(wait.stepId)
            } in nested workflow ${
              escapeControlCharacters(wait.workflowName)
            } until ${escapeControlCharacters(wait.deadline)}`,
          ),
        );
        writeOutput(
          this.pipe.line(
            "system",
            `${yellow("To signal:")}  swamp workflow signal ${
              quoteShellWord(wait.waitId)
            } --payload '<json>'${this.commandTarget}`,
          ),
        );
      }
      if (further) {
        writeOutput(
          this.pipe.line(
            "system",
            `${dim("After the signal:")}  swamp workflow resume ${
              quoteShellWord(wait.workflowName)
            } --run ${quoteShellWord(wait.runId)}${this.commandTarget}`,
          ),
        );
      }
      writeBlankLine();
    }
    return deeper;
  }

  /**
   * The command to run after a failed run: retry its failed steps, or, when
   * no failed step is recorded, read its logs. A step stranded by a workflow
   * change would fail a retry again, so that run points to a new run.
   */
  private nextActionForFailedRun(run: WorkflowRunView): string[] {
    const failedSteps = run.jobs.flatMap((job) =>
      job.steps.filter((step) =>
        step.status === "failed" && !step.allowedFailure
      )
    );
    if (failedSteps.some((step) => step.failureKind === "workflow_changed")) {
      const lines: string[] = [];
      // The error printed above is the first failed step's; say why a new
      // run is needed when that was a real failure.
      const first = failedSteps.find((step) => step.error);
      if (first?.failureKind !== "workflow_changed") {
        lines.push(
          dim(
            "A step did not run because the workflow or a forEach collection changed since the run.",
          ),
        );
      }
      lines.push(
        `${
          yellow("To start a new run:")
        }  swamp workflow run ${this.workflowName}${this.commandTarget}`,
      );
      // A new run does not reuse the stored inputs the way a retry does, and
      // only the JSON history shows them.
      if (run.inputs && Object.keys(run.inputs).length > 0) {
        lines.push(
          `${
            dim("Run inputs:")
          }          swamp workflow history get ${run.id} --json${this.commandTarget}`,
        );
      }
      return lines;
    }
    return [
      failedSteps.length > 0
        ? `${
          yellow("To retry failed steps:")
        }  swamp workflow resume ${this.workflowName} --run ${run.id}${this.commandTarget}`
        : `${
          yellow("To inspect the run:")
        }  swamp workflow history logs ${run.id}${this.commandTarget}`,
    ];
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

/**
 * Whether a suspension names a step that waits on a nested run and not a
 * gate of the run's own, with no `nested` to say so: the nested run is not
 * shown to this caller, or its link could not be read. A gate's prompt is
 * never empty, and a step waiting for a signal on a wait that cannot be
 * read shows as `waiting`, which a nested workflow step never does.
 */
function waitsOnNestedRun(
  e: Extract<WorkflowRunEvent, { kind: "suspended" }>,
): boolean {
  if (e.nested !== undefined || e.wait !== undefined || e.prompt !== "") {
    return false;
  }
  const step = e.run.jobs.find((job) => job.name === e.jobId)?.steps
    .find((s) => s.name === e.stepId);
  return step?.status !== "waiting";
}

/** A signal wait as the run's stream requested it. */
interface RequestedWait {
  runId: string;
  workflowName?: string;
  jobId: string;
  stepId: string;
  waitId: string;
  deadline: string;
}

/** An approval gate as the run's stream requested it. */
interface RequestedGate {
  runId: string;
  workflowName?: string;
  jobId: string;
  stepId: string;
  prompt: string;
  timeout?: number;
}

class JsonWorkflowRunRenderer implements WorkflowRunRenderer {
  private _failed = false;
  // Gates requested in this stream, nested runs' included, so a run that
  // suspends on a nested run can name the gate to decide (swamp-club#2736).
  private readonly _gates: RequestedGate[] = [];
  // Signal waits requested in this stream, nested runs' included.
  private readonly _waits: RequestedWait[] = [];

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      validating_inputs: () => {},
      superseded_runs: (e) => {
        unguardedConsole.error(JSON.stringify({
          event: "superseded_runs",
          cancelledRunIds: e.cancelledRunIds,
          ...(e.detachedNestedRuns
            ? { detachedNestedRuns: e.detachedNestedRuns }
            : {}),
          ...(e.skippedRuns ? { skippedRuns: e.skippedRuns } : {}),
        }));
      },
      evaluating_workflow: () => {},
      started: () => {},
      job_started: () => {},
      job_completed: () => {},
      job_skipped: () => {},
      step_started: () => {},
      step_completed: () => {},
      step_skipped: (e) => {
        if (e.reason === "guarded") {
          unguardedConsole.error(JSON.stringify({
            step: e.stepId,
            job: e.jobId,
            status: "skipped",
            reason: "guarded",
            ...(e.guardExpression !== undefined && {
              guardExpression: e.guardExpression,
            }),
            ...(e.guardResult !== undefined && {
              guardResult: e.guardResult,
            }),
          }));
        }
      },
      step_queued: () => {},
      step_target_disconnected: () => {},
      step_failed: () => {},
      approval_requested: (e) => {
        this._gates.push({
          runId: e.runId,
          workflowName: e.workflowName,
          jobId: e.jobId,
          stepId: e.stepId,
          prompt: e.prompt,
          timeout: e.timeout,
        });
      },
      signal_wait_requested: (e) => {
        this._waits.push({
          runId: e.runId,
          workflowName: e.workflowName,
          jobId: e.jobId,
          stepId: e.stepId,
          waitId: e.waitId,
          deadline: e.deadline,
        });
      },
      model_resolved: () => {},
      env_var_warning: () => {},
      method_executing: () => {},
      method_output: () => {},
      method_event: (e) => {
        if (e.event.type === "vault_single_quote_warning") {
          unguardedConsole.error(JSON.stringify({
            warning: "vault_single_quote",
            modelName: e.modelName,
            message: e.event.message,
          }));
        } else if (e.event.type === "sensitive_value_in_command_line") {
          unguardedConsole.error(JSON.stringify({
            warning: "sensitive_value_in_command_line",
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
        unguardedConsole.log(JSON.stringify(e.run, null, 2));
      },
      cancelled: (e) => {
        this._failed = true;
        unguardedConsole.log(JSON.stringify(e.run, null, 2));
      },
      suspended: (e) => {
        // On a nested wait, the gate to decide is the nested run's: the one
        // requested by the run the step waits on, or else the latest gate
        // requested deeper down. Without one in this stream (a resume that
        // found the nested run suspended again), the waiting step is named.
        const nested = e.nested;
        // What the nested run itself requested comes first, gate or wait,
        // so a sibling run's earlier gate is never named in its place.
        const ownGate = nested
          ? this._gates.findLast((g) => g.runId === nested.runId)
          : undefined;
        // A run on a server is not sent a nested wait as it is requested:
        // the suspension names it instead (swamp-club#3110). A wait is named
        // only for a nested run with no gate to decide first, so a named
        // wait comes before a gate another run requested earlier.
        const namedWaits = e.nestedSignalWaits ?? [];
        // A step can wait on a nested run this caller is not shown, which
        // leaves no `nested`: a wait further down is then all there is.
        const hiddenNested = waitsOnNestedRun(e);
        const ownWait = nested && !ownGate
          ? this._waits.findLast((w) => w.runId === nested.runId) ??
            namedWaits.find((w) => w.runId === nested.runId) ?? namedWaits[0]
          : hiddenNested
          ? namedWaits[0]
          : undefined;
        const gate = nested && !ownWait
          ? ownGate ?? this._gates.findLast((g) => g.runId !== e.run.id)
          : undefined;
        // A run suspended on a signal wait, its own or a nested run's, names
        // the wait to signal in place of a gate to approve.
        const requestedWait = (nested || hiddenNested) && !gate
          ? ownWait ?? this._waits.findLast((w) => w.runId !== e.run.id)
          : undefined;
        const signalRequired = e.wait
          ? {
            workflowName: e.run.workflowName,
            runId: e.run.id,
            stepId: e.stepId,
            jobId: e.jobId,
            waitId: e.wait.id,
            deadline: e.wait.deadline,
          }
          : requestedWait
          ? {
            workflowName: requestedWait.workflowName ?? nested?.workflowName,
            runId: requestedWait.runId,
            stepId: requestedWait.stepId,
            jobId: requestedWait.jobId,
            waitId: requestedWait.waitId,
            deadline: requestedWait.deadline,
          }
          : undefined;
        // Every step of this run still waiting for a signal, so a run with
        // several waits, or a wait beside a gate, names them all.
        const signalWaits = e.run.jobs.flatMap((job) =>
          job.steps.flatMap((step) =>
            step.status === "waiting" && step.wait
              ? [{
                stepId: step.name,
                jobId: job.name,
                waitId: step.wait.id,
                deadline: step.wait.deadline,
              }]
              : []
          )
        );
        const waitsField = {
          ...(signalWaits.length > 0 ? { signalWaits } : {}),
          ...(namedWaits.length > 0 ? { nestedSignalWaits: namedWaits } : {}),
        };
        if (signalRequired) {
          unguardedConsole.log(JSON.stringify(
            {
              ...e.run,
              signalRequired,
              ...waitsField,
              ...(e.nested ? { waitingOnNestedRun: e.nested } : {}),
            },
            null,
            2,
          ));
          return;
        }
        unguardedConsole.log(JSON.stringify(
          {
            ...e.run,
            approvalRequired: gate
              ? {
                workflowName: gate.workflowName ?? nested?.workflowName,
                runId: gate.runId,
                stepId: gate.stepId,
                jobId: gate.jobId,
                prompt: gate.prompt,
                timeout: gate.timeout,
              }
              : {
                workflowName: e.run.workflowName,
                runId: e.run.id,
                stepId: e.stepId,
                jobId: e.jobId,
                prompt: e.prompt,
                timeout: e.timeout,
              },
            // The nested run the step waits on, when the run suspended on a
            // nested workflow rather than a gate of its own.
            ...waitsField,
            ...(e.nested ? { waitingOnNestedRun: e.nested } : {}),
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
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
