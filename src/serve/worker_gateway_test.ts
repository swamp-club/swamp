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

import { z } from "zod";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../infrastructure/tracing/execution_observer.ts";
import {
  findSpan,
  withCapturedSpans,
  withObservedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";
import { currentDiagnosticArea } from "../domain/diagnostics/diagnostic_phase.ts";
import {
  type ExecutionObservation,
  setExecutionObserver,
} from "../domain/remote/observability.ts";
import { UserError } from "../domain/errors.ts";
import { UNREADABLE_CONTENT_CODE } from "../domain/datastore/unreadable_content.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  fleetMemberSuffix,
  splitEnrollmentToken,
  WorkerGateway,
  type WorkerGatewayOptions,
  WorkerNotDispatchableError,
  type WorkerSnapshot,
} from "./worker_gateway.ts";
import {
  ChannelClosedError,
  RpcChannel,
  RpcError,
} from "../domain/remote/rpc_channel.ts";
import type { EnrollmentToken } from "../domain/models/worker/enrollment_token_model.ts";
import {
  WORKER_MODEL_TYPE,
  workerModel,
} from "../domain/models/worker/worker_model.ts";
import { createInMemoryWorkerContext } from "../domain/models/worker/worker_test_helpers.ts";
import {
  type DispatchParams,
  type EnrollResult,
  GATE_PASS_UNAVAILABLE,
  PERMANENT_ENROLLMENT_ERROR_CODES,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import { SERVE_NOT_LEADER_CODE } from "../domain/datastore_v3/serve_leader.ts";

interface RecordedTransition {
  typeArg: string;
  definitionName: string;
  methodName: string;
  inputs: Record<string, unknown>;
  expectedDefinitionId?: string;
}

interface Harness {
  gateway: WorkerGateway;
  transitions: RecordedTransition[];
  idle: WorkerSnapshot[];
  disconnected: WorkerSnapshot[];
  graceExpired: WorkerSnapshot[];
  removed: WorkerSnapshot[];
  failOn: Set<string>;
}

function createHarness(
  overrides?: Partial<WorkerGatewayOptions>,
): Harness {
  const transitions: RecordedTransition[] = [];
  const idle: WorkerSnapshot[] = [];
  const disconnected: WorkerSnapshot[] = [];
  const graceExpired: WorkerSnapshot[] = [];
  const removed: WorkerSnapshot[] = [];
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
    onWorkerRemoved: (w) => removed.push(w),
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
    readTokenRecord: (name) => Promise.resolve(mintRecord(name, BASE_MINT)),
    findTokenDefinitionId: (name) => Promise.resolve(`def-${name}`),
    ...overrides,
  });
  return {
    gateway,
    transitions,
    idle,
    disconnected,
    graceExpired,
    removed,
    failOn,
  };
}

const BASE_MINT = "2026-01-01T00:00:00.000Z";

function mintRecord(name: string, createdAt: string): EnrollmentToken {
  return {
    name,
    state: "enrolled",
    createdAt,
    expiresAt: "2099-01-01T00:00:00.000Z",
    vaultName: "local",
    secretKey: `worker-token-${name}`,
    maxEnrollments: 1,
    bindings: [],
  };
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
    h.gateway.sessions.verify(result.sessionCredential)?.workerId,
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

Deno.test("WorkerGateway: enrollment runs in a gateway-tail span (swamp-club#3755)", async () => {
  await withCapturedSpans(async (spans) => {
    const h = createHarness();
    const { workerChannel } = connectWorkerSocket(h.gateway);
    await enroll(workerChannel);

    const span = findSpan(spans, "swamp.serve.transition");
    assertEquals(span.attributes["swamp.transition.tail"], "gateway");
    assertEquals(span.attributes["swamp.transition.operation"], "enroll");
  });
});

Deno.test("WorkerGateway: protocol mismatch is rejected before any transition", async () => {
  for (const protocolVersion of [4, 7, 99]) {
    const h = createHarness();
    const { workerChannel } = connectWorkerSocket(h.gateway);
    const error = await assertRejects(
      () => enroll(workerChannel, { ...enrollParams, protocolVersion }),
      RpcError,
    );
    assertEquals(error.code, "protocol_mismatch");
    assertEquals(h.transitions.length, 0);
    assertEquals(h.gateway.workers().length, 0);
  }
});

Deno.test("WorkerGateway: enrolls protocol versions 5 and 6, keeps each worker's version, and warns about version 5 only (typed-secrets 5.2)", async () => {
  for (const protocolVersion of [5, 6]) {
    const h = createHarness();
    const { workerChannel } = connectWorkerSocket(h.gateway);
    const logs = await capturingGatewayLogs(async () => {
      const result = await enroll(workerChannel, {
        ...enrollParams,
        protocolVersion,
      });
      assertEquals(result.protocolVersion, protocolVersion);
    });
    assertEquals(
      h.gateway.worker("ci-runner-3")?.protocolVersion,
      protocolVersion,
    );
    const enrolled = h.transitions.find((t) => t.methodName === "enroll");
    assertEquals(enrolled?.inputs.protocolVersion, protocolVersion);
    const warnings = logs.filter((l) =>
      l.level === "warning" && l.message.includes("deprecated protocol")
    );
    if (protocolVersion === 5) {
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "ci-runner-3");
      assertStringIncludes(warnings[0].message, "typed-secrets 5.3");
    } else {
      assertEquals(warnings, []);
    }
  }
});

Deno.test("WorkerGateway: a dispatch built for another protocol version than the worker's is refused before anything is sent", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel, { ...enrollParams, protocolVersion: 5 });
  let received = 0;
  workerChannel.register(WorkerMethod.dispatch, () => {
    received++;
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  const error = await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams()),
    WorkerNotDispatchableError,
  );
  assertEquals(error.reason, "version_changed");
  assertEquals(received, 0);
  assertEquals(h.gateway.worker("ci-runner-3")?.activeDispatchIds, []);
  assertEquals(
    h.transitions.filter((t) => t.methodName === "set_status").length,
    0,
  );
});

/** Runs `fn` with the gateway's logs captured, as level and text. */
async function capturingGatewayLogs(
  fn: () => Promise<void>,
): Promise<Array<{ level: string; message: string }>> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["serve", "worker-gateway"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => ({
    level: record.level,
    message: record.message.map(String).join(""),
  }));
}

Deno.test("WorkerGateway: oversized enrollment labels are refused before the token is redeemed", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const labels: Record<string, unknown> = {};
  for (let i = 0; i < 100_000; i++) labels[`k${i}`] = 0;
  const error = await assertRejects(
    () => enroll(workerChannel, { ...enrollParams, labels }),
    RpcError,
  );
  assertStringIncludes(error.message, "Too many entries");
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

Deno.test("WorkerGateway: invalid enrollment cannot suppress server tracing with an unsampled carrier", async () => {
  await withCapturedSpans(async (spans) => {
    installExecutionObserver();
    const h = createHarness();
    const reply = Promise.withResolvers<string>();
    const attached = h.gateway.attachTransport({
      send: (raw) => reply.resolve(raw),
    });
    const traceId = "11111111111111111111111111111111";
    try {
      attached.feed(JSON.stringify({
        type: "rpc.request",
        id: "untrusted",
        method: RemoteMethod.enroll,
        params: { ...enrollParams, token: "nodot" },
        trace: { traceparent: `00-${traceId}-2222222222222222-00` },
      }));
      assertEquals(JSON.parse(await reply.promise).error.code, "invalid_token");
      const span = findSpan(spans, "swamp.enrollment.request");
      assertEquals(span.parentSpanId, undefined);
      assertEquals(span.spanContext().traceId === traceId, false);
      assertEquals(span.spanContext().traceFlags, 1);
      assertEquals(
        spans.some((s) => s.name === "swamp.enrollment.accepted"),
        false,
      );
    } finally {
      attached.closed();
      h.gateway.dispose();
      uninstallExecutionObserver();
    }
  });
});

Deno.test("WorkerGateway: failed redemption leaves no pool state behind", async () => {
  const h = createHarness();
  h.failOn.add("redeem");
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await assertRejects(() => enroll(workerChannel), RpcError, "stubbed failure");
  assertEquals(h.gateway.workers().length, 0);
  assertEquals(h.idle.length, 0);
});

Deno.test("WorkerGateway: redeem runs pinned to the token's definition", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  assertEquals(h.transitions[0].methodName, "redeem");
  assertEquals(h.transitions[0].expectedDefinitionId, "def-ci-runner-3");
});

