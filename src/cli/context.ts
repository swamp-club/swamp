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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { SWAMP_MARKER_FILE } from "../infrastructure/persistence/paths.ts";
import { CLUB_API_KEY_FILE_FLAG } from "../infrastructure/persistence/api_key_source.ts";
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
  readJsonOutputEnv: () => string | undefined = () =>
    Deno.env.get("SWAMP_CLI_OUTPUT_JSON"),
): CommandContext {
  const outputMode = resolveOutputMode(
    options.json ?? false,
    readJsonOutputEnv(),
  );

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

export function getOutputModeFromArgs(
  args: string[],
  readJsonOutputEnv: () => string | undefined = () =>
    Deno.env.get("SWAMP_CLI_OUTPUT_JSON"),
): OutputMode {
  return resolveOutputMode(args.includes("--json"), readJsonOutputEnv());
}

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
 * NO_COLOR counts as set by presence, so an empty string disables colour. the
 * terminal probe is a thunk so the cases decided by flag or env cost no
 * syscall, which matters on the hook fast path
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
 * applied before the command is constructed, since Cliffy exits on --version
 * and --help before globalAction runs; it only disables colour, as an
 * unconditional enable would override a disable elsewhere
 */
export function applyColorPolicy(
  noColorRequested: boolean,
  readNoColorEnv: () => string | undefined = () => Deno.env.get("NO_COLOR"),
  stdoutIsTerminal: () => boolean = isStdoutTty,
  setEnabled: (enabled: boolean) => void = setColorEnabled,
): boolean {
  const enabled = resolveColorEnabled(
    noColorRequested,
    readNoColorEnv(),
    stdoutIsTerminal,
  );
  if (!enabled) {
    setEnabled(false);
  }
  return enabled;
}

const BOOLEAN_SHORT_FLAGS = new Set(["q", "v", "h"]);

/**
 * pre-parses --quiet as Cliffy reads it: -qv is quiet, in -tq the q is -t's
 * value, nothing after -- is an option. it cannot see a command's own boolean
 * flags, so -yq reads as not quiet; the miss shows output, never hides it
 */
export function isQuietFromArgs(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--quiet" || arg === "-q") return true;
    if (/^-[A-Za-z]{2,}$/.test(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === "q") return true;
        if (!BOOLEAN_SHORT_FLAGS.has(flag)) break;
      }
    }
  }
  return false;
}

/**
 * whether the notices printed after a command (update banners, autoupdate
 * warnings) may be shown: they are human-readable commentary on stderr, so
 * neither JSON mode nor -q shows them
 */
export function postCommandNoticesAllowed(
  outputMode: OutputMode,
  quiet: boolean,
): boolean {
  return outputMode === "log" && !quiet;
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
 * the traversal boundary is the git root, widened to the main working tree from
 * a linked worktree, where the repository marker usually lives; kept as the git
 * root unless the main tree is its ancestor
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
 * symlinks are resolved because node:sqlite refuses a database path through a
 * symlink; Windows keeps the path as given
 */
function explicitRepoDir(path: string): string {
  return Deno.build.os === "windows" ? resolve(path) : canonicalize(path);
}

export function getRepoDirFromArgs(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo-dir" && i + 1 < args.length) {
      return explicitRepoDir(args[i + 1]);
    }
    if (arg.startsWith("--repo-dir=")) {
      return explicitRepoDir(arg.slice("--repo-dir=".length));
    }
  }
  const envDir = Deno.env.get("SWAMP_REPO_DIR");
  if (envDir && envDir.length > 0) {
    return explicitRepoDir(envDir);
  }
  const cwd = Deno.cwd();
  return findAncestorRepoDir(cwd) ?? cwd;
}

/**
 * respells a path under repoDir when it reaches the repository through another
 * spelling, swapping only the shallowest ancestor so a symlink inside is never
 * resolved; extension loading compares strings
 */
export function rebaseOntoRepoDir(path: string, repoDir: string): string {
  const target = resolve(path);
  const rel = relative(repoDir, target);
  const escapes = rel === ".." || rel.startsWith(".." + SEPARATOR) ||
    isAbsolute(rel);
  if (Deno.build.os === "windows" || !escapes) return target;
  let realRepoDir: string;
  try {
    realRepoDir = Deno.realPathSync(repoDir);
  } catch {
    return target;
  }
  let repoRoot: string | undefined;
  for (let ancestor = target;; ancestor = dirname(ancestor)) {
    try {
      if (Deno.realPathSync(ancestor) === realRepoDir) repoRoot = ancestor;
    } catch {
      // Not there yet, or unreadable — keep walking up
    }
    if (dirname(ancestor) === ancestor) break;
  }
  return repoRoot === undefined
    ? target
    : join(repoDir, relative(repoRoot, target));
}

export function hasExplicitRepoDir(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo-dir" && i + 1 < args.length) return true;
    if (arg.startsWith("--repo-dir=")) return true;
  }
  const envDir = Deno.env.get("SWAMP_REPO_DIR");
  return envDir !== undefined && envDir.length > 0;
}

