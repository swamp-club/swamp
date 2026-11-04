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
import { getCommandGuardian } from "./command_guardian_policy.ts";
import { shouldIsolateProcessGroup } from "./process_group_policy.ts";
import { isProcessAlive } from "./process_kill.ts";
import { attachProcessJob, type ProcessJob } from "./windows_job.ts";

export interface ProcessExecutorOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** When true, the child starts with an empty environment and gets only
   *  the variables from `env`. Without this, `env` augments the inherited
   *  parent environment (Deno default). */
  clearEnv?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  redactor?: SecretRedactor;
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  /**
   * abort or timeout kills the whole tree: its own process group on POSIX,
   * taskkill /T plus a kill-on-close Job Object on Windows; a command that
   * exits on its own is never signalled. Under the local-v1 engine a guardian
   * also owns each managed command group, so its descendants end with it
   */
  terminateProcessTree?: boolean;
  killGraceMs?: number;
  /**
   * drops a CR ending a line so CRLF shell output matches LF output; off by
   * default, so every CR the command writes is kept
   */
  normalizeCrlf?: boolean;
  attachJob?: (pid: number) => ProcessJob | undefined;
}

export interface ProcessResult {
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * on abort returns the output accumulated so far; with normalizeCrlf only a CR
 * ending an LF-terminated line is dropped, and an unterminated final line is
 * kept as written
 */
export async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
  options: { normalizeCrlf?: boolean } = {},
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

      for (let i = 0; i < bufferLines.length - 1; i++) {
        const line = options.normalizeCrlf && bufferLines[i].endsWith("\r")
          ? bufferLines[i].slice(0, -1)
          : bufferLines[i];
        lines.push(line);
        onLine?.(line);
      }

      buffer = bufferLines[bufferLines.length - 1];
    }

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
 * kept under STEP_STOP_GRACE_MS, itself under SHUTDOWN_ABORT_GRACE_MS, so a
 * step that ignores SIGTERM still records its cancellation; swamp model cancel
 * budgets its wait on it
 */
export const KILL_GRACE_MS = 3000;
const GROUP_POLL_MS = 50;

type TerminationMode =
  | "group"
  | "tree"
  | "child";

interface Spawned {
  child: Deno.ChildProcess;
  job?: ProcessJob;
  guardianControl?: WritableStreamDefaultWriter<Uint8Array>;
}

const liveProcessGroups = new Set<number>();
let unloadListenerInstalled = false;

/**
 * runs on unload, which fires on Deno.exit, so no isolated process group
 * outlives swamp
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
 * terminates at most once however many triggers fire, and never once the child
 * exited on its own: a late abort must not reach what it backgrounded
 */
interface Terminator {
  /** The child's status. Every path awaits this instead of `child.status`,
   *  so the terminator learns when the child exits. */
  status: Promise<Deno.CommandStatus>;
  terminate(): void;
  settled(): Promise<void>;
}

function createTerminator(
  { child, job, guardianControl }: Spawned,
  mode: TerminationMode,
  graceMs: number,
): Terminator {
  let running: Promise<void> | undefined;
  let exited = false;
  return {
    status: child.status.then(async (status) => {
      if (guardianControl) {
        try {
          await guardianControl.close();
        } catch { /* guardian already exited */ }
        guardianControl.releaseLock();
      }
      exited = true;
      // Exited on its own: what it backgrounded is not the exit sweep's.
      if (!running) {
        liveProcessGroups.delete(child.pid);
        try {
          job?.release();
        } catch { /* the job closes with swamp instead */ }
      }
      return status;
    }),
    terminate: () => {
      if (exited) return;
      running ??= guardianControl
        ? terminateGuardedProcess(child, guardianControl)
        : terminateProcess(child, mode, graceMs, job);
    },
    settled: () => running ?? Promise.resolve(),
  };
}