Deno.test("WorkerGateway: a token whose record arrived before its definition is refused as retryable, without redeeming", async () => {
  const h = createHarness({
    findTokenDefinitionId: () => Promise.resolve(null),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const error = await assertRejects(() => enroll(workerChannel), RpcError);
  assertEquals(error.code, "token_not_synced");
  assertEquals(PERMANENT_ENROLLMENT_ERROR_CODES.has(error.code), false);
  assertEquals(h.transitions.length, 0);
  assertEquals(h.gateway.workers().length, 0);
});

Deno.test("WorkerGateway: a token with neither a definition nor a record is not found, without redeeming", async () => {
  const h = createHarness({
    findTokenDefinitionId: () => Promise.resolve(null),
    readTokenRecord: () => Promise.resolve(null),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const error = await assertRejects(() => enroll(workerChannel), RpcError);
  assertEquals(error.code, "token_not_found");
  assertEquals(h.transitions.length, 0);
});

Deno.test("WorkerGateway: enrollment hands the worker this serve's gate pass", async () => {
  const h = createHarness({ gatePass: () => "cHJvb2Y.c2ln" });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel, {
    ...enrollParams,
    needsGatePass: true,
  });
  assertEquals(result.gatePass, "cHJvb2Y.c2ln");
});

Deno.test("WorkerGateway: a worker that does not ask for the pass is not sent it", async () => {
  const h = createHarness({ gatePass: () => "cHJvb2Y.c2ln" });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);
  assertEquals("gatePass" in result, false);
});

Deno.test("WorkerGateway: a serve without a pass omits it, and enrolls workers that do not need one", async () => {
  for (const gatePass of [undefined, () => undefined]) {
    const h = createHarness({ gatePass });
    const { workerChannel } = connectWorkerSocket(h.gateway);
    const result = await enroll(workerChannel);
    assertEquals("gatePass" in result, false);
    assertEquals(h.gateway.workers().length, 1);
  }
});

Deno.test("WorkerGateway: a worker that needs a pass is refused before the token is redeemed", async () => {
  const h = createHarness({ gatePass: () => undefined });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const error = await assertRejects(
    () => enroll(workerChannel, { ...enrollParams, needsGatePass: true }),
    RpcError,
  );
  assertEquals(error.code, GATE_PASS_UNAVAILABLE);
  // No redeem: the token's enrollment allowance is untouched.
  assertEquals(h.transitions, []);
  assertEquals(h.gateway.workers().length, 0);
  assertEquals(h.idle.length, 0);
});

Deno.test("WorkerGateway: a follower in team mode refuses a worker before the token is redeemed, with a retried code (swamp-club#4096)", async () => {
  const h = createHarness({ acceptsWorkers: () => false });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const error = await assertRejects(() => enroll(workerChannel), RpcError);
  assertEquals(error.code, SERVE_NOT_LEADER_CODE);
  assertEquals(PERMANENT_ENROLLMENT_ERROR_CODES.has(error.code), false);
  assertEquals(h.transitions, []);
  assertEquals(h.gateway.workers().length, 0);
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
    h.gateway.sessions.verify(refreshed.sessionCredential)?.workerId,
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

Deno.test("WorkerGateway: a dispatch result with oversized malformed logs is refused with one issue", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  workerChannel.register(WorkerMethod.dispatch, () =>
    Promise.resolve({
      status: "success",
      outputs: [],
      logs: Array(100_000).fill(0),
      durationMs: 5,
    }));

  const error = await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams()),
    z.ZodError,
  );
  assertEquals(error.issues.length, 1);
  assertEquals(error.issues[0].path, ["logs", 0]);
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
    "at capacity",
  );
  gate.resolve();
  await first;
});

Deno.test("WorkerGateway: onRegistered fires once, when the dispatch is already listed (swamp-club#3293)", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  const gate = Promise.withResolvers<void>();
  workerChannel.register(WorkerMethod.dispatch, async () => {
    await gate.promise;
    return { status: "success", outputs: [], logs: [], durationMs: 1 };
  });

  const listedAtRegistration: string[][] = [];
  const onRegistered = () =>
    listedAtRegistration.push(
      h.gateway.worker("ci-runner-3")?.activeDispatchIds ?? [],
    );
  const first = h.gateway.dispatch("ci-runner-3", dispatchParams("d-1"), {
    onRegistered,
  });
  // Registered before dispatch() first yields, not at some later turn.
  assertEquals(listedAtRegistration, [["d-1"]]);

  // A dispatch refused on a precondition never took a slot.
  await assertRejects(
    () =>
      h.gateway.dispatch("ci-runner-3", dispatchParams("d-2"), {
        onRegistered,
      }),
    Error,
    "at capacity",
  );
  await assertRejects(
    () => h.gateway.dispatch("ghost", dispatchParams("d-3"), { onRegistered }),
    Error,
    "not in the pool",
  );
  gate.resolve();
  await first;
  assertEquals(listedAtRegistration, [["d-1"]]);
});

Deno.test("WorkerGateway: dispatch releases its slot when recording the busy status fails (swamp-club#3294)", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  const received: string[] = [];
  workerChannel.register(WorkerMethod.dispatch, (params) => {
    received.push((params as DispatchParams).dispatchId);
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });

  h.failOn.add("set_status");
  await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams("d-1")),
    Error,
    "stubbed failure: set_status",
  );
  // The dispatch never reached the worker, and holds no slot.
  assertEquals(received, []);
  assertEquals(h.gateway.worker("ci-runner-3")?.activeDispatchIds, []);
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "idle");

  h.failOn.clear();
  const result = await h.gateway.dispatch("ci-runner-3", dispatchParams("d-2"));
  assertEquals(result.status, "success");
  assertEquals(received, ["d-2"]);
});

Deno.test("WorkerGateway: a failed busy status releases only its own slot (swamp-club#3294)", async () => {
  let busyWrites = 0;
  const h = createHarness({
    runModelMethod: (input) => {
      if (
        input.methodName === "set_status" && input.inputs.status === "busy" &&
        ++busyWrites === 2
      ) {
        return Promise.reject(new Error("datastore offline"));
      }
      return Promise.resolve();
    },
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel, {
    ...enrollParams,
    resourceLimits: { capacity: 2 },
  });

  const gate = Promise.withResolvers<void>();
  workerChannel.register(WorkerMethod.dispatch, async () => {
    await gate.promise;
    return { status: "success", outputs: [], logs: [], durationMs: 1 };
  });

  const first = h.gateway.dispatch("ci-runner-3", dispatchParams("d-1"));
  await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams("d-2")),
    Error,
    "datastore offline",
  );
  assertEquals(h.gateway.worker("ci-runner-3")?.activeDispatchIds, ["d-1"]);
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "busy");

  gate.resolve();
  await first;
  assertEquals(h.gateway.worker("ci-runner-3")?.activeDispatchIds, []);
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "idle");
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

