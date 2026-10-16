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

import {
  currentVaultAccess,
  RunVaultAccess,
  runWithVaultAccess,
} from "../domain/vaults/run_vault_access.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import {
  BUILTIN_BUNDLE_PREFIX,
  type DispatchGateway,
  DispatchService,
  withWrittenVersions,
  WorkerAffinityLostError,
} from "./dispatch_service.ts";
import { DispatchRegistry } from "./dispatch_registry.ts";
import { BundleRegistry } from "./bundle_registry.ts";
import {
  WorkerGateway,
  WorkerNotDispatchableError,
  type WorkerSnapshot,
} from "./worker_gateway.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { errorPaths } from "../domain/errors.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import type { WrittenVersion } from "../domain/datastore/datastore_sync_service.ts";
import { writtenVersionsOf } from "../domain/models/method_execution_service.ts";
import {
  type DispatchParams,
  type DispatchResult,
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import {
  ChannelClosedError,
  RpcChannel,
  RpcError,
} from "../domain/remote/rpc_channel.ts";
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
  /** The vault scope each lease transition ran in. */
  const transitionScopes: (RunVaultAccess | undefined)[] = [];
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
      transitionScopes.push(currentVaultAccess());
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
    transitionScopes,
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

Deno.test("DispatchService: the step lease records the workflow run it serves", async () => {
  const h = createHarness();
  await h.service.executeRemote(stepRequest({ workflowRunId: "run-9" }));
  const acquire = h.transitions.find((t) => t.methodName === "acquire");
  assertEquals(acquire?.inputs.workflowRunId, "run-9");
  assertEquals(acquire?.inputs.workflowName, "wf");
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

Deno.test("DispatchService: remote method error keeps the worker's marked paths (swamp-club#2830)", async () => {
  const h = createHarness();
  const path = "/srv/acme/final report";
  h.setBehavior(() =>
    Promise.resolve({
      status: "error",
      error: `cannot read ${path}`,
      errorPaths: [path],
      outputs: [],
      logs: [],
      durationMs: 1,
    })
  );
  const error = await assertRejects(
    () => h.service.executeRemote(stepRequest()),
    Error,
    "cannot read",
  );
  assertEquals(errorPaths(error), [path]);
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

/**
 * A step's lock hand-offs as `MethodExecutionService` would bind them: each
 * begun attempt is lent the current nonce, and ending one re-keys it.
 */
function lockHandOffs(options: { failEnd?: Error } = {}) {
  let generation = 1;
  const log: string[] = [];
  const endSignals: Array<AbortSignal | undefined> = [];
  const beginLockHandOff: NonNullable<RemoteStepRequest["beginLockHandOff"]> =
    () => {
      const nonce = `nonce-${generation}`;
      log.push(`begin ${nonce}`);
      return Promise.resolve({
        lent: { pid: 4242, hostname: "host-a", lockIds: [nonce] },
        end: (signal) => {
          log.push(`end ${nonce}`);
          endSignals.push(signal);
          generation++;
          return options.failEnd
            ? Promise.reject(options.failEnd)
            : Promise.resolve();
        },
      });
    };
  return { beginLockHandOff, log, endSignals };
}

Deno.test("DispatchService: lends the step's locks to the attempt, and nothing when the step holds no lock", async () => {
  const h = createHarness();
  const { beginLockHandOff, log } = lockHandOffs();

  await h.service.executeRemote(stepRequest({ beginLockHandOff }));
  await h.service.executeRemote(stepRequest());

  assertEquals(h.dispatchCalls[0].params.lockHolder, {
    pid: 4242,
    hostname: "host-a",
    lockIds: ["nonce-1"],
  });
  assertEquals(h.dispatchCalls[1].params.lockHolder, undefined);
  assertEquals(log, ["begin nonce-1", "end nonce-1"]);
});

Deno.test("DispatchService: a re-dispatch after a lost worker is a new hand-off with re-keyed locks (swamp-club#3111)", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
  });
  const { beginLockHandOff, log } = lockHandOffs();
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

  await h.service.executeRemote(stepRequest({ beginLockHandOff }));

  // The first attempt's hand-off ended before the second began, so the
  // nonce the lost runner holds matches no lock the retry runs under.
  assertEquals(log, [
    "begin nonce-1",
    "end nonce-1",
    "begin nonce-2",
    "end nonce-2",
  ]);
  assertEquals(
    h.dispatchCalls.map((call) => call.params.lockHolder?.lockIds),
    [["nonce-1"], ["nonce-2"]],
  );
});

Deno.test("DispatchService: a cancelled dispatch ends its hand-off and stays cancelled when the locks cannot be taken back", async () => {
  const h = createHarness();
  const { beginLockHandOff, log, endSignals } = lockHandOffs({
    failEnd: new Error("structural command still working"),
  });
  const controller = new AbortController();
  h.setBehavior(() => {
    controller.abort();
    return Promise.reject(
      new RpcError({ code: "cancelled", message: "aborted on worker" }),
    );
  });

  const error = await assertRejects(
    () =>
      h.service.executeRemote(
        stepRequest({ beginLockHandOff, signal: controller.signal }),
      ),
    DOMException,
  );
  assertEquals(error.name, "AbortError");
  // One attempt: a cancelled step is not dispatched again. Its end is given
  // the step's signal, so the reclaim does not wait (swamp-club#3157).
  assertEquals(log, ["begin nonce-1", "end nonce-1"]);
  assertEquals(h.dispatchCalls.length, 1);
  assertEquals(endSignals, [controller.signal]);
});

Deno.test("DispatchService: an attempt that succeeded still fails when its locks cannot be taken back, even if the step was cancelled meanwhile", async () => {
  const h = createHarness();
  const controller = new AbortController();
  const failure = new Error("structural command still working");
  const endSignals: Array<AbortSignal | undefined> = [];
  const beginLockHandOff: NonNullable<RemoteStepRequest["beginLockHandOff"]> =
    () =>
      Promise.resolve({
        lent: { pid: 4242, hostname: "host-a", lockIds: ["nonce-1"] },
        // The user cancels while the reclaim is waiting, and it times out.
        end: (signal) => {
          endSignals.push(signal);
          controller.abort();
          return Promise.reject(failure);
        },
      });

  const error = await assertRejects(() =>
    h.service.executeRemote(
      stepRequest({ beginLockHandOff, signal: controller.signal }),
    )
  );
  assertEquals(error, failure);
  // It has a result to write, so its reclaim is not cut short by a cancel.
  assertEquals(endSignals, [undefined]);
});

Deno.test("DispatchService: an attempt whose locks cannot be taken back fails the step instead of returning", async () => {
  const h = createHarness();
  const { beginLockHandOff } = lockHandOffs({
    failEnd: new Error("structural command still working"),
  });

  await assertRejects(
    () => h.service.executeRemote(stepRequest({ beginLockHandOff })),
    Error,
    "structural command still working",
  );
});

Deno.test("DispatchService: records the dispatch's trace headers for the data plane", async () => {
  const h = createHarness();
  let recorded: Readonly<Record<string, string>> | undefined;
  h.setBehavior(() => {
    // Read while the dispatch is active, as a data-plane request would.
    recorded = h.dispatches.forWorker("w1")[0]?.traceHeaders;
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  await h.service.executeRemote(
    stepRequest({
      traceHeaders: { traceparent: "00-abc-def-01" },
    } as Partial<RemoteStepRequest>),
  );
  assertEquals(recorded, { traceparent: "00-abc-def-01" });
});

Deno.test("DispatchService: a dispatch records the run's vault scope; lease transitions run outside it (swamp-club#2676)", async () => {
  const h = createHarness();
  const access = RunVaultAccess.create({ allowedVaults: ["roomcontrol"] });
  let recorded: RunVaultAccess | undefined;
  h.setBehavior(() => {
    recorded = h.dispatches.forWorker("w1")[0]?.vaultAccess;
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  await runWithVaultAccess(
    access,
    () => h.service.executeRemote(stepRequest()),
  );
  assertEquals(recorded, access);
  assertEquals(h.transitionScopes.length > 0, true);
  assertEquals(h.transitionScopes.every((s) => s === undefined), true);
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

Deno.test("executeRemote: forwards the worker's console capture as output events (swamp-club#3080)", async () => {
  const h = createHarness();
  h.setBehavior(() =>
    Promise.resolve({
      status: "success",
      outputs: [],
      logs: ["first", "second"],
      durationMs: 3,
    })
  );
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  await h.service.executeRemote(stepRequest({
    onEvent: (event) => events.push(event),
  }));

  assertEquals(events.filter((e) => e.kind === "method_event"), [
    {
      kind: "method_event",
      event: { type: "output", line: "first", stream: "stdout", level: "info" },
    },
    {
      kind: "method_event",
      event: {
        type: "output",
        line: "second",
        stream: "stdout",
        level: "info",
      },
    },
  ]);
});

Deno.test("executeRemote: forwards the worker's console capture when the dispatch failed (swamp-club#3080)", async () => {
  const h = createHarness();
  h.setBehavior(() =>
    Promise.resolve({
      status: "error",
      error: "boom",
      outputs: [],
      logs: ["before the failure"],
      durationMs: 3,
    })
  );
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        onEvent: (event) => events.push(event),
      })),
    Error,
    "boom",
  );

  assertEquals(
    events.filter((e) => e.kind === "method_event").map((e) =>
      (e.event as { line: string }).line
    ),
    ["before the failure"],
  );
});

Deno.test("executeRemote: a listener that throws on console output does not fail the dispatch (swamp-club#3080)", async () => {
  const h = createHarness();
  h.setBehavior(() =>
    Promise.resolve({
      status: "success",
      outputs: [],
      logs: ["first", "second"],
      durationMs: 3,
    })
  );
  let calls = 0;
  const result = await h.service.executeRemote(stepRequest({
    onEvent: (event) => {
      if (event.kind !== "method_event") return;
      calls++;
      throw new Error("client went away");
    },
  }));

  assertEquals(result.workerName, "w1");
  assertEquals(calls, 1);
  assertEquals(h.transitions.at(-1)?.methodName, "complete");
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

const OK_RESULT: DispatchResult = {
  status: "success",
  outputs: [],
  logs: [],
  durationMs: 1,
};

Deno.test("executeRemote: first affinity step re-dispatches when its worker is lost before the pin binds (swamp-club#3156)", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });
  const affinityKey = "run-4:job-build";

  let callCount = 0;
  h.setBehavior((name) => {
    callCount++;
    if (callCount === 1) {
      h.pool.delete(name);
      throw new ChannelClosedError("socket dropped");
    }
    return Promise.resolve(OK_RESULT);
  });

  const lost = h.dispatchCalls;
  const result = await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-1",
  }));
  assertEquals(callCount, 2);
  assertEquals(result.workerName !== lost[0].name, true);

  // The group pins to the worker that completed the first step.
  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-2",
  }));
  assertEquals(h.dispatchCalls[2].name, result.workerName);
});

