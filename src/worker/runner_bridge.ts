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

import { RemoteMethod } from "../domain/remote/protocol.ts";
import { observeExecutionWork } from "../domain/remote/observability.ts";
import type {
  RpcChannel,
  RpcHandlerContext,
} from "../domain/remote/rpc_channel.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["worker", "bridge"]);

/**
 * data-plane HTTP operations go directly from the child to the orchestrator,
 * not through the bridge
 */
const BRIDGED_VERBS: readonly string[] = [
  RemoteMethod.getData,
  RemoteMethod.queryData,
  RemoteMethod.listVersions,
  RemoteMethod.deleteData,
  RemoteMethod.resolveSecret,
  RemoteMethod.putSecret,
  RemoteMethod.readDefinition,
  RemoteMethod.readOutput,
  RemoteMethod.resolveModel,
] as const;

export interface RunnerBridgeOptions {
  childChannel: RpcChannel;
  orchestratorChannel: RpcChannel;
  dispatchId: string;
  signal: AbortSignal;
  onChildStream?: (event: unknown) => void;
}

/**
 * strictly larger than the default call timeout so the child observes a stall
 * first; catches leaked pending calls when a child exits without rpc.cancel
 */
export const BRIDGE_CAPABILITY_TIMEOUT_MS = 180_000;

export function bridgeCapabilityVerbs(
  options: RunnerBridgeOptions,
): void {
  const { childChannel, orchestratorChannel, dispatchId, signal } = options;

  for (const verb of BRIDGED_VERBS) {
    childChannel.register(
      verb,
      async (params: unknown, ctx: RpcHandlerContext) => {
        const start = performance.now();
        logger.debug(
          "Bridging {verb} to orchestrator [{dispatchId}] (request {requestId})",
          { verb, dispatchId, requestId: ctx.requestId },
        );
        const combinedSignal = AbortSignal.any([signal, ctx.signal]);
        const { dispatchId: _childDispatchId, ...childParams } =
          params as Record<string, unknown>;
        const wrapped = { ...childParams, dispatchId };
        try {
          const result = await observeExecutionWork("rpc.server", {
            "swamp.rpc.request_id": ctx.requestId,
            "swamp.dispatch.id": dispatchId,
          }, (observation) => {
            ctx.responseTrace = observation.carrier;
            return orchestratorChannel.call(verb, wrapped, {
              signal: combinedSignal,
              timeoutMs: BRIDGE_CAPABILITY_TIMEOUT_MS,
              onStream: options.onChildStream
                ? (event) => options.onChildStream!(event)
                : undefined,
            });
          }, ctx.trace);
          const elapsedMs = Math.round(performance.now() - start);
          logger.debug(
            "Bridge {verb} completed in {elapsedMs}ms [{dispatchId}] (request {requestId})",
            { verb, elapsedMs, dispatchId, requestId: ctx.requestId },
          );
          return result;
        } catch (error) {
          const elapsedMs = Math.round(performance.now() - start);
          const message = error instanceof Error
            ? error.message
            : String(error);
          if (
            error instanceof DOMException && error.name === "TimeoutError"
          ) {
            logger.error(
              "Bridge {verb} timed out after {elapsedMs}ms [{dispatchId}] (request {requestId}): {error}",
              {
                verb,
                elapsedMs,
                dispatchId,
                requestId: ctx.requestId,
                error: message,
              },
            );
          } else {
            logger.warn(
              "Bridge {verb} failed after {elapsedMs}ms [{dispatchId}] (request {requestId}): {error}",
              {
                verb,
                elapsedMs,
                dispatchId,
                requestId: ctx.requestId,
                error: message,
              },
            );
          }
          throw error;
        }
      },
    );
  }
}

export { BRIDGED_VERBS };
