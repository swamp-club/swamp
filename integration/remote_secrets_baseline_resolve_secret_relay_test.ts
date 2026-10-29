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
 * Remote-secrets baseline, path 3: the resolveSecret control-RPC relay
 * (swamp-club#3512).
 *
 * Wires the three hops in-process: the runner's RpcChannel over stdio pipes,
 * the supervisor's `bridgeCapabilityVerbs`, and a worker control channel
 * enrolled with serve, whose `CapabilityService.registerHandlers` answers.
 * The dispatch is registered through the real `DispatchService` path. Pins
 * what crosses each hop and what each hop logs; Phase 5 moves secret reads
 * off this relay (design/enablers/typed-secrets.md §9).
 */

import "../src/domain/models/models.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { RpcChannel, RpcError } from "../src/domain/remote/rpc_channel.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../src/domain/remote/stdio_transport.ts";
import {
  type DispatchParams,
  type DispatchResult,
  RemoteMethod,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import { bridgeCapabilityVerbs } from "../src/worker/runner_bridge.ts";
import {
  BASELINE_VAULT,
  canary,
  type CapturedLog,
  captureLogs,
  connectInMemoryWorker,
  logsHolding,
  startBaselineOrchestrator,
  withTempDir,
} from "./remote_secrets_baseline_harness.ts";
import { IT_DEFINITION_ID, IT_TYPE } from "./remote_execution_test_model.ts";

await initializeLogging({});

interface Relay {
  /** The runner's channel; calls here go runner → supervisor → serve. */
  runner: RpcChannel;
  /** The dispatch the supervisor bridge stamps on every call. */
  dispatchId: string;
  /** Params as the bridge sent them on to serve. */
  forwarded: Record<string, unknown>[];
  /** A key the dispatched step references, stored with `value`. */
  allowedKey: string;
  value: string;
  /** A key the step references but the vault does not hold. */
  missingKey: string;
}

/**
 * Starts an orchestrator, enrolls an in-memory worker and dispatches a step
 * whose method args reference `allowedKey` and `missingKey` with literal
 * vault.get calls. While the dispatch is held open on the worker, `fn` runs
 * against a runner channel bridged to serve exactly as the supervisor
 * bridges a child runner.
 */
async function withRelay(fn: (relay: Relay) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const o = await startBaselineOrchestrator(dir);
    const workerName = `relay-${crypto.randomUUID().slice(0, 8)}`;
    const allowedKey = `relay-allowed-${crypto.randomUUID()}`;
    const missingKey = `relay-missing-${crypto.randomUUID()}`;
    const value = canary("relay");
    await o.putSecret(allowedKey, value);

    const worker = await connectInMemoryWorker(o, workerName);
    let dispatch: DispatchParams | null = null;
    let release: (result: DispatchResult) => void = () => {};
    const held = new Promise<DispatchResult>((resolve) => release = resolve);
    worker.channel.register(WorkerMethod.dispatch, (params) => {
      dispatch = params as DispatchParams;
      return held;
    });

    const step = o.dispatchService.executeRemote({
      placeArguments: (args) => args,
      placement: { target: workerName },
      modelDef: modelRegistry.get(IT_TYPE)!,
      modelType: IT_TYPE,
      modelId: IT_DEFINITION_ID,
      methodName: "run",
      definitionName: "remote-it-def",
      definitionTags: {},
      definitionMeta: {
        id: IT_DEFINITION_ID,
        name: "remote-it-def",
        version: 1,
        tags: {},
      },
      globalArgs: {},
      methodArgs: {
        echo: `\${{ vault.get("${BASELINE_VAULT}", "${allowedKey}") }} ` +
          `\${{ vault.get("${BASELINE_VAULT}", "${missingKey}") }}`,
      },
      workflowName: "relay-workflow",
      stepName: "relay-step",
    });

    // runner → supervisor and supervisor → runner stdio pipes.
    const toSupervisor = new TransformStream<Uint8Array>();
    const toRunner = new TransformStream<Uint8Array>();
    const runnerTransport = new StdioTransport(toSupervisor.writable);
    const supervisorTransport = new StdioTransport(toRunner.writable);
    const runner = new RpcChannel(runnerTransport);
    const supervisorChild = new RpcChannel(supervisorTransport);
    const runnerReader = createStdioReader(
      toRunner.readable,
      (data) => runner.handleRaw(data),
      () => runner.close("closed"),
    );
    const supervisorReader = createStdioReader(
      toSupervisor.readable,
      (data) => supervisorChild.handleRaw(data),
      () => supervisorChild.close("closed"),
    );
    const bridgeStop = new AbortController();
    const forwarded: Record<string, unknown>[] = [];

    try {
      await waitFor(() => dispatch !== null, "the dispatch reached the worker");
      const dispatchId = (dispatch as DispatchParams | null)!.dispatchId;
      // Records what the bridge forwards, then sends it on unchanged.
      const orchestrator = {
        call: (
          verb: string,
          params: unknown,
          options: Parameters<RpcChannel["call"]>[2],
        ) => {
          forwarded.push(params as Record<string, unknown>);
          return worker.channel.call(verb, params, options);
        },
      } as unknown as RpcChannel;
      bridgeCapabilityVerbs({
        childChannel: supervisorChild,
        orchestratorChannel: orchestrator,
        dispatchId,
        signal: bridgeStop.signal,
      });

      await fn({
        runner,
        dispatchId,
        forwarded,
        allowedKey,
        value,
        missingKey,
      });
    } finally {
      release({ status: "success", outputs: [], logs: [], durationMs: 1 });
      await step.catch(() => {});
      bridgeStop.abort();
      runner.close("done");
      supervisorChild.close("done");
      runnerTransport.close();
      supervisorTransport.close();
      await toSupervisor.writable.close().catch(() => {});
      await toRunner.writable.close().catch(() => {});
      await runnerReader.catch(() => {});
      await supervisorReader.catch(() => {});
      // No dropSocket: shutdown disposes the gateway, and a socket drop here
      // races its disconnect-record write against temp-dir removal.
      await o.shutdown();
    }
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * One hop's records as `level: text`, with the per-run dispatch id, request
 * ids, worker name and durations replaced by placeholders.
 */
function hop(logs: CapturedLog[], category: string): string[] {
  return logs
    .filter((log) => log.category === category)
    .map((log) =>
      `${log.level}: ${log.text}`
        .replace(/\[[0-9a-f-]{36}\]/g, "[<dispatch>]")
        .replace(UUID, "<id>")
        .replace(/relay-[0-9a-f]{8}\b/g, "<worker>")
        .replace(/\d+ms/g, "<n>ms")
    );
}

Deno.test({
  name:
    "remote secrets baseline: resolveSecret relay: the bridge replaces a runner-supplied dispatchId with its own",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRelay(async (relay) => {
      const forged = crypto.randomUUID();
      const reply = await relay.runner.call<{ value: unknown }>(
        RemoteMethod.resolveSecret,
        {
          vaultName: BASELINE_VAULT,
          secretKey: relay.allowedKey,
          dispatchId: forged,
        },
      );

      assertEquals(reply, { value: relay.value });
      assertEquals(relay.forwarded, [{
        vaultName: BASELINE_VAULT,
        secretKey: relay.allowedKey,
        dispatchId: relay.dispatchId,
      }]);
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: resolveSecret relay: a served value crosses every hop unchanged and no hop logs it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRelay(async (relay) => {
      let reply: unknown;
      const logs = await captureLogs(async () => {
        reply = await relay.runner.call(RemoteMethod.resolveSecret, {
          vaultName: BASELINE_VAULT,
          secretKey: relay.allowedKey,
        });
      });

      // Plaintext travels the control channel and both stdio pipes: the
      // relay Phase 5 replaces with a protected data-plane reveal route.
      assertEquals(reply, { value: relay.value });
      assertEquals(logsHolding(logs, relay.value), []);

      assertEquals(hop(logs, "worker.bridge"), [
        "debug: Bridging capability.resolveSecret to orchestrator [<dispatch>] (request <id>)",
        "debug: Bridge capability.resolveSecret completed in <n>ms [<dispatch>] (request <id>)",
      ]);
      assertEquals(hop(logs, "serve.capability"), [
        "debug: Handler start: capability.resolveSecret for worker <worker> (request <id>)",
        "debug: Handler done: capability.resolveSecret for worker <worker> in <n>ms (request <id>)",
      ]);
    });
  },
});

/** Calls resolveSecret from the runner and returns the error it gets. */
async function refused(
  relay: Relay,
  secretKey: string,
): Promise<{ error: RpcError; logs: CapturedLog[] }> {
  let error: RpcError | undefined;
  const logs = await captureLogs(async () => {
    error = await assertRejects(
      () =>
        relay.runner.call(RemoteMethod.resolveSecret, {
          vaultName: BASELINE_VAULT,
          secretKey,
        }),
      RpcError,
    );
  });
  return { error: error!, logs };
}

Deno.test({
  name:
    "remote secrets baseline: resolveSecret relay: an unreferenced key is refused, and serve and the bridge both warn with the raw message",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRelay(async (relay) => {
      const key = `relay-unreferenced-${crypto.randomUUID()}`;
      const denial =
        `resolveSecret: secret '${key}' is not referenced by the dispatched step`;
      const { error, logs } = await refused(relay, key);

      // sanitizeRpcError masks only paths and long messages, so the runner
      // receives the same text serve logs.
      assertEquals(error.code, "handler_failed");
      assertEquals(error.message, denial);
      assertEquals(hop(logs, "serve.capability"), [
        "debug: Handler start: capability.resolveSecret for worker <worker> (request <id>)",
        `warning: Handler error: capability.resolveSecret for worker <worker> after <n>ms (request <id>): ${
          denial.replace(UUID, "<id>")
        }`,
      ]);
      assertEquals(hop(logs, "worker.bridge"), [
        "debug: Bridging capability.resolveSecret to orchestrator [<dispatch>] (request <id>)",
        `warning: Bridge capability.resolveSecret failed after <n>ms [<dispatch>] (request <id>): ${
          denial.replace(UUID, "<id>")
        }`,
      ]);
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: resolveSecret relay: a vault error on a referenced key reaches the runner as serve logged it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRelay(async (relay) => {
      const vaultError =
        `Secret '${relay.missingKey}' not found in local vault '${BASELINE_VAULT}'`;
      const { error, logs } = await refused(relay, relay.missingKey);

      assertEquals(error.code, "handler_failed");
      assertEquals(error.message, vaultError);
      assertEquals(hop(logs, "serve.capability"), [
        "debug: Handler start: capability.resolveSecret for worker <worker> (request <id>)",
        `warning: Handler error: capability.resolveSecret for worker <worker> after <n>ms (request <id>): ${
          vaultError.replace(UUID, "<id>")
        }`,
      ]);
      assertEquals(hop(logs, "worker.bridge"), [
        "debug: Bridging capability.resolveSecret to orchestrator [<dispatch>] (request <id>)",
        `warning: Bridge capability.resolveSecret failed after <n>ms [<dispatch>] (request <id>): ${
          vaultError.replace(UUID, "<id>")
        }`,
      ]);
    });
  },
});
