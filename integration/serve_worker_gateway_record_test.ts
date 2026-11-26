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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { RpcChannel, RpcError } from "../src/domain/remote/rpc_channel.ts";
import {
  type DispatchParams,
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import {
  WORKER_MODEL_TYPE,
  WORKER_STATE_DATA_NAME,
  workerDefinitionName,
  type WorkerState,
  WorkerStateSchema,
} from "../src/domain/models/worker/worker_model.ts";
import { handleWorkerTokenCreate } from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  QUIET_REASSERT_INTERVAL_MS,
  WorkerGateway,
  type WorkerGatewayOptions,
} from "../src/serve/worker_gateway.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../src/domain/models/worker/enrollment_token_model.ts";
import {
  methodRunnerWorkerStatusStore,
  WorkerStatusLedger,
} from "../src/serve/worker_status_ledger.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const VERSION = "20260101.120000.0";

interface Harness {
  repoDir: string;
  repoContext: RepositoryContext;
  gateway: WorkerGateway;
  pushes: () => number;
  peerAlive: { value: boolean };
  token: string;
  name: string;
}

async function mintToken(
  repoDir: string,
  repoContext: RepositoryContext,
  name: string,
): Promise<string> {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
    close() {},
  } as unknown as WebSocket;
  await handleWorkerTokenCreate(
    socket,
    {
      repoDir,
      repoContext,
      datastoreConfig: { type: "filesystem" },
      datastoreResolver: {},
      authConfig: { mode: "none" },
    } as unknown as ConnectionContext,
    "req-create",
    { name, durationMs: 60 * 60_000 },
    new AbortController(),
    null,
  );
  return JSON.parse(sent[0]).payload.data.token as string;
}

async function withGateway(
  fn: (h: Harness) => Promise<void>,
  holdPushes?: Promise<void>,
  options: Partial<WorkerGatewayOptions> = {},
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-gateway-record-" });
  const initEvents = await collect(
    repoInit(createLibSwampContext(), createRepoInitDeps(VERSION), {
      path: repoDir,
      force: false,
      version: VERSION,
      tools: [],
    }),
  );
  assertEquals(initEvents.some((event) => event.kind === "error"), false);
  const repoContext = createRepositoryContext({ repoDir });
  const provider = new ControlPlaneVaultProvider(
    new FileSystemControlPlaneStore(swampPath(repoDir)),
  );
  await provider.initialize();
  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "control_plane",
    provider,
  );
  let pushes = 0;
  const peerAlive = { value: true };
  const gateway = new WorkerGateway({
    workerOwnerAlive: () => Promise.resolve(peerAlive.value),
    repoDir,
    repoContext,
    capabilityService: { registerHandlers: () => {} },
    graceWindowMs: 60_000,
    owner: { instanceId: "this-serve", pid: Deno.pid },
    pushWorkerRecords: async () => {
      pushes++;
      await holdPushes;
    },
    ...options,
  });
  try {
    const name = `w-${crypto.randomUUID().slice(0, 8)}`;
    const token = await mintToken(repoDir, repoContext, name);
    await fn({
      repoDir,
      repoContext,
      gateway,
      pushes: () => pushes,
      peerAlive,
      token,
      name,
    });
  } finally {
    await gateway.settled();
    gateway.dispose();
    VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function connectWorker(
  gateway: WorkerGateway,
): { channel: RpcChannel; drop: () => void } {
  const channel: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => attached.feed(data)),
  });
  const attached = gateway.attachTransport({
    send: (data) => void Promise.resolve().then(() => channel.handleRaw(data)),
  });
  return {
    channel,
    drop: () => {
      attached.closed();
      channel.close("control socket closed");
    },
  };
}

