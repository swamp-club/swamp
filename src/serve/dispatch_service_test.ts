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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  BUILTIN_BUNDLE_PREFIX,
  type DispatchGateway,
  DispatchService,
} from "./dispatch_service.ts";
import { DispatchRegistry } from "./dispatch_registry.ts";
import { BundleRegistry } from "./bundle_registry.ts";
import type { WorkerSnapshot } from "./worker_gateway.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import type {
  DispatchParams,
  DispatchResult,
} from "../domain/remote/protocol.ts";
import { ChannelClosedError, RpcError } from "../domain/remote/rpc_channel.ts";
import type { RemoteStepRequest } from "../domain/remote/remote_dispatch.ts";

const MODEL_TYPE = ModelType.create("swamp/dispatch-test");

const builtinModelDef: ModelDefinition = {
  type: MODEL_TYPE,
  version: "2026.06.09.1",
  resources: {
    "out": {
      description: "output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {},
};

function snapshot(
  overrides: Partial<WorkerSnapshot> & { name: string },
): WorkerSnapshot {
  return {
    instanceUuid: `uuid-${overrides.name}`,
    labels: {},
    platform: "linux",
    arch: "x86_64",
    swampVersion: "1.0.0",
    status: "idle",
    connected: true,
    dispatchId: null,
    ...overrides,
  };
}

type DispatchBehavior = (
  name: string,
  params: DispatchParams,
) => Promise<DispatchResult>;

function createHarness(options?: {
  workers?: WorkerSnapshot[];
  queueTimeoutMs?: number;
}) {
  const pool = new Map<string, WorkerSnapshot>(
    (options?.workers ?? [snapshot({ name: "w1" })]).map((w) => [w.name, w]),
  );
  const dispatchCalls: Array<{ name: string; params: DispatchParams }> = [];
  const transitions: Array<
    { methodName: string; inputs: Record<string, unknown> }
  > = [];
  let behavior: DispatchBehavior = () =>
    Promise.resolve({
      status: "success",
      outputs: [{
        dataId: "data-1",
        version: 1,
        name: "out-main",
        specName: "out",
        type: "resource",
      }],
      logs: [],
      durationMs: 3,
    });

  const gateway: DispatchGateway = {
    workers: () => [...pool.values()],
    worker: (name) => pool.get(name) ?? null,
    dispatch: (name, params) => {
      dispatchCalls.push({ name, params });
      const entry = pool.get(name);
      if (entry) pool.set(name, { ...entry, status: "busy" });
      return behavior(name, params).finally(() => {
        const after = pool.get(name);
        if (after) pool.set(name, { ...after, status: "idle" });
      });
    },
  };

  const dispatches = new DispatchRegistry();
  const bundles = new BundleRegistry();
  const service = new DispatchService({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    dispatches,
    bundles,
    queueTimeoutMs: options?.queueTimeoutMs ?? 2_000,
    runModelMethod: (input) => {
      transitions.push({ methodName: input.methodName, inputs: input.inputs });
      return Promise.resolve();
    },
    captureEnvironment: () => ({ SHIPPED: "yes" }),
  });
  service.bindGateway(gateway);

  return {
    service,
    pool,
    dispatchCalls,
    transitions,
    bundles,
    dispatches,
    setBehavior: (b: DispatchBehavior) => {
      behavior = b;
    },
  };
}

function stepRequest(
  overrides?: Partial<RemoteStepRequest>,
): RemoteStepRequest {
  return {
    placement: { labels: {}, platform: "linux" },
    modelDef: builtinModelDef,
    modelType: MODEL_TYPE,
    modelId: "m-1",
    methodName: "run",
    definitionName: "test-def",
    definitionTags: {},
    definitionMeta: { id: "m-1", name: "test-def", version: 1, tags: {} },
    globalArgs: {},
    methodArgs: { value: 1 },
    stepName: "build",
    workflowName: "wf",
    ...overrides,
  };
}

Deno.test("DispatchService: dispatches a step and completes its lease", async () => {
  const h = createHarness();
  const result = await h.service.executeRemote(stepRequest());

  assertEquals(result.outputs.length, 1);
  assertEquals(h.dispatchCalls.length, 1);
  assertEquals(h.dispatchCalls[0].name, "w1");
  // Built-in model: sentinel fingerprint, no bundle registered.
  assertStringIncludes(
    h.dispatchCalls[0].params.bundleFingerprint,
    BUILTIN_BUNDLE_PREFIX,
  );
  // The shipped environment snapshot is the captured one.
  assertEquals(
    h.dispatchCalls[0].params.environmentSnapshot,
    { SHIPPED: "yes" },
  );
  assertEquals(
    h.transitions.map((t) => t.methodName),
    ["acquire", "complete"],
  );
  // The dispatch registry is empty again after completion.
  assertEquals(h.dispatches.forWorker("w1"), null);
});

Deno.test("DispatchService: extension bundles register by content fingerprint", async () => {
  const h = createHarness();
  const extensionDef: ModelDefinition = {
    ...builtinModelDef,
    bundleSourceFactory: () => Promise.resolve("export const model = 1;"),
    extensionFilesRoot: "/ext/files",
  };
  await h.service.executeRemote(stepRequest({ modelDef: extensionDef }));
  const fingerprint = h.dispatchCalls[0].params.bundleFingerprint;
  assertEquals(fingerprint.startsWith(BUILTIN_BUNDLE_PREFIX), false);
  const registered = h.bundles.get(fingerprint);
  assertEquals(registered?.js, "export const model = 1;");
  assertEquals(registered?.filesRoot, "/ext/files");
});

Deno.test("DispatchService: remote method error fails the lease and rethrows", async () => {
  const h = createHarness();
  h.setBehavior(() =>
    Promise.resolve({
      status: "error",
      error: "boom in method",
      outputs: [],
      logs: [],
      durationMs: 1,
    })
  );
  await assertRejects(
    () => h.service.executeRemote(stepRequest()),
    Error,
    "boom in method",
  );
  assertEquals(
    h.transitions.map((t) => t.methodName),
    ["acquire", "fail"],
  );
});

Deno.test("DispatchService: unschedulable placement fails fast", async () => {
  const h = createHarness();
  await assertRejects(
    () =>
      h.service.executeRemote(
        stepRequest({ placement: { labels: { gpu: "true" } } }),
      ),
    Error,
    "No connected worker matches",
  );
  assertEquals(h.transitions.length, 0);
});

Deno.test("DispatchService: queues while eligible workers are busy", async () => {
  const h = createHarness();
  const gate = Promise.withResolvers<void>();
  let firstStarted = false;
  h.setBehavior(async () => {
    firstStarted = true;
    await gate.promise;
    return { status: "success", outputs: [], logs: [], durationMs: 1 };
  });

  const first = h.service.executeRemote(stepRequest({ stepName: "one" }));
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(firstStarted, true);

  // Second step queues — its dispatch must not start while w1 is busy.
  h.setBehavior(() =>
    Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    })
  );
  const second = h.service.executeRemote(stepRequest({ stepName: "two" }));
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(h.dispatchCalls.length, 1);

  gate.resolve();
  h.service.notifyWorkerIdle(snapshot({ name: "w1" }));
  await first;
  await second;
  assertEquals(h.dispatchCalls.length, 2);
});

