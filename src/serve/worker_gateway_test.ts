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
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  fleetMemberSuffix,
  splitEnrollmentToken,
  WorkerGateway,
  type WorkerGatewayOptions,
  type WorkerSnapshot,
} from "./worker_gateway.ts";
import { RpcChannel, RpcError } from "../domain/remote/rpc_channel.ts";
import {
  type DispatchParams,
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  WorkerMethod,
} from "../domain/remote/protocol.ts";

interface RecordedTransition {
  typeArg: string;
  definitionName: string;
  methodName: string;
  inputs: Record<string, unknown>;
}

interface Harness {
  gateway: WorkerGateway;
  transitions: RecordedTransition[];
  idle: WorkerSnapshot[];
  disconnected: WorkerSnapshot[];
  graceExpired: WorkerSnapshot[];
  failOn: Set<string>;
}

function createHarness(
  overrides?: Partial<WorkerGatewayOptions>,
): Harness {
  const transitions: RecordedTransition[] = [];
  const idle: WorkerSnapshot[] = [];
  const disconnected: WorkerSnapshot[] = [];
  const graceExpired: WorkerSnapshot[] = [];
  const failOn = new Set<string>();
  const gateway = new WorkerGateway({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    capabilityService: {
      registerHandlers: (channel: RpcChannel) => {
        channel.register(
          RemoteMethod.getData,
          () => Promise.resolve({ found: false }),
        );
      },
    },
    graceWindowMs: 30,
    onWorkerIdle: (w) => idle.push(w),
    onWorkerDisconnected: (w) => disconnected.push(w),
    onGraceExpired: (w) => graceExpired.push(w),
    runModelMethod: (input) => {
      if (failOn.has(input.methodName)) {
        return Promise.reject(
          new Error(`stubbed failure: ${input.methodName}`),
        );
      }
      transitions.push(input);
      return Promise.resolve();
    },
    // No expiry enforcement unless a test opts in with a real timestamp.
    readTokenExpiresAt: () => Promise.resolve(null),
    ...overrides,
  });
  return { gateway, transitions, idle, disconnected, graceExpired, failOn };
}

/** Wires a simulated worker control socket to the gateway. */
function connectWorkerSocket(gateway: WorkerGateway): {
  workerChannel: RpcChannel;
  dropSocket: () => void;
} {
  const workerChannel: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => attached.feed(data)),
  });
  const attached = gateway.attachTransport({
    send: (data) =>
      void Promise.resolve().then(() => workerChannel.handleRaw(data)),
    // A gateway-initiated close surfaces like a real socket close.
  }, () => attached.closed());
  return { workerChannel, dropSocket: () => attached.closed() };
}

const enrollParams = {
  token: "ci-runner-3.s3cret",
  instanceUuid: "uuid-1",
  machineId: "machine-1",
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  swampVersion: "1.0.0",
  platform: "linux",
  arch: "x86_64",
  labels: { region: "us-east" },
};

function enroll(
  channel: RpcChannel,
  params: Record<string, unknown> = enrollParams,
): Promise<EnrollResult> {
  return channel.call<EnrollResult>(RemoteMethod.enroll, params);
}

Deno.test("splitEnrollmentToken: splits on the first dot only", () => {
  assertEquals(splitEnrollmentToken("ci.abc.def"), {
    name: "ci",
    secret: "abc.def",
  });
  assertEquals(splitEnrollmentToken("noseparator"), null);
  assertEquals(splitEnrollmentToken(".secret"), null);
  assertEquals(splitEnrollmentToken("name."), null);
});

Deno.test("WorkerGateway: enrollment redeems the token, records the worker, issues a credential", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);

  assertEquals(result.workerId, "ci-runner-3");
  assertEquals(result.protocolVersion, REMOTE_PROTOCOL_VERSION);
  assertEquals(typeof result.sessionCredential, "string");
  assertEquals(
    h.gateway.sessions.verify(result.sessionCredential),
    "ci-runner-3",
  );

  assertEquals(h.transitions.map((t) => t.methodName), ["redeem", "enroll"]);
  assertEquals(h.transitions[0].typeArg, "swamp/enrollment-token");
  assertEquals(h.transitions[0].inputs.presentedToken, "s3cret");
  assertEquals(h.transitions[0].inputs.machineId, "machine-1");
  assertEquals(h.transitions[1].typeArg, "swamp/worker");

  const workers = h.gateway.workers();
  assertEquals(workers.length, 1);
  assertEquals(workers[0].status, "idle");
  assertEquals(workers[0].connected, true);
  assertEquals(h.idle.length, 1);
});

