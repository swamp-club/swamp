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
  WorkerAffinityLostError,
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
    capacity: 1,
    activeDispatchIds: [],
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
    {
      typeArg: string;
      methodName: string;
      inputs: Record<string, unknown>;
    }
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
      transitions.push({
        typeArg: input.typeArg,
        methodName: input.methodName,
        inputs: input.inputs,
      });
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
  assertEquals(h.dispatches.forWorker("w1"), []);
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

Deno.test("DispatchService: no-match placement queues then times out", async () => {
  const h = createHarness({ queueTimeoutMs: 100 });
  await assertRejects(
    () =>
      h.service.executeRemote(
        stepRequest({
          placement: { labels: { gpu: "true" }, platform: "linux" },
        }),
      ),
    Error,
    "Timed out waiting for a worker matching",
  );
  const leaseTransitions = h.transitions.filter((t) =>
    t.typeArg === "swamp/step-lease"
  );
  assertEquals(leaseTransitions.length, 0);
});

Deno.test("DispatchService: per-step queueTimeout overrides serve-level default", async () => {
  const h = createHarness({ queueTimeoutMs: 60_000 });
  await assertRejects(
    () =>
      h.service.executeRemote(
        stepRequest({
          placement: {
            labels: { gpu: "true" },
            platform: "linux",
            queueTimeoutMs: 100,
          },
        }),
      ),
    Error,
    "Timed out waiting for a worker matching",
  );
  const leaseTransitions = h.transitions.filter((t) =>
    t.typeArg === "swamp/step-lease"
  );
  assertEquals(leaseTransitions.length, 0);
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
    workers: [
      snapshot({
        name: "w1",
        status: "busy",
        activeDispatchIds: ["d-existing"],
        capacity: 1,
      }),
    ],
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

Deno.test("DispatchService: declaredWrites pre-marks dispatch as write-bearing", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
  });
  let attempts = 0;
  h.setBehavior((name) => {
    attempts++;
    if (attempts === 1) {
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

  await assertRejects(
    () => h.service.executeRemote(stepRequest({ declaredWrites: true })),
    Error,
    "write-then-drop",
  );
  assertEquals(
    h.transitions.map((t) => t.methodName),
    ["acquire", "mark_writes", "fail"],
  );
  assertEquals(attempts, 1);
});

Deno.test("DispatchService: declaredWrites false behaves like no declaration", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
  });
  let attempts = 0;
  h.setBehavior((name) => {
    attempts++;
    if (attempts === 1) {
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

  const result = await h.service.executeRemote(
    stepRequest({ declaredWrites: false }),
  );
  assertEquals(result.durationMs, 1);
  assertEquals(attempts, 2);
});

Deno.test("DispatchService: abort during queue wait rejects", async () => {
  const h = createHarness({
    workers: [
      snapshot({
        name: "w1",
        status: "busy",
        activeDispatchIds: ["d-existing"],
        capacity: 1,
      }),
    ],
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

Deno.test("DispatchService: wake-on-enroll dispatches to newly enrolled worker", async () => {
  const h = createHarness({ workers: [], queueTimeoutMs: 5_000 });
  const pending = h.service.executeRemote(
    stepRequest({ placement: { platform: "linux" } }),
  );
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(h.dispatchCalls.length, 0);

  h.pool.set("new-worker", snapshot({ name: "new-worker" }));
  h.service.notifyWorkerEnrolled(snapshot({ name: "new-worker" }));
  const result = await pending;
  assertEquals(h.dispatchCalls.length, 1);
  assertEquals(h.dispatchCalls[0].name, "new-worker");
  assertEquals(result.outputs.length, 1);
});

Deno.test("DispatchService: timeout error contains placement description", async () => {
  const h = createHarness({ queueTimeoutMs: 100 });
  const error = await assertRejects(
    () =>
      h.service.executeRemote(
        stepRequest({
          placement: { labels: { gpu: "true" }, platform: "linux/aarch64" },
        }),
      ),
    Error,
  );
  assertStringIncludes(error.message, "gpu=true");
  assertStringIncludes(error.message, "linux/aarch64");
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

Deno.test("DispatchService: worker_draining re-queues instead of failing the run", async () => {
  const h = createHarness();
  let attempts = 0;
  h.setBehavior(() => {
    attempts++;
    if (attempts === 1) {
      queueMicrotask(() =>
        h.service.notifyWorkerIdle(snapshot({ name: "w1" }))
      );
      return Promise.reject(
        new RpcError({
          code: "worker_draining",
          message: "Worker is draining — no new dispatches accepted",
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
});

Deno.test("executeRemote: emits target_disconnected event for grace-window disconnected worker", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1", connected: false, status: "idle" }),
    ],
    queueTimeoutMs: 100,
  });
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: { target: "w1" },
        onEvent: (event) => events.push(event),
      })),
    Error,
    "Timed out",
  );
  const disconnectedEvents = events.filter(
    (e) => e.kind === "target_disconnected",
  );
  assertEquals(disconnectedEvents.length, 1);
  assertEquals(disconnectedEvents[0].target, "w1");
});

Deno.test("executeRemote: no target_disconnected event for connected worker", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1", connected: true, status: "idle" })],
  });
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  await h.service.executeRemote(stepRequest({
    placement: { target: "w1" },
    onEvent: (event) => events.push(event),
  }));
  const disconnectedEvents = events.filter(
    (e) => e.kind === "target_disconnected",
  );
  assertEquals(disconnectedEvents.length, 0);
});

Deno.test("executeRemote: no target_disconnected event without explicit target", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1", connected: true, status: "idle" })],
  });
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux" },
    onEvent: (event) => events.push(event),
  }));
  const disconnectedEvents = events.filter(
    (e) => e.kind === "target_disconnected",
  );
  assertEquals(disconnectedEvents.length, 0);
});