Deno.test("DispatchService: queue wait times out with a clear error", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1", status: "busy" })],
    queueTimeoutMs: 50,
  });
  await assertRejects(
    () => h.service.executeRemote(stepRequest()),
    Error,
    "Timed out waiting",
  );
});

Deno.test("DispatchService: no-write drop re-dispatches; lease expires", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
  });
  let attempts = 0;
  h.setBehavior((name) => {
    attempts++;
    if (attempts === 1) {
      // First attempt: socket drops; worker w1 then disappears (grace expiry
      // is simulated by removing it from the pool).
      h.pool.delete(name);
      h.service.notifyGraceExpired(snapshot({ name }));
      return Promise.reject(new ChannelClosedError("control socket closed"));
    }
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });

  const result = await h.service.executeRemote(stepRequest());
  assertEquals(result.durationMs, 1);
  assertEquals(attempts, 2);
  assertEquals(h.dispatchCalls.map((c) => c.name), ["w1", "w2"]);
  assertEquals(
    h.transitions.map((t) => t.methodName),
    ["acquire", "expire", "acquire", "complete"],
  );
});

Deno.test("DispatchService: write-then-drop fails the run", async () => {
  const h = createHarness();
  h.setBehavior(async (name, params) => {
    // The worker writes, then its socket drops.
    await h.service.recordFirstWrite({
      workerName: name,
      dispatchId: params.dispatchId,
      leaseId: params.leaseId,
      modelDef: builtinModelDef,
      modelType: MODEL_TYPE,
      modelId: "m-1",
      methodName: "run",
      definitionName: "test-def",
      definitionTags: {},
    });
    h.pool.delete(name);
    h.service.notifyGraceExpired(snapshot({ name }));
    return Promise.reject(new ChannelClosedError("control socket closed"));
  });

  await assertRejects(
    () => h.service.executeRemote(stepRequest()),
    Error,
    "write-then-drop",
  );
  assertEquals(
    h.transitions.map((t) => t.methodName),
    ["acquire", "mark_writes", "fail"],
  );
});

