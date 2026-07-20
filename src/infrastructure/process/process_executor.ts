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
import type { SecretRedactor } from "../../domain/secrets/mod.ts";
import { escapeLogTemplate } from "../logging/logger.ts";

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
 * Reads lines from a ReadableStream, calling onLine for each complete line.
 * Returns the full accumulated output as a string.
 *
 * When an AbortSignal is provided and fires, the read loop breaks and the
 * function returns whatever output has been accumulated so far.
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

  const abortPromise = signal
    ? new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
      if (signal.aborted) {
        resolve({ done: true, value: undefined });
        return;
      }
      signal.addEventListener("abort", () => {
        resolve({ done: true, value: undefined });
      }, { once: true });
    })
    : undefined;

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
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
    try {
      await reader.cancel();
    } catch {
      // Reader may already be closed
    }
    try {
      reader.releaseLock();
    } catch {
      // Lock may already be released by cancel
    }
  }

  return lines.join("\n");
}

const PIPE_DRAIN_GRACE_MS = 5000;

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

  if (options.timeoutMs) {
    // Timeout path: race process.status against the timeout, then drain
    // pipes separately.  This prevents orphaned child processes that hold
    // pipes open from causing a spurious timeout when the command itself
    // exited successfully.
    const process = command.spawn();
    const pipeAbort = new AbortController();

    const redact = (line: string) =>
      options.redactor?.hasSecrets ? options.redactor.redact(line) : line;

    let stdoutOnLine: ((line: string) => void) | undefined;
    let stderrOnLine: ((line: string) => void) | undefined;

    if (options.logger) {
      const logger = options.logger;
      const onOutput = options.onOutput;
      stdoutOnLine = (line: string) => {
        const redacted = redact(line);
        if (onOutput) {
          onOutput(redacted, "stdout");
          logger.debug(escapeLogTemplate(redacted));
        } else {
          logger.info(escapeLogTemplate(redacted));
        }
      };
      stderrOnLine = (line: string) => {
        const redacted = redact(line);
        if (onOutput) {
          onOutput(redacted, "stderr");
          logger.debug(escapeLogTemplate(redacted));
        } else {
          logger.warn(escapeLogTemplate(redacted));
        }
      };
    }

    // Start pipe reading immediately (prevents buffer deadlock)
    const stdoutPromise = streamLines(
      process.stdout,
      stdoutOnLine,
      pipeAbort.signal,
    );
    const stderrPromise = streamLines(
      process.stderr,
      stderrOnLine,
      pipeAbort.signal,
    );

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
      pipeAbort.abort();
    }, options.timeoutMs);

    // Kill subprocess when abort signal fires
    let abortHandler: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        try {
          process.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }
        pipeAbort.abort();
      } else {
        abortHandler = () => {
          try {
            process.kill("SIGTERM");
          } catch {
            // Process may have already exited
          }
          pipeAbort.abort();
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    try {
      // Wait for the direct child to exit — process.status resolves
      // independently of pipe closure, so orphaned children holding pipes
      // open do not block this.
      const status = await process.status;
      clearTimeout(timeoutId);

      if (timedOut) {
        throw new Error(`Command timed out after ${options.timeoutMs}ms`);
      }

      // Re-throw as AbortError if signal was responsible for the kill
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      exitCode = status.code;

      // Process exited — drain pipes with a grace period.  If orphaned
      // children hold pipes open past the deadline, abort the readers and
      // return whatever output has been accumulated.
      const graceTimeout = setTimeout(
        () => pipeAbort.abort(),
        PIPE_DRAIN_GRACE_MS,
      );
      try {
        const pipeResults = await Promise.all([stdoutPromise, stderrPromise]);
        stdout = pipeResults[0];
        stderr = pipeResults[1];
      } finally {
        clearTimeout(graceTimeout);
      }
    } catch (err) {
      // On timeout/abort, wait for pipe promises to settle
      await Promise.all([
        stdoutPromise.catch(() => {}),
        stderrPromise.catch(() => {}),
      ]);
      throw err;
    } finally {
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  } else if (options.logger) {
    // Streaming mode without timeout
    const process = command.spawn();

    // Kill subprocess when abort signal fires
    let abortHandler: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        try {
          process.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }
      } else {
        abortHandler = () => {
          try {
            process.kill("SIGTERM");
          } catch {
            // Process may have already exited
          }
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    try {
      const logger = options.logger;
      const redact = (line: string) =>
        options.redactor?.hasSecrets ? options.redactor.redact(line) : line;
      const onOutput = options.onOutput;
      const [stdoutResult, stderrResult, status] = await Promise.all([
        streamLines(process.stdout, (line) => {
          const redacted = redact(line);
          if (onOutput) {
            onOutput(redacted, "stdout");
            logger.debug(escapeLogTemplate(redacted));
          } else {
            logger.info(escapeLogTemplate(redacted));
          }
        }),
        streamLines(process.stderr, (line) => {
          const redacted = redact(line);
          if (onOutput) {
            onOutput(redacted, "stderr");
            logger.debug(escapeLogTemplate(redacted));
          } else {
            logger.warn(escapeLogTemplate(redacted));
          }
        }),
        process.status,
      ]);

      stdout = stdoutResult;
      stderr = stderrResult;
      exitCode = status.code;
    } finally {
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }

    // Re-throw as AbortError if signal was responsible for the kill
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  } else {
    // Simple buffered execution
    const output = await command.output();
    stdout = new TextDecoder().decode(output.stdout);
    stderr = new TextDecoder().decode(output.stderr);
    exitCode = output.code;
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
