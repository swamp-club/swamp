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
import type {
  RpcChannel,
  RpcHandlerContext,
} from "../domain/remote/rpc_channel.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["worker", "bridge"]);

/**
 * The 9 metadata-RPC capability verbs that the bridge forwards from the
 * child runner to the orchestrator. Data-plane HTTP operations
 * (persistResource, persistFile, appendData, getData for bytes) go
 * directly from the child to the orchestrator — not through the bridge.
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
  /** RPC channel to the child runner (over StdioTransport). */
  childChannel: RpcChannel;
  /** RPC channel to the orchestrator (over WebSocket). */
  orchestratorChannel: RpcChannel;
  /** Dispatch ID injected into every bridged call for dispatch-scoped auth. */
  dispatchId: string;
  /** Signal to abort all bridged calls (e.g. dispatch cancelled). */
  signal: AbortSignal;
  /** Receives stream events from the child to forward to the orchestrator. */
  onChildStream?: (event: unknown) => void;
}

/**
 * Wire the capability RPC bridge: register handlers on the child channel
 * that forward each capability verb to the orchestrator channel and return
 * the response. Call IDs are mapped automatically by RpcChannel — each
 * side generates its own IDs.
 */
export function bridgeCapabilityVerbs(
  options: RunnerBridgeOptions,
): void {
  const { childChannel, orchestratorChannel, dispatchId, signal } = options;

  for (const verb of BRIDGED_VERBS) {
    childChannel.register(
      verb,
      async (params: unknown, ctx: RpcHandlerContext) => {
        logger.debug("Bridging {verb} from runner to orchestrator", { verb });
        const combinedSignal = AbortSignal.any([signal, ctx.signal]);
        const wrapped = { ...(params as Record<string, unknown>), dispatchId };
        return await orchestratorChannel.call(verb, wrapped, {
          signal: combinedSignal,
          timeoutMs: null,
          onStream: options.onChildStream
            ? (event) => options.onChildStream!(event)
            : undefined,
        });
      },
    );
  }
}

export { BRIDGED_VERBS };
