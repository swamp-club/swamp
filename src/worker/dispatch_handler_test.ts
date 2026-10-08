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
import {
  overlayEnvironment,
  stripWorkerCredentials,
} from "../domain/remote/environment_snapshot.ts";
import {
  buildRunnerEnvironment,
  runnerSpawnOptions,
} from "./dispatch_handler.ts";
import { RpcChannel, type RpcError } from "../domain/remote/rpc_channel.ts";
import {
  DispatchParamsSchema,
  REMOTE_PROTOCOL_VERSION,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import {
  buildRunnerBootstrapParams,
  registerDispatchHandler,
} from "./dispatch_handler.ts";
import { RunnerBootstrapParamsSchema } from "./runner_protocol.ts";

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

function dispatchParams() {
  return {
    dispatchId: crypto.randomUUID(),
    leaseId: "l-1",
    execution: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      modelType: "test/mock",
      modelId: "m-1",
      methodName: "run",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: {
        id: "def-1",
        name: "test",
        version: 1,
        tags: {},
      },
    },
    bundleFingerprint: "builtin:test/mock",
    reportBundleFingerprints: [],
    environmentSnapshot: {},
  };
}

Deno.test("overlayEnvironment: returns a merged record without mutating the base", () => {
  const base = { PATH: "/usr/bin", EXISTING: "original", HOME: "/root" };
  const snapshot = {
    EXISTING: "shipped",
    ADDED: "new",
    HOME: "/should-not-apply",
  };
  const merged = overlayEnvironment(base, snapshot);

  assertEquals(merged["EXISTING"], "shipped");
  assertEquals(merged["ADDED"], "new");
  assertEquals(merged["HOME"], "/root");
  assertEquals(merged["PATH"], "/usr/bin");
  assertEquals(base["EXISTING"], "original");
  assertEquals("ADDED" in base, false);
});

Deno.test("buildRunnerEnvironment: trace headers overlay on top of snapshot", () => {
  const env = buildRunnerEnvironment(
    { HOME: "/root", PATH: "/usr/bin" },
    { API_KEY: "secret" },
    {
      traceparent: "00-abc123-def456-01",
      "ld-preload": "/tmp/evil.so",
    },
  );
  assertEquals(env["TRACEPARENT"], "00-abc123-def456-01");
  assertEquals(env["API_KEY"], "secret");
  // Only W3C trace headers reach the spawn env; other keys are dropped.
  assertEquals("LD_PRELOAD" in env, false);
});

Deno.test("registerDispatchHandler: draining rejects with worker_draining", async () => {
  const { worker, orchestrator } = channelPair();
  const handle = registerDispatchHandler({
    channel: worker,
    sessionCredential: () => "test-cred",
    dataPlaneUrl: "http://localhost:0",
    cacheDirPath: "/tmp/test-cache",
    capacity: 1,
  });

  await handle.drain();

  let drainError: RpcError | null = null;
  try {
    await orchestrator.call(
      WorkerMethod.dispatch,
      dispatchParams(),
      { timeoutMs: 1_000 },
    );
  } catch (error) {
    drainError = error as RpcError;
  }
  assertEquals(drainError?.code, "worker_draining");
});

Deno.test("registerDispatchHandler: a dispatch waits for admission and fails when it does", async () => {
  const { worker, orchestrator } = channelPair();
  let reject: (error: Error) => void = () => {};
  const admitted = new Promise<void>((_, r) => reject = r);
  // The worker handles the rejection itself; the handler only awaits it.
  admitted.catch(() => {});
  registerDispatchHandler({
    channel: worker,
    sessionCredential: () => "test-cred",
    dataPlaneUrl: "http://localhost:0",
    cacheDirPath: "/tmp/test-cache",
    capacity: 1,
    admitted,
  });
  const call = orchestrator.call(
    WorkerMethod.dispatch,
    dispatchParams(),
    { timeoutMs: 1_000 },
  );
  reject(new Error("not admitted"));
  const error = await call.then(() => null, (e: unknown) => e as Error);
  assertStringIncludes(error?.message ?? "", "not admitted");
});

