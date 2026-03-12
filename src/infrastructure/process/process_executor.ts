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
 * Reads lines from a ReadableStream, calling onLine for each complete line.
 * Returns the full accumulated output as a string.
 */
export async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
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
            logger.debug(redacted);
          } else {
            logger.info(redacted);
          }
        }),
        streamLines(process.stderr, (line) => {
          const redacted = redact(line);
          if (onOutput) {
            onOutput(redacted, "stderr");
            logger.debug(redacted);
          } else {
            logger.warn(redacted);
          }
        }),
        process.status,
      ]);

      stdout = stdoutResult;
      stderr = stderrResult;
      exitCode = status.code;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }

    if (timedOut) {
      throw new Error(`Command timed out after ${options.timeoutMs}ms`);
    }

    // Re-throw as AbortError if signal was responsible for the kill
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  } else if (options.timeoutMs) {
    // Buffered with timeout
    const process = command.spawn();
    let timedOut = false;

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
    }

    if (timedOut) {
      throw new Error(`Command timed out after ${options.timeoutMs}ms`);
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