Deno.test("executeRemote: first affinity step with declared writes fails when its worker is lost", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });
  let callCount = 0;
  h.setBehavior((name) => {
    callCount++;
    h.pool.delete(name);
    throw new ChannelClosedError("socket dropped");
  });

  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: {
          labels: {},
          platform: "linux",
          affinityKey: "run-4:job-w",
        },
        declaredWrites: true,
      })),
    WorkerAffinityLostError,
  );
  assertEquals(callCount, 1);
});

Deno.test("executeRemote: affinity worker lost mid-dispatch after the pin binds fails instead of re-dispatching", async () => {
  const h = createHarness({
    workers: [
      snapshot({ name: "w1" }),
      snapshot({ name: "w2" }),
    ],
  });
  const affinityKey = "run-4:job-bound";
  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-1",
  }));

  let callCount = 0;
  h.setBehavior(() => {
    callCount++;
    throw new ChannelClosedError("socket dropped");
  });
  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: { labels: {}, platform: "linux", affinityKey },
        stepName: "step-2",
      })),
    WorkerAffinityLostError,
  );
  assertEquals(callCount, 1);
});

Deno.test("executeRemote: affinity fails at once when the pinned worker is draining (swamp-club#3156)", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
    queueTimeoutMs: 60_000,
  });
  const affinityKey = "run-5:job-drain";
  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
  }));
  const pinned = h.dispatchCalls[0].name;
  h.pool.set(pinned, { ...h.pool.get(pinned)!, status: "draining" });

  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: { labels: {}, platform: "linux", affinityKey },
        stepName: "step-2",
      })),
    WorkerAffinityLostError,
  );
  assertEquals(h.dispatchCalls.length, 1);
});

