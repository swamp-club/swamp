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

type ConsoleMethod = (...args: unknown[]) => void;

const CAPTURED_METHODS = ["log", "info", "debug", "warn", "error"] as const;

const STDERR_ENCODER = new TextEncoder();

function defaultStderrWriter(line: string): void {
  Deno.stderr.writeSync(STDERR_ENCODER.encode(line + "\n"));
}

let writeStderr: (line: string) => void = defaultStderrWriter;

/**
 * Replaces the sink captured lines are written to. Tests pass a recorder to
 * count writes; `undefined` restores the default stderr writer.
 */
export function setConsoleGuardStderrWriter(
  writer: ((line: string) => void) | undefined,
): void {
  writeStderr = writer ?? defaultStderrWriter;
}

let _jsonMode = false;

export function setConsoleGuardJsonMode(enabled: boolean): void {
  _jsonMode = enabled;
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (typeof a === "number") return String(a);
  try {
    return JSON.stringify(a) ?? Deno.inspect(a);
  } catch {
    return Deno.inspect(a);
  }
}

let activeGuards = 0;
const allActiveLogs: Set<string[]> = new Set();
// The console methods in place when the first guard installed, restored when
// the last guard exits and used by `unguardedConsole` meanwhile.
const preGuardConsole = new Map<string, ConsoleMethod>();

/**
 * Console output for swamp's own renderers. While a guard is active the
 * global console belongs to the guard, so a renderer writing through it would
 * have its output captured as if the running method had written it. These
 * methods write through the pre-guard console instead, so renderer output
 * always reaches its intended stream and never enters a method's logs.
 * Extension code must keep using the global console.
 */
export const unguardedConsole = {
  log(...args: unknown[]): void {
    resolveUnguarded("log")(...args);
  },
  error(...args: unknown[]): void {
    resolveUnguarded("error")(...args);
  },
};

function resolveUnguarded(method: "log" | "error"): ConsoleMethod {
  return preGuardConsole.get(method) ?? (console[method] as ConsoleMethod);
}

export interface ConsoleGuardOptions {
  jsonMode?: boolean;
}

// Redirects console methods to a capture array during fn execution.
// In JSON mode, captures console output from extension code into `logs`
// and writes each line to stderr to prevent stdout pollution. In non-JSON mode,
// console output flows to stdout normally (the renderer is not involved).
export async function withConsoleGuard<T>(
  fn: () => T | Promise<T>,
  logs: string[],
  options?: ConsoleGuardOptions,
): Promise<T> {
  const effectiveJsonMode = options?.jsonMode ?? _jsonMode;

  if (!effectiveJsonMode) {
    return await fn();
  }

  allActiveLogs.add(logs);
  if (activeGuards === 0) {
    for (const method of CAPTURED_METHODS) {
      preGuardConsole.set(method, console[method] as ConsoleMethod);
      // A line cannot be attributed to one of several concurrent methods, so
      // every active guard records it, but it reaches stderr only once.
      // deno-lint-ignore no-explicit-any
      (console as any)[method] = (...args: unknown[]) => {
        const line = args.map(formatArg).join(" ");
        for (const logArray of allActiveLogs) {
          logArray.push(line);
        }
        writeStderr(line);
      };
    }
  }
  activeGuards++;

  try {
    return await fn();
  } finally {
    activeGuards--;
    allActiveLogs.delete(logs);

    if (activeGuards === 0) {
      for (const method of CAPTURED_METHODS) {
        // deno-lint-ignore no-explicit-any
        (console as any)[method] = preGuardConsole.get(method)!;
      }
      preGuardConsole.clear();
    }
  }
}
