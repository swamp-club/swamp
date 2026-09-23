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

import type { Logger } from "@logtape/logtape";
import { setColorEnabled } from "@std/fmt/colors";
import { basename, dirname, join, resolve, SEPARATOR } from "@std/path";
import { SWAMP_MARKER_FILE } from "../infrastructure/persistence/paths.ts";
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

/**
 * Checks if stdout is a TTY (terminal).
 * Returns false if stdout is not a terminal (e.g., piped or redirected).
 *
 * Wrapped like `isStdinTty` above: this runs before Cliffy parses anything, so
 * a throw here would take down every invocation — including the `--version`
 * and `--help` output the colour policy exists to clean up.
 */
export function isStdoutTty(): boolean {
  try {
    return Deno.stdout.isTerminal();
  } catch {
    return false;
  }
}

export function createContext(
  options: GlobalOptions,
  loggerCategory: string[] = ["cli"],
  jsonOutputEnv = Deno.env.get("SWAMP_CLI_OUTPUT_JSON"),
): CommandContext {
  const outputMode = resolveOutputMode(options.json ?? false, jsonOutputEnv);

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
 * Determines the output mode from raw CLI arguments and the JSON output default.
 * Used for error handling before the CLI has fully parsed options.
 */
export function getOutputModeFromArgs(
  args: string[],
  jsonOutputEnv = Deno.env.get("SWAMP_CLI_OUTPUT_JSON"),
): OutputMode {
  return resolveOutputMode(args.includes("--json"), jsonOutputEnv);
}

/**
 * Resolves the CLI's two output modes without reading process state, so callers
 * that run before command parsing and unit tests share identical behavior.
 */
export function resolveOutputMode(
  jsonRequested: boolean,
  jsonOutputEnv: string | undefined,
): OutputMode {
  if (jsonRequested || isTruthyOutputEnv(jsonOutputEnv)) {
    return "json";
  }
  return "log";
}

function isTruthyOutputEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" &&
    value !== "false";
}

/**
 * Resolves whether ANSI colour should be emitted, without reading process
 * state, so callers that run before command parsing and unit tests share
 * identical behavior.
 *
 * `NO_COLOR` counts as set by presence, not by value — an empty string disables
 * colour — which is both the informal standard and the check this replaced in
 * `runCli`'s global action.
 *
 * The terminal probe is a thunk so the two decided cases cost no syscall: with
 * the flag or the environment variable in play the answer is already known, and
 * the hook fast path (`audit record --from-hook`) pays nothing for a question
 * it does not need asked.
 */
export function resolveColorEnabled(
  noColorRequested: boolean,
  noColorEnv: string | undefined,
  stdoutIsTerminal: () => boolean,
): boolean {
  if (noColorRequested || noColorEnv !== undefined) {
    return false;
  }
  return stdoutIsTerminal();
}

/**
 * Applies the colour policy for this invocation and returns what it decided.
 *
 * Cliffy resolves `--version` and `--help` while parsing arguments and exits
 * before `globalAction` runs, so the decision has to be made — and applied —
 * before the command is even constructed, or `--no-color` cannot reach it
 * (swamp-club#2414). Colour lives in `@std/fmt`'s module state, which swamp and
 * Cliffy share, so flipping it here reaches Cliffy's own output too;
 * `integration/color_policy_rules_test.ts` guards that shared resolution.
 *
 * Only ever *disables*: `@std/fmt` applied `NO_COLOR` itself when it loaded, and
 * an unconditional `setEnabled(true)` would override a disable this code did not
 * make.
 *
 * The environment read, the terminal probe and the effect are all parameters
 * with production defaults, so tests drive the policy through a spy instead of
 * mutating process-global colour state.
 */
export function applyColorPolicy(
  noColorRequested: boolean,
  noColorEnv: string | undefined = Deno.env.get("NO_COLOR"),
  stdoutIsTerminal: () => boolean = isStdoutTty,
  setEnabled: (enabled: boolean) => void = setColorEnabled,
): boolean {
  const enabled = resolveColorEnabled(
    noColorRequested,
    noColorEnv,
    stdoutIsTerminal,
  );
  if (!enabled) {
    setEnabled(false);
  }
  return enabled;
}

/**
 * Pre-parses --quiet / -q from raw CLI arguments. Used by code paths that
 * fire before Cliffy's globalAction has parsed options (e.g. extension
 * load warnings emitted from lazy loaders inside ensureLoaded()).
 */
export function isQuietFromArgs(args: string[]): boolean {
  return args.includes("--quiet") || args.includes("-q");
}

const MAX_ANCESTOR_DEPTH = 10;

