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
 * stdout carries RPC frames only; all logging and console output must go to
 * stderr, enforced before any model code loads
 */

import { Definition } from "../domain/definitions/definition.ts";
import {
  observeExecutionWork,
  type TraceCarrier,
} from "../domain/remote/observability.ts";
import { DefaultMethodExecutionService } from "../domain/models/method_execution_service.ts";
import type { DataHandle } from "../domain/models/model.ts";
import { withConsoleGuard } from "../domain/models/console_guard.ts";
import { wordedError, wordedText } from "../domain/behavior_wording.ts";
import {
  dispatchErrorCode,
  dispatchErrorPaths,
  type DispatchExecution,
  type DispatchOutput,
  type DispatchResult,
  plaintextFieldsOf,
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
  dispatchRedactor,
  dispatchSecretLoader,
  loadsOwnSecrets,
} from "./remote_method_context.ts";
import {
  RUNNER_ARGUMENTS_VALIDATED,
  type RunnerBootstrapParams,
  RunnerBootstrapParamsSchema,
} from "./runner_protocol.ts";
import {
  getSwampLogger,
  runFileSink,
} from "../infrastructure/logging/logger.ts";
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
 * rebuilt with Definition.fromData, not create, because create's naming rule
 * may reject names that local loading accepts; methodArgs are already migrated
 * and the result is never persisted
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
 * sent without waiting for the answer: the frame leaves ahead of the result on
 * the same ordered pipe, so serve sees it first; a failed report is logged, not
 * fatal
 */
function reportArgumentsValidated(
  channel: RpcChannel,
  signal: AbortSignal,
): Promise<void> {
  channel.call(RUNNER_ARGUMENTS_VALIDATED, {}, { timeoutMs: null, signal })
    .catch((error: unknown) => {
      logger.warn("Could not report the validated arguments: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return Promise.resolve();
}

export async function runDispatchRunner(
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
  options: { retainRedactorUntilExit?: boolean } = {},
): Promise<void> {
  const transport = new StdioTransport(stdout);
  const channel = new RpcChannel(transport);
  const cancelController = new AbortController();

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
  let completionTrace: TraceCarrier | undefined;

  const ownScratchDir = params.scratchDirPath === undefined;
  const scratchDir = params.scratchDirPath ?? await Deno.makeTempDir({
    prefix: `swamp-dispatch-${dispatch.dispatchId.slice(0, 8)}-`,
  });

  // one redactor for the dispatch, registered process-wide so stderr and
  // console output are masked before a line leaves; CLI entry points keep it
  // until exit because buffered traces flush later
  const redactor = dispatchRedactor(dispatch.secretValues);
  const redactorHandle = runFileSink.registerRedactor(redactor);

  try {
    // A version 6 dispatch loads its own secrets and carries none; one that
    // does is refused before anything reads it.
    const referencesOnly = loadsOwnSecrets(dispatch);
    const plaintext = referencesOnly ? plaintextFieldsOf(dispatch) : [];
    if (plaintext.length > 0) {
      throw new Error(
        `Refusing a protocol version ${execution.protocolVersion} dispatch that carries ${
          plaintext.join(", ")
        }: such a dispatch carries vault references only`,
      );
    }
    // Built inside the try so a TLS client failure fails this dispatch
    // instead of crashing the runner before it reports a result.
    const client = new DataPlaneClient({
      baseUrl: params.dataPlaneUrl,
      credential: () => params.sessionCredential,
      extraHeaders: resolveExtraHeaders(),
      fetchImpl: createDataPlaneFetch(params.caCerts),
    });
    const bundleCache = new WorkerBundleCache(params.cacheDirPath, client);

    const { modelDef, filesDir } = await observeExecutionWork(
      "worker.prepare",
      {
        "swamp.dispatch.id": dispatch.dispatchId,
      },
      () =>
        bundleCache.load(
          dispatch.bundleFingerprint,
          signal,
        ),
    );
    const method = modelDef.methods[execution.methodName];
    if (!method) {
      throw wordedError(
        wordedText((w) =>
          `Method '${execution.methodName}' not found on ${w.noun} '${execution.modelType}'`
        ),
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
      resourceSpecs: modelDef.resources,
      signal,
      redactor,
      onEvent: (event) => {
        channel.call("runner.event", { event: { ...event } }, {
          timeoutMs: null,
          signal,
        }).catch(() => {});
      },
    });
    getHandles = remote.getHandles;

    const executor = new DefaultMethodExecutionService();
    // references load once through the protected route before arguments are
    // validated on this worker; serve learns the parse passed from the runner
    // itself, never from a method's events
    const run = referencesOnly
      ? () =>
        executor.executeDispatched(
          definition,
          modelDef,
          execution.methodName,
          remote.context,
          {
            secretLoader: dispatchSecretLoader(client, redactor, signal),
            onArgumentsValidated: () =>
              reportArgumentsValidated(channel, signal),
          },
        )
      : () => executor.execute(definition, method, remote.context);
    const methodResult = await observeExecutionWork("worker.execute", {
      "swamp.dispatch.id": dispatch.dispatchId,
      "swamp.lease.id": dispatch.leaseId,
    }, (observation) => {
      completionTrace = observation.carrier;
      return withConsoleGuard(run, logs, { jsonMode: true });
    });

    const handles = methodResult.dataHandles?.length
      ? methodResult.dataHandles
      : remote.getHandles();
    const durationMs = performance.now() - start;

    result = {
      status: "success",
      outputs: toOutputs(handles),
      logs: logs.map((line) => redactor.redact(line)),
      durationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = dispatchErrorCode(error);
    logger.warn("Runner dispatch failed: {error}", { error: message });
    const durationMs = performance.now() - start;

    result = {
      status: "error",
      error: redactor.redact(message),
      errorPaths: dispatchErrorPaths(error),
      errorCode: code === undefined ? undefined : redactor.redact(code),
      outputs: toOutputs(getHandles()),
      logs: logs.map((line) => redactor.redact(line)),
      durationMs,
    };
  } finally {
    if (!options.retainRedactorUntilExit) {
      runFileSink.unregisterRedactor(redactorHandle);
    }
    if (ownScratchDir) {
      await Deno.remove(scratchDir, { recursive: true }).catch(() => {});
    }
  }

  result.trace = completionTrace;
  await transport.sendFinal(JSON.stringify({ type: "runner.result", result }));
  // return rather than exit so the CLI ends the runner's span and flushes
  // tracing before main.ts exits
}
