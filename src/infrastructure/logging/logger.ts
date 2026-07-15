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
  configure,
  getConsoleSink,
  getLogger,
  type LogLevel,
  type Sink,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { textFormatter, TIMESTAMP_FORMAT } from "./log_format.ts";
import { runFileSink } from "./run_file_sink.ts";
import { initLogs } from "../tracing/mod.ts";
import { createOtelLogRecordSink } from "./otel_log_sink.ts";

export { runFileSink } from "./run_file_sink.ts";

export interface LoggingOptions {
  prettyOutput?: boolean;
  showProperties?: boolean;
  logLevel?: LogLevel;
  jsonMode?: boolean;
  noColor?: boolean;
  /** Write all log output to stderr only (for dispatch runners where stdout carries RPC frames). */
  stderrOnly?: boolean;
}

const stderrEncoder = new TextEncoder();
const stderrFormatter = textFormatter();

function createStderrSink(): Sink {
  return (record) => {
    const text = stderrFormatter(record);
    Deno.stderr.writeSync(stderrEncoder.encode(text + "\n"));
  };
}

let isInitialized = false;

export async function initializeLogging(
  options: LoggingOptions,
): Promise<void> {
  // LogTape can only be configured once per process
  if (isInitialized) {
    return;
  }

  const logLevel: LogLevel = options.logLevel ?? "info";

  // The console (non-pretty) sink always renders plain text: it is used for
  // non-interactive contexts (piped, redirected, `--no-color`, non-TTY stdin),
  // where ANSI escape codes would pollute the output. Colored output is the
  // pretty sink's job, selected only when stdin is a TTY.
  const consoleSink: Sink = options.stderrOnly
    ? createStderrSink()
    : getConsoleSink({ formatter: textFormatter() });

  const sinks: Record<string, Sink | (Sink & Disposable)> = {
    console: consoleSink,
    runFile: runFileSink.sink,
  };

  const loggers: Array<{
    category: string[];
    lowestLevel: LogLevel;
    sinks: string[];
  }> = [];

  if (options.prettyOutput) {
    const useColors = !(options.noColor ?? false);
    const prettyFormat = getPrettyFormatter({
      timestamp: TIMESTAMP_FORMAT,
      timestampStyle: "dim",
      levelStyle: "dim",
      icons: false,
      categoryColor: "rgb(34,197,94)",
      categoryStyle: "bold",
      categoryTruncate: false,
      messageColor: null,
      messageStyle: null,
      align: true,
      wordWrap: true,
      colors: useColors,
      properties: options.showProperties ?? false,
      inspectOptions: { colors: useColors },
    });

    sinks["pretty"] = getConsoleSink({ formatter: prettyFormat });
  }

  // Initialize the OTel logs signal. When OTLP logs export is enabled (same
  // OTEL_EXPORTER_OTLP_* config as traces, opt out via OTEL_LOGS_EXPORTER=none),
  // this returns a LoggerProvider we bridge into LogTape via a sink. The sink
  // exports over the network only — never stdout/stderr — so it is orthogonal
  // to the CLI output mode. Zero cost when logs export is disabled.
  //
  // Guarded: a telemetry init failure (e.g. a dynamic import of the OTel SDK
  // rejecting) must never take down core logging — "telemetry must never
  // interfere with the CLI", as elsewhere in this codebase. On failure we simply
  // proceed without the otel sink.
  let otelProvider: Awaited<ReturnType<typeof initLogs>>;
  try {
    otelProvider = await initLogs();
  } catch {
    otelProvider = undefined;
  }
  const otelSinks: string[] = [];
  if (otelProvider) {
    sinks["otel"] = createOtelLogRecordSink(otelProvider);
    otelSinks.push("otel");
  }

  if (options.jsonMode) {
    // JSON mode: the renderError() function in
    // src/presentation/output/error_output.ts is the single emitter for
    // fatal output (it writes JSON to stderr and skips logger.fatal).
    // The root logger has no *console* sinks so nothing leaks to stdout via the
    // standard logging pipeline. Audit at swamp-club#235: only error_output.ts
    // calls logger.fatal in src/, both inside renderError itself.
    //
    // OTLP log export is orthogonal to output mode — it writes only to the
    // network. So when the otel sink is enabled, lower the root threshold to
    // the configured level and attach only the otel sink: all logs export,
    // while stdout stays clean. When it is disabled, keep the original
    // fatal/no-sink behavior byte-for-byte.
    loggers.push({
      category: [],
      lowestLevel: otelSinks.length > 0 ? logLevel : "fatal",
      sinks: [...otelSinks],
    });
  } else {
    loggers.push({
      category: [],
      lowestLevel: logLevel,
      sinks: [options.prettyOutput ? "pretty" : "console", ...otelSinks],
    });
  }

  // In JSON mode, sever sink inheritance from the root logger on the
  // category loggers — otherwise a child logger emitting an info record
  // would also emit through the root's `jsonError` sink, polluting
  // stderr with malformed JSON. `parentSinks: 'override'` is the
  // documented LogTape API for this (since 0.6.0). Also clear the
  // logtape.meta logger's own sinks in JSON mode so its warnings
  // don't reach the console at all.
  const jsonMode = options.jsonMode ?? false;
  await configure({
    sinks,
    loggers: [
      ...loggers,
      {
        category: ["model", "method", "run"],
        lowestLevel: logLevel,
        // In JSON mode these loggers override parent sinks, so the otel sink
        // must be listed here explicitly or per-run logs would never reach it.
        // In non-JSON mode they inherit the root's otel sink, so adding it here
        // too would double-export — hence the jsonMode guard.
        sinks: jsonMode ? ["runFile", ...otelSinks] : ["runFile"],
        parentSinks: jsonMode ? "override" : "inherit",
      },
      {
        category: ["workflow", "run"],
        lowestLevel: logLevel,
        sinks: jsonMode ? ["runFile", ...otelSinks] : ["runFile"],
        parentSinks: jsonMode ? "override" : "inherit",
      },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: jsonMode ? [] : ["console"],
        parentSinks: jsonMode ? "override" : "inherit",
      },
    ],
  });

  isInitialized = true;
}

export function getSwampLogger(category: string[]) {
  return getLogger(category);
}

/**
 * Writes plain text to stdout with no decoration (no timestamp, level,
 * or category prefix). Use for human-readable CLI "log" mode output
 * that should read like a document rather than a log stream.
 */
export function writeOutput(message: string): void {
  // deno-lint-ignore no-console
  console.log(message);
}

export function getRunLogger(modelName: string, methodName: string) {
  return getLogger([
    "model",
    "method",
    "run",
    modelName,
    methodName,
  ]);
}

export function getWorkflowRunLogger(
  workflowName: string,
  jobName?: string,
  stepName?: string,
) {
  const category: string[] = ["workflow", "run", workflowName];
  if (jobName) category.push(jobName);
  if (stepName) category.push(stepName);
  return getLogger(category);
}