Deno.test("WorkerGateway: protocol mismatch is rejected before any transition", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const error = await assertRejects(
    () => enroll(workerChannel, { ...enrollParams, protocolVersion: 99 }),
    RpcError,
  );
  assertEquals(error.code, "protocol_mismatch");
  assertEquals(h.transitions.length, 0);
  assertEquals(h.gateway.workers().length, 0);
});

Deno.test("WorkerGateway: malformed token is rejected", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const error = await assertRejects(
    () => enroll(workerChannel, { ...enrollParams, token: "nodot" }),
    RpcError,
  );
  assertEquals(error.code, "invalid_token");
});

Deno.test("WorkerGateway: failed redemption leaves no pool state behind", async () => {
  const h = createHarness();
  h.failOn.add("redeem");
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await assertRejects(() => enroll(workerChannel), RpcError, "stubbed failure");
  assertEquals(h.gateway.workers().length, 0);
  assertEquals(h.idle.length, 0);
});

Deno.test("WorkerGateway: capability verbs are unavailable before enrollment", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const error = await assertRejects(
    () => workerChannel.call(RemoteMethod.getData, {}),
    RpcError,
  );
  assertEquals(error.code, "unknown_method");
  await enroll(workerChannel);
  assertEquals(
    await workerChannel.call(RemoteMethod.getData, {}),
    { found: false },
  );
});

Deno.test("WorkerGateway: session refresh issues a fresh sliding credential", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const first = await enroll(workerChannel);
  const refreshed = await workerChannel.call<
    { sessionCredential: string; sessionExpiresAtMs: number }
  >(RemoteMethod.sessionRefresh, {});
  assertEquals(
    h.gateway.sessions.verify(refreshed.sessionCredential),
    "ci-runner-3",
  );
  assertEquals(h.gateway.sessions.verify(first.sessionCredential), null);
});

function dispatchParams(dispatchId = "d-1"): DispatchParams {
  return {
    dispatchId,
    leaseId: `lease-${dispatchId}`,
    execution: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      modelType: "@acme/widget",
      modelId: "m-1",
      methodName: "create",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: { id: "m-1", name: "widget", version: 1, tags: {} },
    },
    bundleFingerprint: "fp-1",
    reportBundleFingerprints: [],
    environmentSnapshot: {},
    dataPlaneUrl: "http://127.0.0.1:0",
  };
}

Deno.test("WorkerGateway: dispatch streams events and records busy → idle", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  workerChannel.register(WorkerMethod.dispatch, (_params, ctx) => {
    ctx.stream({ kind: "log", line: "working" });
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: ["working"],
      durationMs: 5,
    });
  });

  const events: string[] = [];
  const result = await h.gateway.dispatch("ci-runner-3", dispatchParams(), {
    onEvent: (event) => events.push(String(event.line)),
  });
  assertEquals(result.status, "success");
  assertEquals(events, ["working"]);

  const statusTransitions = h.transitions
    .filter((t) => t.methodName === "set_status")
    .map((t) => t.inputs.status);
  assertEquals(statusTransitions, ["busy", "idle"]);
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "idle");
  // Idle fires at enrollment and again after the dispatch completes.
  assertEquals(h.idle.length, 2);
});

Deno.test("WorkerGateway: dispatch to a busy worker rejects", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  const gate = Promise.withResolvers<void>();
  workerChannel.register(WorkerMethod.dispatch, async () => {
    await gate.promise;
    return { status: "success", outputs: [], logs: [], durationMs: 1 };
  });

  const first = h.gateway.dispatch("ci-runner-3", dispatchParams("d-1"));
  await new Promise((r) => setTimeout(r, 10));
  await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams("d-2")),
    Error,
    "busy",
  );
  gate.resolve();
  await first;
});

Deno.test("WorkerGateway: dispatch to an unknown worker rejects", async () => {
  const h = createHarness();
  await assertRejects(
    () => h.gateway.dispatch("ghost", dispatchParams()),
    Error,
    "not in the pool",
  );
});

