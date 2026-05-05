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

import type { Logger } from "@logtape/logtape";
import type { SecretRedactor } from "../../domain/secrets/mod.ts";

/**
 * Options for executing a process.
 */
export interface ProcessExecutorOptions {
  /** The command to execute. */
  command: string;
  /** Command arguments. */
  args?: string[];
  /** Working directory. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Logger for streaming stdout (info) and stderr (warning). */
  logger?: Logger;
  /** Secret redactor for stripping vault secrets from streamed output. */
  redactor?: SecretRedactor;
  /** Optional callback for streaming output lines to an event stream. */
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
  /** Optional abort signal — when aborted, the subprocess is killed. */
  signal?: AbortSignal;
}

/**
 * Result of executing a process.
 */
export interface ProcessResult {
  /** Process exit code. */
  exitCode: number;
  /** Whether the process exited successfully (code 0). */
  success: boolean;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
}

/**
 * Attaches a SIGTERM-on-abort listener to the given child process. Returns a
 * cleanup function that detaches the listener — call it from a `finally` block
 * to avoid leaking listeners when the process exits normally.
 *
 * Why a manual listener rather than `Deno.CommandOptions.signal`: the native
 * option works for direct AbortControllers but does not reliably propagate
 * `AbortSignal.any([..., AbortSignal.timeout(...)])` on Linux (observed in
 * CI for swamp-club#247). The manual `addEventListener('abort')` path is
 * proven to work uniformly across platforms.
 */
function attachSignalKill(
  process: Deno.ChildProcess,
  signal: AbortSignal,
): () => void {
  if (signal.aborted) {
    try {
      process.kill("SIGTERM");
    } catch {
      // Process may have already exited
    }
    return () => {};
  }
  const handler = () => {
    try {
      process.kill("SIGTERM");
    } catch {
      // Process may have already exited
    }
  };
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

/**
 * Reads lines from a ReadableStream, calling onLine for each complete line.
 * Returns the full accumulated output as a string.
 *
 * When `signal` is provided, the read loop releases the reader and returns
 * as soon as the signal aborts. This unblocks callers when the underlying
 * pipe stays open due to grandchildren that inherited it (e.g. dash on Linux
 * forks `sleep 30` from `sh -c`; SIGTERM kills sh but the orphan keeps the
 * write end of the pipe open, so the deno-side reader never sees EOF).
 */
export async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";

  try {
    while (true) {
      // Race the next read against the abort signal so an aborted run
      // doesn't block on an inherited-pipe orphan that never EOFs.
      const readPromise = reader.read();
      const result = signal && !signal.aborted
        ? await Promise.race([
          readPromise,
          new Promise<{ done: true; value: undefined }>((resolve) => {
            signal.addEventListener(
              "abort",
              () => resolve({ done: true, value: undefined }),
              { once: true },
            );
          }),
        ])
        : await readPromise;

      if (signal?.aborted || result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      const bufferLines = buffer.split("\n");

      // Process all complete lines
      for (let i = 0; i < bufferLines.length - 1; i++) {
        lines.push(bufferLines[i]);
        onLine?.(bufferLines[i]);
      }

      // Keep the incomplete line in the buffer
      buffer = bufferLines[bufferLines.length - 1];
    }

    // Process any remaining content
    if (buffer) {
      lines.push(buffer);
      onLine?.(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  return lines.join("\n");
}

/**
 * Executes a process with optional streaming through a logger.
 *
 * When a logger is provided, stdout lines are logged at info level and stderr
 * lines at warning level, providing real-time output. When omitted, output is
 * buffered and returned in the result.
 */
export async function executeProcess(
  options: ProcessExecutorOptions,
): Promise<ProcessResult> {
  const startTime = Date.now();

  const commandOptions: Deno.CommandOptions = {
    args: options.args,
    stdout: "piped",
    stderr: "piped",
  };

  if (options.cwd) {
    commandOptions.cwd = options.cwd;
  }

  if (options.env) {
    commandOptions.env = options.env;
  }

  const command = new Deno.Command(options.command, commandOptions);

  let stdout: string;
  let stderr: string;
  let exitCode: number;

  if (options.logger) {
    // Streaming mode: log each line in real-time
    const process = command.spawn();
    let timeoutId: number | undefined;
    let timedOut = false;
    const detachSignal = options.signal
      ? attachSignalKill(process, options.signal)
      : () => {};

    if (options.timeoutMs) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          process.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }
      }, options.timeoutMs);
    }

    try {
      const logger = options.logger;
      const redact = (line: string) =>
        options.redactor?.hasSecrets ? options.redactor.redact(line) : line;
      const onOutput = options.onOutput;
      // Pass the abort signal down so the read loops bail out when an
      // orphaned grandchild keeps the pipe write end open after the parent
      // shell dies (dash on Linux, see streamLines docs).
      const [stdoutResult, stderrResult, status] = await Promise.all([
        streamLines(process.stdout, (line) => {
          const redacted = redact(line);
          if (onOutput) {
            onOutput(redacted, "stdout");
            logger.debug(redacted);
          } else {
            logger.info(redacted);
          }
        }, options.signal),
        streamLines(process.stderr, (line) => {
          const redacted = redact(line);
          if (onOutput) {
            onOutput(redacted, "stderr");
            logger.debug(redacted);
          } else {
            logger.warn(redacted);
          }
        }, options.signal),
        process.status,
      ]);

      stdout = stdoutResult;
      stderr = stderrResult;
      exitCode = status.code;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      detachSignal();
    }

    if (timedOut) {
      throw new Error(`Command timed out after ${options.timeoutMs}ms`);
    }

    // Surface AbortError if the signal aborted — the manual SIGTERM in
    // attachSignalKill resolves `process.status` with `code: 143` rather
    // than rejecting, so this normalization is load-bearing for libswamp's
    // run.ts handler to route it to the `cancelled` envelope.
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  } else if (options.timeoutMs) {
    // Buffered with timeout
    const process = command.spawn();
    let timedOut = false;
    const detachSignal = options.signal
      ? attachSignalKill(process, options.signal)
      : () => {};

    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    }, options.timeoutMs);

    try {
      const output = await process.output();
      stdout = new TextDecoder().decode(output.stdout);
      stderr = new TextDecoder().decode(output.stderr);
      exitCode = output.code;
    } finally {
      clearTimeout(timeoutId);
      detachSignal();
    }

    if (timedOut) {
      throw new Error(`Command timed out after ${options.timeoutMs}ms`);
    }

    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  } else {
    // Simple buffered execution. Use spawn() + output() so the manual
    // abort listener can call process.kill() — `command.output()` does
    // not expose the underlying child handle.
    const process = command.spawn();
    const detachSignal = options.signal
      ? attachSignalKill(process, options.signal)
      : () => {};
    try {
      const output = await process.output();
      stdout = new TextDecoder().decode(output.stdout);
      stderr = new TextDecoder().decode(output.stderr);
      exitCode = output.code;
    } finally {
      detachSignal();
    }

    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    exitCode,
    success: exitCode === 0,
    stdout,
    stderr,
    durationMs,
  };
}
