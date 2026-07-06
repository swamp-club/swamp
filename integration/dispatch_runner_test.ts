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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { RpcChannel } from "../src/domain/remote/rpc_channel.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../src/domain/remote/stdio_transport.ts";
import { overlayEnvironment } from "../src/domain/remote/environment_snapshot.ts";
import { bridgeCapabilityVerbs } from "../src/worker/runner_bridge.ts";
import { RemoteMethod } from "../src/domain/remote/protocol.ts";
import { RunnerBootstrapParamsSchema } from "../src/worker/runner_protocol.ts";

Deno.test("StdioTransport + RpcChannel: end-to-end RPC over stdio pipes", async () => {
  const { readable: aToB, writable: aOut } = new TransformStream<Uint8Array>();
  const { readable: bToA, writable: bOut } = new TransformStream<Uint8Array>();

  const transportA = new StdioTransport(aOut);
  const transportB = new StdioTransport(bOut);

  const channelA = new RpcChannel(transportA);
  const channelB = new RpcChannel(transportB);

  const readerADone = createStdioReader(
    bToA,
    (data) => channelA.handleRaw(data),
    () => channelA.close("closed"),
  );
  const readerBDone = createStdioReader(
    aToB,
    (data) => channelB.handleRaw(data),
    () => channelB.close("closed"),
  );

  channelB.register("echo", (params) => Promise.resolve({ echoed: params }));

  const result = await channelA.call<{ echoed: unknown }>("echo", {
    msg: "hello",
    nested: { a: 1, b: [2, 3] },
  });

  assertEquals(result, {
    echoed: { msg: "hello", nested: { a: 1, b: [2, 3] } },
  });

  channelA.close("done");
  channelB.close("done");
  await transportA.shutdown();
  await transportB.shutdown();
  await readerADone.catch(() => {});
  await readerBDone.catch(() => {});
});

Deno.test("StdioTransport + RpcChannel: stream events flow through bridge", async () => {
  const { readable: aToB, writable: aOut } = new TransformStream<Uint8Array>();
  const { readable: bToA, writable: bOut } = new TransformStream<Uint8Array>();

  const transportA = new StdioTransport(aOut);
  const transportB = new StdioTransport(bOut);

  const channelA = new RpcChannel(transportA);
  const channelB = new RpcChannel(transportB);

  const readerADone = createStdioReader(
    bToA,
    (data) => channelA.handleRaw(data),
    () => channelA.close("closed"),
  );
  const readerBDone = createStdioReader(
    aToB,
    (data) => channelB.handleRaw(data),
    () => channelB.close("closed"),
  );

  channelB.register("work", (_params, ctx) => {
    ctx.stream({ kind: "progress", value: 50 });
    ctx.stream({ kind: "progress", value: 100 });
    return Promise.resolve({ done: true });
  });

  const streamEvents: unknown[] = [];
  const result = await channelA.call<{ done: boolean }>("work", {}, {
    onStream: (event) => streamEvents.push(event),
  });

  assertEquals(result, { done: true });
  assertEquals(streamEvents.length, 2);

  channelA.close("done");
  channelB.close("done");
  await transportA.shutdown();
  await transportB.shutdown();
  await readerADone.catch(() => {});
  await readerBDone.catch(() => {});
});

Deno.test("environment isolation: overlayEnvironment does not mutate process env", () => {
  const originalValue = Deno.env.get("ISOLATION_TEST_VAR");
  Deno.env.delete("ISOLATION_TEST_VAR");

  const base = Deno.env.toObject();
  const merged = overlayEnvironment(base, { ISOLATION_TEST_VAR: "shipped" });

  assertEquals(merged["ISOLATION_TEST_VAR"], "shipped");
  assertEquals(Deno.env.get("ISOLATION_TEST_VAR"), undefined);

  if (originalValue !== undefined) {
    Deno.env.set("ISOLATION_TEST_VAR", originalValue);
  }
});

Deno.test("environment isolation: denylist vars survive overlay", () => {
  const base = {
    HOME: "/my-home",
    PATH: "/usr/bin",
    USER: "me",
    API_KEY: "original",
  };
  const snapshot = {
    HOME: "/attacker",
    PATH: "/evil/bin",
    USER: "attacker",
    API_KEY: "shipped",
    DENO_DIR: "/bad",
    SWAMP_TOKEN: "leaked",
  };

  const merged = overlayEnvironment(base, snapshot);
  assertEquals(merged["HOME"], "/my-home");
  assertEquals(merged["PATH"], "/usr/bin");
  assertEquals(merged["USER"], "me");
  assertEquals(merged["API_KEY"], "shipped");
  assertEquals("DENO_DIR" in merged, false);
  assertEquals("SWAMP_TOKEN" in merged, false);
});

Deno.test("bootstrap params: round-trip through JSON serialization", () => {
  const original = {
    sessionCredential: "cred-abc",
    dataPlaneUrl: "https://orch.example.com",
    cacheDirPath: "/tmp/cache",
    dispatch: {
      dispatchId: "d-1",
      leaseId: "l-1",
      execution: {
        protocolVersion: 3,
        modelType: "@test/model",
        modelId: "m-1",
        methodName: "run",
        globalArgs: {},
        methodArgs: { input: "value" },
        definitionMeta: {
          id: "def-1",
          name: "test",
          version: 1,
          tags: {},
        },
      },
      bundleFingerprint: "builtin:@test/model",
      environmentSnapshot: { API_KEY: "secret" },
    },
  };

  const serialized = JSON.stringify(original);
  const parsed = RunnerBootstrapParamsSchema.parse(JSON.parse(serialized));

  assertEquals(parsed.sessionCredential, original.sessionCredential);
  assertEquals(parsed.dataPlaneUrl, original.dataPlaneUrl);
  assertEquals(parsed.dispatch.dispatchId, original.dispatch.dispatchId);
  assertEquals(
    parsed.dispatch.execution.methodArgs,
    original.dispatch.execution.methodArgs,
  );
  assertEquals(
    parsed.dispatch.environmentSnapshot,
    original.dispatch.environmentSnapshot,
  );
});

Deno.test("capability bridge: orchestrator error message propagates to runner", async () => {
  function channelPair(): { a: RpcChannel; b: RpcChannel } {
    const a: RpcChannel = new RpcChannel({
      send: (data) => void Promise.resolve().then(() => b.handleRaw(data)),
    });
    const b: RpcChannel = new RpcChannel({
      send: (data) => void Promise.resolve().then(() => a.handleRaw(data)),
    });
    return { a, b };
  }

  const runnerPair = channelPair();
  const orchPair = channelPair();

  orchPair.b.register(
    RemoteMethod.resolveSecret,
    () =>
      Promise.reject(
        new Error(
          "vault 'production' is sealed — unlock with swamp vault open",
        ),
      ),
  );

  bridgeCapabilityVerbs({
    childChannel: runnerPair.b,
    orchestratorChannel: orchPair.a,
    signal: AbortSignal.timeout(5_000),
  });

  try {
    await runnerPair.a.call(RemoteMethod.resolveSecret, {
      vaultName: "production",
      secretKey: "DB_PASSWORD",
    });
    throw new Error("should have thrown");
  } catch (error: unknown) {
    const message = (error as Error).message;
    assertStringIncludes(message, "vault 'production' is sealed");
  }
});