Deno.test("executeRemote: a queued affinity step fails when its pinned worker starts draining (swamp-club#3156)", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
    queueTimeoutMs: 60_000,
  });
  const affinityKey = "run-6:job-drain";
  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
  }));
  const pinned = h.dispatchCalls[0].name;
  h.pool.set(pinned, {
    ...h.pool.get(pinned)!,
    status: "busy",
    activeDispatchIds: ["other"],
  });

  let queued = false;
  const step = h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-2",
    onEvent: (event) => {
      if (event.kind === "queued") queued = true;
    },
  }));
  step.catch(() => {});
  await waitFor(() => queued, "step-2 queued behind its busy pinned worker");

  const draining = { ...h.pool.get(pinned)!, status: "draining" as const };
  h.pool.set(pinned, draining);
  h.service.notifyWorkerDraining(draining);

  await assertRejects(() => step, WorkerAffinityLostError);
  assertEquals(h.dispatchCalls.length, 1);
});

Deno.test("executeRemote: a queued affinity step dispatches to its pinned worker once it is free", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
    queueTimeoutMs: 60_000,
  });
  const affinityKey = "run-7:job-busy";
  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
  }));
  const pinned = h.dispatchCalls[0].name;
  h.pool.set(pinned, {
    ...h.pool.get(pinned)!,
    status: "busy",
    activeDispatchIds: ["other"],
  });

  let queued = false;
  const step = h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-2",
    onEvent: (event) => {
      if (event.kind === "queued") queued = true;
    },
  }));
  await waitFor(() => queued, "step-2 queued behind its busy pinned worker");

  const idle = snapshot({ name: pinned });
  h.pool.set(pinned, idle);
  h.service.notifyWorkerIdle(idle);

  const result = await step;
  assertEquals(result.workerName, pinned);
});

