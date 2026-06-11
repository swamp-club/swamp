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
import { z } from "zod";
import {
  applyEnvironmentOverlay,
  registerDispatchHandler,
} from "./dispatch_handler.ts";
import { RpcChannel, type RpcError } from "../domain/remote/rpc_channel.ts";
import {
  type DispatchResult,
  REMOTE_PROTOCOL_VERSION,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import { defineModel, type MethodContext } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { WorkerBundleCache } from "./bundle_cache.ts";
import type { DataPlaneClient } from "./data_plane_client.ts";

const TEST_TYPE = ModelType.create("swamp/dispatch-handler-test");

let lastContext: MethodContext | null = null;
let methodBehavior: (
  args: Record<string, unknown>,
  context: MethodContext,
) => Promise<void> = () => Promise.resolve();

const testModel = defineModel({
  type: TEST_TYPE,
  version: "2026.06.09.1",
  resources: {
    "out": {
      description: "test output",
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    run: {
      description: "test method",
      kind: "action",
      arguments: z.object({ value: z.string() }),
      execute: async (args, context) => {
        lastContext = context;
        await methodBehavior(args as Record<string, unknown>, context);
        const handle = await context.writeResource!("out", "out", {
          value: String((args as { value: string }).value),
        });
        return { dataHandles: [handle] };
      },
    },
  },
});

function channelPair(): { worker: RpcChannel; orchestrator: RpcChannel } {
  const worker: RpcChannel = new RpcChannel({
    send: (data) =>
      void Promise.resolve().then(() => orchestrator.handleRaw(data)),
  });
  const orchestrator: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => worker.handleRaw(data)),
  });
  return { worker, orchestrator };
}

function stubClient(): {
  client: DataPlaneClient;
  resourceWrites: Array<Record<string, unknown>>;
} {
  const resourceWrites: Array<Record<string, unknown>> = [];
  const client = {
    writeResource: (
      body: { specName: string; name: string; data: Record<string, unknown> },
    ) => {
      resourceWrites.push(body);
      return Promise.resolve({
        dataId: crypto.randomUUID(),
        name: body.name,
        specName: body.specName,
        kind: "resource" as const,
        version: resourceWrites.length,
        size: 1,
        tags: {},
      });
    },
  } as unknown as DataPlaneClient;
  return { client, resourceWrites };
}

const bundleCache = {
  load: (fingerprint: string) => {
    if (fingerprint !== `builtin:${TEST_TYPE.normalized}`) {
      return Promise.reject(new Error(`unexpected fingerprint ${fingerprint}`));
    }
    return Promise.resolve({ modelDef: testModel });
  },
} as unknown as WorkerBundleCache;

function dispatchParams(overrides?: {
  methodArgs?: Record<string, unknown>;
  environmentSnapshot?: Record<string, string>;
  methodName?: string;
}) {
  return {
    dispatchId: crypto.randomUUID(),
    leaseId: "l-1",
    execution: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      modelType: TEST_TYPE.normalized,
      modelId: "m-1",
      methodName: overrides?.methodName ?? "run",
      globalArgs: {},
      methodArgs: overrides?.methodArgs ?? { value: "hello" },
      definitionMeta: {
        id: "0e6cf12e-8a3a-4f55-9c5d-1a2b3c4d5e6f",
        name: "test-def",
        version: 1,
        tags: {},
      },
    },
    bundleFingerprint: `builtin:${TEST_TYPE.normalized}`,
    reportBundleFingerprints: [],
    environmentSnapshot: overrides?.environmentSnapshot ?? {},
  };
}

function harness() {
  const { worker, orchestrator } = channelPair();
  const { client, resourceWrites } = stubClient();
  registerDispatchHandler({ channel: worker, client, bundleCache });
  methodBehavior = () => Promise.resolve();
  lastContext = null;
  return { worker, orchestrator, resourceWrites };
}

Deno.test("applyEnvironmentOverlay: applies, then restores added and changed vars", () => {
  Deno.env.set("OVERLAY_EXISTING", "original");
  Deno.env.delete("OVERLAY_ADDED");
  const restore = applyEnvironmentOverlay({
    OVERLAY_EXISTING: "shipped",
    OVERLAY_ADDED: "new",
    HOME: "/should-not-apply",
  });
  assertEquals(Deno.env.get("OVERLAY_EXISTING"), "shipped");
  assertEquals(Deno.env.get("OVERLAY_ADDED"), "new");
  assertEquals(Deno.env.get("HOME") === "/should-not-apply", false);
  restore();
  assertEquals(Deno.env.get("OVERLAY_EXISTING"), "original");
  assertEquals(Deno.env.get("OVERLAY_ADDED"), undefined);
  Deno.env.delete("OVERLAY_EXISTING");
});

Deno.test("dispatch handler: executes the method and returns persisted outputs", async () => {
  const h = harness();
  const result = await h.orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams(),
    { timeoutMs: null },
  );
  assertEquals(result.status, "success");
  assertEquals(result.outputs.length, 1);
  assertEquals(result.outputs[0].specName, "out");
  assertEquals(h.resourceWrites[0].data, { value: "hello" });
});