Deno.test("WorkerGateway: disconnect starts the grace window; reconnect cancels it", async () => {
  const h = createHarness({ graceWindowMs: 200 });
  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);

  first.dropSocket();
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(h.disconnected.length, 1);
  assertEquals(h.gateway.pendingGraceWindows, 1);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, false);
  assertEquals(
    h.transitions.at(-1)?.inputs.status,
    "disconnected",
  );

  // Same {token, instanceUuid} reconnects: same pool member, no re-enroll.
  const second = connectWorkerSocket(h.gateway);
  await enroll(second.workerChannel);
  assertEquals(h.gateway.pendingGraceWindows, 0);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, true);
  assertEquals(h.graceExpired.length, 0);
  // Reconnect re-redeems but does NOT run worker enroll again.
  const enrolls = h.transitions.filter((t) => t.methodName === "enroll");
  assertEquals(enrolls.length, 1);
  second.dropSocket();
  await new Promise((r) => setTimeout(r, 250));
});

Deno.test("WorkerGateway: a restarted process on the same machine re-enrolls after a disconnect", async () => {
  const h = createHarness({ graceWindowMs: 200 });
  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);
  first.dropSocket();
  await new Promise((r) => setTimeout(r, 5));

  // A restart means a fresh instanceUuid but the same persisted machineId —
  // the token's machine binding lets it back in as a fresh enrollment.
  const second = connectWorkerSocket(h.gateway);
  await enroll(second.workerChannel, {
    ...enrollParams,
    instanceUuid: "uuid-2",
  });
  assertEquals(h.gateway.pendingGraceWindows, 0);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, true);
  const enrolls = h.transitions.filter((t) => t.methodName === "enroll");
  assertEquals(enrolls.length, 2);
  second.dropSocket();
  await new Promise((r) => setTimeout(r, 250));
});

Deno.test("WorkerGateway: grace expiry removes the worker and revokes its credential", async () => {
  const h = createHarness({ graceWindowMs: 20 });
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);

  dropSocket();
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(h.graceExpired.length, 1);
  assertEquals(h.gateway.workers().length, 0);
  assertEquals(h.gateway.sessions.verify(result.sessionCredential), null);
});

Deno.test("WorkerGateway: token expiry disconnects the worker and removes it after grace", async () => {
  const h = createHarness({
    graceWindowMs: 20,
    readTokenExpiresAt: () =>
      Promise.resolve(new Date(Date.now() + 30).toISOString()),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, true);

  await new Promise((r) => setTimeout(r, 100));
  // The expiry timer recorded the lapsed lifetime, dropped the socket, and
  // the grace window then removed the worker from the pool.
  const expires = h.transitions.filter((t) => t.methodName === "expire");
  assertEquals(expires.length, 1);
  assertEquals(expires[0].typeArg, "swamp/enrollment-token");
  assertEquals(h.disconnected.length, 1);
  assertEquals(h.graceExpired.length, 1);
  assertEquals(h.gateway.workers().length, 0);
});

Deno.test("WorkerGateway: a different instance cannot enroll while a worker is connected", async () => {
  const h = createHarness();
  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);

  const second = connectWorkerSocket(h.gateway);
  const error = await assertRejects(
    () =>
      enroll(second.workerChannel, {
        ...enrollParams,
        instanceUuid: "uuid-2",
      }),
    RpcError,
  );
  assertEquals(error.code, "already_connected");
});

Deno.test("WorkerGateway: dispatch ending after a socket drop does not mark idle", async () => {
  const h = createHarness({ graceWindowMs: 30 });
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  workerChannel.register(
    WorkerMethod.dispatch,
    (_params, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );

  const dispatch = h.gateway.dispatch("ci-runner-3", dispatchParams());
  await new Promise((r) => setTimeout(r, 10));
  dropSocket();
  await assertRejects(() => dispatch, Error);
  // No idle status write may follow the disconnect record.
  assertEquals(h.transitions.at(-1)?.inputs.status, "disconnected");
  assertEquals(h.idle.length, 1); // only the enrollment idle
  await new Promise((r) => setTimeout(r, 50));
});

Deno.test("WorkerGateway: a cancelled dispatch frees the worker only after it unwinds", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  let unwound = false;
  workerChannel.register(
    WorkerMethod.dispatch,
    (_params, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          setTimeout(() => {
            unwound = true;
            reject(new DOMException("aborted", "AbortError"));
          }, 20);
        });
      }),
  );

  const cancel = new AbortController();
  const dispatch = h.gateway.dispatch("ci-runner-3", dispatchParams("d-c"), {
    signal: cancel.signal,
  });
  await new Promise((r) => setTimeout(r, 10));
  cancel.abort();
  await assertRejects(() => dispatch, RpcError, "aborted");
  // By the time the dispatch settled, the worker's serial slot was free —
  // an immediate follow-up dispatch must not hit worker_busy.
  assertEquals(unwound, true);
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "idle");

  workerChannel.register(WorkerMethod.dispatch, () =>
    Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    }));
  const followUp = await h.gateway.dispatch(
    "ci-runner-3",
    dispatchParams("d-n"),
  );
  assertEquals(followUp.status, "success");
});