Deno.test("executeRemote: a refused affinity step fails when its pinned worker has left, and re-queues when it is only busy", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
    queueTimeoutMs: 60_000,
  });
  const affinityKey = "run-8:job-refused";
  await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
  }));
  const pinned = h.dispatchCalls[0].name;

  // Busy desync on a healthy pinned worker: the step waits and retries.
  let attempts = 0;
  h.setBehavior(() => {
    attempts++;
    if (attempts === 1) {
      // A macrotask, so the wake lands after the step starts waiting.
      setTimeout(() => h.service.notifyWorkerIdle(snapshot({ name: pinned })));
      return Promise.reject(
        new RpcError({ code: "worker_busy", message: "at capacity" }),
      );
    }
    return Promise.resolve(OK_RESULT);
  });
  const retried = await h.service.executeRemote(stepRequest({
    placement: { labels: {}, platform: "linux", affinityKey },
    stepName: "step-2",
  }));
  assertEquals(retried.workerName, pinned);
  assertEquals(attempts, 2);

  // The pinned worker left the pool before the dispatch was sent.
  h.setBehavior((name) => {
    h.pool.delete(name);
    return Promise.reject(new WorkerNotDispatchableError(name, "not_in_pool"));
  });
  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: { labels: {}, platform: "linux", affinityKey },
        stepName: "step-3",
      })),
    WorkerAffinityLostError,
  );
});

Deno.test("executeRemote: an unbound first affinity step queues when the only worker is draining", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1", status: "draining" })],
    queueTimeoutMs: 50,
  });
  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: {
          labels: {},
          platform: "linux",
          affinityKey: "run-9:job-first",
        },
      })),
    Error,
    "Timed out waiting for a worker",
  );
  assertEquals(h.dispatchCalls.length, 0);
});

Deno.test("DispatchService: a worker that leaves the pool between scheduling and dispatch re-queues the step (swamp-club#3156)", async () => {
  const h = createHarness({
    workers: [snapshot({ name: "w1" }), snapshot({ name: "w2" })],
  });
  h.setBehavior((name) => {
    if (h.dispatchCalls.length === 1) {
      // What WorkerGateway.dispatch throws once a drained worker has closed
      // its socket and been removed from the pool.
      h.pool.delete(name);
      return Promise.reject(
        new WorkerNotDispatchableError(name, "not_in_pool"),
      );
    }
    return Promise.resolve(OK_RESULT);
  });

  const result = await h.service.executeRemote(stepRequest());
  assertEquals(h.dispatchCalls.length, 2);
  assertEquals(result.workerName, h.dispatchCalls[1].name);
  assertEquals(result.workerName !== h.dispatchCalls[0].name, true);
  // The abandoned attempt's lease ends; the second attempt's completes.
  assertEquals(
    h.transitions.filter((t) => t.typeArg.includes("lease")).map((t) =>
      t.methodName
    ),
    ["acquire", "expire", "acquire", "complete"],
  );
});

Deno.test("DispatchService: a probe refused by the gateway fails instead of re-queueing", async () => {
  const h = createHarness();
  h.setBehavior((name) =>
    Promise.reject(new WorkerNotDispatchableError(name, "at_capacity"))
  );
  await assertRejects(
    () =>
      h.service.executeRemote(stepRequest({
        placement: { target: "w1" },
        skipScheduler: true,
      })),
    WorkerNotDispatchableError,
  );
  assertEquals(h.dispatchCalls.length, 1);
});

for (
  const [label, refuse] of [
    [
      "a gateway refusal",
      (name: string) => new WorkerNotDispatchableError(name, "at_capacity"),
    ],
    [
      "worker_busy",
      (_name: string) =>
        new RpcError({ code: "worker_busy", message: "at capacity" }),
    ],
  ] as const
) {
  Deno.test(`DispatchService: a step re-queued on ${label} times out at its queue deadline`, async () => {
    const h = createHarness({ queueTimeoutMs: 50 });
    h.setBehavior((name) => Promise.reject(refuse(name)));
    await assertRejects(
      () => h.service.executeRemote(stepRequest()),
      Error,
      "Timed out waiting for a worker",
    );
    // The loop ended with the rejection: no dispatch follows it.
    const calls = h.dispatchCalls.length;
    assertEquals(calls >= 1, true);
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    assertEquals(h.dispatchCalls.length, calls);
  });
}

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
      // A write-bearing first step fails on a drop; a no-write one would
      // re-dispatch (swamp-club#3156).
      declaredWrites: true,
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

