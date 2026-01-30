import type { Logger } from "@logtape/logtape";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { OutputMode } from "../presentation/output/output.tsx";

export type Verbosity = "quiet" | "normal" | "verbose";

export interface GlobalOptions {
  debugLogs?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export interface CommandContext {
  outputMode: OutputMode;
  verbosity: Verbosity;
  logger: Logger;
}

function getVerbosity(options: GlobalOptions): Verbosity {
  if (options.quiet) return "quiet";
  if (options.verbose) return "verbose";
  return "normal";
}

export function createContext(
  options: GlobalOptions,
  loggerName: string = "cli",
): CommandContext {
  return {
    outputMode: options.json ? "json" : "interactive",
    verbosity: getVerbosity(options),
    logger: getSwampLogger(loggerName),
  };
}

/**
 * Determines the output mode from raw CLI arguments.
 * Used for error handling before the CLI has fully parsed options.
 */
export function getOutputModeFromArgs(args: string[]): OutputMode {
  return args.includes("--json") ? "json" : "interactive";
}
