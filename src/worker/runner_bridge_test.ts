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

import { assertEquals, assertRejects } from "@std/assert";
import { RpcChannel, RpcError } from "../domain/remote/rpc_channel.ts";
import { RemoteMethod } from "../domain/remote/protocol.ts";
import { bridgeCapabilityVerbs, BRIDGED_VERBS } from "./runner_bridge.ts";

function channelPair(): { a: RpcChannel; b: RpcChannel } {
  const a: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => b.handleRaw(data)),
  });
  const b: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => a.handleRaw(data)),
  });
  return { a, b };
}

Deno.test("bridgeCapabilityVerbs: forwards getData from runner to orchestrator", async () => {
  const runnerPair = channelPair();
  const orchPair = channelPair();

  orchPair.b.register(
    RemoteMethod.getData,
    (params) => Promise.resolve({ found: true, data: params }),
  );

  bridgeCapabilityVerbs({
    childChannel: runnerPair.b,
    orchestratorChannel: orchPair.a,
    signal: AbortSignal.timeout(5_000),
  });

  const result = await runnerPair.a.call<{ found: boolean; data: unknown }>(
    RemoteMethod.getData,
    { modelType: "test", modelId: "m1", dataName: "out" },
  );

  assertEquals(result.found, true);
  assertEquals(result.data, {
    modelType: "test",
    modelId: "m1",
    dataName: "out",
  });
});

Deno.test("bridgeCapabilityVerbs: forwards all 9 capability verbs", async () => {
  const runnerPair = channelPair();
  const orchPair = channelPair();
  const called: string[] = [];

  for (const verb of BRIDGED_VERBS) {
    orchPair.b.register(verb, (params) => {
      called.push(verb);
      return Promise.resolve({ verb, params });
    });
  }

  bridgeCapabilityVerbs({
    childChannel: runnerPair.b,
    orchestratorChannel: orchPair.a,
    signal: AbortSignal.timeout(5_000),
  });

  for (const verb of BRIDGED_VERBS) {
    await runnerPair.a.call(verb, {});
  }

  assertEquals(called.sort(), [...BRIDGED_VERBS].sort());
});

Deno.test("bridgeCapabilityVerbs: propagates orchestrator errors to runner", async () => {
  const runnerPair = channelPair();
  const orchPair = channelPair();

  orchPair.b.register(
    RemoteMethod.resolveSecret,
    () => Promise.reject(new Error("secret not found")),
  );

  bridgeCapabilityVerbs({
    childChannel: runnerPair.b,
    orchestratorChannel: orchPair.a,
    signal: AbortSignal.timeout(5_000),
  });

  await assertRejects(
    () =>
      runnerPair.a.call(RemoteMethod.resolveSecret, {
        vaultName: "default",
        secretKey: "missing",
      }),
    RpcError,
    "secret not found",
  );
});

Deno.test("bridgeCapabilityVerbs: cancel signal aborts bridged call", async () => {
  const runnerPair = channelPair();
  const orchPair = channelPair();

  orchPair.b.register(
    RemoteMethod.queryData,
    (_params, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  );

  const controller = new AbortController();
  bridgeCapabilityVerbs({
    childChannel: runnerPair.b,
    orchestratorChannel: orchPair.a,
    signal: controller.signal,
  });

  const callPromise = runnerPair.a.call(RemoteMethod.queryData, {
    predicate: "true",
  });

  // Give the call time to propagate, then abort
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();

  await assertRejects(
    () => callPromise,
    RpcError,
  );
});

Deno.test("bridgeCapabilityVerbs: exactly 9 verbs are bridged", () => {
  assertEquals(BRIDGED_VERBS.length, 9);
});