Deno.test("DispatchService: revoking the worker's token mid-dispatch fails the step instead of waiting out a grace window", async () => {
  const transitions: string[] = [];
  const gateway = new WorkerGateway({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    capabilityService: { registerHandlers: () => {} },
    // A long grace window: the step must not wait it out.
    graceWindowMs: 60_000,
    onWorkerRemoved: (worker) => service.notifyWorkerRemoved(worker),
    runModelMethod: () => Promise.resolve(),
    findTokenDefinitionId: (name) => Promise.resolve(`def-${name}`),
    readTokenExpiresAt: () => Promise.resolve(null),
    readTokenRecord: (name) =>
      Promise.resolve({
        name,
        state: "enrolled",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        vaultName: "local",
        secretKey: `worker-token-${name}`,
        maxEnrollments: 1,
        bindings: [],
      }),
  });
  const service = new DispatchService({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    dispatches: new DispatchRegistry(),
    bundles: new BundleRegistry(),
    queueTimeoutMs: 60_000,
    runModelMethod: (input) => {
      transitions.push(input.methodName);
      return Promise.resolve();
    },
    captureEnvironment: () => ({}),
  });
  service.bindGateway(gateway);

  // An in-process worker whose dispatch writes, then never returns.
  const workerChannel: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => attached.feed(data)),
  });
  const attached = gateway.attachTransport({
    send: (data) =>
      void Promise.resolve().then(() => workerChannel.handleRaw(data)),
  }, () => attached.closed());
  await workerChannel.call<EnrollResult>(RemoteMethod.enroll, {
    token: "w1.s3cret",
    instanceUuid: "uuid-1",
    machineId: "machine-1",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    swampVersion: "1.0.0",
    platform: "linux",
    arch: "x86_64",
    labels: {},
  });
  let dispatched = false;
  workerChannel.register(WorkerMethod.dispatch, async (params) => {
    const p = params as DispatchParams;
    await service.recordFirstWrite({
      workerName: "w1",
      dispatchId: p.dispatchId,
      leaseId: p.leaseId,
      modelDef: builtinModelDef,
      modelType: MODEL_TYPE,
      modelId: "m-1",
      methodName: "run",
      definitionName: "test-def",
      definitionTags: {},
    });
    dispatched = true;
    return await new Promise(() => {});
  });

  const step = service.executeRemote(stepRequest());
  await waitFor(() => dispatched, "dispatch reached the worker");
  await gateway.revokeToken("w1", "revoked");

  await assertRejects(() => step, Error, "write-then-drop");
  assertEquals(transitions, ["acquire", "mark_writes", "fail"]);
  gateway.dispose();
});

Deno.test("DispatchService: forwards the unresolved args and secret bag to the worker (swamp-club#2760)", async () => {
  const h = createHarness();
  const sentinel = `__SWAMP_VSEC_${"0a1b2c3d".repeat(4)}_0__`;
  const registered: Array<Record<string, unknown>> = [];
  h.setBehavior((name) => {
    for (const entry of h.dispatches.forWorker(name)) {
      registered.push({ ...entry });
    }
    return Promise.resolve<DispatchResult>({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });

  await h.service.executeRemote(stepRequest({
    methodArgs: { run: "echo s3cret" },
    unresolvedMethodArgs: { run: `echo ${sentinel}` },
    secretBag: [{ sentinel, value: "s3cret", dataOrigin: false }],
    secretValues: ["s3cret"],
  }));

  const params = h.dispatchCalls[0].params;
  assertEquals(params.execution.methodArgs, { run: "echo s3cret" });
  assertEquals(params.unresolvedMethodArgs, { run: `echo ${sentinel}` });
  assertEquals(params.secretBag, [{
    sentinel,
    value: "s3cret",
    dataOrigin: false,
  }]);
  // The bag goes to the worker only; the dispatch registry never holds it.
  assertEquals(registered.length, 1);
  assertEquals("secretBag" in registered[0], false);
  assertEquals("unresolvedMethodArgs" in registered[0], false);
});

Deno.test("DispatchService: dispatch-env-allow limits the shipped snapshot (swamp-club#2791)", async () => {
  const service = new DispatchService({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    dispatches: new DispatchRegistry(),
    bundles: new BundleRegistry(),
    dispatchEnvAllow: [],
    runModelMethod: () => Promise.resolve(),
  });
  const calls: DispatchParams[] = [];
  service.bindGateway({
    workers: () => [snapshot({ name: "w1" })],
    worker: () => snapshot({ name: "w1" }),
    dispatch: (_name, params) => {
      calls.push(params);
      return Promise.resolve({
        status: "success",
        outputs: [],
        logs: [],
        durationMs: 1,
      });
    },
  });

  await service.executeRemote(stepRequest());

  // The real process environment, with an empty allowlist: nothing ships.
  assertEquals(calls[0].environmentSnapshot, {});
});

/**
 * A one-worker pool whose fake gateway counts slots the way the real one
 * does: a dispatch is listed in `activeDispatchIds` from registration until
 * it settles, and one past capacity is refused. Each dispatch stays open
 * until the test settles its gate.
 */
function createSlotHarness(capacity: number) {
  const active: string[] = [];
  const calls: DispatchParams[] = [];
  const gates: PromiseWithResolvers<DispatchResult>[] = [];
  /** Step names whose lease acquire rejects. */
  const failedAcquires = new Set<string>();
  const worker = (): WorkerSnapshot =>
    snapshot({
      name: "w1",
      capacity,
      activeDispatchIds: [...active],
      status: active.length > 0 ? "busy" : "idle",
    });

  const service = new DispatchService({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    dispatches: new DispatchRegistry(),
    bundles: new BundleRegistry(),
    queueTimeoutMs: 60_000,
    runModelMethod: (input) => {
      const stepName = String(input.inputs.stepName);
      if (input.methodName === "acquire" && failedAcquires.has(stepName)) {
        return Promise.reject(
          new Error(`stubbed acquire failure: ${stepName}`),
        );
      }
      return Promise.resolve();
    },
    captureEnvironment: () => ({}),
  });
  service.bindGateway({
    workers: () => [worker()],
    worker: () => worker(),
    dispatch: (_name, params, options) => {
      if (active.length >= capacity) {
        return Promise.reject(new Error("Worker 'w1' is at capacity"));
      }
      calls.push(params);
      active.push(params.dispatchId);
      options?.onRegistered?.();
      const gate = Promise.withResolvers<DispatchResult>();
      gates.push(gate);
      return gate.promise.finally(() => {
        active.splice(active.indexOf(params.dispatchId), 1);
        service.notifyWorkerIdle(worker());
      });
    },
  });

  /** Runs a step, recording whether it was ever queued. */
  const run = (stepName: string, overrides?: Partial<RemoteStepRequest>) => {
    const step = { queued: false, done: Promise.resolve() };
    step.done = service.executeRemote(stepRequest({
      stepName,
      onEvent: (event) => {
        if (event.kind === "queued") step.queued = true;
      },
      ...overrides,
    })).then(() => {});
    return step;
  };
  const succeed = (index: number) =>
    gates[index].resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });

  return {
    service,
    worker,
    active,
    calls,
    gates,
    failedAcquires,
    run,
    succeed,
  };
}

