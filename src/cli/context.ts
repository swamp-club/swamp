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

/**
 * Checks if stdin is a TTY (terminal).
 * Returns false if stdin is not a terminal (e.g., piped input).
 */
function isStdinTty(): boolean {
  try {
    return Deno.stdin.isTerminal();
  } catch {
    return false;
  }
}

export function createContext(
  options: GlobalOptions,
  loggerName: string = "cli",
): CommandContext {
  // Auto-detect output mode: use JSON if explicitly requested or if not a TTY
  const outputMode: OutputMode = options.json
    ? "json"
    : isStdinTty()
    ? "interactive"
    : "json";

  return {
    outputMode,
    verbosity: getVerbosity(options),
    logger: getSwampLogger(loggerName),
  };
}

/**
 * Determines the output mode from raw CLI arguments.
 * Used for error handling before the CLI has fully parsed options.
 * Falls back to JSON mode if stdin is not a TTY.
 */
export function getOutputModeFromArgs(args: string[]): OutputMode {
  if (args.includes("--json")) {
    return "json";
  }
  return isStdinTty() ? "interactive" : "json";
}