Deno.test("WorkerGateway: settled waits for the disconnect a closed socket is recording (swamp-club#3854)", async () => {
  const held = Promise.withResolvers<void>();
  const order: string[] = [];
  const h = createHarness({
    graceWindowMs: 20,
    runModelMethod: async (input) => {
      if (input.inputs.status !== "disconnected") return;
      await held.promise;
      order.push("disconnect written");
    },
  });
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  dropSocket();

  const settling = h.gateway.settled().then(() => order.push("settled"));
  // A full turn, so every microtask settled() could resolve on has run;
  // waitFor cannot assert that something has not happened yet.
  await new Promise((r) => setTimeout(r, 0));
  held.resolve();
  await settling;
  assertEquals(order, ["disconnect written", "settled"]);
  await waitFor(() => h.graceExpired.length === 1, "grace window expiry");
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

Deno.test("WorkerGateway: token expiry removes the worker and revokes its credential without a grace window", async () => {
  const h = createHarness({
    graceWindowMs: 60_000,
    readTokenExpiresAt: () =>
      Promise.resolve(new Date(Date.now() + 30).toISOString()),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, true);

  // The expiry timer recorded the lapsed lifetime and removed the worker
  // at once; the long grace window never started.
  await waitFor(() => h.removed.length === 1, "worker removed on expiry");
  const expires = h.transitions.filter((t) => t.methodName === "expire");
  assertEquals(expires.length, 1);
  assertEquals(expires[0].typeArg, "swamp/enrollment-token");
  assertEquals(h.gateway.workers().length, 0);
  assertEquals(h.gateway.pendingGraceWindows, 0);
  assertEquals(h.gateway.sessions.verify(result.sessionCredential), null);
  assertEquals(h.disconnected.length, 0);
  assertEquals(h.graceExpired.length, 0);
});

Deno.test("WorkerGateway: token expiry skips the expire record when the token's definition is gone", async () => {
  let definitionGone = false;
  const h = createHarness({
    readTokenExpiresAt: () =>
      Promise.resolve(new Date(Date.now() + 30).toISOString()),
    findTokenDefinitionId: (name) =>
      Promise.resolve(definitionGone ? null : `def-${name}`),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  definitionGone = true;

  await waitFor(() => h.removed.length === 1, "worker removed on expiry");
  // The disconnect record is queued after the skipped expire record.
  await waitFor(
    () => h.transitions.some((t) => t.inputs.status === "disconnected"),
    "disconnect recorded",
  );
  assertEquals(h.transitions.filter((t) => t.methodName === "expire"), []);
});

Deno.test("WorkerGateway: token expiry records expire pinned to the token's definition", async () => {
  const h = createHarness({
    readTokenExpiresAt: () =>
      Promise.resolve(new Date(Date.now() + 30).toISOString()),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  await waitFor(
    () => h.transitions.some((t) => t.methodName === "expire"),
    "expire recorded",
  );
  const expire = h.transitions.find((t) => t.methodName === "expire");
  assertEquals(expire?.expectedDefinitionId, "def-ci-runner-3");
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

  await waitFor(() => h.removed.length === 1, "fleet worker removed");
  const expires = h.transitions.filter((t) => t.methodName === "expire");
  assertEquals(expires.length, 1);
  assertEquals(expires[0].typeArg, "swamp/enrollment-token");
  assertEquals(expires[0].definitionName, "ci-runner-3");
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

/**
 * A harness whose enrollment verification really dispatches a probe through
 * the gateway, as `swamp serve` does, instead of stubbing the result.
 */
function createProbingHarness(): Harness & { enrolled: WorkerSnapshot[] } {
  const enrolled: WorkerSnapshot[] = [];
  const h: Harness = createHarness({
    verifyOnEnroll: true,
    verifyWorker: async (name) => {
      const result = await h.gateway.dispatch(name, {
        ...dispatchParams("enroll-probe"),
        probeMarker: "verify-on-enroll",
      });
      return result.status === "success"
        ? { ok: true }
        : { ok: false, failureReason: "probe failed on worker" };
    },
    onWorkerEnrolled: (w) => enrolled.push(w),
  });
  return { ...h, enrolled };
}

function setStatusWrites(h: Harness): unknown[] {
  return h.transitions
    .filter((t) => t.methodName === "set_status")
    .map((t) => t.inputs.status);
}

Deno.test("WorkerGateway: verifyOnEnroll — a dispatched probe that fails leaves the worker unverified and unschedulable (swamp-club#3388)", async () => {
  const h = createProbingHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const received: string[] = [];
  workerChannel.register(WorkerMethod.dispatch, (params) => {
    received.push((params as DispatchParams).dispatchId);
    return Promise.resolve({
      status: "error",
      error: "data plane broken",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  await enroll(workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.verifyFailureReason !== undefined,
    "the verification failure to be recorded",
  );

  const worker = h.gateway.worker("ci-runner-3");
  assertEquals(worker?.status, "unverified");
  assertEquals(worker?.verifyFailureReason, "probe failed on worker");
  assertEquals(worker?.activeDispatchIds, []);
  assertEquals(h.idle.length, 0);
  assertEquals(h.enrolled.length, 0);
  assertEquals(setStatusWrites(h), ["unverified"]);

  const error = await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams("step-1")),
    WorkerNotDispatchableError,
  );
  assertEquals(error.reason, "unverified");
  assertEquals(received, ["enroll-probe"]);
});

Deno.test("WorkerGateway: verifyOnEnroll — a probe dispatch that rejects leaves the worker unverified (swamp-club#3388)", async () => {
  const h = createProbingHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  workerChannel.register(
    WorkerMethod.dispatch,
    () => Promise.reject(new Error("worker exploded")),
  );
  await enroll(workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.verifyFailureReason !== undefined,
    "the verification error to be recorded",
  );

  const worker = h.gateway.worker("ci-runner-3");
  assertEquals(worker?.status, "unverified");
  assertEquals(worker?.activeDispatchIds, []);
  assertEquals(h.idle.length, 0);
  assertEquals(h.enrolled.length, 0);
  assertEquals(setStatusWrites(h), ["unverified"]);
});

Deno.test("WorkerGateway: verifyOnEnroll — a dispatched probe that passes promotes the worker once (swamp-club#3388)", async () => {
  const h = createProbingHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const gate = Promise.withResolvers<void>();
  let probing = false;
  workerChannel.register(WorkerMethod.dispatch, async () => {
    probing = true;
    await gate.promise;
    return { status: "success", outputs: [], logs: [], durationMs: 1 };
  });
  await enroll(workerChannel);
  await waitFor(() => probing, "the probe to reach the worker");

  // Holding a slot, but not schedulable while the probe is unjudged.
  const during = h.gateway.worker("ci-runner-3");
  assertEquals(during?.status, "unverified");
  assertEquals(during?.activeDispatchIds, ["enroll-probe"]);
  assertEquals(h.idle.length, 0);

  gate.resolve();
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be promoted",
  );
  assertEquals(h.gateway.worker("ci-runner-3")?.activeDispatchIds, []);
  assertEquals(h.idle.length, 1);
  assertEquals(h.enrolled.length, 1);
  assertEquals(setStatusWrites(h), ["idle"]);
});

Deno.test("WorkerGateway: a later probe leaves an unverified worker unverified, pass or fail (swamp-club#3388)", async () => {
  const h = createHarness({
    verifyOnEnroll: true,
    verifyWorker: () =>
      Promise.resolve({ ok: false, failureReason: "data plane broken" }),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.verifyFailureReason !== undefined,
    "the verification failure to be recorded",
  );
  const writesBefore = setStatusWrites(h);

  for (const status of ["success", "error"] as const) {
    workerChannel.register(
      WorkerMethod.dispatch,
      () =>
        Promise.resolve({
          status,
          ...(status === "error" ? { error: "still broken" } : {}),
          outputs: [],
          logs: [],
          durationMs: 1,
        }),
    );
    const result = await h.gateway.dispatch("ci-runner-3", {
      ...dispatchParams(`manual-${status}`),
      probeMarker: "fleet-verify",
    });
    assertEquals(result.status, status);

    const worker = h.gateway.worker("ci-runner-3");
    assertEquals(worker?.status, "unverified");
    assertEquals(worker?.verifyFailureReason, "data plane broken");
    assertEquals(worker?.activeDispatchIds, []);
  }
  assertEquals(h.idle.length, 0);
  assertEquals(setStatusWrites(h), writesBefore);
});

Deno.test("WorkerGateway: verifyOnEnroll — a worker that drops mid-probe is not left idle (swamp-club#3388)", async () => {
  const h = createProbingHarness();
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  let probing = false;
  workerChannel.register(WorkerMethod.dispatch, () => {
    probing = true;
    return new Promise(() => {});
  });
  await enroll(workerChannel);
  await waitFor(() => probing, "the probe to reach the worker");

  dropSocket();
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.activeDispatchIds.length === 0,
    "the probe dispatch to end",
  );
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "unverified");
  assertEquals(h.idle.length, 0);
  assertEquals(h.enrolled.length, 0);
  await waitFor(
    () => h.gateway.pendingGraceWindows === 0,
    "the grace window to expire",
  );
});

Deno.test("WorkerGateway: verifyOnEnroll — a worker that reconnects while a step still holds its slot is probed again when the step ends (swamp-club#3388)", async () => {
  const h = createProbingHarness();
  const first = connectWorkerSocket(h.gateway);
  first.workerChannel.register(
    WorkerMethod.dispatch,
    (params) =>
      (params as DispatchParams).probeMarker
        ? Promise.resolve({
          status: "success",
          outputs: [],
          logs: [],
          durationMs: 1,
        })
        // The step is lost with the socket: it never answers.
        : new Promise(() => {}),
  );
  await enroll(first.workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be verified",
  );
  const step = h.gateway.dispatch("ci-runner-3", dispatchParams("step-1"));
  const stepEnded = step.then(() => "resolved", () => "rejected");
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "busy",
    "the step to be placed",
  );

  // The worker's side of the socket died first: it is back on a new one
  // before the orchestrator has seen the old one close.
  const second = connectWorkerSocket(h.gateway);
  const probes: string[] = [];
  second.workerChannel.register(WorkerMethod.dispatch, (params) => {
    probes.push((params as DispatchParams).dispatchId);
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  await enroll(second.workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.verifyFailureReason !== undefined,
    "the enrollment probe to be refused",
  );
  // No slot for the probe while the lost step still holds it.
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "unverified");
  assertEquals(probes, []);

  first.dropSocket();
  assertEquals(await stepEnded, "rejected");
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be probed again and promoted",
  );
  const worker = h.gateway.worker("ci-runner-3");
  assertEquals(probes, ["enroll-probe"]);
  assertEquals(worker?.verifyFailureReason, undefined);
  assertEquals(worker?.activeDispatchIds, []);
  assertEquals(setStatusWrites(h).at(-1), "idle");
});

Deno.test("WorkerGateway: verifyOnEnroll — a worker that reconnects while its enrollment probe is still out on the old socket is probed again (swamp-club#3388)", async () => {
  const h = createProbingHarness();
  const first = connectWorkerSocket(h.gateway);
  let probing = false;
  // The first probe is lost with the socket: it never answers.
  first.workerChannel.register(WorkerMethod.dispatch, () => {
    probing = true;
    return new Promise(() => {});
  });
  await enroll(first.workerChannel);
  await waitFor(() => probing, "the first probe to reach the worker");

  const second = connectWorkerSocket(h.gateway);
  const probes: string[] = [];
  second.workerChannel.register(WorkerMethod.dispatch, (params) => {
    probes.push((params as DispatchParams).dispatchId);
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  await enroll(second.workerChannel);
  // The lost probe still holds the only slot.
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "unverified");
  assertEquals(probes, []);

  first.dropSocket();
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be probed on its new socket and promoted",
  );
  const worker = h.gateway.worker("ci-runner-3");
  assertEquals(probes, ["enroll-probe"]);
  assertEquals(worker?.verifyFailureReason, undefined);
  assertEquals(worker?.activeDispatchIds, []);
  assertEquals(h.enrolled.length, 1);
  assertEquals(h.idle.length, 1);
});

Deno.test("WorkerGateway: verifyOnEnroll — a held step ending while the reconnect's probe is still being prepared does not start a second probe (swamp-club#3388)", async () => {
  // As in serve, the probe does asynchronous setup before it takes a slot.
  let setup = Promise.resolve();
  let verifications = 0;
  const h: Harness = createHarness({
    verifyOnEnroll: true,
    verifyWorker: async (name) => {
      verifications++;
      await setup;
      const result = await h.gateway.dispatch(name, {
        ...dispatchParams(`enroll-probe-${verifications}`),
        probeMarker: "verify-on-enroll",
      });
      return result.status === "success"
        ? { ok: true }
        : { ok: false, failureReason: "probe failed on worker" };
    },
  });
  const answer = (received: string[]) => (params: unknown) => {
    const p = params as DispatchParams;
    if (!p.probeMarker) return new Promise(() => {});
    received.push(p.dispatchId);
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  };
  const first = connectWorkerSocket(h.gateway);
  first.workerChannel.register(WorkerMethod.dispatch, answer([]));
  await enroll(first.workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be verified",
  );
  const step = h.gateway.dispatch("ci-runner-3", dispatchParams("step-1"));
  const stepEnded = step.then(() => "resolved", () => "rejected");
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "busy",
    "the step to be placed",
  );

  const gate = Promise.withResolvers<void>();
  setup = gate.promise;
  const second = connectWorkerSocket(h.gateway);
  const probes: string[] = [];
  second.workerChannel.register(WorkerMethod.dispatch, answer(probes));
  await enroll(second.workerChannel);
  assertEquals(verifications, 2);

  // The step ends while the reconnect's probe has not yet taken a slot.
  first.dropSocket();
  assertEquals(await stepEnded, "rejected");
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "unverified");
  assertEquals(verifications, 2);

  gate.resolve();
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the pending probe to pass",
  );
  assertEquals(probes, ["enroll-probe-2"]);
  assertEquals(h.gateway.worker("ci-runner-3")?.verifyFailureReason, undefined);
  assertEquals(verifications, 2);
});

/**
 * As in serve, the enrollment probe does asynchronous setup before it takes
 * a slot: it waits on `setup`, which a test replaces with a gate. Every
 * probe that reaches the worker is answered with the result `answer` gives,
 * at once unless `holdProbes` is set; any other dispatch is held until
 * `release` is called with its id.
 */
function createSlotRaceHarness(options?: {
  holdUnverifiedWrite?: Promise<void>;
  readTokenExpiresAt?: WorkerGatewayOptions["readTokenExpiresAt"];
}) {
  const transitions: RecordedTransition[] = [];
  const state = {
    setup: Promise.resolve(),
    verifications: 0,
    probes: [] as string[],
    answer: "success" as "success" | "error",
    holdProbes: false,
  };
  const held = new Map<string, () => void>();
  const h: Harness = createHarness({
    verifyOnEnroll: true,
    verifyWorker: async (name) => {
      state.verifications++;
      const dispatchId = `enroll-probe-${state.verifications}`;
      await state.setup;
      const result = await h.gateway.dispatch(name, {
        ...dispatchParams(dispatchId),
        probeMarker: "verify-on-enroll",
      });
      return result.status === "success"
        ? { ok: true }
        : { ok: false, failureReason: "probe failed on worker" };
    },
    runModelMethod: async (input) => {
      transitions.push(input);
      if (
        options?.holdUnverifiedWrite && input.methodName === "set_status" &&
        input.inputs.status === "unverified"
      ) {
        await options.holdUnverifiedWrite;
      }
    },
    ...(options?.readTokenExpiresAt
      ? { readTokenExpiresAt: options.readTokenExpiresAt }
      : {}),
  });
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  workerChannel.register(WorkerMethod.dispatch, (params) => {
    const p = params as DispatchParams;
    const done = (status: "success" | "error") => ({
      status,
      ...(status === "error" ? { error: "data plane broken" } : {}),
      outputs: [],
      logs: [],
      durationMs: 1,
    });
    if (p.probeMarker === "verify-on-enroll") {
      state.probes.push(p.dispatchId);
      if (state.holdProbes) {
        return new Promise((resolve) =>
          held.set(p.dispatchId, () => resolve(done(state.answer)))
        );
      }
      return Promise.resolve(done(state.answer));
    }
    return new Promise((resolve) =>
      held.set(p.dispatchId, () => resolve(done("success")))
    );
  });
  const release = (dispatchId: string) => {
    const resolve = held.get(dispatchId);
    if (!resolve) throw new Error(`${dispatchId} is not held`);
    held.delete(dispatchId);
    resolve();
  };
  return {
    ...h,
    transitions,
    state,
    held,
    release,
    workerChannel,
    dropSocket,
  };
}

/**
 * Enrolls the worker with its probe gated before it takes a slot, puts a
 * manual probe on the only slot, then lets the enrollment probe run so it is
 * refused for capacity. Returns the manual probe, still holding the slot.
 */
async function refuseEnrollmentProbeForCapacity(
  h: ReturnType<typeof createSlotRaceHarness>,
): Promise<{ manual: Promise<unknown> }> {
  const gate = Promise.withResolvers<void>();
  h.state.setup = gate.promise;
  await enroll(h.workerChannel);
  assertEquals(h.state.verifications, 1);
  const manual = h.gateway.dispatch("ci-runner-3", {
    ...dispatchParams("manual-probe"),
    probeMarker: "fleet-verify",
  });
  await waitFor(
    () => h.held.has("manual-probe"),
    "the manual probe to take the slot",
  );
  gate.resolve();
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.verifyFailureReason !== undefined,
    "the enrollment probe to be refused",
  );
  assertEquals(h.state.probes, []);
  return { manual };
}

Deno.test("WorkerGateway: verifyOnEnroll — an enrollment probe refused while a manual probe holds the slot is sent again when the slot frees (swamp-club#3404)", async () => {
  const h = createSlotRaceHarness();
  const { manual } = await refuseEnrollmentProbeForCapacity(h);
  await waitFor(
    () => setStatusWrites(h).includes("unverified"),
    "the refusal to be recorded",
  );
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "unverified");

  h.release("manual-probe");
  await manual;
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be probed again and promoted",
  );
  const worker = h.gateway.worker("ci-runner-3");
  assertEquals(h.state.probes, ["enroll-probe-2"]);
  assertEquals(h.state.verifications, 2);
  assertEquals(worker?.verifyFailureReason, undefined);
  assertEquals(worker?.activeDispatchIds, []);
  assertEquals(setStatusWrites(h).at(-1), "idle");
});

Deno.test("WorkerGateway: verifyOnEnroll — a slot freed while the refused probe's result is still being recorded still gets the probe sent again (swamp-club#3404)", async () => {
  const hold = Promise.withResolvers<void>();
  const h = createSlotRaceHarness({ holdUnverifiedWrite: hold.promise });
  const { manual } = await refuseEnrollmentProbeForCapacity(h);

  // The refused run is still writing its unverified record.
  h.release("manual-probe");
  await manual;
  assertEquals(h.state.verifications, 1);

  hold.resolve();
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the deferred probe to pass",
  );
  assertEquals(h.state.probes, ["enroll-probe-2"]);
  assertEquals(h.state.verifications, 2);
  assertEquals(h.gateway.worker("ci-runner-3")?.verifyFailureReason, undefined);
});

Deno.test("WorkerGateway: verifyOnEnroll — a probe sent again after a capacity refusal that then fails is not sent a third time (swamp-club#3404)", async () => {
  const h = createSlotRaceHarness();
  h.state.answer = "error";
  const { manual } = await refuseEnrollmentProbeForCapacity(h);
  await waitFor(
    () => setStatusWrites(h).includes("unverified"),
    "the refusal to be recorded",
  );

  h.release("manual-probe");
  await manual;
  await waitFor(
    () =>
      h.gateway.worker("ci-runner-3")?.verifyFailureReason ===
        "probe failed on worker",
    "the second probe to fail on the worker",
  );
  assertEquals(h.state.probes, ["enroll-probe-2"]);

  // A later manual probe ending finds no refusal to answer for.
  const later = h.gateway.dispatch("ci-runner-3", {
    ...dispatchParams("manual-probe-2"),
    probeMarker: "fleet-verify",
  });
  await waitFor(
    () => h.held.has("manual-probe-2"),
    "the later manual probe to reach the worker",
  );
  h.release("manual-probe-2");
  await later;
  assertEquals(h.state.verifications, 2);
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "unverified");
});