Deno.test("DispatchService: a step arriving mid-dispatch gets the worker's free slot (swamp-club#3293)", async () => {
  const h = createSlotHarness(2);
  const first = h.run("one");
  await waitFor(() => h.calls.length === 1, "first dispatch registered");

  // One of two slots is in use: the second step must not wait for it.
  const second = h.run("two");
  await waitFor(() => h.calls.length === 2, "second dispatch registered");
  assertEquals(second.queued, false);
  assertEquals(h.active.length, 2);

  h.succeed(0);
  h.succeed(1);
  await first.done;
  await second.done;
});

Deno.test("DispatchService: steps arriving together never exceed the worker's capacity (swamp-club#3293)", async () => {
  const h = createSlotHarness(2);
  const steps = [h.run("one"), h.run("two"), h.run("three")];
  await waitFor(() => h.calls.length === 2, "two dispatches registered");
  // The third was placed while the first two only held reservations.
  assertEquals(steps.map((s) => s.queued), [false, false, true]);
  assertEquals(h.active.length, 2);

  // A slot frees up: the queued step takes it.
  h.succeed(0);
  await waitFor(() => h.calls.length === 3, "third dispatch registered");
  h.succeed(1);
  h.succeed(2);
  await Promise.all(steps.map((s) => s.done));
});

Deno.test("DispatchService: a retried step holds one slot, not one per attempt (swamp-club#3293)", async () => {
  const h = createSlotHarness(2);
  const retried = h.run("one");
  await waitFor(() => h.calls.length === 1, "first attempt registered");
  h.gates[0].reject(
    new RpcError({ code: "worker_busy", message: "Worker is at capacity" }),
  );
  // The re-queued step waits for a pool change, as it would for the
  // gateway's idle notification.
  await waitFor(() => {
    h.service.notifyWorkerIdle(h.worker());
    return h.calls.length === 2;
  }, "second attempt registered");

  // Only the second attempt occupies a slot, so the other one is free.
  const other = h.run("two");
  await waitFor(() => h.calls.length === 3, "other step registered");
  assertEquals(other.queued, false);

  h.succeed(1);
  h.succeed(2);
  await retried.done;
  await other.done;

  // Nothing is left reserved: both slots are available again.
  const pair = [h.run("three"), h.run("four")];
  await waitFor(() => h.calls.length === 5, "both later steps registered");
  assertEquals(pair.map((s) => s.queued), [false, false]);
  h.succeed(3);
  h.succeed(4);
  await Promise.all(pair.map((s) => s.done));
});

Deno.test("DispatchService: an attempt that fails before reaching the gateway frees its slot (swamp-club#3293)", async () => {
  const h = createSlotHarness(2);
  h.failedAcquires.add("one");
  await assertRejects(
    () => h.service.executeRemote(stepRequest({ stepName: "one" })),
    Error,
    "stubbed acquire failure",
  );
  assertEquals(h.calls.length, 0);

  const pair = [h.run("two"), h.run("three")];
  await waitFor(() => h.calls.length === 2, "both steps registered");
  assertEquals(pair.map((s) => s.queued), [false, false]);
  h.succeed(0);
  h.succeed(1);
  await Promise.all(pair.map((s) => s.done));
});

