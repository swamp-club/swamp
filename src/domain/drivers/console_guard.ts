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

/**
 * Executes an async function with console methods redirected to a capture array.
 * All output is restored on completion (success or throw) via try/finally.
 * Captured lines are relayed to stderr after execution so extension developers
 * still see their debug output without polluting stdout.
 */
export async function withConsoleGuard<T>(
  fn: () => T | Promise<T>,
  logs: string[],
): Promise<T> {
  const originals = new Map<string, ConsoleMethod>();

  for (const method of CAPTURED_METHODS) {
    originals.set(method, console[method] as ConsoleMethod);
    // deno-lint-ignore no-explicit-any
    (console as any)[method] = (...args: unknown[]) => {
      const line = args.map((a) =>
        typeof a === "string" ? a : JSON.stringify(a)
      ).join(" ");
      logs.push(`[${method}] ${line}`);
    };
  }

  try {
    return await fn();
  } finally {
    for (const method of CAPTURED_METHODS) {
      // deno-lint-ignore no-explicit-any
      (console as any)[method] = originals.get(method)!;
    }

    if (logs.length > 0) {
      const originalError = originals.get("error")!;
      for (const line of logs) {
        originalError(line);
      }
    }
  }
}