Deno.test("WorkerGateway: verifyOnEnroll — a manual probe ending on a worker whose probe failed on the worker sends no new probe (swamp-club#3404)", async () => {
  const h = createSlotRaceHarness();
  h.state.answer = "error";
  await enroll(h.workerChannel);
  await waitFor(
    () =>
      h.gateway.worker("ci-runner-3")?.verifyFailureReason ===
        "probe failed on worker",
    "the enrollment probe to fail on the worker",
  );

  const manual = h.gateway.dispatch("ci-runner-3", {
    ...dispatchParams("manual-probe"),
    probeMarker: "fleet-verify",
  });
  await waitFor(
    () => h.held.has("manual-probe"),
    "the manual probe to reach the worker",
  );
  h.release("manual-probe");
  await manual;
  assertEquals(h.state.verifications, 1);
  assertEquals(h.state.probes, ["enroll-probe-1"]);
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "unverified");
});

Deno.test("WorkerGateway: verifyOnEnroll — a manual probe refused while no enrollment probe is running sends no probe when the slot frees (swamp-club#3404)", async () => {
  const h = createSlotRaceHarness();
  h.state.answer = "error";
  await enroll(h.workerChannel);
  await waitFor(
    () =>
      h.gateway.worker("ci-runner-3")?.verifyFailureReason ===
        "probe failed on worker",
    "the enrollment probe to fail on the worker",
  );

  const first = h.gateway.dispatch("ci-runner-3", {
    ...dispatchParams("manual-probe"),
    probeMarker: "fleet-verify",
  });
  await waitFor(
    () => h.held.has("manual-probe"),
    "the first manual probe to take the slot",
  );
  await assertRejects(
    () =>
      h.gateway.dispatch("ci-runner-3", {
        ...dispatchParams("manual-probe-2"),
        probeMarker: "fleet-verify",
      }),
    WorkerNotDispatchableError,
    "at capacity",
  );
  h.release("manual-probe");
  await first;
  assertEquals(h.state.verifications, 1);
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "unverified");
});

