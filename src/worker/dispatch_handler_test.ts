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

import { assertEquals } from "@std/assert";
import {
  overlayEnvironment,
  stripWorkerCredentials,
} from "../domain/remote/environment_snapshot.ts";
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

Deno.test("overlayEnvironment: trace headers overlay on top of snapshot", () => {
  const base = Deno.env.toObject();
  const snapshot = { API_KEY: "secret" };
  let env = overlayEnvironment(base, snapshot);
  assertEquals(env["API_KEY"], "secret");

  const traceEnv: Record<string, string> = {
    TRACEPARENT: "00-abc123-def456-01",
  };
  env = { ...env, ...traceEnv };
  assertEquals(env["TRACEPARENT"], "00-abc123-def456-01");
  assertEquals(env["API_KEY"], "secret");
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