Deno.test("DispatchService: recordFirstWrite marks the lease exactly once", async () => {
  const h = createHarness();
  const dispatch = {
    workerName: "w1",
    dispatchId: "d-x",
    leaseId: "l-x",
    modelDef: builtinModelDef,
    modelType: MODEL_TYPE,
    modelId: "m-1",
    methodName: "run",
    definitionName: "test-def",
    definitionTags: {},
  };
  await h.service.recordFirstWrite(dispatch);
  await h.service.recordFirstWrite(dispatch);
  assertEquals(
    h.transitions.filter((t) => t.methodName === "mark_writes").length,
    1,
  );
});

Deno.test("DispatchService: abort during queue wait rejects", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1", status: "busy" })],
  });
  const controller = new AbortController();
  const pending = h.service.executeRemote(
    stepRequest({ signal: controller.signal }),
  );
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await assertRejects(() => pending, DOMException);
});

Deno.test("DispatchService: cancelled dispatch fails the lease and rejects with AbortError", async () => {
  const h = createHarness();
  h.setBehavior(() =>
    Promise.reject(
      new RpcError({ code: "cancelled", message: "aborted on worker" }),
    )
  );
  const error = await assertRejects(
    () => h.service.executeRemote(stepRequest()),
    DOMException,
    "cancelled",
  );
  assertEquals(error.name, "AbortError");
  assertEquals(
    h.transitions.map((t) => t.methodName),
    ["acquire", "fail"],
  );
});

Deno.test("DispatchService: worker_busy desync re-queues instead of failing the run", async () => {
  const h = createHarness();
  let attempts = 0;
  h.setBehavior(() => {
    attempts++;
    if (attempts === 1) {
      // The worker still held its serial slot (e.g. a cancel grace period
      // elapsed) — the gateway view said idle, the worker said busy.
      queueMicrotask(() =>
        h.service.notifyWorkerIdle(snapshot({ name: "w1" }))
      );
      return Promise.reject(
        new RpcError({
          code: "worker_busy",
          message: "Worker is already executing a dispatch",
        }),
      );
    }
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  const result = await h.service.executeRemote(stepRequest());
  assertEquals(result.durationMs, 1);
  assertEquals(attempts, 2);
  // The abandoned first attempt's lease ended (expire), not leaked active.
  assertEquals(
    h.transitions.map((t) => t.methodName),
    ["acquire", "expire", "acquire", "complete"],
  );
});

Deno.test("DispatchService: forwards trace headers and reports the executing worker", async () => {
  const h = createHarness();
  const result = await h.service.executeRemote(
    stepRequest({
      traceHeaders: { traceparent: "00-abc-def-01" },
    } as Partial<RemoteStepRequest>),
  );
  assertEquals(
    h.dispatchCalls[0].params.execution.traceHeaders,
    { traceparent: "00-abc-def-01" },
  );
  assertEquals(result.workerName, "w1");
});
