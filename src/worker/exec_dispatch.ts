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
import type {
  DispatchOutput,
  DispatchResult,
} from "../domain/remote/protocol.ts";
import { RpcChannel } from "../domain/remote/rpc_channel.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../domain/remote/stdio_transport.ts";
import { DataPlaneClient } from "./data_plane_client.ts";
import { WorkerBundleCache } from "./bundle_cache.ts";
import { createRemoteMethodContext } from "./remote_method_context.ts";
import {
  type RunnerBootstrapParams,
  RunnerBootstrapParamsSchema,
} from "./runner_protocol.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

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

function serializeFollowUpActions(
  result: {
    followUpActions?: Array<{
      methodName: string;
      delayMs?: number;
      maxRetries?: number;
    }>;
  },
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
  const bootstrapReady = new Promise<void>((resolve) => {
    bootstrapResolve = resolve;
  });

  createStdioReader(
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
    },
  );

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

  const client = new DataPlaneClient({
    baseUrl: params.dataPlaneUrl,
    credential: () => params.sessionCredential,
  });
  const bundleCache = new WorkerBundleCache(params.cacheDirPath, client);

  const signal = cancelController.signal;
  const start = performance.now();
  const logs: string[] = [];
  let getHandles: () => DataHandle[] = () => [];

  let result: DispatchResult;

  const scratchDir = await Deno.makeTempDir({
    prefix: `swamp-dispatch-${dispatch.dispatchId.slice(0, 8)}-`,
  });

  try {
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
      ? { ...execution.methodArgs, probeMarker: dispatch.probeMarker }
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
      followUpActions: serializeFollowUpActions(methodResult),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Runner dispatch failed: {error}", { error: message });
    const durationMs = performance.now() - start;

    result = {
      status: "error",
      error: message,
      outputs: toOutputs(getHandles()),
      logs,
      durationMs,
    };
  } finally {
    await Deno.remove(scratchDir, { recursive: true }).catch(() => {});
  }

  // Send the result as the final RPC frame and exit. Do not await
  // readerDone — the stdin reader blocks on read() until the supervisor
  // closes the pipe, but the supervisor waits on child.status first.
  // Exiting the process closes all handles cleanly.
  transport.send(JSON.stringify({ type: "runner.result", result }));
  await transport.close();
}