Deno.test("WorkerGateway: verifyOnEnroll — a refusal seen before the worker was verified does not probe it early after a reconnect (swamp-club#3404)", async () => {
  let expiry: Promise<string | null> = Promise.resolve(null);
  const h = createSlotRaceHarness({ readTokenExpiresAt: () => expiry });
  h.state.holdProbes = true;
  await enroll(h.workerChannel);
  await waitFor(
    () => h.held.has("enroll-probe-1"),
    "the enrollment probe to take the slot",
  );
  // Refused while the enrollment probe holds the slot; that probe passes.
  await assertRejects(
    () =>
      h.gateway.dispatch("ci-runner-3", {
        ...dispatchParams("manual-probe"),
        probeMarker: "fleet-verify",
      }),
    WorkerNotDispatchableError,
    "at capacity",
  );
  h.release("enroll-probe-1");
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be verified",
  );
  h.state.holdProbes = false;

  const step = h.gateway.dispatch("ci-runner-3", dispatchParams("step-1"));
  const stepEnded = step.then(() => "resolved", () => "rejected");
  await waitFor(() => h.held.has("step-1"), "the step to reach the worker");

  // The reconnect turns the worker unverified, then waits on the token
  // record before it starts its probe.
  const gate = Promise.withResolvers<string | null>();
  expiry = gate.promise;
  const second = connectWorkerSocket(h.gateway);
  second.workerChannel.register(WorkerMethod.dispatch, (params) => {
    h.state.probes.push((params as DispatchParams).dispatchId);
    return Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });
  const enrolled = enroll(second.workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "unverified",
    "the reconnect to turn the worker unverified",
  );

  h.dropSocket();
  assertEquals(await stepEnded, "rejected");
  assertEquals(h.state.verifications, 1);

  gate.resolve(null);
  await enrolled;
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the reconnect's probe to pass",
  );
  assertEquals(h.state.verifications, 2);
  assertEquals(h.state.probes, ["enroll-probe-1", "enroll-probe-2"]);
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

/** Status the worker model saves for the gateway's recorded enroll call. */
async function savedEnrollStatus(h: Harness): Promise<unknown> {
  const transition = h.transitions.find((t) => t.methodName === "enroll");
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    transition!.definitionName,
  );
  await workerModel.methods.enroll.execute(
    workerModel.methods.enroll.arguments.parse(transition!.inputs),
    context,
  );
  return store.get("state-main")!.status;
}

Deno.test("WorkerGateway: without verifyOnEnroll — the worker record says idle from enrollment", async () => {
  const h = createHarness({});
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  assertEquals(await savedEnrollStatus(h), "idle");
  assertEquals(setStatusWrites(h), []);
});

Deno.test("WorkerGateway: verifyOnEnroll — the worker record says unverified until the enrollment probe passes (swamp-club#3501)", async () => {
  let resolveProbe!: () => void;
  const probe = new Promise<void>((r) => {
    resolveProbe = r;
  });
  const h = createHarness({
    verifyOnEnroll: true,
    verifyWorker: async () => {
      await probe;
      return { ok: true };
    },
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  assertEquals(await savedEnrollStatus(h), "unverified");
  assertEquals(setStatusWrites(h), []);

  resolveProbe();
  await waitFor(
    () => setStatusWrites(h).length > 0,
    "the probe result to be recorded",
  );
  assertEquals(setStatusWrites(h), ["idle"]);
});

Deno.test("WorkerGateway: verifyOnEnroll — a reconnect records the worker unverified until its probe passes (swamp-club#3501)", async () => {
  let probe = Promise.resolve();
  const h = createHarness({
    graceWindowMs: 200,
    verifyOnEnroll: true,
    verifyWorker: async () => {
      await probe;
      return { ok: true };
    },
  });
  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be verified",
  );
  first.dropSocket();
  await waitFor(
    () => setStatusWrites(h).at(-1) === "disconnected",
    "the disconnect to be recorded",
  );

  let resolveProbe!: () => void;
  probe = new Promise<void>((r) => {
    resolveProbe = r;
  });
  const second = connectWorkerSocket(h.gateway);
  await enroll(second.workerChannel);
  assertEquals(setStatusWrites(h), ["idle", "disconnected", "unverified"]);

  resolveProbe();
  await waitFor(
    () => setStatusWrites(h).length === 4,
    "the probe result to be recorded",
  );
  assertEquals(setStatusWrites(h).at(-1), "idle");
  second.dropSocket();
  await waitFor(
    () => h.gateway.workers().length === 0,
    "the grace window to expire",
  );
});

Deno.test("WorkerGateway: without verifyOnEnroll — a reconnect records the worker idle", async () => {
  const h = createHarness({ graceWindowMs: 200 });
  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);
  first.dropSocket();
  await waitFor(
    () => setStatusWrites(h).at(-1) === "disconnected",
    "the disconnect to be recorded",
  );
  const second = connectWorkerSocket(h.gateway);
  await enroll(second.workerChannel);
  assertEquals(setStatusWrites(h), ["disconnected", "idle"]);
  second.dropSocket();
  await waitFor(
    () => h.gateway.workers().length === 0,
    "the grace window to expire",
  );
});

Deno.test("WorkerGateway: verifyOnEnroll — a reconnect while a step holds a slot records unverified and keeps the step (swamp-club#3501)", async () => {
  const h = createProbingHarness();
  const first = connectWorkerSocket(h.gateway);
  first.workerChannel.register(
    WorkerMethod.dispatch,
    (params) =>
      (params as DispatchParams).probeMarker
        ? Promise.resolve({
          status: "success",
          outputs: [],
          logs: [],
          durationMs: 1,
        })
        // The step is lost with the socket: it never answers.
        : new Promise(() => {}),
  );
  await enroll(first.workerChannel);
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be verified",
  );
  const step = h.gateway.dispatch("ci-runner-3", dispatchParams("step-1"));
  const stepEnded = step.then(() => "resolved", () => "rejected");
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "busy",
    "the step to be placed",
  );
  // The busy record lands on the transition tail after the in-memory status.
  await waitFor(
    () =>
      h.transitions.some((t) =>
        t.methodName === "set_status" && t.inputs.status === "busy"
      ),
    "the busy status to be recorded",
  );

  const second = connectWorkerSocket(h.gateway);
  second.workerChannel.register(WorkerMethod.dispatch, () =>
    Promise.resolve({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    }));
  const writesBefore = h.transitions.length;
  await enroll(second.workerChannel);
  const reconnectWrite = h.transitions
    .slice(writesBefore)
    .find((t) => t.methodName === "set_status");
  assertEquals(reconnectWrite?.inputs, {
    status: "unverified",
    activeDispatchIds: ["step-1"],
  });

  first.dropSocket();
  assertEquals(await stepEnded, "rejected");
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "idle",
    "the worker to be probed again and promoted",
  );
  second.dropSocket();
  await waitFor(
    () => h.gateway.workers().length === 0,
    "the grace window to expire",
  );
});

Deno.test("WorkerGateway: worker.drain sets status to draining", async () => {
  const draining: WorkerSnapshot[] = [];
  const h = createHarness({
    onWorkerDraining: (w) => draining.push(w),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  await workerChannel.call(RemoteMethod.drain, {});
  const workers = h.gateway.workers();
  assertEquals(workers[0].status, "draining");
  assertEquals(draining.length, 1);
  assertEquals(draining[0].status, "draining");
  const setStatusCalls = h.transitions.filter(
    (t) => t.methodName === "set_status",
  );
  assertEquals(
    setStatusCalls.some((t) => t.inputs.status === "draining"),
    true,
  );
});

Deno.test("WorkerGateway: a repeated worker.drain changes nothing", async () => {
  const draining: WorkerSnapshot[] = [];
  const h = createHarness({
    onWorkerDraining: (w) => draining.push(w),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  await workerChannel.call(RemoteMethod.drain, {});
  await workerChannel.call(RemoteMethod.drain, {});

  assertEquals(draining.length, 1);
  assertEquals(
    h.transitions.filter((t) =>
      t.methodName === "set_status" && t.inputs.status === "draining"
    ).length,
    1,
  );
});

Deno.test("WorkerGateway: a refused dispatch names why the worker could not take it (swamp-club#3156)", async () => {
  const h = createHarness({
    graceWindowMs: 60_000,
    onWorkerDraining: () => {},
  });

  const unknown = await assertRejects(
    () => h.gateway.dispatch("ghost", dispatchParams()),
    WorkerNotDispatchableError,
    "Worker 'ghost' is not in the pool",
  );
  assertEquals(unknown.reason, "not_in_pool");
  assertEquals(unknown.workerName, "ghost");

  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);
  const gate = Promise.withResolvers<void>();
  first.workerChannel.register(WorkerMethod.dispatch, async () => {
    await gate.promise;
    return { status: "success", outputs: [], logs: [], durationMs: 1 };
  });
  const inFlight = h.gateway.dispatch("ci-runner-3", dispatchParams("d-1"));
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.status === "busy",
    "the first dispatch to occupy the worker",
  );
  const full = await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams("d-2")),
    WorkerNotDispatchableError,
    "is at capacity",
  );
  assertEquals(full.reason, "at_capacity");

  // A worker that announces its drain with work in flight stays draining
  // when that work ends, and takes nothing new.
  await first.workerChannel.call(RemoteMethod.drain, {});
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "draining");
  gate.resolve();
  await inFlight;
  assertEquals(h.gateway.worker("ci-runner-3")?.status, "draining");
  const draining = await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams("d-3")),
    WorkerNotDispatchableError,
    "is draining",
  );
  assertEquals(draining.reason, "draining");
  h.gateway.dispose();
});

Deno.test("WorkerGateway: a dispatch to a disconnected worker is refused as disconnected", async () => {
  const h = createHarness({ graceWindowMs: 60_000 });
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  dropSocket();
  await waitFor(
    () => h.gateway.worker("ci-runner-3")?.connected === false,
    "the gateway to see the drop",
  );
  const error = await assertRejects(
    () => h.gateway.dispatch("ci-runner-3", dispatchParams()),
    WorkerNotDispatchableError,
    "is disconnected",
  );
  assertEquals(error.reason, "disconnected");
  h.gateway.dispose();
});