Deno.test("dispatch handler: the environment snapshot applies during the method and restores after", async () => {
  const h = harness();
  Deno.env.delete("DISPATCH_TEST_VAR");
  let seenDuringMethod: string | undefined;
  methodBehavior = (_args, _context) => {
    seenDuringMethod = Deno.env.get("DISPATCH_TEST_VAR");
    return Promise.resolve();
  };
  await h.orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams({ environmentSnapshot: { DISPATCH_TEST_VAR: "shipped" } }),
    { timeoutMs: null },
  );
  assertEquals(seenDuringMethod, "shipped");
  assertEquals(Deno.env.get("DISPATCH_TEST_VAR"), undefined);
});

Deno.test("dispatch handler: env restores even when the method throws, and prior writes survive", async () => {
  const h = harness();
  Deno.env.delete("DISPATCH_THROW_VAR");
  methodBehavior = async (_args, context) => {
    await context.writeResource!("out", "early", { value: "before-throw" });
    throw new Error("kaboom after writing");
  };
  const result = await h.orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams({ environmentSnapshot: { DISPATCH_THROW_VAR: "x" } }),
    { timeoutMs: null },
  );
  assertEquals(result.status, "error");
  assertStringIncludes(result.error!, "kaboom");
  // The write that landed before the throw is reported (write-then-throw).
  assertEquals(result.outputs.length, 1);
  assertEquals(result.outputs[0].name, "early");
  assertEquals(Deno.env.get("DISPATCH_THROW_VAR"), undefined);
});

Deno.test("dispatch handler: the method receives a scratch repoDir, not a repository", async () => {
  const h = harness();
  await h.orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams(),
    { timeoutMs: null },
  );
  assertStringIncludes(lastContext!.repoDir, "swamp-dispatch-");
});

Deno.test("dispatch handler: unknown methods fail with a clear error", async () => {
  const h = harness();
  const result = await h.orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams({ methodName: "nope" }),
    { timeoutMs: null },
  );
  assertEquals(result.status, "error");
  assertStringIncludes(result.error!, "Method 'nope' not found");
});

Deno.test("dispatch handler: argument validation failures surface as errors", async () => {
  const h = harness();
  const result = await h.orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams({ methodArgs: { value: 42 } }),
    { timeoutMs: null },
  );
  assertEquals(result.status, "error");
  assertStringIncludes(result.error!, "validation failed");
});

Deno.test("dispatch handler: concurrent dispatches are rejected (serial v1)", async () => {
  const h = harness();
  const gate = Promise.withResolvers<void>();
  methodBehavior = async () => {
    await gate.promise;
  };
  const first = h.orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams(),
    { timeoutMs: null },
  );
  await new Promise((r) => setTimeout(r, 20));
  let busyError: RpcError | null = null;
  try {
    await h.orchestrator.call<DispatchResult>(
      WorkerMethod.dispatch,
      dispatchParams(),
      { timeoutMs: null },
    );
  } catch (error) {
    busyError = error as RpcError;
  }
  assertEquals(busyError?.code, "worker_busy");
  gate.resolve();
  const result = await first;
  assertEquals(result.status, "success");
});

Deno.test("dispatch handler: emits started and finished events for connect-mode output", async () => {
  const { worker, orchestrator } = channelPair();
  const { client } = stubClient();
  const dispatchEvents: Array<Record<string, unknown>> = [];
  registerDispatchHandler({
    channel: worker,
    client,
    bundleCache,
    onDispatch: (event) => dispatchEvents.push({ ...event }),
  });
  methodBehavior = () => Promise.resolve();

  await orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams(),
    { timeoutMs: null },
  );
  assertEquals(
    dispatchEvents.map((e) => e.kind),
    ["dispatch_started", "dispatch_finished"],
  );
  assertEquals(dispatchEvents[0].methodName, "run");
  assertEquals(dispatchEvents[1].status, "success");

  // Failures report status error with the message.
  dispatchEvents.length = 0;
  methodBehavior = () => Promise.reject(new Error("boom"));
  await orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    dispatchParams(),
    { timeoutMs: null },
  );
  assertEquals(dispatchEvents[1].status, "error");
  assertEquals(String(dispatchEvents[1].error).includes("boom"), true);
});

Deno.test("dispatch handler: trace context applies during the method and restores after", async () => {
  const h = harness();
  Deno.env.delete("TRACEPARENT");
  let seenTraceparent: string | undefined;
  methodBehavior = () => {
    seenTraceparent = Deno.env.get("TRACEPARENT");
    return Promise.resolve();
  };
  const params = dispatchParams();
  (params.execution as Record<string, unknown>).traceHeaders = {
    traceparent: "00-abc123-def456-01",
  };
  await h.orchestrator.call<DispatchResult>(
    WorkerMethod.dispatch,
    params,
    { timeoutMs: null },
  );
  assertEquals(seenTraceparent, "00-abc123-def456-01");
  assertEquals(Deno.env.get("TRACEPARENT"), undefined);
});
