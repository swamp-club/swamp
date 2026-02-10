import {
  configure,
  getConsoleSink,
  getLogger,
  getTextFormatter,
  type LogLevel,
  type LogRecord,
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

/**
 * Creates a sink that formats fatal log records as JSON on stderr.
 * Used in JSON mode so error output matches the structured output contract.
 */
function createJsonErrorSink(): Sink {
  return (record: LogRecord) => {
    const errorProp = record.properties["error"];
    const messageProp = record.properties["message"];

    let errorMessage: string;
    let stack: string | undefined;

    if (errorProp instanceof Error) {
      errorMessage = errorProp.message;
      stack = extractStackLines(errorProp.stack);
    } else if (typeof messageProp === "string") {
      errorMessage = messageProp;
    } else {
      // Fallback: render the full message
      errorMessage = record.message.map(String).join("");
    }

    const data: Record<string, string> = { error: errorMessage };
    if (stack) {
      data.stack = stack;
    }
    console.error(JSON.stringify(data, null, 2));
  };
}

/**
 * Extracts just the stack trace lines from an error stack.
 * Removes the error message line and any source code snippets.
 */
function extractStackLines(stack: string | undefined): string | undefined {
  if (!stack) return undefined;

  const lines = stack.split("\n");
  const stackLines = lines.filter((line) => line.trim().startsWith("at "));
  return stackLines.length > 0 ? stackLines.join("\n") : undefined;
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
    sinks["jsonError"] = createJsonErrorSink();
  }

  if (options.jsonMode) {
    // In JSON mode without debug, suppress most console output
    // to keep stdout clean for structured output.
    // Fatal messages use a JSON-formatted sink on stderr so
    // error output is valid JSON matching the structured output contract.
    loggers.push({
      category: [],
      lowestLevel: "fatal",
      sinks: ["jsonError"],
    });
  } else {
    loggers.push({
      category: [],
      lowestLevel: logLevel,
      sinks: [options.prettyOutput ? "pretty" : "console"],
    });
  }

  await configure({
    sinks,
    loggers: [
      ...loggers,
      {
        category: ["model", "method", "run"],
        lowestLevel: logLevel,
        sinks: ["runFile"],
      },
      {
        category: ["workflow", "run"],
        lowestLevel: logLevel,
        sinks: ["runFile"],
      },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: ["console"],
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