Deno.test("WorkerGateway: draining worker disconnect skips grace window", async () => {
  const h = createHarness({
    graceWindowMs: 60_000,
    onWorkerDraining: () => {},
  });
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  await workerChannel.call(RemoteMethod.drain, {});
  assertEquals(h.gateway.workers()[0].status, "draining");

  dropSocket();
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(h.gateway.workers().length, 0);
  assertEquals(h.gateway.pendingGraceWindows, 0);
  assertEquals(h.graceExpired.length, 0);
  assertEquals(h.disconnected.length, 1);
});

Deno.test("WorkerGateway: revokeToken removes the worker, revokes its credential, and closes its socket", async () => {
  const h = createHarness({ graceWindowMs: 60_000 });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);

  const removed = await h.gateway.revokeToken("ci-runner-3", "revoked");

  assertEquals(removed, ["ci-runner-3"]);
  assertEquals(h.gateway.workers().length, 0);
  assertEquals(h.gateway.pendingGraceWindows, 0);
  assertEquals(h.gateway.sessions.verify(result.sessionCredential), null);
  assertEquals(h.removed.map((w) => w.name), ["ci-runner-3"]);
  assertEquals(h.removed[0].connected, false);
  // The socket close it forces is not treated as a drop.
  assertEquals(h.disconnected.length, 0);
  await waitFor(
    () =>
      h.transitions.some((t) =>
        t.methodName === "set_status" && t.inputs.status === "disconnected"
      ),
    "disconnect recorded",
  );
});

Deno.test("WorkerGateway: revokeToken fails an in-flight dispatch and revokes its dispatch credential", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  let dispatchCredential: string | undefined;
  workerChannel.register(
    WorkerMethod.dispatch,
    (params) => {
      dispatchCredential = (params as { dispatchCredential: string })
        .dispatchCredential;
      return new Promise(() => {});
    },
  );

  const dispatch = h.gateway.dispatch("ci-runner-3", dispatchParams());
  await waitFor(() => dispatchCredential !== undefined, "dispatch sent");
  assertEquals(
    h.gateway.sessions.verify(dispatchCredential!)?.workerId,
    "ci-runner-3",
  );

  await h.gateway.revokeToken("ci-runner-3", "revoked");

  await assertRejects(() => dispatch, ChannelClosedError, "revoked");
  assertEquals(h.gateway.sessions.verify(dispatchCredential!), null);
  assertEquals(h.gateway.worker("ci-runner-3"), null);
});

Deno.test("WorkerGateway: revokeToken cuts off every fleet member of that token only", async () => {
  const h = createHarness({
    readTokenMaxEnrollments: (name) =>
      Promise.resolve(name === "ci-runner-3" ? 3 : 1),
  });
  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);
  const second = connectWorkerSocket(h.gateway);
  await enroll(second.workerChannel, {
    ...enrollParams,
    instanceUuid: "uuid-2",
    machineId: "machine-2",
  });
  const other = connectWorkerSocket(h.gateway);
  await enroll(other.workerChannel, {
    ...enrollParams,
    token: "other-token.s3cret",
    instanceUuid: "uuid-3",
    machineId: "machine-3",
  });

  const removed = await h.gateway.revokeToken("ci-runner-3", "revoked");

  assertEquals(removed.length, 2);
  assertEquals(h.gateway.workers().map((w) => w.name), ["other-token"]);
});

Deno.test("WorkerGateway: revokeToken removes a worker inside its grace window", async () => {
  const h = createHarness({ graceWindowMs: 60_000 });
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  const result = await enroll(workerChannel);
  dropSocket();
  assertEquals(h.gateway.pendingGraceWindows, 1);

  const removed = await h.gateway.revokeToken("ci-runner-3", "revoked");

  assertEquals(removed, ["ci-runner-3"]);
  assertEquals(h.gateway.pendingGraceWindows, 0);
  assertEquals(h.gateway.sessions.verify(result.sessionCredential), null);
});

Deno.test("WorkerGateway: revokeToken is a no-op for a token with no workers", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  await h.gateway.revokeToken("ci-runner-3", "revoked");

  assertEquals(await h.gateway.revokeToken("ci-runner-3", "revoked"), []);
  assertEquals(h.removed.length, 1);
});