function enroll(
  channel: RpcChannel,
  token: string,
  instanceUuid: string,
  extra: Record<string, unknown> = {},
): Promise<EnrollResult> {
  return channel.call<EnrollResult>(RemoteMethod.enroll, {
    ...extra,
    token,
    instanceUuid,
    machineId: "machine-1",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    swampVersion: "1.0.0",
    platform: "linux",
    arch: "x86_64",
    labels: { pool: "repro" },
  });
}

async function stored(h: Harness): Promise<WorkerState | null> {
  const definition = await h.repoContext.definitionRepo.findByName(
    WORKER_MODEL_TYPE,
    workerDefinitionName(h.name),
  );
  if (definition === null) return null;
  const content = await h.repoContext.unifiedDataRepo.getContent(
    WORKER_MODEL_TYPE,
    definition.id,
    WORKER_STATE_DATA_NAME,
  );
  return content === null
    ? null
    : WorkerStateSchema.parse(JSON.parse(new TextDecoder().decode(content)));
}

// what a peer's colliding versions leave after a pull
async function overwrite(
  h: Harness,
  instanceUuid: string,
  status: "idle" | "disconnected",
): Promise<void> {
  const ledger = new WorkerStatusLedger(
    h.repoContext,
    methodRunnerWorkerStatusStore(() => Promise.reject(new Error("unused"))),
  );
  const peer = {
    instanceUuid,
    tokenName: h.name,
    workerName: h.name,
    labels: {},
    platform: "linux",
    arch: "x86_64",
    swampVersion: "1.0.0",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
  };
  const peerServe = { instanceId: "peer-serve", pid: 1 };
  // placed unowned, then stamped with the peer's owner, as a pull would leave it
  await ledger.recordStatus(h.name, { status: "idle" }, peer);
  await ledger.recordStatus(h.name, { status, owner: peerServe }, peer);
}

async function removeRecord(h: Harness): Promise<void> {
  const definition = await h.repoContext.definitionRepo.findByName(
    WORKER_MODEL_TYPE,
    workerDefinitionName(h.name),
  );
  assert(definition !== null);
  await runInRootUnitOfWork(h.repoContext, { flush: undefined }, async () => {
    await h.repoContext.unifiedDataRepo.delete(
      WORKER_MODEL_TYPE,
      definition.id,
      WORKER_STATE_DATA_NAME,
    );
    await h.repoContext.definitionRepo.delete(WORKER_MODEL_TYPE, definition.id);
  });
}

function dispatchParams(dispatchId: string): DispatchParams {
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
    extensionBundles: [],
    environmentSnapshot: {},
    dataPlaneUrl: "http://127.0.0.1:0",
  };
}

Deno.test("WorkerGateway on a repo: an enrollment is published", async () => {
  await withGateway(async (h) => {
    const { channel } = connectWorker(h.gateway);
    await enroll(channel, h.token, crypto.randomUUID());
    await waitFor(() => h.pushes() >= 1, "the enrollment publish");
  });
});

Deno.test("WorkerGateway on a repo: reassertConnected restores a connected worker a peer's record says is gone, and leaves another live instance", async () => {
  await withGateway(async (h) => {
    const live = crypto.randomUUID();
    const { channel } = connectWorker(h.gateway);
    await enroll(channel, h.token, live);
    await h.gateway.settled();
    const before = h.pushes();

    await overwrite(h, crypto.randomUUID(), "disconnected");
    assertEquals(await h.gateway.reassertConnected(), 1);
    const restored = await stored(h);
    assertEquals(restored?.instanceUuid, live);
    assertEquals(restored?.status, "idle");
    assertEquals(h.pushes(), before + 1);

    assertEquals(await h.gateway.reassertConnected(), 0);
    assertEquals(h.pushes(), before + 1);

    const elsewhere = crypto.randomUUID();
    await overwrite(h, elsewhere, "idle");
    assertEquals(await h.gateway.reassertConnected(), 0);
    assertEquals((await stored(h))?.instanceUuid, elsewhere);

    await removeRecord(h);
    assertEquals(await h.gateway.reassertConnected(), 1);
    assertEquals((await stored(h))?.instanceUuid, live);
  });
});

