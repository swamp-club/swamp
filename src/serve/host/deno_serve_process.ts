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

import { serveIdKey } from "../../domain/serve/managed_serve.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { type ListenedServe, parseListeningLine } from "../listening_line.ts";
import { swampInvocation } from "../swamp_invocation.ts";
import {
  type ServeChild,
  serveChildArgs,
  type ServeChildExit,
  type ServeProcessPort,
} from "./serve_process.ts";

const childLogger = getSwampLogger(["serve", "host", "child"]);

export const READY_POLL_INTERVAL_MS = 250;
const READY_ATTEMPT_TIMEOUT_MS = 2_000;
const STDERR_TAIL_LINES = 20;
// a child writing without newlines must not grow the host's memory
export const MAX_LINE_CHARS = 8_192;
// the last stderr lines explain an exit, but a grandchild holding the pipe
// open must not hold the exit back
const STDERR_SETTLE_MS = 1_000;

export function linesOf(
  bytes: ReadableStream<Uint8Array>,
  maxChars: number = MAX_LINE_CHARS,
): ReadableStreamDefaultReader<string> {
  return bytes
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(boundedLines(maxChars))
    .getReader();
}

/** a line longer than maxChars is cut there and the rest of it dropped */
function boundedLines(maxChars: number): TransformStream<string, string> {
  let partial = "";
  let overflowing = false;
  return new TransformStream({
    transform(chunk, controller) {
      const pieces = chunk.split("\n");
      const last = pieces.pop() ?? "";
      for (const piece of pieces) {
        if (!overflowing) {
          controller.enqueue(withoutCr((partial + piece).slice(0, maxChars)));
        }
        partial = "";
        overflowing = false;
      }
      if (overflowing) return;
      partial += last;
      if (partial.length > maxChars) {
        controller.enqueue(partial.slice(0, maxChars));
        partial = "";
        overflowing = true;
      }
    },
    flush(controller) {
      if (!overflowing && partial !== "") {
        controller.enqueue(withoutCr(partial));
      }
    },
  });
}

function withoutCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** null when the stream ends before a listening line */
export async function readListening(
  lines: ReadableStreamDefaultReader<string>,
): Promise<ListenedServe | null> {
  while (true) {
    const { value, done } = await lines.read();
    if (done) return null;
    const listened = parseListeningLine(value);
    if (listened !== null) return listened;
  }
}

/** true once /ready answers 200; false when the signal aborts first */
export async function pollReady(
  port: number,
  signal: AbortSignal,
  intervalMs: number = READY_POLL_INTERVAL_MS,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/ready`;
  while (!signal.aborted) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(READY_ATTEMPT_TIMEOUT_MS),
        ]),
      });
      await response.body?.cancel();
      if (response.status === 200) return true;
    } catch {
      // Not listening yet, or this attempt timed out.
    }
    await delay(intervalMs, signal);
  }
  return false;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

export class StderrTail {
  readonly #lines: string[] = [];

  constructor(private readonly limit: number = STDERR_TAIL_LINES) {}

  push(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.limit) this.#lines.shift();
  }

  lines(): string[] {
    return [...this.#lines];
  }
}

export function exitCode(
  status: { readonly code: number; readonly signal: Deno.Signal | null },
): number | null {
  // for a signal death Deno's code is 128 plus the signal, not an exit code
  return status.signal === null ? status.code : null;
}

export const DENO_SERVE_PROCESS_PORT: ServeProcessPort = {
  spawn(spec) {
    const cmd = swampInvocation(serveChildArgs(spec));
    let process: Deno.ChildProcess;
    try {
      process = new Deno.Command(cmd.execPath, {
        args: cmd.args,
        cwd: spec.repoDir,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        env: { ...spec.env },
        clearEnv: true,
      }).spawn();
    } catch (error) {
      return unstartedChild(error);
    }
    return childOf(process, serveIdKey(spec.id));
  },
};

function childOf(process: Deno.ChildProcess, serve: string): ServeChild {
  const stdin = process.stdin.getWriter();
  let stdinClosed: Promise<void> | undefined;
  const closeStdin = () => stdinClosed ??= stdin.close().catch(() => {});
  const polling = new AbortController();

  const tail = new StderrTail();
  const stderrLines = linesOf(process.stderr);
  const stderrDrained = (async () => {
    try {
      while (true) {
        const { value, done } = await stderrLines.read();
        if (done) return;
        if (value.trim() === "") continue;
        tail.push(value);
        childLogger.info("{serve}: {line}", { serve, line: value });
      }
    } catch {
      // Cancelled by release.
    }
  })();

  const stdoutLines = linesOf(process.stdout);
  const listening = (async () => {
    const listened = await readListening(stdoutLines);
    if (listened === null) throw new Error("serve exited before listening");
    return listened;
  })();
  // drained after the listening line so the child never blocks on a full pipe
  const stdoutDrained = (async () => {
    try {
      await listening.catch(() => {});
      while (!(await stdoutLines.read()).done) { /* discard */ }
    } catch {
      // Cancelled by release.
    }
  })();

  const ready = (async () => {
    const { port } = await listening;
    if (!await pollReady(port, polling.signal)) {
      throw new Error("serve stopped before it was ready");
    }
  })();

  const status = process.status;
  const exited = (async (): Promise<ServeChildExit> => {
    const result = await status;
    polling.abort();
    await settlesWithin(stderrDrained, STDERR_SETTLE_MS);
    return { code: exitCode(result), stderrTail: tail.lines() };
  })();

  // a consumer may attach late or not at all; neither may surface as unhandled
  listening.catch(() => {});
  ready.catch(() => {});

  return {
    listening,
    ready,
    exited,
    terminate() {
      // Deno's SIGTERM ends a Windows child outright; stdin end of file drains it
      if (Deno.build.os === "windows") {
        closeStdin();
        return;
      }
      signalQuietly(process, "SIGTERM");
    },
    kill() {
      signalQuietly(process, "SIGKILL");
    },
    async release() {
      await closeStdin();
      await status;
      polling.abort();
      await Promise.all([
        stdoutLines.cancel().catch(() => {}),
        stderrLines.cancel().catch(() => {}),
      ]);
      await Promise.allSettled([
        listening,
        ready,
        exited,
        stdoutDrained,
        stderrDrained,
      ]);
    },
  };
}

function unstartedChild(error: unknown): ServeChild {
  const reason = error instanceof Error ? error.message : String(error);
  const listening = Promise.reject(new Error(`serve did not start: ${reason}`));
  const ready = Promise.reject(new Error(`serve did not start: ${reason}`));
  listening.catch(() => {});
  ready.catch(() => {});
  return {
    listening,
    ready,
    exited: Promise.resolve({ code: null, stderrTail: [reason] }),
    terminate() {},
    kill() {},
    release: () => Promise.resolve(),
  };
}

function signalQuietly(process: Deno.ChildProcess, signal: Deno.Signal): void {
  try {
    process.kill(signal);
  } catch {
    // Already exited.
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
