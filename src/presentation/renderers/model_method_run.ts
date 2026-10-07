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
import type { ModelMethodRunEvent } from "../../libswamp/models/run.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { unguardedConsole } from "../../domain/models/console_guard.ts";
import { formatReportFrame } from "../output/report_frame.ts";
import { getTerminalColumns } from "../output/terminal_size.ts";
import { dim } from "@std/fmt/colors";
import {
  type DataArtifact,
  type DataBoxOptions,
  formatDuration,
  formatTimestamp,
  renderDataBox,
  STATUS_COLORS,
  writeBlankLine,
  writeContentLine,
  writeGutterLine,
} from "../output/console_writer.ts";

export interface ModelMethodRunRenderOpts {
  modelName: string;
  methodName: string;
  quiet?: boolean;
  /** Also frame reports whose markdown is empty. */
  verbose?: boolean;
}

export interface ModelMethodRunRenderer extends Renderer<ModelMethodRunEvent> {
  runFailed(): boolean;
}

const QUIET_BUFFER_LIMIT = 500;

class ConsoleModelMethodRunRenderer implements ModelMethodRunRenderer {
  private modelName: string;
  private methodName: string;
  private quiet: boolean;
  private verbose: boolean;
  private _failed = false;
  private outputBuffer: string[] = [];

  constructor(opts: ModelMethodRunRenderOpts) {
    this.modelName = opts.modelName;
    this.methodName = opts.methodName;
    this.quiet = opts.quiet ?? false;
    this.verbose = opts.verbose ?? false;
  }