Deno.test("WorkerGateway on a repo: a dispatch to a worker whose record was pruned recreates it from the connection", async () => {
  await withGateway(async (h) => {
    const live = crypto.randomUUID();
    const { channel } = connectWorker(h.gateway);
    channel.register(WorkerMethod.dispatch, () =>
      Promise.resolve({
        status: "success",
        outputs: [],
        logs: [],
        durationMs: 1,
      }));
    await enroll(channel, h.token, live);
    await h.gateway.settled();

    await removeRecord(h);
    const result = await h.gateway.dispatch(h.name, dispatchParams("d-1"));
    assertEquals(result.status, "success");
    const recreated = await stored(h);
    assertEquals(recreated?.instanceUuid, live);
    assertEquals(recreated?.status, "idle");
  });
});

Deno.test("WorkerGateway on a repo: a departure never stamps a newer enrollment's record, and is published", async () => {
  await withGateway(async (h) => {
    const { channel, drop } = connectWorker(h.gateway);
    await enroll(channel, h.token, crypto.randomUUID());
    await h.gateway.settled();
    const before = h.pushes();

    const newer = crypto.randomUUID();
    await overwrite(h, newer, "idle");
    drop();
    await h.gateway.settled();
    const kept = await stored(h);
    assertEquals(kept?.instanceUuid, newer);
    assertEquals(kept?.status, "idle");
    assertEquals(h.pushes(), before + 1);
  });
});

Deno.test("WorkerGateway on a repo: a draining worker's close leaves a newer enrollment's record alone", async () => {
  await withGateway(async (h) => {
    const { channel, drop } = connectWorker(h.gateway);
    await enroll(channel, h.token, crypto.randomUUID());
    await channel.call(RemoteMethod.drain, {});
    await h.gateway.settled();
    assertEquals((await stored(h))?.status, "draining");

    const newer = crypto.randomUUID();
    await overwrite(h, newer, "idle");
    drop();
    await h.gateway.settled();
    assertEquals(h.gateway.worker(h.name), null);
    const kept = await stored(h);
    assertEquals(kept?.instanceUuid, newer);
    assertEquals(kept?.status, "idle");
  });
});

Deno.test("WorkerGateway on a repo: a draining worker over another instance's record is not counted as restored", async () => {
  await withGateway(async (h) => {
    const { channel } = connectWorker(h.gateway);
    await enroll(channel, h.token, crypto.randomUUID());
    await channel.call(RemoteMethod.drain, {});
    await h.gateway.settled();
    const before = h.pushes();

    const other = crypto.randomUUID();
    await overwrite(h, other, "disconnected");
    assertEquals(await h.gateway.reassertConnected(), 0);
    assertEquals(h.pushes(), before);
    assertEquals((await stored(h))?.instanceUuid, other);
  });
});

Deno.test("WorkerGateway on a repo: publishes queued while one waits are coalesced", async () => {
  const release = Promise.withResolvers<void>();
  await withGateway(async (h) => {
    try {
      const first = connectWorker(h.gateway);
      await enroll(first.channel, h.token, crypto.randomUUID());
      await waitFor(() => h.pushes() === 1, "the first publish started");

      first.drop();
      const secondInstance = crypto.randomUUID();
      const second = connectWorker(h.gateway);
      await enroll(second.channel, h.token, secondInstance);
      second.drop();
      await waitFor(async () => {
        const record = await stored(h);
        return record?.instanceUuid === secondInstance &&
          record.status === "disconnected";
      }, "the last departure written");
    } finally {
      release.resolve();
    }
    await h.gateway.settled();
    assertEquals(h.pushes(), 2);
  }, release.promise);
});