Deno.test("DispatchService: an unscheduled dispatch leaves another step's reservation alone (swamp-club#3293)", async () => {
  const h = createSlotHarness(2);
  // Step one is placed on w1 but held before the gateway registers it.
  const handOff = Promise.withResolvers<void>();
  const reserved = h.run("one", {
    beginLockHandOff: async () => {
      await handOff.promise;
      return { lent: undefined, end: () => Promise.resolve() };
    },
  });

  const unscheduled = h.run("probe", {
    skipScheduler: true,
    placement: { labels: {}, platform: "linux", target: "w1" },
  });
  await waitFor(() => h.calls.length === 1, "unscheduled dispatch registered");
  h.succeed(0);
  await unscheduled.done;

  // Step one's reservation still holds a slot, so only one more step fits.
  const second = h.run("two");
  await waitFor(() => h.calls.length === 2, "second dispatch registered");
  const third = h.run("three");
  await waitFor(() => third.queued, "third step queued");
  assertEquals(second.queued, false);
  assertEquals(h.calls.length, 2);

  handOff.resolve();
  await waitFor(() => h.calls.length === 3, "reserved step registered");
  h.succeed(1);
  h.succeed(2);
  await waitFor(() => h.calls.length === 4, "third dispatch registered");
  h.succeed(3);
  await Promise.all([reserved.done, second.done, third.done]);
});

Deno.test("DispatchService: a two-slot worker runs a step that arrives while another is running (swamp-club#3293)", async () => {
  const gateway = new WorkerGateway({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    capabilityService: { registerHandlers: () => {} },
    onWorkerIdle: (worker) => service.notifyWorkerIdle(worker),
    runModelMethod: () => Promise.resolve(),
    readTokenExpiresAt: () => Promise.resolve(null),
    findTokenDefinitionId: (name) => Promise.resolve(`def-${name}`),
    readTokenRecord: (name) =>
      Promise.resolve({
        name,
        state: "enrolled",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        vaultName: "local",
        secretKey: `worker-token-${name}`,
        maxEnrollments: 1,
        bindings: [],
      }),
  });
  const service = new DispatchService({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    dispatches: new DispatchRegistry(),
    bundles: new BundleRegistry(),
    queueTimeoutMs: 60_000,
    runModelMethod: () => Promise.resolve(),
    captureEnvironment: () => ({}),
  });
  service.bindGateway(gateway);

  const workerChannel: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => attached.feed(data)),
  });
  const attached = gateway.attachTransport({
    send: (data) =>
      void Promise.resolve().then(() => workerChannel.handleRaw(data)),
  }, () => attached.closed());
  await workerChannel.call<EnrollResult>(RemoteMethod.enroll, {
    token: "w1.s3cret",
    instanceUuid: "uuid-1",
    machineId: "machine-1",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    swampVersion: "1.0.0",
    platform: "linux",
    arch: "x86_64",
    labels: {},
    resourceLimits: { capacity: 2 },
  });
  let running = 0;
  const finish = Promise.withResolvers<void>();
  workerChannel.register(WorkerMethod.dispatch, async () => {
    running++;
    await finish.promise;
    return { status: "success", outputs: [], logs: [], durationMs: 1 };
  });

  const first = service.executeRemote(stepRequest({ stepName: "one" }));
  await waitFor(() => running === 1, "first dispatch reached the worker");
  assertEquals(gateway.worker("w1")?.activeDispatchIds.length, 1);

  let queued = false;
  const second = service.executeRemote(stepRequest({
    stepName: "two",
    onEvent: (event) => {
      if (event.kind === "queued") queued = true;
    },
  }));
  await waitFor(() => running === 2, "second dispatch reached the worker");
  assertEquals(queued, false);

  finish.resolve();
  await first;
  await second;
  gateway.dispose();
});

/** A source of written versions for {@link DispatchService.setWrittenVersionsSource}. */
function writtenVersionsSource(versions: Map<string, WrittenVersion[]>) {
  return (dispatchId: string) =>
    Promise.resolve(versions.get(dispatchId) ?? []);
}

const WRITTEN: WrittenVersion = {
  modelType: MODEL_TYPE.normalized,
  modelId: "m-1",
  dataName: "out-main",
  version: 4,
};

