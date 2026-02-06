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
}

let isInitialized = false;

export async function initializeLogging(
  options: LoggingOptions,
): Promise<void> {
  // LogTape can only be configured once per process
  if (isInitialized) {
    return;
  }

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
          ["swamp", "model", "method", "run"],
          "rgb(52,211,153)" as const,
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
      category: ["swamp"],
      lowestLevel: "debug",
      sinks: ["file", "console"],
    });
  } else {
    loggers.push({
      category: ["swamp"],
      lowestLevel: "error",
      sinks: ["console"],
    });
  }

  // Route run output to the pretty sink when available
  if (options.prettyOutput) {
    loggers.push({
      category: ["swamp", "model", "method", "run"],
      lowestLevel: "info",
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
  return getLogger(["swamp", name]);
}

export function getRunLogger(modelName: string, methodName: string) {
  return getLogger([
    "swamp",
    "model",
    "method",
    "run",
    modelName,
    methodName,
  ]);
}
