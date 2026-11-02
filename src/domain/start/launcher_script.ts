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

export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * double quotes with % doubled; & | < > ^ are literal inside them; a double
 * quote or line break cannot be represented, so they are refused
 */
export function cmdQuote(value: string): string {
  if (/["\r\n]/.test(value)) {
    throw new Error(`Cannot quote a value containing '"' or a line break`);
  }
  return `"${value.replace(/%/g, "%%")}"`;
}

/**
 * call expands % a second time, so each % is written %%%%; call also doubles a
 * ^ inside quotes, which has no escape
 */
export function cmdCallQuote(value: string): string {
  return cmdQuote(value).replace(/%%/g, "%%%%");
}

/**
 * %% is not an escape at an interactive prompt, so each % is moved outside the
 * quotes as ^% and the quoted pieces join into one argument
 */
export function cmdPasteQuote(value: string): string {
  cmdQuote(value);
  return `"${value.replace(/%/g, `"^%"`)}"`;
}

export function isBatchFile(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

export interface LauncherEnvironment {
  readonly workspacePath: string;
  readonly swampBinDir: string;
  readonly exports: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
}

/**
 * a real session that later exits with an error must not open a fresh one; cmd
 * has no simple clock, so on Windows any failed resume falls back
 */
export const RESUME_FALLBACK_SECONDS = 10;

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
