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
import { shouldIsolateProcessGroup } from "./process_group_policy.ts";
import { isProcessAlive } from "./process_kill.ts";

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
  /** When true, the child starts with an empty environment and gets only
   *  the variables from `env`. Without this, `env` augments the inherited
   *  parent environment (Deno default). */
  clearEnv?: boolean;
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
  /** When true, an abort or timeout terminates everything the command
   *  started, not just the direct child: on POSIX by running it in its own
   *  process group (subject to `process_group_policy.ts`), on Windows with
   *  `taskkill /T`. A command that exits on its own is never signalled, so
   *  processes it deliberately backgrounds keep running. */
  terminateProcessTree?: boolean;
  /** Grace between SIGTERM and SIGKILL when terminating. Tests only. */
  killGraceMs?: number;
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
 * Grace between SIGTERM and SIGKILL. Kept under the 5 s serve allows aborted
 * runs to settle (`ActiveRunRegistry.drainAll(5_000)`), so a step that ignores
 * SIGTERM still records its own cancellation.
 */
const KILL_GRACE_MS = 3000;
const GROUP_POLL_MS = 50;

/** How an aborted or timed-out process is terminated. */
type TerminationMode =
  /** POSIX: signal the process group the child leads. */
  | "group"
  /** Windows: `taskkill /T` the child's tree. */
  | "tree"
  /** Signal only the direct child. */
  | "child";

/** Process groups of isolated spawns that have not settled yet. */
const liveProcessGroups = new Set<number>();
let unloadListenerInstalled = false;

/**
 * SIGKILLs every isolated process group that has not settled. Runs on
 * `unload`, which fires on `Deno.exit` — a forced second Ctrl-C, or a process
 * exiting before an escalation finished — so no group outlives swamp.
 */
export function killLiveProcessGroups(): void {
  for (const pgid of liveProcessGroups) {
    try {
      Deno.kill(-pgid, "SIGKILL");
    } catch { /* group already gone */ }
  }
  liveProcessGroups.clear();
}

function trackProcessGroup(pgid: number): void {
  if (!unloadListenerInstalled) {
    globalThis.addEventListener("unload", killLiveProcessGroups);
    unloadListenerInstalled = true;
  }
  liveProcessGroups.add(pgid);
}

/**
 * Terminates the process, at most once however many triggers (timeout,
 * abort) fire, and never once the direct child has exited on its own: a
 * late abort (say, while pipes drain) must not reach what it backgrounded.
 */
interface Terminator {
  /** The child's status. Every path awaits this instead of `child.status`,
   *  so the terminator learns when the child exits. */
  status: Promise<Deno.CommandStatus>;
  terminate(): void;
  /** Resolves once a started termination finishes, or at once if none. */
  settled(): Promise<void>;
}

function createTerminator(
  child: Deno.ChildProcess,
  mode: TerminationMode,
  graceMs: number,
): Terminator {
  let running: Promise<void> | undefined;
  let exited = false;
  return {
    status: child.status.then((status) => {
      exited = true;
      // Exited on its own: what it backgrounded is not the exit sweep's.
      if (!running) liveProcessGroups.delete(child.pid);
      return status;
    }),
    terminate: () => {
      if (exited) return;
      running ??= terminateProcess(child, mode, graceMs);
    },
    settled: () => running ?? Promise.resolve(),
  };
}

/**
 * Runs `onAbort` when `signal` aborts, immediately if it already has.
 * Returns a function that detaches the listener.
 */