// --- Worker affinity ---

Deno.test("executeRemote: affinity pins subsequent steps to the same worker", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });
  const affinityKey = "run-1:job-build";

  const r1 = await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-1",
  }));

  const r2 = await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-2",
  }));

  assertEquals(r1.workerName, r2.workerName);
  assertEquals(h.dispatchCalls[0].name, h.dispatchCalls[1].name);
});

Deno.test("executeRemote: affinity fails when pinned worker disconnects", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });
  const affinityKey = "run-2:job-deploy";

  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-1",
  }));

  const pinnedWorker = h.dispatchCalls[0].name;
  const entry = h.pool.get(pinnedWorker)!;
  h.pool.set(pinnedWorker, { ...entry, connected: false });

  const error = await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: { labels: {}, platform: "linux", affinityKey },
        stepName: "step-2",
      })),
    WorkerAffinityLostError,
  );
  assertStringIncludes(error.message, "affinity group");
  assertStringIncludes(error.message, affinityKey);
});

Deno.test("executeRemote: releaseAffinity clears pin", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });
  const affinityKey = "run-3:job-test";

  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
  }));

  h.service.releaseAffinity(affinityKey);

  const r2 = await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
  }));

  assertEquals(typeof r2.workerName, "string");
});

Deno.test("executeRemote: affinity worker lost mid-dispatch fails instead of re-dispatching", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });
  const affinityKey = "run-4:job-build";

  let callCount = 0;
  h.setBehavior((_name, _params) => {
    callCount++;
    if (callCount === 1) {
      throw new ChannelClosedError("socket dropped");
    }
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });

  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: { labels: {}, platform: "linux", affinityKey },
        stepName: "step-1",
      })),
    WorkerAffinityLostError,
  );
  assertEquals(callCount, 1);
});

Deno.test("executeRemote: steps without affinity key are unaffected", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });

  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux" },
    stepName: "step-1",
  }));

  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux" },
    stepName: "step-2",
  }));

  assertEquals(h.dispatchCalls.length, 2);
});

Deno.test("executeRemote: concurrent affinity steps pin to the same worker", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });
  const affinityKey = "run-5:job-concurrent";

  const [r1, r2] = await Promise.all([
    h.service.executeRemote(stepRequest({
      placement: { labels: {}, platform: "linux", affinityKey },
      stepName: "step-a",
    })),
    h.service.executeRemote(stepRequest({
      placement: { labels: {}, platform: "linux", affinityKey },
      stepName: "step-b",
    })),
  ]);

  assertEquals(r1.workerName, r2.workerName);
});

Deno.test("executeRemote: concurrent affinity step rejects when first step fails", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
    queueTimeoutMs: 500,
  });
  const affinityKey = "run-6:job-fail-race";

  let callCount = 0;
  h.setBehavior(() => {
    callCount++;
    return new Promise((_resolve, reject) => {
      setTimeout(
        () => reject(new ChannelClosedError("socket dropped")),
        50,
      );
    });
  });

  const results = await Promise.allSettled([
    h.service.executeRemote(stepRequest({
      placement: { labels: {}, platform: "linux", affinityKey },
      stepName: "step-a",
    })),
    h.service.executeRemote(stepRequest({
      placement: { labels: {}, platform: "linux", affinityKey },
      stepName: "step-b",
    })),
  ]);

  assertEquals(results[0].status, "rejected");
  assertEquals(results[1].status, "rejected");
  assertEquals(callCount, 1);
});

Deno.test("executeRemote: dataOutputOverrides and tagOverrides are stored on the active dispatch", async () => {
  const h = createHarness();
  const overrides = [
    { specName: "out", lifetime: "workflow" as const },
  ];
  const tags = { workflow: "my-wf", job: "my-job", step: "my-step" };
  let capturedDispatch: import("./dispatch_registry.ts").ActiveDispatch | null =
    null;
  h.setBehavior((_name, _params) => {
    capturedDispatch = h.dispatches.forWorker("w1")[0] ?? null;
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  await h.service.executeRemote(stepRequest({
    dataOutputOverrides: overrides,
    tagOverrides: tags,
  }));
  assertEquals(capturedDispatch!.dataOutputOverrides, overrides);
  assertEquals(capturedDispatch!.tagOverrides, tags);
});