// ── Fleet token tests ──────────────────────────────────────────────────

Deno.test("fleetMemberSuffix: returns a stable 8-char hex suffix", async () => {
  const a = await fleetMemberSuffix("machine-1");
  assertEquals(a.length, 8);
  assertEquals(/^[0-9a-f]{8}$/.test(a), true);
  assertEquals(await fleetMemberSuffix("machine-1"), a);
  const b = await fleetMemberSuffix("machine-2");
  assertEquals(b.length, 8);
  assertEquals(a === b, false);
});

Deno.test("WorkerGateway: fleet token (maxEnrollments > 1) names workers with suffix", async () => {
  const h = createHarness({
    readTokenMaxEnrollments: () => Promise.resolve(3),
  });
  const { workerChannel: w1 } = connectWorkerSocket(h.gateway);
  const result1 = await enroll(w1, {
    ...enrollParams,
    machineId: "machine-1",
    instanceUuid: "uuid-1",
  });
  const suffix1 = await fleetMemberSuffix("machine-1");
  assertEquals(result1.workerId, `ci-runner-3-${suffix1}`);

  const { workerChannel: w2 } = connectWorkerSocket(h.gateway);
  const result2 = await enroll(w2, {
    ...enrollParams,
    machineId: "machine-2",
    instanceUuid: "uuid-2",
  });
  const suffix2 = await fleetMemberSuffix("machine-2");
  assertEquals(result2.workerId, `ci-runner-3-${suffix2}`);

  const workers = h.gateway.workers();
  assertEquals(workers.length, 2);
  const names = workers.map((w) => w.name).sort();
  assertEquals(
    names,
    [`ci-runner-3-${suffix1}`, `ci-runner-3-${suffix2}`].sort(),
  );
});