function onSignalAbort(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * SIGTERM, then SIGKILL whatever is still alive after the grace period.
 * Never rejects: it is started from a synchronous listener and awaited later.
 */
async function terminateProcess(
  child: Deno.ChildProcess,
  mode: TerminationMode,
  graceMs: number,
): Promise<void> {
  try {
    if (mode === "group") {
      await terminateGroup(child.pid, graceMs);
    } else if (mode === "tree") {
      await terminateWindowsTree(child, graceMs);
    } else {
      await terminateChild(child, graceMs);
    }
  } catch {
    // Best effort: the process may already have exited.
  }
}

async function terminateGroup(pgid: number, graceMs: number): Promise<void> {
  try {
    Deno.kill(-pgid, "SIGTERM");
  } catch {
    return; // Group already gone
  }
  const deadline = Date.now() + graceMs;
  while (isProcessAlive(-pgid)) {
    if (Date.now() >= deadline) {
      // SIGKILL cannot be ignored, so it is final: a member that stays
      // visible afterwards is an unreaped zombie, not a live process.
      try {
        Deno.kill(-pgid, "SIGKILL");
      } catch { /* exited in between */ }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  liveProcessGroups.delete(pgid);
}

async function terminateChild(
  child: Deno.ChildProcess,
  graceMs: number,
): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    return; // Already exited
  }
  // Wait on the status rather than probing the pid: once the child is
  // reaped, its pid can belong to an unrelated process.
  if (!await exitsWithin(child, graceMs)) {
    try {
      child.kill("SIGKILL");
    } catch { /* exited in between */ }
  }
}

async function terminateWindowsTree(
  child: Deno.ChildProcess,
  graceMs: number,
): Promise<void> {
  try {
    const result = await new Deno.Command("taskkill", {
      args: ["/PID", String(child.pid), "/T", "/F"],
      stdout: "null",
      stderr: "null",
      signal: AbortSignal.timeout(graceMs),
    }).output();
    if (result.success) return;
  } catch {
    // taskkill unavailable or timed out; fall back to the direct child
  }
  try {
    child.kill("SIGKILL");
  } catch { /* already exited */ }
}

async function exitsWithin(
  child: Deno.ChildProcess,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      child.status.then(() => true, () => true),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
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

  if (options.clearEnv) {
    commandOptions.clearEnv = true;
  }

  const isolated = options.terminateProcessTree === true &&
    shouldIsolateProcessGroup();
  if (isolated) {
    // setsid(): the child leads its own session and process group, so the
    // group id to signal is its pid.
    commandOptions.detached = true;
  }
  const mode: TerminationMode = isolated
    ? "group"
    : options.terminateProcessTree && Deno.build.os === "windows"
    ? "tree"
    : "child";
  const graceMs = options.killGraceMs ?? KILL_GRACE_MS;

  const command = new Deno.Command(options.command, commandOptions);
  const spawn = (): Deno.ChildProcess => {
    const child = command.spawn();
    if (isolated) trackProcessGroup(child.pid);
    return child;
  };
  // Waits out any termination, then stops tracking the group. A path that
  // ends while the child still runs (a throwing output callback) abandons
  // it, so it is terminated rather than left running untracked; a child
  // that already exited is left alone.
  const release = async (
    child: Deno.ChildProcess,
    terminator: Terminator,
  ): Promise<void> => {
    terminator.terminate();
    await terminator.settled();
    liveProcessGroups.delete(child.pid);
  };

  let stdout: string;
  let stderr: string;
  let exitCode: number;

  if (options.timeoutMs) {
    // Timeout path: race process.status against the timeout, then drain
    // pipes separately.  This prevents orphaned child processes that hold
    // pipes open from causing a spurious timeout when the command itself
    // exited successfully.
    const process = spawn();
    const terminator = createTerminator(process, mode, graceMs);
    const pipeAbort = new AbortController();
    const stop = () => {
      terminator.terminate();
      pipeAbort.abort();
    };

    const redact = (line: string) =>
      options.redactor?.hasSecrets ? options.redactor.redact(line) : line;

    let stdoutOnLine: ((line: string) => void) | undefined;
    let stderrOnLine: ((line: string) => void) | undefined;

    if (options.logger) {
      const logger = options.logger;
      const onOutput = options.onOutput;
      stdoutOnLine = (line: string) => {
        const redacted = redact(line);
        if (onOutput) onOutput(redacted, "stdout");
        logger.info(escapeLogTemplate(redacted));
      };
      stderrOnLine = (line: string) => {
        const redacted = redact(line);
        if (onOutput) onOutput(redacted, "stderr");
        logger.warn(escapeLogTemplate(redacted));
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
      stop();
    }, options.timeoutMs);

    // Kill subprocess when abort signal fires
    const detachAbort = onSignalAbort(options.signal, stop);

    try {
      // Wait for the direct child to exit — process.status resolves
      // independently of pipe closure, so orphaned children holding pipes
      // open do not block this.
      const status = await terminator.status;
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
      clearTimeout(timeoutId);
      detachAbort();
      await release(process, terminator);
    }
  } else if (options.logger) {
    // Streaming mode without timeout
    const process = spawn();
    const terminator = createTerminator(process, mode, graceMs);
    const pipeAbort = new AbortController();

    // Kill subprocess when abort signal fires
    const detachAbort = onSignalAbort(options.signal, () => {
      terminator.terminate();
      pipeAbort.abort();
    });

    try {
      const logger = options.logger;
      const redact = (line: string) =>
        options.redactor?.hasSecrets ? options.redactor.redact(line) : line;
      const onOutput = options.onOutput;
      const [stdoutResult, stderrResult, status] = await Promise.all([
        streamLines(process.stdout, (line) => {
          const redacted = redact(line);
          if (onOutput) onOutput(redacted, "stdout");
          logger.info(escapeLogTemplate(redacted));
        }, pipeAbort.signal),
        streamLines(process.stderr, (line) => {
          const redacted = redact(line);
          if (onOutput) onOutput(redacted, "stderr");
          logger.warn(escapeLogTemplate(redacted));
        }, pipeAbort.signal),
        terminator.status,
      ]);

      stdout = stdoutResult;
      stderr = stderrResult;
      exitCode = status.code;
    } finally {
      detachAbort();
      await release(process, terminator);
    }

    // Re-throw as AbortError if signal was responsible for the kill
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  } else {
    // Simple buffered execution
    const process = spawn();
    const terminator = createTerminator(process, mode, graceMs);
    const pipeAbort = new AbortController();

    const detachAbort = onSignalAbort(options.signal, () => {
      terminator.terminate();
      pipeAbort.abort();
    });

    try {
      const [stdoutResult, stderrResult, status] = await Promise.all([
        streamLines(process.stdout, undefined, pipeAbort.signal),
        streamLines(process.stderr, undefined, pipeAbort.signal),
        terminator.status,
      ]);
      stdout = stdoutResult;
      stderr = stderrResult;
      exitCode = status.code;
    } finally {
      detachAbort();
      await release(process, terminator);
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
