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

import type { HarnessLaunchSpec } from "./harness.ts";

/**
 * Quotes a value for a POSIX shell: single quotes, with each `'` written as
 * `'\''`. Every byte inside single quotes is literal.
 */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quotes a value for a line in a `.cmd` file: double quotes, with `%`
 * doubled so batch expansion leaves it alone. Inside double quotes `&`, `|`,
 * `<`, `>` and `^` are literal. A double quote or a line break cannot be
 * represented, so they are refused; Swamp only ever writes paths it chose
 * and fixed text here.
 */
export function cmdQuote(value: string): string {
  if (/["\r\n]/.test(value)) {
    throw new Error(`Cannot quote a value containing '"' or a line break`);
  }
  return `"${value.replace(/%/g, "%%")}"`;
}

/**
 * Quotes an argument of a `call` line in a `.cmd` file. `call` expands `%`
 * a second time, so each `%` is written as `%%%%`: the file's own expansion
 * leaves `%%`, and `call`'s leaves `%`. (`call` also doubles a `^` inside
 * quotes, which has no escape; Swamp only writes paths and fixed text here.)
 */
export function cmdCallQuote(value: string): string {
  return cmdQuote(value).replace(/%%/g, "%%%%");
}

/**
 * Quotes a value for pasting at an interactive `cmd` prompt, where `%%` is
 * not an escape and a `%NAME%` expands when NAME is set. Each `%` is moved
 * outside the quotes and written `^%`, so `50%` becomes `"50"^%""`; the
 * quoted pieces join into one argument. Refuses what {@link cmdQuote}
 * refuses.
 */
export function cmdPasteQuote(value: string): string {
  cmdQuote(value);
  return `"${value.replace(/%/g, `"^%"`)}"`;
}

/** True for a Windows batch file, which another batch file must `call`. */
export function isBatchFile(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

/** What a launcher needs besides the harness spec. */
export interface LauncherEnvironment {
  readonly workspacePath: string;
  /** The folder holding the swamp binary, put first on PATH. */
  readonly swampBinDir: string;
  /** Variables to export, only those that were set when start ran. */
  readonly exports: Readonly<Record<string, string>>;
  /** Variables the agent must not inherit. */
  readonly unset: readonly string[];
}

/**
 * How long a resume may run before its failure no longer means "nothing to
 * continue". A real session that later exits with an error must not open a
 * second, fresh one. The POSIX launcher checks it; `cmd` has no simple clock,
 * so on Windows any failed resume falls back.
 */
export const RESUME_FALLBACK_SECONDS = 10;

/** The `launch.command` script for macOS and Linux. */
export function renderPosixLauncher(
  spec: HarnessLaunchSpec,
  env: LauncherEnvironment,
): string {
  const lines = ["#!/bin/sh"];
  if (env.unset.length > 0) lines.push(`unset ${env.unset.join(" ")}`);
  lines.push(`export PATH=${posixQuote(env.swampBinDir)}:"$PATH"`);
  for (const [name, value] of Object.entries(env.exports)) {
    lines.push(`export ${name}=${posixQuote(value)}`);
  }
  lines.push(`cd ${posixQuote(env.workspacePath)} || exit 1`);
  // Ask the terminal for a sensible window, 40 rows by 120 columns, instead
  // of its default; a terminal that doesn't support the request ignores it.
  lines.push(`printf '\\033[8;40;120t'`);
  const run = [spec.binaryPath, ...spec.args].map(posixQuote).join(" ");
  if (spec.fallbackArgs === undefined) {
    lines.push(run);
  } else {
    const fallback = [spec.binaryPath, ...spec.fallbackArgs].map(posixQuote)
      .join(" ");
    lines.push("started=$(date +%s)");
    lines.push(
      `${run} || { [ $(($(date +%s) - started)) -lt ${RESUME_FALLBACK_SECONDS} ] && ${fallback}; }`,
    );
  }
  lines.push("echo");
  lines.push(
    `echo ${
      posixQuote(`${spec.displayName} exited. You can close this window.`)
    }`,
  );
  return lines.join("\n") + "\n";
}

/** The `launch.cmd` script for Windows. */
export function renderCmdLauncher(
  spec: HarnessLaunchSpec,
  env: LauncherEnvironment,
): string {
  const lines = ["@echo off"];
  for (const name of env.unset) lines.push(`set ${name}=`);
  lines.push(`set "PATH=${env.swampBinDir.replace(/%/g, "%%")};%PATH%"`);
  for (const [name, value] of Object.entries(env.exports)) {
    // Refuses `"` and line breaks, as every other value here does.
    cmdQuote(value);
    lines.push(`set "${name}=${value.replace(/%/g, "%%")}"`);
  }
  lines.push(`cd /d ${cmdQuote(env.workspacePath)} || exit /b 1`);
  // A batch file (an npm `.cmd` shim) is run with `call` so control comes
  // back to this script; an `.exe` is run directly, avoiding `call`'s second
  // expansion.
  const line = (args: readonly string[]) => {
    const parts = [spec.binaryPath, ...args];
    return isBatchFile(spec.binaryPath)
      ? `call ${parts.map(cmdCallQuote).join(" ")}`
      : parts.map(cmdQuote).join(" ");
  };
  lines.push(
    spec.fallbackArgs === undefined
      ? line(spec.args)
      : `${line(spec.args)} || ${line(spec.fallbackArgs)}`,
  );
  lines.push("echo.");
  lines.push(`echo ${spec.displayName} exited. You can close this window.`);
  return lines.join("\r\n") + "\r\n";
}

/** The command a user can paste when no window could be opened. */
export function copyCommand(
  spec: HarnessLaunchSpec,
  workspacePath: string,
  os: string,
): string {
  if (os === "windows") {
    const run = (args: readonly string[]) =>
      [spec.binaryPath, ...args].map(cmdPasteQuote).join(" ");
    const cd = `cd /d ${cmdPasteQuote(workspacePath)}`;
    return spec.fallbackArgs === undefined
      ? `${cd} && ${run(spec.args)}`
      : `${cd} && (${run(spec.args)} || ${run(spec.fallbackArgs)})`;
  }
  const run = (args: readonly string[]) =>
    [spec.binaryPath, ...args].map(posixQuote).join(" ");
  const cd = `cd ${posixQuote(workspacePath)}`;
  return spec.fallbackArgs === undefined
    ? `${cd} && ${run(spec.args)}`
    : `${cd} && { ${run(spec.args)} || ${run(spec.fallbackArgs)}; }`;
}