Deno.test("WorkerGateway on a repo: a reconnect with an unusable capacity can still have its record rebuilt", async () => {
  await withGateway(async (h) => {
    const live = crypto.randomUUID();
    const first = connectWorker(h.gateway);
    await enroll(first.channel, h.token, live);
    first.drop();
    const again = connectWorker(h.gateway);
    await enroll(again.channel, h.token, live, {
      resourceLimits: { capacity: 0 },
    });
    await h.gateway.settled();

    await removeRecord(h);
    assertEquals(await h.gateway.reassertConnected(), 1);
    const rebuilt = await stored(h);
    assertEquals(rebuilt?.instanceUuid, live);
    assertEquals(rebuilt?.capacity, 1);
  });
});

Deno.test("WorkerGateway on a repo: a quiet pull checks the records only on the slower clock", async () => {
  await withGateway(async (h) => {
    const live = crypto.randomUUID();
    const { channel } = connectWorker(h.gateway);
    await enroll(channel, h.token, live);
    await h.gateway.settled();
    const start = Date.now();

    assertEquals(await h.gateway.reassertAfterPull(0, start), 0);
    await overwrite(h, crypto.randomUUID(), "disconnected");
    assertEquals(await h.gateway.reassertAfterPull(0, start + 1), 0);
    assertEquals(await h.gateway.reassertAfterPull(5, start + 2), 1);

    await overwrite(h, crypto.randomUUID(), "disconnected");
    assertEquals(
      await h.gateway.reassertAfterPull(
        0,
        start + 2 + QUIET_REASSERT_INTERVAL_MS - 1,
      ),
      0,
    );
    assertEquals(
      await h.gateway.reassertAfterPull(
        0,
        start + 2 + QUIET_REASSERT_INTERVAL_MS,
      ),
      1,
    );
    assertEquals((await stored(h))?.instanceUuid, live);
  });
});

Deno.test("WorkerGateway on a repo: a malformed record of a connected worker is rewritten", async () => {
  await withGateway(async (h) => {
    const live = crypto.randomUUID();
    const { channel } = connectWorker(h.gateway);
    await enroll(channel, h.token, live);
    await h.gateway.settled();
    const definition = await h.repoContext.definitionRepo.findByName(
      WORKER_MODEL_TYPE,
      workerDefinitionName(h.name),
    );
    assert(definition !== null);
    const latest = await h.repoContext.unifiedDataRepo.findByName(
      WORKER_MODEL_TYPE,
      definition.id,
      WORKER_STATE_DATA_NAME,
    );
    assert(latest !== null);
    const path = h.repoContext.unifiedDataRepo.getContentPath(
      WORKER_MODEL_TYPE,
      definition.id,
      WORKER_STATE_DATA_NAME,
      latest.version,
    );
    await Deno.writeTextFile(path, JSON.stringify({ name: 42 }));

    assertEquals(await h.gateway.reassertConnected(), 1);
    assertEquals((await stored(h))?.instanceUuid, live);
  });
});

Deno.test("WorkerGateway on a repo: shutdown writes each connected worker's departure before the sockets close", async () => {
  await withGateway(async (h) => {
    const live = crypto.randomUUID();
    const { channel, drop } = connectWorker(h.gateway);
    await enroll(channel, h.token, live);
    await h.gateway.settled();
    const before = h.pushes();

    await h.gateway.recordShutdownDepartures();
    const departed = await stored(h);
    assertEquals(departed?.instanceUuid, live);
    assertEquals(departed?.status, "disconnected");
    assertEquals(h.pushes(), before + 1);

    const definition = await h.repoContext.definitionRepo.findByName(
      WORKER_MODEL_TYPE,
      workerDefinitionName(h.name),
    );
    assert(definition !== null);
    const versionBefore = (await h.repoContext.unifiedDataRepo.findByName(
      WORKER_MODEL_TYPE,
      definition.id,
      WORKER_STATE_DATA_NAME,
    ))?.version;
    drop();
    await h.gateway.settled();
    const versionAfter = (await h.repoContext.unifiedDataRepo.findByName(
      WORKER_MODEL_TYPE,
      definition.id,
      WORKER_STATE_DATA_NAME,
    ))?.version;
    assertEquals(versionAfter, versionBefore);
  });
});