Deno.test("buildRunnerEnvironment: the worker's own nested pass reaches runners; a shipped one does not", () => {
  const fromWorker = buildRunnerEnvironment(
    { SWAMP_NESTED_GATE_PASS: "77.cHJvb2Y.c2ln" },
    {},
    undefined,
  );
  assertEquals(fromWorker["SWAMP_NESTED_GATE_PASS"], "77.cHJvb2Y.c2ln");
  const shipped = buildRunnerEnvironment(
    {},
    { SWAMP_NESTED_GATE_PASS: "1.cHJvb2Y.c2ln" },
    undefined,
  );
  assertEquals("SWAMP_NESTED_GATE_PASS" in shipped, false);
});

Deno.test("dispatch spawn env: worker credentials are stripped after overlay", () => {
  const base: Record<string, string> = {
    SWAMP_WORKER_TOKEN: "tok.secret",
    SWAMP_SERVER_TOKEN: "srv.secret",
    SWAMP_ORCHESTRATOR_URL: "wss://orch:4000",
    SWAMP_SERVE_EXTRA_HEADERS: "Tunnel-Token: abc123",
    SWAMP_WORKER_LABELS: "gpu=true",
    DEPLOY_ENV: "dev",
  };
  const snapshot = { DEPLOY_ENV: "prod", API_KEY: "key123" };
  const spawnEnv = stripWorkerCredentials(overlayEnvironment(base, snapshot));

  assertEquals(spawnEnv["SWAMP_WORKER_TOKEN"], undefined);
  assertEquals(spawnEnv["SWAMP_SERVER_TOKEN"], undefined);
  assertEquals(spawnEnv["SWAMP_ORCHESTRATOR_URL"], undefined);
  assertEquals(spawnEnv["SWAMP_SERVE_EXTRA_HEADERS"], "Tunnel-Token: abc123");
  assertEquals(spawnEnv["SWAMP_WORKER_LABELS"], "gpu=true");
  assertEquals(spawnEnv["DEPLOY_ENV"], "prod");
  assertEquals(spawnEnv["API_KEY"], "key123");
});

Deno.test("buildRunnerBootstrapParams: carries the worker's CA certificates", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const dispatch = DispatchParamsSchema.parse(dispatchParams());
  const bootstrap = buildRunnerBootstrapParams(dispatch, undefined, {
    sessionCredential: () => "session-cred",
    dataPlaneUrl: "https://orch.internal:4443/",
    cacheDirPath: "/tmp/test-cache",
    caCerts: [pem],
  });

  assertEquals(bootstrap.caCerts, [pem]);
  assertEquals(RunnerBootstrapParamsSchema.parse(bootstrap).caCerts, [pem]);
});

Deno.test("buildRunnerBootstrapParams: omits caCerts when the worker has none", () => {
  const dispatch = DispatchParamsSchema.parse(dispatchParams());
  for (const caCerts of [undefined, []]) {
    const bootstrap = buildRunnerBootstrapParams(dispatch, undefined, {
      sessionCredential: () => "session-cred",
      dataPlaneUrl: "http://localhost:0",
      cacheDirPath: "/tmp/test-cache",
      caCerts,
    });
    assertEquals("caCerts" in bootstrap, false);
  }
});

Deno.test("buildRunnerBootstrapParams: prefers the per-dispatch credential", () => {
  const dispatch = DispatchParamsSchema.parse(dispatchParams());
  const options = {
    sessionCredential: () => "session-cred",
    dataPlaneUrl: "http://localhost:0",
    cacheDirPath: "/tmp/test-cache",
  };

  assertEquals(
    buildRunnerBootstrapParams(dispatch, "dispatch-cred", options)
      .sessionCredential,
    "dispatch-cred",
  );
  assertEquals(
    buildRunnerBootstrapParams(dispatch, undefined, options).sessionCredential,
    "session-cred",
  );
});

Deno.test("registerDispatchHandler: drain() resolves immediately when idle", async () => {
  const { worker } = channelPair();
  const handle = registerDispatchHandler({
    channel: worker,
    sessionCredential: () => "test-cred",
    dataPlaneUrl: "http://localhost:0",
    cacheDirPath: "/tmp/test-cache",
    capacity: 1,
  });

  await handle.drain();
});