Deno.test("WorkerGateway: revokeToken with a mint leaves workers on a newer mint connected", async () => {
  const h = createHarness({
    readTokenRecord: (name) =>
      Promise.resolve(mintRecord(name, "2026-01-01T00:05:00.000Z")),
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  assertEquals(h.gateway.boundTokens(), [{
    tokenName: "ci-runner-3",
    tokenCreatedAt: "2026-01-01T00:05:00.000Z",
  }]);

  const stale = await h.gateway.revokeToken("ci-runner-3", "reminted", {
    mint: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(stale, []);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, true);

  const current = await h.gateway.revokeToken("ci-runner-3", "revoked", {
    mint: "2026-01-01T00:05:00.000Z",
  });
  assertEquals(current, ["ci-runner-3"]);
});

Deno.test("WorkerGateway: revokeToken waits for an enrollment in progress and cuts it off", async () => {
  let releaseRedeem!: () => void;
  const redeemGate = new Promise<void>((r) => {
    releaseRedeem = r;
  });
  let redeemStarted = false;
  const h = createHarness({
    runModelMethod: async (input) => {
      if (input.methodName === "redeem") {
        redeemStarted = true;
        await redeemGate;
      }
    },
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  const enrolling = enroll(workerChannel).catch((error: unknown) => error);
  // The enrollment holds the transition tail before the revoke queues.
  await waitFor(() => redeemStarted, "redeem started");

  const revoking = h.gateway.revokeToken("ci-runner-3", "revoked");
  releaseRedeem();

  assertEquals(await revoking, ["ci-runner-3"]);
  assertEquals(h.gateway.workers().length, 0);
  // The gateway closed the socket before the enroll reply; the simulated
  // worker only learns that when its end closes.
  workerChannel.close("control socket closed");
  assertEquals((await enrolling) instanceof ChannelClosedError, true);
});

Deno.test("WorkerGateway: boundTokens records the mint each worker enrolled on", async () => {
  const h = createHarness();
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  assertEquals(h.gateway.boundTokens(), [{
    tokenName: "ci-runner-3",
    tokenCreatedAt: BASE_MINT,
  }]);
});

Deno.test("WorkerGateway: enrollment fails when the redeemed record cannot be read", async () => {
  for (
    const readTokenRecord of [
      () => Promise.reject(new Error("datastore offline")),
      () => Promise.resolve(null),
    ]
  ) {
    const h = createHarness({ readTokenRecord });
    const { workerChannel } = connectWorkerSocket(h.gateway);
    const error = await assertRejects(() => enroll(workerChannel), RpcError);
    assertEquals(error.code, "token_unreadable");
    // Not a permanent rejection: the worker retries instead of exiting.
    assertEquals(error.message.includes("revoked"), false);
    assertEquals(error.message.includes("expired"), false);
    assertEquals(h.gateway.workers().length, 0);
  }
});

Deno.test("WorkerGateway: readTokenRecords resolves a duplicated name to the newest mint", async () => {
  const stale = { ...mintRecord("dup", BASE_MINT), state: "revoked" };
  const fresh = mintRecord("dup", "2026-01-01T00:05:00.000Z");
  const contents = new Map<string, unknown>([
    ["m-fresh", fresh],
    ["m-stale", stale],
    ["m-broken", "{not json"],
  ]);
  const repoContext = {
    unifiedDataRepo: {
      findAllForType: () =>
        Promise.resolve([...contents.keys()].map((modelId) => ({
          data: { name: "token-main", isRenamed: false, isDeleted: false },
          modelType: "swamp/enrollment-token",
          modelId,
        }))),
      getContent: (_type: unknown, modelId: string) => {
        const value = contents.get(modelId);
        return Promise.resolve(
          new TextEncoder().encode(
            typeof value === "string" ? value : JSON.stringify(value),
          ),
        );
      },
    },
  } as unknown as RepositoryContext;
  const h = createHarness({ repoContext });

  const records = await h.gateway.readTokenRecords();

  assertEquals(records.size, 1);
  assertEquals(records.get("dup")?.createdAt, fresh.createdAt);
  assertEquals(records.get("dup")?.state, "enrolled");
});

Deno.test("WorkerGateway: readTokenRecords leaves out a record the datastore cannot materialise (swamp-club#3617)", async () => {
  const fresh = mintRecord("ci", BASE_MINT);
  const repoContext = {
    unifiedDataRepo: {
      findAllForType: () =>
        Promise.resolve(["m-torn", "m-fresh"].map((modelId) => ({
          data: { name: "token-main", isRenamed: false, isDeleted: false },
          modelType: "swamp/enrollment-token",
          modelId,
        }))),
      getContent: (_type: unknown, modelId: string) =>
        modelId === "m-torn"
          ? Promise.reject(
            new UserError("unreadable", UNREADABLE_CONTENT_CODE),
          )
          : Promise.resolve(new TextEncoder().encode(JSON.stringify(fresh))),
    },
  } as unknown as RepositoryContext;
  const h = createHarness({ repoContext });

  const records = await h.gateway.readTokenRecords();

  assertEquals([...records.keys()], ["ci"]);
});

Deno.test("WorkerGateway: redeem rejections reach the worker coded, whatever the token is named", async () => {
  const cases: [string, string][] = [
    ["Enrollment token 'expired-runners' has been revoked", "token_revoked"],
    ["Enrollment token 'revoked-fleet' has expired", "token_expired"],
    ["Enrollment token 'ci' does not match", "token_mismatch"],
    [
      "Enrollment token 'ci' does not exist — mint it first",
      "token_not_found",
    ],
    [
      "Enrollment token 'ci': enrollment allowance exhausted",
      "enrollment_allowance_exhausted",
    ],
    // A name alone never supplies the reason.
    ["Enrollment token 'has-been-revoked' vault unavailable", "handler_failed"],
  ];
  for (const [message, code] of cases) {
    const h = createHarness({
      runModelMethod: (input) =>
        input.methodName === "redeem"
          ? Promise.reject(new Error(message))
          : Promise.resolve(),
    });
    const { workerChannel } = connectWorkerSocket(h.gateway);
    const error = await assertRejects(() => enroll(workerChannel), RpcError);
    assertEquals(error.code, code, message);
    assertEquals(error.message, message);
  }
});

Deno.test("WorkerGateway: a dispatch whose worker drops while its busy status is recorded fails as a lost worker", async () => {
  let releaseBusy!: () => void;
  const busyGate = new Promise<void>((r) => {
    releaseBusy = r;
  });
  let busyStarted = false;
  const h = createHarness({
    graceWindowMs: 60_000,
    runModelMethod: async (input) => {
      if (input.methodName === "set_status" && input.inputs.status === "busy") {
        busyStarted = true;
        await busyGate;
      }
    },
  });
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);

  const dispatch = h.gateway.dispatch("ci-runner-3", dispatchParams());
  await waitFor(() => busyStarted, "busy status recording");
  dropSocket();
  releaseBusy();

  await assertRejects(() => dispatch, ChannelClosedError, "before dispatch");
});

/** The worker methods that record an enrollment, first-connect or reconnect. */
const RECORDING_METHODS = ["enroll", "set_status"];

/**
 * A harness whose held methods wait while held — redeem unless a test names
 * others — so a test can close the worker's socket while its token is being
 * redeemed or its enrollment recorded (swamp-club#3405, swamp-club#3984).
 */
function createHeldHarness(
  overrides?: Partial<WorkerGatewayOptions>,
): Harness & {
  hold: (methods?: readonly string[]) => void;
  release: () => void;
  redeems: () => number;
  reached: () => number;
  enrolled: WorkerSnapshot[];
} {
  let gate: Promise<void> | null = null;
  let held: readonly string[] = [];
  let open = () => {};
  let redeems = 0;
  let reached = 0;
  const enrolled: WorkerSnapshot[] = [];
  const h: Harness = createHarness({
    onWorkerEnrolled: (w) => enrolled.push(w),
    ...overrides,
    runModelMethod: async (input) => {
      if (input.methodName === "redeem") redeems++;
      if (gate !== null && held.includes(input.methodName)) {
        reached++;
        await gate;
      }
      h.transitions.push(input);
    },
  });
  return {
    ...h,
    enrolled,
    hold: (methods = ["redeem"]) => {
      held = methods;
      gate = new Promise<void>((resolve) => {
        open = () => {
          gate = null;
          resolve();
        };
      });
    },
    release: () => open(),
    redeems: () => redeems,
    reached: () => reached,
  };
}

/**
 * Enrolls on a socket the worker closes while serve is still recording the
 * enrollment: the worker's enroll call timed out and it gave up on the socket.
 */
async function enrollThenCloseMidway(
  h: ReturnType<typeof createHeldHarness>,
  params: Record<string, unknown> = enrollParams,
): Promise<void> {
  const disconnects = h.disconnected.length;
  const reached = h.reached();
  h.hold(RECORDING_METHODS);
  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  const reply = workerChannel.call(RemoteMethod.enroll, params, {
    timeoutMs: null,
  }).catch(() => {});
  await waitFor(() => h.reached() > reached, "enrollment being recorded");
  dropSocket();
  h.release();
  await waitFor(
    () => h.disconnected.length > disconnects,
    "late enrollment disconnected",
  );
  workerChannel.close("test done");
  await reply;
}

Deno.test("WorkerGateway: an enrollment finishing after its socket closed leaves the worker disconnected (swamp-club#3405)", async () => {
  const h = createHeldHarness({ graceWindowMs: 200 });
  await enrollThenCloseMidway(h);

  assertEquals(h.gateway.worker("ci-runner-3")?.connected, false);
  assertEquals(h.gateway.pendingGraceWindows, 1);
  assertEquals(h.idle.length, 0);
  assertEquals(h.enrolled.length, 0);
  await waitFor(
    () => h.transitions.at(-1)?.inputs.status === "disconnected",
    "disconnect recorded",
  );
  await waitFor(
    () => h.gateway.worker("ci-runner-3") === null,
    "grace expiry removes the worker",
  );
  assertEquals(h.graceExpired.length, 1);
});

Deno.test("WorkerGateway: a restarted worker enrolls after an enrollment that finished on a closed socket (swamp-club#3405)", async () => {
  const h = createHeldHarness({ graceWindowMs: 200 });
  await enrollThenCloseMidway(h);

  const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel, { ...enrollParams, instanceUuid: "uuid-2" });
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, true);
  assertEquals(h.gateway.worker("ci-runner-3")?.instanceUuid, "uuid-2");
  assertEquals(h.gateway.pendingGraceWindows, 0);
  dropSocket();
  await waitFor(() => h.gateway.worker("ci-runner-3") === null, "cleanup");
});

Deno.test("WorkerGateway: a reconnect finishing after its socket closed re-arms the grace window (swamp-club#3405)", async () => {
  const h = createHeldHarness({ graceWindowMs: 200 });
  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);
  first.dropSocket();
  assertEquals(h.gateway.pendingGraceWindows, 1);
  // Recorded before the hold, so the hold catches the reconnect's status.
  await waitFor(
    () => h.transitions.at(-1)?.inputs.status === "disconnected",
    "disconnect recorded",
  );

  await enrollThenCloseMidway(h);

  assertEquals(h.gateway.worker("ci-runner-3")?.connected, false);
  assertEquals(h.gateway.pendingGraceWindows, 1);
  await waitFor(
    () => h.gateway.worker("ci-runner-3") === null,
    "grace expiry removes the worker",
  );
});

Deno.test("WorkerGateway: verifyOnEnroll — no probe for an enrollment that finished after its socket closed (swamp-club#3405)", async () => {
  let probes = 0;
  const h = createHeldHarness({
    graceWindowMs: 200,
    verifyOnEnroll: true,
    verifyWorker: () => {
      probes++;
      return Promise.resolve({ ok: true });
    },
  });
  await enrollThenCloseMidway(h);

  assertEquals(probes, 0);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, false);
  await waitFor(() => h.gateway.worker("ci-runner-3") === null, "cleanup");
});

Deno.test("WorkerGateway: an enrollment whose socket closed while it was queued records nothing (swamp-club#3405)", async () => {
  const h = createHeldHarness({ graceWindowMs: 200 });
  h.hold();
  const live = connectWorkerSocket(h.gateway);
  const liveEnroll = enroll(live.workerChannel);
  await waitFor(() => h.redeems() === 1, "first enrollment reached redeem");

  // Queued behind the held enrollment; the worker gives up before its turn.
  const dead = connectWorkerSocket(h.gateway);
  const deadEnroll = dead.workerChannel.call(
    RemoteMethod.enroll,
    { ...enrollParams, instanceUuid: "uuid-2" },
    { timeoutMs: null },
  ).catch(() => {});
  dead.dropSocket();
  h.release();
  await liveEnroll;
  // Runs on the transition tail, so the queued enrollment has had its turn.
  await h.gateway.revokeToken("no-such-token", "revoked");

  assertEquals(h.redeems(), 1);
  assertEquals(h.gateway.worker("ci-runner-3")?.instanceUuid, "uuid-1");
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, true);
  dead.workerChannel.close("test done");
  await deadEnroll;
  live.dropSocket();
  await waitFor(() => h.gateway.worker("ci-runner-3") === null, "cleanup");
});

/**
 * Starts an enrollment on a fresh socket and holds it at redeem, where the
 * worker gives up on it: it closes the socket, or cancels the call and keeps
 * the socket for a retry. Settles once the gateway has finished with it.
 */
async function enrollThenAbandonAtRedeem(
  h: ReturnType<typeof createHeldHarness>,
  how: "close" | "cancel",
): Promise<{ workerChannel: RpcChannel; dropSocket: () => void }> {
  const redeems = h.redeems();
  h.hold();
  const socket = connectWorkerSocket(h.gateway);
  const controller = new AbortController();
  const reply = socket.workerChannel.call(RemoteMethod.enroll, enrollParams, {
    timeoutMs: null,
    signal: controller.signal,
  }).catch(() => {});
  await waitFor(() => h.redeems() > redeems, "enrollment reached redeem");
  if (how === "close") socket.dropSocket();
  else controller.abort();
  h.release();
  // Runs on the transition tail, so the abandoned enrollment has finished.
  await h.gateway.revokeToken("no-such-token", "revoked");
  // A closed socket never answers the call; the worker gives up on it.
  if (how === "close") socket.workerChannel.close("test done");
  await reply;
  return socket;
}

function recorded(h: Harness): string[] {
  return h.transitions
    .filter((t) => t.typeArg === WORKER_MODEL_TYPE.normalized)
    .map((t) => t.methodName);
}

Deno.test("WorkerGateway: an enrollment whose socket closed while its token was redeemed records no worker (swamp-club#3984)", async () => {
  const h = createHeldHarness({ graceWindowMs: 200 });
  await enrollThenAbandonAtRedeem(h, "close");

  assertEquals(h.redeems(), 1);
  assertEquals(recorded(h), []);
  assertEquals(h.gateway.worker("ci-runner-3"), null);
  assertEquals(h.gateway.pendingGraceWindows, 0);
  assertEquals(h.disconnected.length, 0);
  assertEquals(h.enrolled.length, 0);
});