  handlers(): EventHandlers<ModelMethodRunEvent> {
    return {
      validating_inputs: () => {},
      resolving_model: () => {},
      auto_created: (e) => {
        writeGutterLine(
          "Created",
          STATUS_COLORS.info,
          `${e.definitionName} ${dim(`(${e.modelType})`)}`,
        );
        writeContentLine(dim(`at ${e.definitionPath}`));
      },
      global_args_updated: (e) => {
        writeGutterLine(
          "Updated",
          STATUS_COLORS.info,
          `global arguments on ${e.definitionName}`,
        );
      },
      model_resolved: (e) => {
        this.modelName = e.modelName;
        this.methodName = e.methodName;
        writeGutterLine(
          "Resolved",
          STATUS_COLORS.info,
          `${e.modelName} ${dim(`(${e.modelType})`)}`,
        );
      },
      env_var_warning: (e) => {
        writeGutterLine(
          "Warning",
          STATUS_COLORS.warn,
          "Environment variables detected in model definition",
        );
        for (const detail of e.envVars) {
          writeContentLine(`${detail.path} uses ${detail.envVar}`);
        }
        writeContentLine(e.message);
      },
      evaluating_expressions: () => {},
      executing: (e) => {
        writeGutterLine(
          "Executing",
          STATUS_COLORS.info,
          e.methodName,
          formatTimestamp(),
        );
      },
      method_output: (e) => {
        if (this.quiet) {
          this.outputBuffer.push(e.line);
          if (this.outputBuffer.length > QUIET_BUFFER_LIMIT) {
            this.outputBuffer.shift();
          }
        } else {
          writeContentLine(e.line);
        }
      },
      method_event: (e) => {
        switch (e.event.type) {
          case "vault_secret_stored":
            writeGutterLine(
              "Stored",
              STATUS_COLORS.dim,
              `'${e.event.fieldPath}' in vault '${e.event.vaultName}'`,
            );
            break;
          case "schema_validation_warning":
            writeGutterLine(
              "Warning",
              STATUS_COLORS.warn,
              `Resource '${e.event.specName}' (instance '${e.event.instanceName}') data does not match schema: ${e.event.error}`,
            );
            break;
          case "vault_single_quote_warning":
          case "sensitive_value_in_command_line":
            writeGutterLine("Warning", STATUS_COLORS.warn, e.event.message);
            break;
        }
      },
      data_artifact_saved: () => {},
      report_started: () => {},
      report_completed: (e) => {
        if (e.reportName === "@swamp/method-summary") return;
        const frame = formatReportFrame(
          e.reportName,
          e.markdown,
          getTerminalColumns(),
          { showEmpty: this.verbose },
        );
        if (frame === undefined) return;
        writeBlankLine();
        writeGutterLine("Report", STATUS_COLORS.info, e.reportName);
        writeOutput(frame);
      },
      report_failed: (e) => {
        writeGutterLine(
          "Warning",
          STATUS_COLORS.warn,
          `Report ${e.reportName} failed: ${e.error}`,
        );
      },
      completed: (e) => {
        if (e.run.status === "failed") {
          this._failed = true;
          this.replayBufferOnFailure();
          writeBlankLine();
          const duration = e.run.duration
            ? ` ${dim(`in ${formatDuration(e.run.duration)}`)}`
            : "";
          writeGutterLine(
            "Failed",
            STATUS_COLORS.error,
            `${e.run.methodName} on ${e.run.modelName}${duration}`,
            formatTimestamp(),
          );
          if (e.run.logFile) {
            writeBlankLine();
            writeContentLine(dim(`Full output: ${e.run.logFile}`));
          }
        } else {
          writeBlankLine();
          const duration = e.run.duration
            ? ` ${dim(`in ${formatDuration(e.run.duration)}`)}`
            : "";
          writeGutterLine(
            "Completed",
            STATUS_COLORS.success,
            `${e.run.methodName} on ${e.run.modelName} succeeded${duration}`,
            formatTimestamp(),
          );
          this.renderDataArtifacts(e.run.dataArtifacts, {
            globalArguments: e.run.globalArguments,
            methodArguments: e.run.methodArguments,
            modelName: e.run.modelName,
          });
        }
      },
      cancelled: (e) => {
        this._failed = true;
        const reason = e.reason ? `: ${e.reason}` : "";
        writeBlankLine();
        writeGutterLine(
          "Cancelled",
          STATUS_COLORS.warn,
          `${e.run.methodName} on ${e.run.modelName}${reason}`,
          formatTimestamp(),
        );
      },
      auto_gc_started: () => {},
      auto_gc_completed: (e) => {
        if (e.versionsDeleted > 0 || e.dataEntriesExpired > 0) {
          const parts: string[] = [];
          if (e.dataEntriesExpired > 0) {
            parts.push(`${e.dataEntriesExpired} expired`);
          }
          parts.push(`${e.versionsDeleted} version(s) removed`);
          parts.push(`${e.bytesReclaimed} bytes reclaimed`);
          writeGutterLine("Cleanup", STATUS_COLORS.dim, parts.join(", "));
        }
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }

  runFailed(): boolean {
    return this._failed;
  }

  private replayBufferOnFailure(): void {
    if (!this.quiet || this.outputBuffer.length === 0) return;
    writeBlankLine();
    writeContentLine(dim(`─── output ───`));
    for (const line of this.outputBuffer) {
      writeContentLine(line);
    }
    writeContentLine(dim(`───────────────`));
    this.outputBuffer = [];
  }

  private renderDataArtifacts(
    artifacts: Array<{ name: string; attributes?: Record<string, unknown> }>,
    options?: DataBoxOptions,
  ): void {
    const dataArtifacts: DataArtifact[] = artifacts
      .filter((a) => !a.name.startsWith("report-") && a.name !== "log")
      .map((a) => ({
        name: a.name,
        attributes: a.attributes,
      }));
    const lines = renderDataBox(dataArtifacts, options);
    for (const line of lines) {
      writeOutput(`  ${line}`);
    }
  }
}

class JsonModelMethodRunRenderer implements ModelMethodRunRenderer {
  private _failed = false;

  handlers(): EventHandlers<ModelMethodRunEvent> {
    return {
      validating_inputs: () => {},
      resolving_model: () => {},
      auto_created: (e) => {
        console.log(JSON.stringify({
          event: "definition_auto_created",
          modelType: e.modelType,
          definitionName: e.definitionName,
          definitionPath: e.definitionPath,
        }));
      },
      global_args_updated: (e) => {
        console.log(JSON.stringify({
          event: "global_args_updated",
          definitionName: e.definitionName,
        }));
      },
      model_resolved: () => {},
      env_var_warning: (e) => {
        console.log(JSON.stringify(
          {
            warning: "env_var_usage",
            modelName: e.modelName,
            envVars: e.envVars,
            message: e.message,
          },
          null,
          2,
        ));
      },
      evaluating_expressions: () => {},
      executing: () => {},
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
      data_artifact_saved: () => {},
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
      auto_gc_started: () => {},
      auto_gc_completed: () => {},
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }

  runFailed(): boolean {
    return this._failed;
  }
}

export function createModelMethodRunRenderer(
  mode: OutputMode,
  opts: ModelMethodRunRenderOpts,
): ModelMethodRunRenderer {
  switch (mode) {
    case "json":
      return new JsonModelMethodRunRenderer();
    case "log":
      return new ConsoleModelMethodRunRenderer(opts);
  }
}
