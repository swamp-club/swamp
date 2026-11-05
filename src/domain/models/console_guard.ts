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

import { runFileSink } from "../../infrastructure/logging/run_file_sink.ts";

type ConsoleMethod = (...args: unknown[]) => void;

const CAPTURED_METHODS = [
  "log",
  "info",
  "debug",
  "warn",
  "error",
  "dir",
  "table",
  "trace",
  "assert",
] as const;

type CapturedMethod = typeof CAPTURED_METHODS[number];

const STDERR_ENCODER = new TextEncoder();

function defaultStderrWriter(line: string): void {
  Deno.stderr.writeSync(STDERR_ENCODER.encode(line + "\n"));
}

let writeStderr: (line: string) => void = defaultStderrWriter;

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
    return JSON.stringify(a) ??
      Deno.inspect(a, { strAbbreviateSize: Infinity, breakLength: Infinity });
  } catch {
    return Deno.inspect(a, {
      strAbbreviateSize: Infinity,
      breakLength: Infinity,
    });
  }
}

// undefined when the call prints nothing, as a passing console.assert does
function renderLine(
  method: CapturedMethod,
  args: unknown[],
): string | undefined {
  switch (method) {
    case "dir":
    case "table":
      return Deno.inspect(args[0], {
        ...(method === "dir"
          ? args[1] as Deno.InspectOptions | undefined
          : undefined),
        // Truncating a secret before redaction would expose its prefix.
        strAbbreviateSize: Infinity,
        breakLength: Infinity,
      });
    case "assert": {
      if (args[0]) return undefined;
      const data = args.slice(1).map(formatArg).join(" ");
      return data ? `Assertion failed: ${data}` : "Assertion failed";
    }
    case "trace": {
      const data = args.map(formatArg).join(" ");
      // drops the Error line and the renderLine and patched console frames
      const frames = new Error().stack?.split("\n").slice(3).join("\n") ?? "";
      return `Trace${data ? `: ${data}` : ""}\n${frames}`;
    }
    default:
      return args.map(formatArg).join(" ");
  }
}

// a rendered table or dir would be quoted by its own method, and trace and
// assert report on stderr, so log mode prints the masked line through these
const LOG_MODE_TARGET: Partial<Record<CapturedMethod, "log" | "error">> = {
  dir: "log",
  table: "log",
  trace: "error",
  assert: "error",
};

let activeGuards = 0;
const allActiveLogs: Set<string[]> = new Set();
// The console methods in place when the first guard installed, restored when
// the last guard exits and used by `unguardedConsole` meanwhile.
const preGuardConsole = new Map<string, ConsoleMethod>();

/**
 * renderers write through the pre-guard console so their output reaches its
 * intended stream and never enters a method's logs; extension code must keep
 * using the global console
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

// in JSON mode captured console output goes into logs and, redacted, to stderr
// to avoid stdout pollution; otherwise it flows to its own stream, redacted
// once a run has secrets
export async function withConsoleGuard<T>(
  fn: () => T | Promise<T>,
  logs: string[],
  options?: ConsoleGuardOptions,
): Promise<T> {
  const effectiveJsonMode = options?.jsonMode ?? _jsonMode;

  if (effectiveJsonMode) allActiveLogs.add(logs);
  if (activeGuards === 0) {
    for (const method of CAPTURED_METHODS) {
      const original = console[method] as ConsoleMethod;
      preGuardConsole.set(method, original);
      // A line cannot be attributed to one of several concurrent methods, so
      // every active guard records it, but it reaches stderr only once.
      // deno-lint-ignore no-explicit-any
      (console as any)[method] = (...args: unknown[]) => {
        if (allActiveLogs.size === 0 && !runFileSink.hasActiveSecrets) {
          original(...args);
          return;
        }
        const line = renderLine(method, args);
        if (line === undefined) return;
        if (allActiveLogs.size === 0) {
          const target = LOG_MODE_TARGET[method];
          (target ? preGuardConsole.get(target)! : original)(
            runFileSink.redactActive(line),
          );
          return;
        }
        for (const logArray of allActiveLogs) {
          logArray.push(line);
        }
        // every active redactor applies before the line reaches stderr,
        // whichever writer is installed; the captured copy stays raw and its
        // consumers redact it themselves
        writeStderr(runFileSink.redactActive(line));
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