Deno.test("WorkerGateway: an enroll call cancelled while its token was redeemed records no worker, and its retry enrolls (swamp-club#3984)", async () => {
  const h = createHeldHarness({ graceWindowMs: 200 });
  const { workerChannel, dropSocket } = await enrollThenAbandonAtRedeem(
    h,
    "cancel",
  );

  assertEquals(recorded(h), []);
  assertEquals(h.gateway.worker("ci-runner-3"), null);

  // The worker retries on the same socket and machine: redeem runs again,
  // re-authenticating the machine the first attempt bound.
  await enroll(workerChannel);
  assertEquals(h.redeems(), 2);
  assertEquals(recorded(h), ["enroll"]);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, true);
  dropSocket();
  await waitFor(() => h.gateway.worker("ci-runner-3") === null, "cleanup");
});

Deno.test("WorkerGateway: a reconnect abandoned while its token was redeemed leaves the prior grace window running (swamp-club#3984)", async () => {
  // Long enough that the window is still open when the abandoned attempt
  // has been checked, on a loaded runner too.
  const h = createHeldHarness({ graceWindowMs: 2_000 });
  const first = connectWorkerSocket(h.gateway);
  await enroll(first.workerChannel);
  first.dropSocket();
  await waitFor(
    () => h.transitions.at(-1)?.inputs.status === "disconnected",
    "disconnect recorded",
  );
  assertEquals(h.gateway.pendingGraceWindows, 1);
  const before = recorded(h);

  await enrollThenAbandonAtRedeem(h, "close");

  assertEquals(recorded(h), before);
  assertEquals(h.gateway.worker("ci-runner-3")?.connected, false);
  assertEquals(h.gateway.pendingGraceWindows, 1);
  await waitFor(
    () => h.gateway.worker("ci-runner-3") === null,
    "grace expiry removes the worker",
  );
  assertEquals(h.graceExpired.length, 1);
});

/** A repo context whose token records hold `records`, read by the default reader. */
function tokenRecordContext(records: EnrollmentToken[]): RepositoryContext {
  return {
    unifiedDataRepo: {
      findAllForType: () =>
        Promise.resolve(records.map((_, i) => ({
          data: { name: "token-main", isRenamed: false, isDeleted: false },
          modelType: "swamp/enrollment-token",
          modelId: `m-${i}`,
        }))),
      getContent: (_type: unknown, modelId: string) =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify(records[Number(modelId.slice(2))]),
          ),
        ),
    },
  } as unknown as RepositoryContext;
}

Deno.test("WorkerGateway: enrollment reads token records as a token_record_scan phase", async () => {
  await withObservedSpans(async (spans) => {
    const h = createHarness({
      repoContext: tokenRecordContext([
        mintRecord("ci-runner-3", BASE_MINT),
        mintRecord("other", BASE_MINT),
      ]),
      readTokenRecord: undefined,
    });
    const { workerChannel } = connectWorkerSocket(h.gateway);
    await enroll(workerChannel);
    const scan = findSpan(spans, "swamp.diagnostic.token_record_scan");
    assertEquals(scan.attributes["swamp.diagnostic.area"], "enrollment");
    assertEquals(scan.attributes["swamp.diagnostic.records_listed"], 2);
    assertEquals(scan.attributes["swamp.diagnostic.content_reads"], 2);
    assertEquals(scan.attributes["swamp.diagnostic.tokens"], 2);
    assertEquals(scan.attributes["swamp.diagnostic.cancel_observed"], false);
  });
});

Deno.test("WorkerGateway: only enrollment preparation runs in the enrollment area, not the work it starts (swamp-club#3986)", async () => {
  const areas: [string, string | undefined][] = [];
  const h = createHarness({
    verifyOnEnroll: true,
    verifyWorker: () => Promise.resolve({ ok: true }),
    runModelMethod: (input) => {
      areas.push([input.methodName, currentDiagnosticArea()]);
      return Promise.resolve();
    },
  });
  const { workerChannel } = connectWorkerSocket(h.gateway);
  await enroll(workerChannel);
  await waitFor(
    () => areas.some(([method]) => method === "set_status"),
    "verification to record its status",
  );
  assertEquals(areas, [
    ["redeem", "enrollment"],
    ["enroll", "enrollment"],
    // Started by the enrollment, after its preparation: no area.
    ["set_status", undefined],
  ]);
});

Deno.test("WorkerGateway: a cancel the worker sends mid-enrollment is recorded as received, and the phases still export", async () => {
  await withObservedSpans(async (spans) => {
    const release = Promise.withResolvers<void>();
    let redeeming = false;
    const h = createHarness({
      repoContext: tokenRecordContext([mintRecord("ci-runner-3", BASE_MINT)]),
      readTokenRecord: undefined,
      runModelMethod: async (input) => {
        if (input.methodName === "redeem") {
          redeeming = true;
          await release.promise;
        }
        h.transitions.push(input);
      },
    });
    let cancelFed = false;
    const workerChannel: RpcChannel = new RpcChannel({
      send: (data) =>
        void Promise.resolve().then(() => {
          attached.feed(data);
          if (data.includes('"rpc.cancel"')) cancelFed = true;
        }),
    });
    const attached = h.gateway.attachTransport({
      send: (data) =>
        void Promise.resolve().then(() => workerChannel.handleRaw(data)),
    }, () => attached.closed());
    const controller = new AbortController();
    const call = workerChannel.call(RemoteMethod.enroll, enrollParams, {
      signal: controller.signal,
    });
    await waitFor(() => redeeming, "redemption to start");
    controller.abort();
    await assertRejects(() => call);
    await waitFor(() => cancelFed, "the cancel to reach the gateway");
    release.resolve();
    await waitFor(
      () => spans.some((s) => s.name === "swamp.enrollment.request"),
      "the enrollment request to finish",
    );

    const request = findSpan(spans, "swamp.enrollment.request");
    assertEquals(request.attributes["swamp.rpc.cancel_observed"], true);
    assertEquals(request.attributes["swamp.rpc.cancel_cause"], "cancel_frame");
    assertEquals(
      typeof request.attributes["swamp.rpc.cancel_observed_ms"],
      "number",
    );
    // The enrollment stops before recording the worker (swamp-club#3984).
    assertEquals(request.attributes["swamp.outcome"], "closed");
    assertEquals(h.transitions.map((t) => t.methodName), ["redeem"]);
    // The record read after redeem saw the cancel, and still exported.
    const scan = findSpan(spans, "swamp.diagnostic.token_record_scan");
    assertEquals(scan.attributes["swamp.diagnostic.cancel_observed"], true);
    assertEquals(scan.attributes["swamp.outcome"], "ok");
  });
});

Deno.test("WorkerGateway: a socket that closes mid-enrollment is recorded as closed, not as a cancel received", async () => {
  await withObservedSpans(async (spans) => {
    const release = Promise.withResolvers<void>();
    let redeeming = false;
    const h = createHarness({
      runModelMethod: async (input) => {
        if (input.methodName === "redeem") {
          redeeming = true;
          await release.promise;
        }
        h.transitions.push(input);
      },
    });
    const { workerChannel, dropSocket } = connectWorkerSocket(h.gateway);
    const call = workerChannel.call(RemoteMethod.enroll, enrollParams);
    await waitFor(() => redeeming, "redemption to start");
    dropSocket();
    release.resolve();
    await waitFor(
      () => spans.some((s) => s.name === "swamp.enrollment.request"),
      "the enrollment request to finish",
    );
    const request = findSpan(spans, "swamp.enrollment.request");
    assertEquals(request.attributes["swamp.rpc.cancel_observed"], true);
    assertEquals(
      request.attributes["swamp.rpc.cancel_cause"],
      "channel_closed",
    );
    workerChannel.close("test done");
    await call.catch(() => {});
  });
});

Deno.test("WorkerGateway: an enrollment nobody cancels records that no cancel was seen", async () => {
  await withObservedSpans(async (spans) => {
    const h = createHarness();
    const { workerChannel } = connectWorkerSocket(h.gateway);
    await enroll(workerChannel);
    const request = findSpan(spans, "swamp.enrollment.request");
    assertEquals(request.attributes["swamp.rpc.cancel_observed"], false);
    assertEquals(request.attributes["swamp.rpc.cancel_cause"], undefined);
  });
});

Deno.test("WorkerGateway: an observer that throws on the cancel fields neither fails enrollment nor throws from the abort listener", async () => {
  const silent: ExecutionObservation = {
    carrier: undefined,
    run: (fn) => fn(),
    attributes: (values) => {
      if (
        Object.keys(values).some((key) => key.startsWith("swamp.rpc.cancel"))
      ) {
        throw new Error("exporter broke");
      }
    },
    end: () => {},
  };
  setExecutionObserver({ start: () => silent });
  try {
    const h = createHarness();
    const { workerChannel } = connectWorkerSocket(h.gateway);
    const result = await enroll(workerChannel);
    assertEquals(result.workerId, "ci-runner-3");

    // A cancel mid-enrollment calls the listener, which must not throw.
    const release = Promise.withResolvers<void>();
    let redeeming = false;
    const cancelled = createHarness({
      runModelMethod: async (input) => {
        if (input.methodName === "redeem") {
          redeeming = true;
          await release.promise;
        }
      },
    });
    const second = connectWorkerSocket(cancelled.gateway);
    const call = second.workerChannel.call(RemoteMethod.enroll, enrollParams);
    await waitFor(() => redeeming, "redemption to start");
    second.dropSocket();
    second.workerChannel.close("test done");
    release.resolve();
    await assertRejects(() => call);
    await cancelled.gateway.settled();
  } finally {
    setExecutionObserver(undefined);
  }
});
