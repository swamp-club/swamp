// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  getTextFormatter,
  type LogLevel,
  type Sink,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { runFileSink } from "./run_file_sink.ts";

export { runFileSink } from "./run_file_sink.ts";

export interface LoggingOptions {
  prettyOutput?: boolean;
  showProperties?: boolean;
  logLevel?: LogLevel;
  jsonMode?: boolean;
  noColor?: boolean;
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

  const sinks: Record<string, Sink | (Sink & Disposable)> = {
    console: options.noColor
      ? getConsoleSink({ formatter: getTextFormatter() })
      : getConsoleSink(),
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
      timestamp: "time",
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

  if (options.jsonMode) {
    // JSON mode: the renderError() function in
    // src/presentation/output/error_output.ts is the single emitter for
    // fatal output (it writes JSON to stdout and skips logger.fatal).
    // The root logger has no sinks so nothing leaks via the standard
    // logging pipeline. Audit at swamp-club#235: only error_output.ts
    // calls logger.fatal in src/, both inside renderError itself.
    loggers.push({
      category: [],
      lowestLevel: "fatal",
      sinks: [],
    });
  } else {
    loggers.push({
      category: [],
      lowestLevel: logLevel,
      sinks: [options.prettyOutput ? "pretty" : "console"],
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
        sinks: ["runFile"],
        parentSinks: jsonMode ? "override" : "inherit",
      },
      {
        category: ["workflow", "run"],
        lowestLevel: logLevel,
        sinks: ["runFile"],
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