Deno.test("buildRunnerEnvironment: drops a TRACEPARENT inherited from the worker when the dispatch has no trace headers", () => {
  const env = buildRunnerEnvironment(
    {
      TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
      tracestate: "vendor=worker",
      DEPLOY_ENV: "dev",
    },
    {},
    undefined,
  );
  assertEquals(env["TRACEPARENT"], undefined);
  assertEquals(env["tracestate"], undefined);
  assertEquals(env["DEPLOY_ENV"], "dev");
});

Deno.test("buildRunnerEnvironment: declares a same-host orchestrator's step locks to the runner", () => {
  const env = buildRunnerEnvironment(
    { SWAMP_LOCK_ANCESTOR_PIDS: "700" },
    {},
    undefined,
    { pid: 500, hostname: "host-a", lockIds: ["nonce-a"] },
    "host-a",
  );
  assertEquals(env["SWAMP_LOCK_ANCESTOR_PIDS"], "500,700");
  assertEquals(env["SWAMP_LOCK_HOLDER_TOKENS"], "500:nonce-a");
});

Deno.test("buildRunnerEnvironment: hands down the locks of a holder on another host without declaring it an ancestor (swamp-club#3096)", () => {
  const env = buildRunnerEnvironment(
    { SWAMP_LOCK_ANCESTOR_PIDS: "700" },
    {},
    undefined,
    { pid: 500, hostname: "host-b", lockIds: ["nonce-a"] },
    "host-a",
  );
  assertEquals(env["SWAMP_LOCK_ANCESTOR_PIDS"], "700");
  assertEquals(env["SWAMP_LOCK_HOLDER_TOKENS"], "500:nonce-a");
});

Deno.test("buildRunnerEnvironment: lock variables shipped in the snapshot never reach the runner", () => {
  // Only the validated lockHolder field may name the orchestrator's locks.
  const env = buildRunnerEnvironment(
    { SWAMP_LOCK_ANCESTOR_PIDS: "700" },
    {
      SWAMP_LOCK_ANCESTOR_PIDS: "500",
      SWAMP_LOCK_HOLDER_PID: "500",
      SWAMP_LOCK_HOLDER_TOKENS: "500:nonce-a",
    },
    undefined,
  );
  assertEquals(env["SWAMP_LOCK_ANCESTOR_PIDS"], "700");
  assertEquals(env["SWAMP_LOCK_HOLDER_PID"], undefined);
  assertEquals(env["SWAMP_LOCK_HOLDER_TOKENS"], undefined);
});

Deno.test("buildRunnerEnvironment: drops trace context shipped in the snapshot", () => {
  // An older orchestrator still ships its own TRACEPARENT in the snapshot.
  const env = buildRunnerEnvironment(
    {},
    {
      TRACEPARENT: "00-33333333333333333333333333333333-4444444444444444-01",
      API_KEY: "key123",
    },
    undefined,
  );
  assertEquals(env["TRACEPARENT"], undefined);
  assertEquals(env["API_KEY"], "key123");
});

Deno.test("buildRunnerEnvironment: the dispatch's trace headers replace inherited trace context", () => {
  const dispatchParent =
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const env = buildRunnerEnvironment(
    {
      TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
      TRACESTATE: "vendor=worker",
      SWAMP_WORKER_TOKEN: "tok.secret",
    },
    {},
    { traceparent: dispatchParent },
  );
  assertEquals(env["TRACEPARENT"], dispatchParent);
  assertEquals(env["TRACESTATE"], undefined);
  assertEquals(env["SWAMP_WORKER_TOKEN"], undefined);
});

Deno.test("runnerSpawnOptions: the built environment replaces the worker's instead of merging over it", () => {
  const env = buildRunnerEnvironment(
    {
      SWAMP_WORKER_TOKEN: "tok.secret",
      TRACEPARENT: "00-1-2-01",
      PATH: "/bin",
    },
    {},
    undefined,
  );
  const options = runnerSpawnOptions(["worker", "exec-dispatch"], env);
  // Without clearEnv, Deno merges env over the worker's own environment and
  // the runner inherits the credentials and trace context removed above.
  assertEquals(options.clearEnv, true);
  assertEquals(options.env, { PATH: "/bin" });
  assertEquals(options.args, ["worker", "exec-dispatch"]);
});
