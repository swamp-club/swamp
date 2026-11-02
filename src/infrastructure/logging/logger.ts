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
  type LogRecord,
  type Sink,
  type TextFormatter,
} from "@logtape/logtape";
import {
  interactiveFormatter,
  serveTextFormatter,
  textFormatter,
} from "./log_format.ts";
import { RUN_ID_PROPERTY, runFileSink } from "./run_file_sink.ts";
import { initLogs, type InitLogsConfig } from "../tracing/mod.ts";
import { createOtelLogRecordSink } from "./otel_log_sink.ts";

export { RUN_ID_PROPERTY, runFileSink } from "./run_file_sink.ts";

export interface LoggingOptions {
  prettyOutput?: boolean;
  showProperties?: boolean;
  logLevel?: LogLevel;
  jsonMode?: boolean;
  noColor?: boolean;
  forceLog?: boolean;
  quiet?: boolean;
  /**
   * for callers whose stdout carries something other than prose, such as RPC
   * frames or a value piped by the commands in stdout_contract.ts; covers the
   * pretty sink too
   */
  stderrOnly?: boolean;
  _reset?: boolean;
  /** Test-only: bypass Deno.env for OTel logs config to avoid env var races under --parallel. */
  _logsConfig?: InitLogsConfig;
}

const stderrEncoder = new TextEncoder();
const stderrFormatter = textFormatter();

function writeStderr(text: string): void {
  Deno.stderr.writeSync(stderrEncoder.encode(text));
}

/**
 * lines pass through runFileSink.redactActive so a dispatch's secrets are
 * masked in method log lines and failure warnings; the formatter owns the
 * trailing newline, so write as given
 */
export function createStderrSink(
  formatter: TextFormatter = stderrFormatter,
  write: (text: string) => void = writeStderr,
): Sink {
  return (record) => {
    if (!runFileSink.hasActiveSecrets) {
      write(formatter(record));
      return;
    }
    // mask complete rendered values before layout can wrap or abbreviate a
    // secret; the message becomes a literal so the formatter only lays out
    // scrubbed text; other sinks get the original record
    const redactString = (value: unknown) =>
      typeof value === "string" ? runFileSink.redactActive(value) : value;
    const render = (value: unknown) =>
      runFileSink.redactActive(Deno.inspect(redactString(value), {
        colors: false,
        strAbbreviateSize: Infinity,
        breakLength: Infinity,
        iterableLimit: Infinity,
      }));
    const message = record.message.map((value, index) =>
      index % 2 === 0 ? String(value) : render(value)
    ).join("");
    const redacted = {
      ...record,
      message: [runFileSink.redactActive(message)],
      properties: Object.fromEntries(
        Object.entries(record.properties).map(([key, value]) => [
          key,
          value !== null && typeof value === "object"
            ? render(value)
            : redactString(value),
        ]),
      ),
    };
    write(runFileSink.redactActive(formatter(redacted)));
  };
}

let isInitialized = false;
let systemPipeWidth = 6;
// Set once a workflow run's pipe display is on screen, so log records line
// up with it as `system │` lines instead of gutter lines.
let pipeOutputActive = false;

const STARTUP_BUFFER_CAP = 200;
let startupBuffer: LogRecord[] | undefined;

/**
 * captures warning-level records emitted before initializeLogging, which
 * replays them through the real loggers so level and JSON-mode filtering apply;
 * info and debug stay dropped
 */
export async function bufferStartupWarnings(
  options: { _reset?: boolean } = {},
): Promise<void> {
  if (options._reset) {
    isInitialized = false;
    startupBuffer = undefined;
  }
  if (isInitialized || startupBuffer) return;
  const buffer: LogRecord[] = [];
  const sink: Sink = (record) => {
    if (buffer.length < STARTUP_BUFFER_CAP) buffer.push(record);
  };
  await configure({
    sinks: { startupBuffer: sink },
    loggers: [
      { category: [], lowestLevel: "warning", sinks: ["startupBuffer"] },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: [],
        parentSinks: "override",
      },
    ],
    reset: true,
  });
  startupBuffer = buffer;
}
let serveFormatEnabled = false;

export function setSystemPipeWidth(width: number): void {
  systemPipeWidth = Math.max(width, 6);
  pipeOutputActive = true;
}

export function endSystemPipeOutput(): void {
  pipeOutputActive = false;
}

export function getSystemPipeWidth(): number {
  return systemPipeWidth;
}

export function enableServeOutput(): void {
  serveFormatEnabled = true;
}

function createDynamicFormatter(
  normalFmt: TextFormatter,
): TextFormatter {
  const serveFmt = serveTextFormatter(() => systemPipeWidth);
  return (record) => serveFormatEnabled ? serveFmt(record) : normalFmt(record);
}