/**
 * commands must not set a Cliffy default for --repo-dir, or Cliffy always
 * populates the value and SWAMP_REPO_DIR is ignored
 */
export function resolveRepoDir(cliValue: string | undefined): string {
  if (cliValue !== undefined) {
    return explicitRepoDir(cliValue);
  }
  const envDir = Deno.env.get("SWAMP_REPO_DIR");
  if (envDir && envDir.length > 0) {
    return explicitRepoDir(envDir);
  }
  const cwd = Deno.cwd();
  return findAncestorRepoDir(cwd) ?? cwd;
}

/**
 * the cwd as the user spelled it: the process cwd has symlinks resolved; PWD is
 * used only when absolute, free of . and .. segments, and naming the same
 * directory; Windows gets the cwd
 */
export function logicalCwd(): string {
  if (Deno.build.os === "windows") return Deno.cwd();
  return logicalCwdFrom(
    Deno.cwd(),
    Deno.env.get("PWD"),
    (path) => Deno.realPathSync(path),
  );
}

export function logicalCwdFrom(
  cwd: string,
  pwd: string | undefined,
  realPath: (path: string) => string,
): string {
  if (pwd === undefined || pwd === cwd || !isAbsolute(pwd)) return cwd;
  if (pwd.split(/[\\/]/).some((s) => s === "." || s === "..")) return cwd;
  try {
    return realPath(pwd) === realPath(cwd) ? resolve(pwd) : cwd;
  } catch {
    return cwd;
  }
}

/**
 * the repo dir spelled as the user gave it, for paths swamp reports; storage
 * keeps repoDir because node:sqlite refuses a path through a symlink
 */
export function repoDirAsGiven(
  cliValue: string | undefined,
  repoDir: string,
): string {
  if (Deno.build.os === "windows") return repoDir;
  return repoDirAsGivenFrom({
    cliValue,
    envValue: Deno.env.get("SWAMP_REPO_DIR"),
    cwd: logicalCwd(),
    repoDir,
    realPath: (path) => Deno.realPathSync(path),
  });
}

export function repoDirAsGivenFrom(options: {
  cliValue: string | undefined;
  envValue: string | undefined;
  cwd: string;
  repoDir: string;
  realPath: (path: string) => string;
}): string {
  const { cliValue, envValue, cwd, repoDir, realPath } = options;
  let realRepoDir: string;
  try {
    realRepoDir = realPath(repoDir);
  } catch {
    return repoDir;
  }
  const namesRepo = (path: string): boolean => {
    try {
      return realPath(path) === realRepoDir;
    } catch {
      return false;
    }
  };
  const explicit = cliValue ??
    (envValue !== undefined && envValue.length > 0 ? envValue : undefined);
  if (explicit !== undefined) {
    const given = resolve(cwd, explicit);
    return namesRepo(given) ? given : repoDir;
  }
  let dir = cwd;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (namesRepo(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return repoDir;
}

export function resolveTraceparent(
  cliValue: string | undefined,
  envGet: (key: string) => string | undefined = Deno.env.get.bind(Deno.env),
): string | undefined {
  if (cliValue !== undefined) {
    return cliValue;
  }
  return envGet("TRACEPARENT") || undefined;
}

export function resolveTracestate(
  cliValue: string | undefined,
  envGet: (key: string) => string | undefined = Deno.env.get.bind(Deno.env),
): string | undefined {
  if (cliValue !== undefined) {
    return cliValue;
  }
  return envGet("TRACESTATE") || undefined;
}

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
 * startup loads credentials before any command runs, so the flag is pre-parsed.
 * only serve commands declare it; elsewhere it is ignored so a stray flag never
 * has its file read and sent as a credential before Cliffy rejects it
 */
export function getClubApiKeyFileFromArgs(
  args: string[],
  commandInfo: { command: string; subcommand?: string },
): string | undefined {
  if (!declaresClubApiKeyFile(args, commandInfo)) return undefined;
  const prefix = `${CLUB_API_KEY_FILE_FLAG}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return undefined;
    if (arg === CLUB_API_KEY_FILE_FLAG && i + 1 < args.length) {
      return resolve(args[i + 1]);
    }
    if (arg.startsWith(prefix)) {
      return resolve(arg.slice(prefix.length));
    }
  }
  return undefined;
}

/**
 * Whether the invoked command path declares --club-api-key-file. When the
 * pre-parse cannot tell (an option it did not know took a value), it answers
 * no: the flag is then ignored here rather than read for the wrong command.
 */
function declaresClubApiKeyFile(
  args: string[],
  commandInfo: { command: string; subcommand?: string },
): boolean {
  if (commandInfo.command !== "serve") return false;
  const sub = commandInfo.subcommand;
  if (sub === undefined || sub === "check-config") return true;
  if (sub !== "daemon") return false;
  return args[args.indexOf("daemon") + 1] === "enable";
}

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
