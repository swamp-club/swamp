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
import { resolve } from "@std/path";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { OutputMode } from "../presentation/output/output.ts";

export type Verbosity = "quiet" | "normal" | "verbose";

export interface GlobalOptions {
  json?: boolean;
  log?: boolean;
  logLevel?: string;
  quiet?: boolean;
  verbose?: boolean;
  noTelemetry?: boolean;
  showProperties?: boolean;
  color?: boolean;
}

export interface CommandContext {
  outputMode: OutputMode;
  forceLog: boolean;
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
    forceLog: options.log ?? false,
    verbosity: getVerbosity(options),
    logger: getSwampLogger(loggerCategory),
  };
}

/**
 * Returns the effective output mode for commands that use interactive Ink UIs.
 * Falls back to "json" when stdin is not a TTY, since Ink requires raw mode
 * on stdin and will crash with "Raw mode is not supported" in non-TTY contexts
 * (piped input, CI, AI agents).
 */
export function interactiveOutputMode(ctx: CommandContext): OutputMode {
  if (ctx.outputMode === "json" || !isStdinTty()) {
    return "json";
  }
  return "log";
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

/**
 * Pre-parses --quiet / -q from raw CLI arguments. Used by code paths that
 * fire before Cliffy's globalAction has parsed options (e.g. extension
 * load warnings emitted from lazy loaders inside ensureLoaded()).
 */
export function isQuietFromArgs(args: string[]): boolean {
  return args.includes("--quiet") || args.includes("-q");
}

/**
 * Pre-parses --repo-dir from raw CLI arguments before Cliffy option parsing.
 *
 * Supports both `--repo-dir <value>` and `--repo-dir=<value>` forms.
 * Returns the resolved absolute path.
 *
 * Priority: --repo-dir flag > SWAMP_REPO_DIR env var > cwd.
 */
export function getRepoDirFromArgs(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo-dir" && i + 1 < args.length) {
      return resolve(args[i + 1]);
    }
    if (arg.startsWith("--repo-dir=")) {
      return resolve(arg.slice("--repo-dir=".length));
    }
  }
  const envDir = Deno.env.get("SWAMP_REPO_DIR");
  if (envDir && envDir.length > 0) {
    return resolve(envDir);
  }
  return Deno.cwd();
}

/**
 * Resolves the repository directory for a command action, given the Cliffy
 * parsed `--repo-dir` option value.
 *
 * Priority: --repo-dir flag > SWAMP_REPO_DIR env var > "." (cwd).
 *
 * Command option definitions must NOT set a Cliffy `default` for `--repo-dir`
 * — otherwise Cliffy always populates the value and the env var is ignored.
 */
export function resolveRepoDir(cliValue: string | undefined): string {
  if (cliValue !== undefined) {
    return resolve(cliValue);
  }
  const envDir = Deno.env.get("SWAMP_REPO_DIR");
  if (envDir && envDir.length > 0) {
    return resolve(envDir);
  }
  return Deno.cwd();
}

/**
 * Pre-parses --extensions-dir from raw CLI arguments before Cliffy option
 * parsing.
 *
 * Supports both `--extensions-dir <value>` and `--extensions-dir=<value>` forms.
 * Returns the resolved absolute path, or undefined if not set.
 *
 * Priority: --extensions-dir flag > SWAMP_EXTENSIONS_DIR env var > undefined.
 */
export function getExtensionsDirFromArgs(
  args: string[],
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--extensions-dir" && i + 1 < args.length) {
      return resolve(args[i + 1]);
    }
    if (arg.startsWith("--extensions-dir=")) {
      return resolve(arg.slice("--extensions-dir=".length));
    }
  }
  const envDir = Deno.env.get("SWAMP_EXTENSIONS_DIR");
  if (envDir && envDir.length > 0) {
    return resolve(envDir);
  }
  return undefined;
}

/**
 * Resolves the extensions directory for a command action, given the Cliffy
 * parsed `--extensions-dir` option value.
 *
 * Priority: --extensions-dir flag > SWAMP_EXTENSIONS_DIR env var > undefined.
 *
 * When undefined, callers should fall back to repoDir for extension scanning.
 */
export function resolveExtensionsDir(
  cliValue: string | undefined,
): string | undefined {
  if (cliValue !== undefined) {
    return resolve(cliValue);
  }
  const envDir = Deno.env.get("SWAMP_EXTENSIONS_DIR");
  if (envDir && envDir.length > 0) {
    return resolve(envDir);
  }
  return undefined;
}
