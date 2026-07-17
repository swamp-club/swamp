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

/**
 * The worker's dispatch handler (see design/remote-execution.md).
 *
 * Each dispatch spawns a child process (dispatch runner) via
 * `swamp worker exec-dispatch`. The environment snapshot is applied as the
 * child's spawn environment (no global mutation). The supervisor bridges
 * capability RPCs between the child and the orchestrator over a
 * StdioTransport. A runner crash fails only that dispatch, not the worker.
 *
 * Each dispatch spawns one runner. The handler accepts up to `capacity`
 * concurrent dispatches, rejecting with `worker_busy` when all slots are full.
 * Capacity 1 is byte-for-byte identical to the prior serial behavior.
 */

import {
  overlayEnvironment,
  stripWorkerCredentials,
} from "../domain/remote/environment_snapshot.ts";
import {
  DispatchParamsSchema,
  type DispatchResult,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import {
  RpcChannel,
  RpcError,
  type RpcHandlerContext,
} from "../domain/remote/rpc_channel.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../domain/remote/stdio_transport.ts";
import { basename, fromFileUrl } from "@std/path";
import { bridgeCapabilityVerbs } from "./runner_bridge.ts";
import type { RunnerBootstrapParams } from "./runner_protocol.ts";
import { RUNNER_CANCEL_GRACE_MS } from "./runner_protocol.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["worker", "dispatch"]);

/** Worker-visible lifecycle of one dispatch, for connect-mode output. */
export type WorkerDispatchEvent =
  | {
    kind: "dispatch_started";
    dispatchId: string;
    modelType: string;
    methodName: string;
    workflowName?: string;
    stepName?: string;
  }
  | {
    kind: "dispatch_finished";
    dispatchId: string;
    modelType: string;
    methodName: string;
    status: "success" | "error";
    durationMs: number;
    error?: string;
  };

export interface DispatchHandlerOptions {
  channel: RpcChannel;
  /** Session credential getter for the data plane. */
  sessionCredential: () => string;
  /** Base URL of the orchestrator's HTTP data plane. */
  dataPlaneUrl: string;
  /** Path to the shared bundle cache directory. */
  cacheDirPath: string;
  /** Maximum concurrent dispatches (default 1). */
  capacity: number;
  /** Receives dispatch start/finish notifications (connect-mode output). */
  onDispatch?: (event: WorkerDispatchEvent) => void;
  /** Override the runner command + args (test seam). */
  runnerCommand?: { cmd: string; args: string[] };
}

export interface DispatchHandlerHandle {
  /** Signal the handler to reject new dispatches and resolve when in-flight work completes. */
  drain: () => Promise<void>;
}

/** Registers the dispatch handler on an enrolled worker channel. */
export function registerDispatchHandler(
  options: DispatchHandlerOptions,
): DispatchHandlerHandle {
  let activeRunners = 0;
  const capacity = options.capacity;
  let draining = false;
  let onDrainComplete: (() => void) | null = null;

  options.channel.register(WorkerMethod.dispatch, async (rawParams, ctx) => {
    if (draining) {
      throw new RpcError({
        code: "worker_draining",
        message: "Worker is draining — no new dispatches accepted",
      });
    }
    if (activeRunners >= capacity) {
      throw new RpcError({
        code: "worker_busy",
        message:
          `Worker is at capacity (${activeRunners}/${capacity} slots in use)`,
      });
    }
    activeRunners++;
    try {
      return await handleDispatch(rawParams, ctx, options);
    } finally {
      activeRunners--;
      if (draining && activeRunners === 0 && onDrainComplete) {
        onDrainComplete();
      }
    }
  });

  return {
    drain: () => {
      draining = true;
      if (activeRunners === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        onDrainComplete = resolve;
      });
    },
  };
}

