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
 * Dispatch runner entry point: executes exactly one dispatch in a child
 * process. The supervisor spawns `swamp worker exec-dispatch` with the
 * merged environment and communicates over length-prefixed stdio frames.
 *
 * stdout carries RPC frames ONLY — all logging and console output MUST
 * go to stderr. This is enforced before any model code loads.
 */

import { Definition } from "../domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../domain/models/method_execution_service.ts";
import type { DataHandle } from "../domain/models/model.ts";
import { withConsoleGuard } from "../domain/models/console_guard.ts";
import {
  dispatchErrorPaths,
  type DispatchExecution,
  type DispatchOutput,
  type DispatchResult,
} from "../domain/remote/protocol.ts";
import { RpcChannel } from "../domain/remote/rpc_channel.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../domain/remote/stdio_transport.ts";
import { createDataPlaneFetch, DataPlaneClient } from "./data_plane_client.ts";
import { WorkerBundleCache } from "./bundle_cache.ts";
import {
  createRemoteMethodContext,
  dispatchMethodArgs,
} from "./remote_method_context.ts";
import {
  type RunnerBootstrapParams,
  RunnerBootstrapParamsSchema,
} from "./runner_protocol.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { resolveExtraHeaders } from "../domain/auth/extra_headers.ts";

const logger = getSwampLogger(["worker", "runner"]);

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
 * Rebuild the definition named in a remote execution envelope so the worker
 * can run one method against it.
 *
 * The definition already exists on the dispatching side, so this reconstitutes
 * it with `Definition.fromData` rather than creating it. `Definition.create`
 * enforces the naming rule for new definitions (bf0320ef), which a definition
 * named before that rule may not meet; local loading accepts those names, and
 * so must the worker (swamp-club#2926). The path-traversal guard still applies.
 *
 * No typeVersion: the result is never persisted. The upgrade chain does not
 * run here either — only executeWorkflow upgrades, and it does so before
 * dispatching, so `methodArgs` are already migrated.
 */
export function definitionFromExecution(
  execution: DispatchExecution,
  methodArgs: Record<string, unknown>,
): Definition {
  return Definition.fromData({
    type: execution.modelType,
    id: execution.definitionMeta.id,
    name: execution.definitionMeta.name,
    version: execution.definitionMeta.version,
    tags: execution.definitionMeta.tags,
    globalArguments: execution.globalArgs,
    methods: { [execution.methodName]: { arguments: methodArgs } },
    inputs: undefined,
  });
}

/**
 * Run the dispatch runner. Called from the hidden `swamp worker exec-dispatch`
 * CLI command. Reads bootstrap params from the first stdin frame, executes
 * the dispatch, and returns the result over the stdio RPC channel.
 */
export async function runDispatchRunner(
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
): Promise<void> {
  const transport = new StdioTransport(stdout);
  const channel = new RpcChannel(transport);
  const cancelController = new AbortController();

  // Read the bootstrap frame (first frame on stdin).
  let bootstrapParams: RunnerBootstrapParams | null = null;
  let bootstrapResolve: (() => void) | null = null;
  let bootstrapReject: ((err: Error) => void) | null = null;
  const bootstrapReady = new Promise<void>((resolve, reject) => {
    bootstrapResolve = resolve;
    bootstrapReject = reject;
  });

  const readerDone = createStdioReader(
    stdin,
    (data) => {
      if (bootstrapParams === null) {
        bootstrapParams = RunnerBootstrapParamsSchema.parse(JSON.parse(data));
        bootstrapResolve!();
      } else {
        channel.handleRaw(data);
      }
    },
    () => {
      channel.close("stdin closed");
      cancelController.abort();
      bootstrapReject?.(new Error("stdin closed before bootstrap frame"));
    },
  );
  readerDone.catch(() => {});

  // Register cancel handler — the supervisor forwards rpc.cancel as a
  // direct "runner.cancel" call on our channel.
  channel.register("runner.cancel", () => {
    cancelController.abort();
    return Promise.resolve({});
  });

  await bootstrapReady;
  const params = bootstrapParams!;
  const dispatch = params.dispatch;
  const execution = dispatch.execution;

  const signal = cancelController.signal;
  const start = performance.now();
  const logs: string[] = [];
  let getHandles: () => DataHandle[] = () => [];

  let result: DispatchResult;

  const scratchDir = await Deno.makeTempDir({
    prefix: `swamp-dispatch-${dispatch.dispatchId.slice(0, 8)}-`,
  });

  try {
    // Built inside the try so a TLS client failure fails this dispatch
    // instead of crashing the runner before it reports a result.
    const client = new DataPlaneClient({
      baseUrl: params.dataPlaneUrl,
      credential: () => params.sessionCredential,
      extraHeaders: resolveExtraHeaders(),
      fetchImpl: createDataPlaneFetch(params.caCerts),
    });
    const bundleCache = new WorkerBundleCache(params.cacheDirPath, client);

    const { modelDef, filesDir } = await bundleCache.load(
      dispatch.bundleFingerprint,
      signal,
    );
    const method = modelDef.methods[execution.methodName];
    if (!method) {
      throw new Error(
        `Method '${execution.methodName}' not found on model '${execution.modelType}'`,
      );
    }

    const methodArgs = dispatch.probeMarker !== undefined &&
        execution.modelType === "swamp/fleet-probe"
      ? { ...dispatchMethodArgs(dispatch), probeMarker: dispatch.probeMarker }
      : dispatchMethodArgs(dispatch);

    const definition = definitionFromExecution(execution, methodArgs);

    const remote = createRemoteMethodContext({
      channel,
      client,
      dispatch,
      scratchDir,
      extensionFilesDir: filesDir ?? modelDef.extensionFilesRoot,
      signal,
      onEvent: (event) => {
        channel.call("runner.event", { event: { ...event } }, {
          timeoutMs: null,
          signal,
        }).catch(() => {});
      },
    });
    getHandles = remote.getHandles;

    const executor = new DefaultMethodExecutionService();
    const methodResult = await withConsoleGuard(
      () => executor.execute(definition, method, remote.context),
      logs,
      { jsonMode: true },
    );

    const handles = methodResult.dataHandles?.length
      ? methodResult.dataHandles
      : remote.getHandles();
    const durationMs = performance.now() - start;

    result = {
      status: "success",
      outputs: toOutputs(handles),
      logs,
      durationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Runner dispatch failed: {error}", { error: message });
    const durationMs = performance.now() - start;

    result = {
      status: "error",
      error: message,
      errorPaths: dispatchErrorPaths(error),
      outputs: toOutputs(getHandles()),
      logs,
      durationMs,
    };
  } finally {
    await Deno.remove(scratchDir, { recursive: true }).catch(() => {});
  }

  await transport.sendFinal(JSON.stringify({ type: "runner.result", result }));
  // Return rather than exit: the CLI then ends the runner's swamp.cli span
  // and flushes tracing before main.ts exits the process. Without that, every
  // runner span hangs off a root the collector never receives. Standalone
  // entry points exit themselves after this returns.
}