Deno.test("DispatchService: a failed dispatch's error carries the versions it wrote (swamp-club#3146)", async () => {
  const h = createHarness();
  const versions = new Map<string, WrittenVersion[]>();
  h.service.setWrittenVersionsSource(writtenVersionsSource(versions));
  h.setBehavior((_name, params) => {
    versions.set(params.dispatchId, [WRITTEN]);
    return Promise.resolve({
      status: "error",
      error: "boom after writing",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });

  const error = await assertRejects(
    () => h.service.executeRemote(stepRequest()),
    Error,
    "boom after writing",
  );
  assertEquals(writtenVersionsOf(error), [WRITTEN]);
});

Deno.test("DispatchService: write-then-drop and cancel keep the written versions on the error they throw (swamp-club#3146)", async () => {
  for (const ending of ["drop", "cancel"] as const) {
    const h = createHarness();
    const versions = new Map<string, WrittenVersion[]>();
    h.service.setWrittenVersionsSource(writtenVersionsSource(versions));
    h.setBehavior(async (name, params) => {
      versions.set(params.dispatchId, [WRITTEN]);
      if (ending === "cancel") {
        return await Promise.reject(
          new RpcError({ code: "cancelled", message: "aborted on worker" }),
        );
      }
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
      return await Promise.reject(
        new ChannelClosedError("control socket closed"),
      );
    });

    const error = await assertRejects(() =>
      h.service.executeRemote(stepRequest())
    );
    assertEquals(writtenVersionsOf(error), [WRITTEN], ending);
  }
});

Deno.test("withWrittenVersions: attaches the versions, and leaves an error without any unchanged", () => {
  const error = new Error("x");
  assertEquals(withWrittenVersions(error, []), error);
  assertEquals(writtenVersionsOf(error), []);
  assertEquals(withWrittenVersions(error, [WRITTEN]), error);
  assertEquals(writtenVersionsOf(error), [WRITTEN]);
  assertEquals(
    withWrittenVersions("not an object", [WRITTEN]),
    "not an object",
  );
});

Deno.test("DispatchService: a step skips a worker whose enrollment finished after its socket closed (swamp-club#3405)", async () => {
  let redeemGate: Promise<void> | null = null;
  let openRedeem = () => {};
  let redeems = 0;
  const gateway = new WorkerGateway({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    capabilityService: { registerHandlers: () => {} },
    graceWindowMs: 60_000,
    onWorkerIdle: (worker) => service.notifyWorkerIdle(worker),
    onWorkerEnrolled: (worker) => service.notifyWorkerEnrolled(worker),
    runModelMethod: async (input) => {
      if (input.methodName === "redeem") {
        redeems++;
        if (redeemGate !== null) await redeemGate;
      }
    },
    findTokenDefinitionId: (name) => Promise.resolve(`def-${name}`),
    readTokenExpiresAt: () => Promise.resolve(null),
    readTokenRecord: (name) =>
      Promise.resolve({
        name,
        state: "enrolled",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        vaultName: "local",
        secretKey: `worker-token-${name}`,
        maxEnrollments: 1,
        bindings: [],
      }),
  });
  const service = new DispatchService({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    dispatches: new DispatchRegistry(),
    bundles: new BundleRegistry(),
    queueTimeoutMs: 60_000,
    runModelMethod: () => Promise.resolve(),
    captureEnvironment: () => ({}),
  });
  service.bindGateway(gateway);
  const connect = () => {
    const workerChannel: RpcChannel = new RpcChannel({
      send: (data) => void Promise.resolve().then(() => attached.feed(data)),
    });
    const attached = gateway.attachTransport({
      send: (data) =>
        void Promise.resolve().then(() => workerChannel.handleRaw(data)),
    }, () => attached.closed());
    return { workerChannel, dropSocket: () => attached.closed() };
  };
  const enrollParams = (token: string, instanceUuid: string) => ({
    token,
    instanceUuid,
    machineId: `machine-${instanceUuid}`,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    swampVersion: "1.0.0",
    platform: "linux",
    arch: "x86_64",
    labels: {},
  });

  // "a-dead" sorts before "b-live", so the scheduler offers it first.
  redeemGate = new Promise<void>((resolve) => {
    openRedeem = () => {
      redeemGate = null;
      resolve();
    };
  });
  const dead = connect();
  const deadEnroll = dead.workerChannel.call(
    RemoteMethod.enroll,
    enrollParams("a-dead.s3cret", "uuid-a"),
    { timeoutMs: null },
  ).catch(() => {});
  await waitFor(() => redeems === 1, "dead enrollment reached redeem");
  dead.dropSocket();
  openRedeem();
  await waitFor(() => gateway.worker("a-dead") !== null, "late enrollment");

  const live = connect();
  await live.workerChannel.call<EnrollResult>(
    RemoteMethod.enroll,
    enrollParams("b-live.s3cret", "uuid-b"),
  );
  // On a dead session reported as connected, the step re-dispatches to it
  // in a loop that never yields to timers; stop it after a few attempts.
  const abort = new AbortController();
  const dispatchedTo: string[] = [];
  const dispatchOnGateway = gateway.dispatch.bind(gateway);
  gateway.dispatch = (name, params, options) => {
    dispatchedTo.push(name);
    if (dispatchedTo.length > 5) abort.abort();
    return dispatchOnGateway(name, params, options);
  };
  live.workerChannel.register(
    WorkerMethod.dispatch,
    () =>
      Promise.resolve<DispatchResult>({
        status: "success",
        outputs: [],
        logs: [],
        durationMs: 1,
      }),
  );

  await service.executeRemote(stepRequest({ signal: abort.signal }));
  assertEquals(dispatchedTo, ["b-live"]);
  dead.workerChannel.close("test done");
  await deadEnroll;
  gateway.dispose();
});