/** The guardian owns escalation and reaping; never kill the guardian group. */
async function terminateGuardedProcess(
  child: Deno.ChildProcess,
  control: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  try {
    await control.write(new Uint8Array([1]));
  } catch {
    try {
      await control.close();
    } catch { /* closed pipe also ends ownership */ }
  }
  try {
    await child.status;
  } catch { /* process already reaped */ }
}
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

/** never rejects: it is started from a synchronous listener and awaited later */
async function terminateProcess(
  child: Deno.ChildProcess,
  mode: TerminationMode,
  graceMs: number,
  job: ProcessJob | undefined,
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
  } finally {
    // After the tree kill, which walks parent links from the live child and
    // so reaches a process the command started before it joined the job.
    // The job then ends descendants whose parent already exited.
    try {
      job?.terminate();
    } catch { /* best effort, as above */ }
  }
}

async function terminateGroup(pgid: number, graceMs: number): Promise<void> {
  try {
    Deno.kill(-pgid, "SIGTERM");
  } catch {
    return;
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
    return;
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

  const guardian = getCommandGuardian();
  const isolated = !guardian && options.terminateProcessTree === true &&
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
  const lineOptions = { normalizeCrlf: options.normalizeCrlf === true };

  if (guardian) {
    commandOptions.args = [
      "__command_guardian",
      "--fence",
      guardian.fence,
      "--grace-ms",
      String(graceMs),
      "--",
      options.command,
      ...(options.args ?? []),
    ];
    commandOptions.stdin = "piped";
    // Survive engine process-group death long enough to kill/reap the target.
    commandOptions.detached = true;
  }
  const command = new Deno.Command(
    guardian?.executable ?? options.command,
    commandOptions,
  );
  const attachJob = options.attachJob ?? attachProcessJob;
  const spawn = (): Spawned => {
    const child = command.spawn();
    if (isolated) trackProcessGroup(child.pid);
    // Deno cannot spawn suspended, so a process the command starts before
    // this line runs is outside the job; `taskkill /T` still reaches it.
    const job = options.terminateProcessTree ? attachJob(child.pid) : undefined;
    return {
      child,
      job,
      guardianControl: guardian ? child.stdin.getWriter() : undefined,
    };
  };
  // waits out any termination, then stops tracking the group; a path ending
  // while the child still runs (a throwing output callback) terminates it
  // rather than leave it untracked
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
    // race the status against the timeout and drain pipes separately, so
    // orphans holding pipes open cannot cause a spurious timeout after a
    // successful exit
    const spawned = spawn();
    const process = spawned.child;
    const terminator = createTerminator(spawned, mode, graceMs);
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
      lineOptions,
    );
    const stderrPromise = streamLines(
      process.stderr,
      stderrOnLine,
      pipeAbort.signal,
      lineOptions,
    );

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

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
    const spawned = spawn();
    const process = spawned.child;
    const terminator = createTerminator(spawned, mode, graceMs);
    const pipeAbort = new AbortController();

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
        streamLines(
          process.stdout,
          (line) => {
            const redacted = redact(line);
            if (onOutput) onOutput(redacted, "stdout");
            logger.info(escapeLogTemplate(redacted));
          },
          pipeAbort.signal,
          lineOptions,
        ),
        streamLines(
          process.stderr,
          (line) => {
            const redacted = redact(line);
            if (onOutput) onOutput(redacted, "stderr");
            logger.warn(escapeLogTemplate(redacted));
          },
          pipeAbort.signal,
          lineOptions,
        ),
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
  } else {
    const spawned = spawn();
    const process = spawned.child;
    const terminator = createTerminator(spawned, mode, graceMs);
    const pipeAbort = new AbortController();

    const detachAbort = onSignalAbort(options.signal, () => {
      terminator.terminate();
      pipeAbort.abort();
    });

    try {
      const [stdoutResult, stderrResult, status] = await Promise.all([
        streamLines(process.stdout, undefined, pipeAbort.signal, lineOptions),
        streamLines(process.stderr, undefined, pipeAbort.signal, lineOptions),
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