async function handleDispatch(
  rawParams: unknown,
  ctx: RpcHandlerContext,
  options: DispatchHandlerOptions,
): Promise<DispatchResult> {
  const params = DispatchParamsSchema.parse(rawParams);
  const execution = params.execution;
  const start = performance.now();

  logger.info(
    "Dispatch {dispatchId} started: {modelType}.{methodName}",
    {
      dispatchId: params.dispatchId,
      modelType: execution.modelType,
      methodName: execution.methodName,
    },
  );
  options.onDispatch?.({
    kind: "dispatch_started",
    dispatchId: params.dispatchId,
    modelType: execution.modelType,
    methodName: execution.methodName,
    workflowName: params.step?.workflowName,
    stepName: params.step?.stepName,
  });

  // Build the spawn environment: overlay the shipped snapshot onto the
  // worker's own environment, then apply W3C trace context on top.
  let spawnEnv = overlayEnvironment(
    Deno.env.toObject(),
    params.environmentSnapshot,
  );
  if (execution.traceHeaders) {
    const traceSnapshot: Record<string, string> = {};
    for (const [key, value] of Object.entries(execution.traceHeaders)) {
      traceSnapshot[key.toUpperCase().replace(/-/g, "_")] = value;
    }
    spawnEnv = overlayEnvironment(spawnEnv, traceSnapshot);
  }
  spawnEnv = stripWorkerCredentials(spawnEnv);

  const rawParams2 = rawParams as Record<string, unknown>;
  const dispatchCredential = rawParams2.dispatchCredential as
    | string
    | undefined;
  const bootstrapParams: RunnerBootstrapParams = {
    sessionCredential: dispatchCredential ?? options.sessionCredential(),
    dataPlaneUrl: options.dataPlaneUrl,
    cacheDirPath: options.cacheDirPath,
    dispatch: params,
  };

  const runnerCmd = options.runnerCommand ?? deriveRunnerCommand();
  const child = new Deno.Command(runnerCmd.cmd, {
    args: runnerCmd.args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: spawnEnv,
  }).spawn();

  const childTransport = new StdioTransport(child.stdin);
  const childChannel = new RpcChannel(childTransport);
  const cancelController = new AbortController();

  // Bridge capability verbs from child → orchestrator.
  bridgeCapabilityVerbs({
    childChannel,
    orchestratorChannel: options.channel,
    dispatchId: params.dispatchId,
    signal: cancelController.signal,
  });

  // Forward stream events from the child to the orchestrator.
  childChannel.register("runner.event", (eventParams: unknown) => {
    const p = eventParams as { event: Record<string, unknown> };
    ctx.stream({ kind: "method_event", event: p.event });
    return Promise.resolve({});
  });

  // Start reading from the child's stdout and stderr BEFORE sending
  // the bootstrap frame. If the child responds before the supervisor
  // starts reading, the pipe buffer fills and both sides deadlock.
  const resultBox: { value: DispatchResult | null } = { value: null };
  const readerDone = createStdioReader(
    child.stdout,
    (data) => {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.type === "runner.result") {
        resultBox.value = parsed.result as DispatchResult;
      } else {
        childChannel.handleRaw(data);
      }
    },
    () => {
      childChannel.close("child stdout closed");
    },
  );

  const stderrChunks: Uint8Array[] = [];
  const stderrDone = (async () => {
    const reader = child.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrChunks.push(new Uint8Array(value));
    }
    reader.releaseLock();
  })();

  // Send bootstrap params as the first frame (after readers are active).
  childTransport.send(JSON.stringify(bootstrapParams));

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onCancel = () => {
    cancelController.abort();
    // Try cooperative cancel; force-kill after the grace period
    // regardless of whether the cooperative path succeeded.
    childChannel.call("runner.cancel", {}, {
      timeoutMs: RUNNER_CANCEL_GRACE_MS,
    }).catch(() => {});
    killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }, RUNNER_CANCEL_GRACE_MS);
  };
  ctx.signal.addEventListener("abort", onCancel, { once: true });

  try {
    // Wait for the child to finish.
    const status = await child.status;
    await readerDone.catch(() => {});
    await stderrDone.catch(() => {});

    const durationMs = performance.now() - start;

    // Log child stderr.
    if (stderrChunks.length > 0) {
      const stderr = new TextDecoder().decode(concatChunks(stderrChunks));
      if (stderr.trim()) {
        for (const line of stderr.trim().split("\n")) {
          logger.debug("Runner [{dispatchId}]: {line}", {
            dispatchId: params.dispatchId,
            line,
          });
        }
      }
    }

    const result = resultBox.value;
    if (result) {
      const statusStr = result.status === "success" ? "succeeded" : "failed";
      logger.info(
        "Dispatch {dispatchId} finished: {modelType}.{methodName} {status} in {durationMs}ms",
        {
          dispatchId: params.dispatchId,
          modelType: execution.modelType,
          methodName: execution.methodName,
          status: statusStr,
          durationMs: Math.round(durationMs),
        },
      );
      options.onDispatch?.({
        kind: "dispatch_finished",
        dispatchId: params.dispatchId,
        modelType: execution.modelType,
        methodName: execution.methodName,
        status: result.status,
        durationMs,
        error: result.error,
      });
      return result;
    }

    // Child exited without sending a result — treat as crash.
    const message = status.success
      ? "Runner exited without sending a result"
      : `Runner crashed with exit code ${status.code}`;

    logger.warn("Dispatch {dispatchId} failed: {error}", {
      dispatchId: params.dispatchId,
      error: message,
    });
    options.onDispatch?.({
      kind: "dispatch_finished",
      dispatchId: params.dispatchId,
      modelType: execution.modelType,
      methodName: execution.methodName,
      status: "error",
      durationMs,
      error: message,
    });
    return {
      status: "error",
      error: message,
      outputs: [],
      logs: [],
      durationMs,
    };
  } finally {
    ctx.signal.removeEventListener("abort", onCancel);
    if (killTimer !== undefined) clearTimeout(killTimer);
    childTransport.close();
  }
}

function deriveRunnerCommand(): { cmd: string; args: string[] } {
  const execPath = Deno.execPath();
  const base = basename(execPath);
  if (base === "deno" || base === "deno.exe") {
    const entryPoint = fromFileUrl(
      new URL(
        "../cli/commands/worker_exec_dispatch_entry.ts",
        import.meta.url,
      ),
    );
    return {
      cmd: execPath,
      args: [
        "run",
        "--unstable-bundle",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        "--allow-sys",
        entryPoint,
      ],
    };
  }
  return { cmd: execPath, args: ["worker", "exec-dispatch"] };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