Deno.test("WorkerGateway: single-enrollment token (maxEnrollments === 1) uses plain token name", async () => {
  const h = createHarness({
    readTokenMaxEnrollments: () => Promise.resolve(1),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);
  assertEquals(result.workerId, "ci-runner-3");
});

Deno.test("WorkerGateway: fleet token auto-injects fleet label", async () => {
  const h = createHarness({
    readTokenMaxEnrollments: () => Promise.resolve(5),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  const enrollTransition = h.transitions.find((t) => t.methodName === "enroll");
  const labels = enrollTransition?.inputs.labels as Record<string, string>;
  assertEquals(labels.fleet, "ci-runner-3");
  assertEquals(labels.region, "us-east");
});

Deno.test("WorkerGateway: worker-supplied fleet label wins over auto-injection", async () => {
  const h = createHarness({
    readTokenMaxEnrollments: () => Promise.resolve(5),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel, {
    ...enrollParams,
    labels: { region: "us-east", fleet: "custom-fleet" },
  });
  const enrollTransition = h.transitions.find((t) => t.methodName === "enroll");
  const labels = enrollTransition?.inputs.labels as Record<string, string>;
  assertEquals(labels.fleet, "custom-fleet");
});

Deno.test("WorkerGateway: fleet worker naming is stable across reconnects", async () => {
  const h = createHarness({
    graceWindowMs: 200,
    readTokenMaxEnrollments: () => Promise.resolve(3),
  });
  const first = connectWorkerSocket(h.gateway);
  const result1 = await enroll(first.workerChannel);
  const suffix = await fleetMemberSuffix("machine-1");
  assertEquals(result1.workerId, `ci-runner-3-${suffix}`);

  first.dropSocket();
  await new Promise((r) => setTimeout(r, 5));

  const second = connectWorkerSocket(h.gateway);
  const result2 = await enroll(second.workerChannel);
  assertEquals(result2.workerId, `ci-runner-3-${suffix}`);
  assertEquals(h.gateway.workers().length, 1);
  second.dropSocket();
  await new Promise((r) => setTimeout(r, 250));
});

Deno.test("WorkerGateway: null readTokenMaxEnrollments defaults to single-machine naming", async () => {
  const h = createHarness({
    readTokenMaxEnrollments: () => Promise.resolve(null),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);
  assertEquals(result.workerId, "ci-runner-3");
});

Deno.test("WorkerGateway: fleet token expiry records expire on the token name, not the worker name", async () => {
  const h = createHarness({
    graceWindowMs: 20,
    readTokenExpiresAt: () =>
      Promise.resolve(new Date(Date.now() + 30).toISOString()),
    readTokenMaxEnrollments: () => Promise.resolve(3),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);
  const suffix = await fleetMemberSuffix("machine-1");
  assertEquals(result.workerId, `ci-runner-3-${suffix}`);

  await new Promise((r) => setTimeout(r, 100));
  const expires = h.transitions.filter((t) => t.methodName === "expire");
  assertEquals(expires.length, 1);
  assertEquals(expires[0].typeArg, "swamp/enrollment-token");
  assertEquals(expires[0].definitionName, "ci-runner-3");
  assertEquals(h.graceExpired.length, 1);
  assertEquals(h.gateway.workers().length, 0);
});

Deno.test("WorkerGateway: verifyOnEnroll — worker starts as unverified and transitions to idle on probe pass", async () => {
  const enrolled: WorkerSnapshot[] = [];
  let resolveProbe!: () => void;
  const probePromise = new Promise<void>((r) => {
    resolveProbe = r;
  });
  const h = createHarness({
    verifyOnEnroll: true,
    verifyWorker: async () => {
      await probePromise;
      return { ok: true };
    },
    onWorkerEnrolled: (w) => enrolled.push(w),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  const before = h.gateway.workers();
  assertEquals(before.length, 1);
  assertEquals(before[0].status, "unverified");
  assertEquals(h.idle.length, 0);
  assertEquals(enrolled.length, 0);

  resolveProbe();
  await new Promise((r) => setTimeout(r, 50));

  const after = h.gateway.workers();
  assertEquals(after[0].status, "idle");
  assertEquals(h.idle.length, 1);
  assertEquals(enrolled.length, 1);
  const setIdle = h.transitions.filter((t) =>
    t.methodName === "set_status" && t.inputs.status === "idle"
  );
  assertEquals(setIdle.length, 1);
});

Deno.test("WorkerGateway: verifyOnEnroll — probe failure leaves worker unverified with reason", async () => {
  const enrolled: WorkerSnapshot[] = [];
  const h = createHarness({
    verifyOnEnroll: true,
    verifyWorker: () =>
      Promise.resolve({ ok: false, failureReason: "data plane broken" }),
    onWorkerEnrolled: (w) => enrolled.push(w),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  await new Promise((r) => setTimeout(r, 50));

  const workers = h.gateway.workers();
  assertEquals(workers.length, 1);
  assertEquals(workers[0].status, "unverified");
  assertEquals(workers[0].verifyFailureReason, "data plane broken");
  assertEquals(h.idle.length, 0);
  assertEquals(enrolled.length, 0);
  const setUnverified = h.transitions.filter((t) =>
    t.methodName === "set_status" && t.inputs.status === "unverified"
  );
  assertEquals(setUnverified.length, 1);
  assertEquals(
    setUnverified[0].inputs.verifyFailureReason,
    "data plane broken",
  );
});

Deno.test("WorkerGateway: verifyOnEnroll — probe error leaves worker unverified with error message", async () => {
  const h = createHarness({
    verifyOnEnroll: true,
    verifyWorker: () => Promise.reject(new Error("dispatch timeout")),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  await new Promise((r) => setTimeout(r, 50));

  const workers = h.gateway.workers();
  assertEquals(workers[0].status, "unverified");
  assertEquals(workers[0].verifyFailureReason, "dispatch timeout");
  assertEquals(h.idle.length, 0);
});

Deno.test("WorkerGateway: without verifyOnEnroll — worker becomes idle immediately", async () => {
  const enrolled: WorkerSnapshot[] = [];
  const h = createHarness({
    onWorkerEnrolled: (w) => enrolled.push(w),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  const workers = h.gateway.workers();
  assertEquals(workers[0].status, "idle");
  assertEquals(h.idle.length, 1);
  assertEquals(enrolled.length, 1);
});
