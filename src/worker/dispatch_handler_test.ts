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
import { overlayEnvironment } from "../domain/remote/environment_snapshot.ts";
import { RpcChannel, type RpcError } from "../domain/remote/rpc_channel.ts";
import {
  REMOTE_PROTOCOL_VERSION,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import { registerDispatchHandler } from "./dispatch_handler.ts";

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

Deno.test("registerDispatchHandler: drain() resolves immediately when idle", async () => {
  const { worker } = channelPair();
  const handle = registerDispatchHandler({
    channel: worker,
    sessionCredential: () => "test-cred",
    dataPlaneUrl: "http://localhost:0",
    cacheDirPath: "/tmp/test-cache",
  });

  await handle.drain();
});
