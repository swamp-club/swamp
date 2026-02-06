import {
  configure,
  getConsoleSink,
  getLogger,
  type LogLevel,
} from "@logtape/logtape";
import { getFileSink } from "@logtape/file";
import { getPrettyFormatter } from "@logtape/pretty";
import { ensureDirSync } from "@std/fs";

export interface LoggingOptions {
  debugLogs: boolean;
  prettyOutput?: boolean;
  showProperties?: boolean;
  logLevel?: LogLevel;
  jsonMode?: boolean;
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

  const sinks: Record<string, ReturnType<typeof getConsoleSink>> = {
    console: getConsoleSink(),
  };

  const loggers: Array<{
    category: string[];
    lowestLevel: LogLevel;
    sinks: string[];
    parentSinks?: "inherit" | "override";
  }> = [];

  if (options.prettyOutput) {
    const prettyFormat = getPrettyFormatter({
      timestamp: "time",
      categorySeparator: ".",
      categoryTruncate: false,
      categoryColorMap: new Map([
        [
          ["model", "method", "run"],
          "rgb(52,211,153)" as const,
        ],
        [
          ["workflow", "run"],
          "rgb(96,165,250)" as const,
        ],
      ]),
      levelStyle: "bold",
      wordWrap: true,
      properties: options.showProperties ?? false,
    });

    sinks["pretty"] = getConsoleSink({ formatter: prettyFormat });
  }

  if (options.debugLogs) {
    const logDir = "dev-logs";
    ensureDirSync(logDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = `${logDir}/swamp-${timestamp}.log`;

    sinks["file"] = getFileSink(logFile);

    loggers.push({
      category: [],
      lowestLevel: "debug",
      sinks: options.jsonMode ? ["file"] : ["file", "console"],
    });
  } else if (options.jsonMode) {
    // In JSON mode without debug, suppress all console output
    // to keep stdout clean for structured output
    loggers.push({
      category: [],
      lowestLevel: "fatal",
      sinks: [],
    });
  } else {
    loggers.push({
      category: [],
      lowestLevel: logLevel,
      sinks: ["console"],
    });
  }

  // Route run output to the pretty sink when available
  if (options.prettyOutput) {
    loggers.push({
      category: ["model", "method", "run"],
      lowestLevel: logLevel,
      sinks: ["pretty"],
      parentSinks: "override",
    });
    loggers.push({
      category: ["workflow", "run"],
      lowestLevel: logLevel,
      sinks: ["pretty"],
      parentSinks: "override",
    });
  }

  await configure({
    sinks,
    loggers: [
      ...loggers,
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: ["console"],
      },
    ],
  });

  isInitialized = true;
}

export function getSwampLogger(name: string) {
  return getLogger([name]);
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
