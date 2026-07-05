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
 * Executes one dispatched step in-process: applies the shipped environment
 * snapshot, loads the model (built-in registry or fetched bundle), builds
 * the remote MethodContext, and runs the method through the same
 * DefaultMethodExecutionService a local run uses. Dispatches execute
 * SERIALLY — the environment overlay mutates process-global state, which is
 * only correct without concurrent dispatches (v1 worker concurrency = 1;
 * recorded in the design doc).
 */

import { Definition } from "../domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../domain/models/method_execution_service.ts";
import type { DataHandle, MethodResult } from "../domain/models/model.ts";
import { withConsoleGuard } from "../domain/models/console_guard.ts";
import {
  type EnvironmentSnapshot,
  isDeniedEnvVar,
} from "../domain/remote/environment_snapshot.ts";
import {
  type DispatchOutput,
  DispatchParamsSchema,
  type DispatchResult,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import {
  type RpcChannel,
  RpcError,
  type RpcHandlerContext,
} from "../domain/remote/rpc_channel.ts";
import type { DataPlaneClient } from "./data_plane_client.ts";
import type { WorkerBundleCache } from "./bundle_cache.ts";
import { createRemoteMethodContext } from "./remote_method_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["worker", "dispatch"]);

/**
 * Apply a shipped environment snapshot to the process env, returning the
 * restore function. Denylisted names never apply (defense in depth — a
 * conforming orchestrator never ships them). The restore function runs on
 * every exit path, including throw and cancel.
 */
export function applyEnvironmentOverlay(
  snapshot: EnvironmentSnapshot,
): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(snapshot)) {
    if (isDeniedEnvVar(name)) {
      continue;
    }
    saved.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }
  return () => {
    for (const [name, previous] of saved) {
      if (previous === undefined) {
        Deno.env.delete(name);
      } else {
        Deno.env.set(name, previous);
      }
    }
  };
}

function toOutputs(handles: DataHandle[]): DispatchOutput[] {
  return handles.map((handle) => ({
    dataId: String(handle.dataId),
    version: handle.version,
    name: handle.name,
    specName: handle.specName,
    type: handle.kind,
  }));
}

/**
 * Follow-up actions travel serialized; `continueCondition` is a function
 * and cannot cross the wire — the orchestrator re-evaluates conditions
 * against the returned handles.
 */
function serializeFollowUpActions(
  result: MethodResult,
): unknown[] | undefined {
  if (!result.followUpActions || result.followUpActions.length === 0) {
    return undefined;
  }
  return result.followUpActions.map((action) => ({
    methodName: action.methodName,
    delayMs: action.delayMs,
    maxRetries: action.maxRetries,
  }));
}

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
  client: DataPlaneClient;
  bundleCache: WorkerBundleCache;
  /** Receives dispatch start/finish notifications (connect-mode output). */
  onDispatch?: (event: WorkerDispatchEvent) => void;
  /** Test seam: overrides the method executor. */
  executor?: Pick<DefaultMethodExecutionService, "execute">;
}

/** Registers the dispatch handler on an enrolled worker channel. */
export function registerDispatchHandler(
  options: DispatchHandlerOptions,
): void {
  let busy = false;
  options.channel.register(WorkerMethod.dispatch, async (rawParams, ctx) => {
    if (busy) {
      throw new RpcError({
        code: "worker_busy",
        message:
          "Worker is already executing a dispatch (v1 dispatches are serial)",
      });
    }
    busy = true;
    try {
      return await handleDispatch(rawParams, ctx, options);
    } finally {
      busy = false;
    }
  });
}

async function handleDispatch(
  rawParams: unknown,
  ctx: RpcHandlerContext,
  options: DispatchHandlerOptions,
): Promise<DispatchResult> {
  const params = DispatchParamsSchema.parse(rawParams);
  const execution = params.execution;
  const start = performance.now();
  const logs: string[] = [];

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

  const scratchDir = await Deno.makeTempDir({
    prefix: `swamp-dispatch-${params.dispatchId.slice(0, 8)}-`,
  });
  const restoreEnv = applyEnvironmentOverlay(params.environmentSnapshot);
  // W3C trace context applies after the overlay so the dispatch-specific
  // parent always wins; extensions and subprocesses that initialize their
  // own OTel SDK read TRACEPARENT/TRACESTATE to join the orchestrator's
  // trace (mirrors the in-process executor).
  const restoreTrace = applyEnvironmentOverlay(
    Object.fromEntries(
      Object.entries(execution.traceHeaders ?? {}).map((
        [key, value],
      ) => [key.toUpperCase().replace(/-/g, "_"), value]),
    ),
  );
  let getHandles: () => DataHandle[] = () => [];

  try {
    const { modelDef, filesDir } = await options.bundleCache.load(
      params.bundleFingerprint,
      ctx.signal,
    );
    const method = modelDef.methods[execution.methodName];
    if (!method) {
      throw new Error(
        `Method '${execution.methodName}' not found on model '${execution.modelType}'`,
      );
    }

    const methodArgs = params.probeMarker !== undefined &&
        execution.modelType === "swamp/fleet-probe"
      ? { ...execution.methodArgs, probeMarker: params.probeMarker }
      : execution.methodArgs;

    const definition = Definition.create({
      type: execution.modelType,
      id: execution.definitionMeta.id,
      name: execution.definitionMeta.name,
      version: execution.definitionMeta.version,
      tags: execution.definitionMeta.tags,
      globalArguments: execution.globalArgs,
      methods: { [execution.methodName]: { arguments: methodArgs } },
    });

    const remote = createRemoteMethodContext({
      channel: options.channel,
      client: options.client,
      dispatch: params,
      scratchDir,
      extensionFilesDir: filesDir ?? modelDef.extensionFilesRoot,
      signal: ctx.signal,
      onEvent: (event) => {
        ctx.stream({ kind: "method_event", event: { ...event } });
      },
    });
    getHandles = remote.getHandles;

    const executor = options.executor ?? new DefaultMethodExecutionService();
    const result = await withConsoleGuard(
      () => executor.execute(definition, method, remote.context),
      logs,
    );

    const handles = result.dataHandles?.length
      ? result.dataHandles
      : remote.getHandles();
    const durationMs = performance.now() - start;
    logger.info(
      "Dispatch {dispatchId} finished: {modelType}.{methodName} succeeded in {durationMs}ms",
      {
        dispatchId: params.dispatchId,
        modelType: execution.modelType,
        methodName: execution.methodName,
        durationMs: Math.round(durationMs),
      },
    );
    options.onDispatch?.({
      kind: "dispatch_finished",
      dispatchId: params.dispatchId,
      modelType: execution.modelType,
      methodName: execution.methodName,
      status: "success",
      durationMs,
    });
    return {
      status: "success",
      outputs: toOutputs(handles),
      logs,
      durationMs,
      followUpActions: serializeFollowUpActions(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Dispatch {dispatchId} failed: {error}", {
      dispatchId: params.dispatchId,
      error: message,
    });
    const durationMs = performance.now() - start;
    options.onDispatch?.({
      kind: "dispatch_finished",
      dispatchId: params.dispatchId,
      modelType: execution.modelType,
      methodName: execution.methodName,
      status: "error",
      durationMs,
      error: message,
    });
    // Writes that landed before the throw stay visible — the same
    // write-then-throw contract as a local run.
    return {
      status: "error",
      error: message,
      outputs: toOutputs(getHandles()),
      logs,
      durationMs,
    };
  } finally {
    restoreTrace();
    restoreEnv();
    await Deno.remove(scratchDir, { recursive: true }).catch(() => {});
  }
}
