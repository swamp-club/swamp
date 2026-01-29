import {
  configure,
  getConsoleSink,
  getFileSink,
  getLogger,
  type LogLevel,
} from "@logtape/logtape";
import { ensureDirSync } from "@std/fs";

export interface LoggingOptions {
  debugLogs: boolean;
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
  }> = [];

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
