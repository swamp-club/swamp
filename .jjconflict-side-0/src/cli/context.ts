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

import type { Logger } from "@logtape/logtape";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { OutputMode } from "../presentation/output/output.ts";

export type Verbosity = "quiet" | "normal" | "verbose";

export interface GlobalOptions {
  json?: boolean;
  logLevel?: string;
  quiet?: boolean;
  verbose?: boolean;
  noTelemetry?: boolean;
  showProperties?: boolean;
  color?: boolean;
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
export function isStdinTty(): boolean {
  try {
    return Deno.stdin.isTerminal();
  } catch {
    return false;
  }
}

export function createContext(
  options: GlobalOptions,
  loggerCategory: string[] = ["cli"],
): CommandContext {
  const outputMode: OutputMode = options.json ? "json" : "log";

  return {
    outputMode,
    verbosity: getVerbosity(options),
    logger: getSwampLogger(loggerCategory),
  };
}

/**
 * Determines the output mode from raw CLI arguments.
 * Used for error handling before the CLI has fully parsed options.
 */
export function getOutputModeFromArgs(args: string[]): OutputMode {
  if (args.includes("--json")) {
    return "json";
  }
  return "log";
}
