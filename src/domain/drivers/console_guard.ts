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

type ConsoleMethod = (...args: unknown[]) => void;

const CAPTURED_METHODS = ["log", "info", "debug", "warn", "error"] as const;

const REAL_CONSOLE = new Map<string, ConsoleMethod>(
  CAPTURED_METHODS.map((m) => [m, console[m] as ConsoleMethod]),
);

const STDERR_WRITER = new TextEncoder();

function writeStderr(line: string): void {
  Deno.stderr.writeSync(STDERR_WRITER.encode(line + "\n"));
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a) ?? Deno.inspect(a);
  } catch {
    return Deno.inspect(a);
  }
}

let activeGuards = 0;
const allActiveLogs: Set<string[]> = new Set();

// Redirects console methods to a capture array during fn execution.
export async function withConsoleGuard<T>(
  fn: () => T | Promise<T>,
  logs: string[],
): Promise<T> {
  allActiveLogs.add(logs);
  if (activeGuards === 0) {
    for (const method of CAPTURED_METHODS) {
      // deno-lint-ignore no-explicit-any
      (console as any)[method] = (...args: unknown[]) => {
        const line = args.map(formatArg).join(" ");
        for (const logArray of allActiveLogs) {
          logArray.push(`[${method}] ${line}`);
        }
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
        (console as any)[method] = REAL_CONSOLE.get(method)!;
      }
    }

    if (logs.length > 0) {
      for (const line of logs) {
        writeStderr(line);
      }
    }
  }
}