export async function initializeLogging(
  options: LoggingOptions,
): Promise<void> {
  if (options._reset) {
    isInitialized = false;
    pipeOutputActive = false;
  }
  if (isInitialized) {
    return;
  }
  const buffered = startupBuffer;
  startupBuffer = undefined;

  const logLevel: LogLevel = options.logLevel ?? "info";

  // the console sink always renders plain text since ANSI would pollute
  // non-interactive output; stderrOnly must reach every console-bound sink, the
  // pretty one included
  const consoleSink: Sink = options.stderrOnly
    ? createStderrSink()
    : getConsoleSink({
      formatter: createDynamicFormatter(textFormatter()),
    });

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
    // Terminal output reads like the run renderers' output, not a log
    // stream: a status gutter, or `system │` lines during a workflow run.
    // The category is shown only when debug records are, where it helps
    // say which component is talking.
    const prettyFormat = interactiveFormatter({
      showCategory: logLevel === "debug" || logLevel === "trace",
      showProperties: options.showProperties ?? false,
      getPipeWidth: () => pipeOutputActive ? systemPipeWidth : undefined,
    });

    // honour stderrOnly here too: prettyOutput keys on stdin being a TTY, so
    // piping stdout from a terminal still uses this sink, not the console sink
    const prettyFormatter = createDynamicFormatter(prettyFormat);
    sinks["pretty"] = options.stderrOnly
      ? createStderrSink(prettyFormatter)
      : getConsoleSink({ formatter: prettyFormatter });
  }

  // OTLP log export goes over the network only, orthogonal to output mode; a
  // telemetry init failure must never take down core logging, so proceed
  // without the otel sink
  let otelProvider: Awaited<ReturnType<typeof initLogs>>;
  try {
    otelProvider = await initLogs(options._logsConfig);
  } catch {
    otelProvider = undefined;
  }
  const otelSinks: string[] = [];
  if (otelProvider) {
    sinks["otel"] = createOtelLogRecordSink(otelProvider);
    otelSinks.push("otel");
  }

  if (options.jsonMode) {
    // in JSON mode renderError is the single fatal emitter, so the root has no
    // console sinks; with the otel sink on, lower the threshold and attach only
    // it so logs export while stdout stays clean
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

  // in JSON mode sever sink inheritance so child records skip the root's
  // jsonError sink and don't pollute stderr; clear the logtape.meta sinks too
  const jsonMode = options.jsonMode ?? false;
  const forceLog = options.forceLog ?? false;
  const quiet = options.quiet ?? false;
  const runParentSinks = forceLog && !quiet ? "inherit" : "override";
  const runLogLevel: LogLevel = quiet ? "info" : logLevel;
  await configure({
    sinks,
    loggers: [
      ...loggers,
      {
        category: ["model", "method", "run"],
        lowestLevel: runLogLevel,
        sinks: ["runFile", ...otelSinks],
        parentSinks: runParentSinks,
      },
      {
        category: ["workflow", "run"],
        lowestLevel: runLogLevel,
        sinks: ["runFile", ...otelSinks],
        parentSinks: runParentSinks,
      },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: jsonMode ? [] : ["console"],
        parentSinks: jsonMode ? "override" : "inherit",
      },
    ],
    ...(options._reset || buffered ? { reset: true } : {}),
  });

  isInitialized = true;

  for (const record of buffered ?? []) {
    getLogger(record.category).emit(record);
  }
}

export function getSwampLogger(category: string[]) {
  return getLogger(category);
}

export function writeOutput(message: string): void {
  // deno-lint-ignore no-console
  console.log(message);
}

export function getRunLogger(
  modelName: string,
  methodName: string,
  runId?: string,
) {
  const logger = getLogger([
    "model",
    "method",
    "run",
    modelName,
    methodName,
  ]);
  return runId ? logger.with({ [RUN_ID_PROPERTY]: runId }) : logger;
}

// LogTape treats {…} as placeholders, so raw JSON output would render as
// undefined; only a template with an opening brace is parsed, so a closing
// brace is doubled only alongside one
export function escapeLogTemplate(text: string): string {
  if (!text.includes("{")) return text;
  return text.replaceAll("{", "{{").replaceAll("}", "}}");
}

export function getWorkflowRunLogger(
  workflowName: string,
  jobName?: string,
  stepName?: string,
  runId?: string,
) {
  const category: string[] = ["workflow", "run", workflowName];
  if (jobName) category.push(jobName);
  if (stepName) category.push(stepName);
  const logger = getLogger(category);
  return runId ? logger.with({ [RUN_ID_PROPERTY]: runId }) : logger;
}