function canonicalize(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return resolve(path);
  }
}

function isAtOrAbove(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return descendant.startsWith(
    ancestor.endsWith(SEPARATOR) ? ancestor : ancestor + SEPARATOR,
  );
}

/**
 * Resolves the directory where ancestor traversal must stop.
 *
 * In a plain checkout this is the git root. In a *linked worktree* the git root
 * is the worktree itself, and the swamp repository marker usually lives in the
 * main working tree — so the boundary is widened to the main working tree,
 * derived from `git rev-parse --git-common-dir` (which points at the main
 * repository's `.git` directory even from inside a linked worktree).
 *
 * The widened boundary is only used when the main working tree is an ancestor
 * of the git root; otherwise (worktree checked out elsewhere on disk, bare
 * repositories, unusual `GIT_DIR` layouts) the git root is kept, preserving
 * existing behavior.
 */
function getGitRootSync(startDir: string): string | null {
  try {
    const result = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel", "--git-common-dir"],
      cwd: startDir,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!result.success) {
      return null;
    }
    const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
    const topLevel = lines[0]?.trim();
    if (topLevel === undefined || topLevel === "") {
      return null;
    }
    const gitRoot = canonicalize(topLevel);

    // `--git-common-dir` is relative to the cwd git ran in when the repository
    // is the main working tree, and absolute from inside a linked worktree.
    const commonDirRaw = lines[1]?.trim();
    if (commonDirRaw === undefined || commonDirRaw === "") {
      return gitRoot;
    }
    const commonDir = canonicalize(resolve(startDir, commonDirRaw));
    if (basename(commonDir) !== ".git") {
      return gitRoot;
    }
    const mainWorkingTree = dirname(commonDir);
    if (!isAtOrAbove(mainWorkingTree, gitRoot)) {
      return gitRoot;
    }
    try {
      if (!Deno.statSync(mainWorkingTree).isDirectory) {
        return gitRoot;
      }
    } catch {
      return gitRoot;
    }
    return mainWorkingTree;
  } catch {
    return null;
  }
}

/**
 * Walks up the directory tree from `startDir` looking for a `.swamp.yaml`
 * marker file.
 *
 * Stops at the git repository root (when inside a git repo) — widened to the
 * main working tree when started from a linked worktree — or after
 * MAX_ANCESTOR_DEPTH levels (when not in a git repo).
 *
 * @returns The ancestor directory containing `.swamp.yaml`, or `null`.
 */
export function findAncestorRepoDir(startDir: string): string | null {
  const gitRoot = getGitRootSync(startDir);

  let dir: string;
  try {
    dir = Deno.realPathSync(startDir);
  } catch {
    dir = resolve(startDir);
  }

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    try {
      const stat = Deno.statSync(join(dir, SWAMP_MARKER_FILE));
      if (stat.isFile) {
        return dir;
      }
    } catch {
      // .swamp.yaml not found at this level — continue up
    }

    if (gitRoot !== null && dir === gitRoot) {
      break;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

/**
 * Pre-parses --repo-dir from raw CLI arguments before Cliffy option parsing.
 *
 * Supports both `--repo-dir <value>` and `--repo-dir=<value>` forms.
 * Returns the resolved absolute path.
 *
 * Priority: --repo-dir flag > SWAMP_REPO_DIR env var > cwd (with ancestor
 * traversal).
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
  const cwd = Deno.cwd();
  return findAncestorRepoDir(cwd) ?? cwd;
}

/**
 * Resolves the repository directory for a command action, given the Cliffy
 * parsed `--repo-dir` option value.
 *
 * Priority: --repo-dir flag > SWAMP_REPO_DIR env var > cwd (with ancestor
 * traversal).
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
  const cwd = Deno.cwd();
  return findAncestorRepoDir(cwd) ?? cwd;
}

/**
 * Resolves the traceparent for a command, given the Cliffy parsed
 * `--traceparent` option value.
 *
 * Priority: --traceparent flag > TRACEPARENT env var > undefined.
 */
export function resolveTraceparent(
  cliValue: string | undefined,
): string | undefined {
  if (cliValue !== undefined) {
    return cliValue;
  }
  return Deno.env.get("TRACEPARENT") || undefined;
}

/**
 * Resolves the tracestate for a command, given the Cliffy parsed
 * `--tracestate` option value.
 *
 * Priority: --tracestate flag > TRACESTATE env var > undefined.
 */
export function resolveTracestate(
  cliValue: string | undefined,
): string | undefined {
  if (cliValue !== undefined) {
    return cliValue;
  }
  return Deno.env.get("TRACESTATE") || undefined;
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