Deno.test("WorkerGateway on a repo: after shutdown departures nothing marks a worker live again", async () => {
  await withGateway(async (h) => {
    const { channel } = connectWorker(h.gateway);
    await enroll(channel, h.token, crypto.randomUUID());
    await h.gateway.settled();
    await h.gateway.recordShutdownDepartures();

    assertEquals(await h.gateway.reassertConnected(), 0);
    assertEquals(await h.gateway.reassertAfterPull(3), 0);
    await channel.call(RemoteMethod.drain, {});
    await h.gateway.settled();
    assertEquals((await stored(h))?.status, "disconnected");
  });
});

Deno.test("WorkerGateway on a repo: a stopping serve refuses a new enrollment with a retryable code", async () => {
  await withGateway(async (h) => {
    await h.gateway.recordShutdownDepartures();
    const { channel } = connectWorker(h.gateway);
    const refusal = await assertRejects(
      () => enroll(channel, h.token, crypto.randomUUID()),
      RpcError,
    );
    assertEquals(refusal.code, "serve_stopping");
    await h.gateway.settled();
    assertEquals(await stored(h), null);
  });
});

Deno.test("WorkerGateway on a repo: a record a dead serve left is restored from the live connection", async () => {
  await withGateway(async (h) => {
    const live = crypto.randomUUID();
    const { channel } = connectWorker(h.gateway);
    await enroll(channel, h.token, live);
    await h.gateway.settled();
    await overwrite(h, crypto.randomUUID(), "idle");
    h.peerAlive.value = false;
    assertEquals(await h.gateway.reassertConnected(), 1);
    assertEquals((await stored(h))?.instanceUuid, live);
  });
});

Deno.test("WorkerGateway on a repo: after shutdown departures and dispose, a token expiry and socket close write nothing", async () => {
  let deadlineMs = Number.POSITIVE_INFINITY;
  await withGateway(
    async (h) => {
      const { channel, drop } = connectWorker(h.gateway);
      await enroll(channel, h.token, crypto.randomUUID());
      await h.gateway.settled();
      const definition = await h.repoContext.definitionRepo.findByName(
        WORKER_MODEL_TYPE,
        workerDefinitionName(h.name),
      );
      const tokenDefinition = await h.repoContext.definitionRepo.findByName(
        ENROLLMENT_TOKEN_MODEL_TYPE,
        h.name,
      );
      assert(definition !== null && tokenDefinition !== null);
      const versions = async () => [
        (await h.repoContext.unifiedDataRepo.findByName(
          WORKER_MODEL_TYPE,
          definition.id,
          WORKER_STATE_DATA_NAME,
        ))?.version,
        (await h.repoContext.unifiedDataRepo.findByName(
          ENROLLMENT_TOKEN_MODEL_TYPE,
          tokenDefinition.id,
          "token-main",
        ))?.version,
      ];

      assertEquals(h.gateway.pendingExpiryTimers, 1);
      await h.gateway.recordShutdownDepartures();
      h.gateway.dispose();
      assertEquals((await stored(h))?.status, "disconnected");
      const before = await versions();
      assert(before.every((version) => version !== undefined));
      const pushesBefore = h.pushes();

      drop();
      await waitFor(() => Date.now() > deadlineMs + 100, "the expiry deadline");
      await h.gateway.settled();
      assertEquals(await versions(), before);
      assertEquals(h.pushes(), pushesBefore);
      assertEquals(h.gateway.pendingGraceWindows, 0);
      assertEquals(h.gateway.pendingExpiryTimers, 0);
    },
    undefined,
    {
      readTokenExpiresAt: () => {
        deadlineMs = Date.now() + 1_000;
        return Promise.resolve(new Date(deadlineMs).toISOString());
      },
    },
  );
});
