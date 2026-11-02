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

import { runFileSink } from "../infrastructure/logging/run_file_sink.ts";

/**
 * the runner's stdout carries length-prefixed RPC frames, so any other byte
 * corrupts the stream and kills the worker; the redirect must happen before
 * anything prints, including OpenTelemetry's console exporter
 */

/**
 * True when `args` invoke the dispatch runner. Positional on purpose: it
 * matches the exact argv deriveRunnerCommand (src/worker/dispatch_handler.ts)
 * spawns the runner with — keep the two in step.
 */
export function isDispatchRunnerInvocation(args: readonly string[]): boolean {
  return args[0] === "worker" && args[1] === "exec-dispatch";
}

const encoder = new TextEncoder();

function writeStderrLine(line: string): void {
  Deno.stderr.writeSync(encoder.encode(line + "\n"));
}

export function redirectConsoleToStderr(
  write: (line: string) => void = writeStderrLine,
): void {
  const scrubbedWrite = (line: string) => write(runFileSink.redactActive(line));
  const join = (args: unknown[]) => args.map(String).join(" ");
  console.log = (...args: unknown[]) => scrubbedWrite(join(args));
  console.info = (...args: unknown[]) => scrubbedWrite(join(args));
  console.debug = (...args: unknown[]) => scrubbedWrite(join(args));
  console.dir = (item?: unknown, options?: Deno.InspectOptions) =>
    scrubbedWrite(Deno.inspect(item, {
      ...options,
      strAbbreviateSize: Infinity,
      breakLength: Infinity,
    }));
  console.warn = (...args: unknown[]) => scrubbedWrite("[WARN] " + join(args));
  console.error = (...args: unknown[]) =>
    scrubbedWrite("[ERROR] " + join(args));
}
