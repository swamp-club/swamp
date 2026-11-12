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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createWorkerTokenRotateDeps,
  workerTokenRotate,
  type WorkerTokenRotateData,
} from "../src/libswamp/worker/token_rotate.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { RpcChannel } from "../src/domain/remote/rpc_channel.ts";
import {
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
} from "../src/domain/remote/protocol.ts";
import {
  handleWorkerTokenCreate,
  handleWorkerTokenRotate,
} from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { WorkerTokenRevalidationService } from "../src/serve/worker_token_revalidation_service.ts";
import {
  registerTokenRotationHandler,
  type WorkerCredential,
} from "../src/worker/token_rotation_handler.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

function createMockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
    close() {},
  } as unknown as WebSocket & { sent: string[] };
}

interface Fixture {
  repoDir: string;
  repoContext: RepositoryContext;
  gateway: WorkerGateway;
  revalidation: WorkerTokenRevalidationService;
  ctx: ConnectionContext;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-worker-token-rotate-",
  });
  const repoContext = createRepositoryContext({ repoDir });
  const version = "20260101.120000.0";
  const initEvents = await collect(
    repoInit(createLibSwampContext(), createRepoInitDeps(version), {
      path: repoDir,
      force: false,
      version,
      tools: [],
    }),
  );
  assertEquals(initEvents.some((event) => event.kind === "error"), false);

  const provider = new ControlPlaneVaultProvider(
    new FileSystemControlPlaneStore(swampPath(repoDir)),
  );
  await provider.initialize();
  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "control_plane",
    provider,
  );

  const gateway = new WorkerGateway({
    repoDir,
    repoContext,
    capabilityService: { registerHandlers: () => {} },
    graceWindowMs: 60_000,
    readTokenSecret: async (vaultName, secretKey) =>
      await (await VaultService.fromRepository(repoDir)).get(
        vaultName,
        secretKey,
      ),
  });
  const revalidation = new WorkerTokenRevalidationService({
    intervalMs: 60_000,
    listBoundTokens: () => gateway.boundTokens(),
    readTokens: () => gateway.readTokenRecords(),
    revokeToken: (name, cause, options) =>
      gateway.revokeToken(name, cause, options),
  });
  const ctx = {
    repoDir,
    repoContext,
    datastoreConfig: { type: "filesystem" },
    datastoreResolver: {},
    authConfig: { mode: "none" },
    workerGateway: gateway,
  } as unknown as ConnectionContext;
  try {
    await fn({ repoDir, repoContext, gateway, revalidation, ctx });
  } finally {
    await revalidation.dispose();
    await gateway.settled();
    gateway.dispose();
    repoContext.catalogStore.close();
    VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function mintToken(
  f: Fixture,
  name: string,
  options: { durationMs?: number; maxEnrollments?: number } = {},
): Promise<string> {
  const socket = createMockSocket();
  await handleWorkerTokenCreate(
    socket,
    f.ctx,
    "req-create",
    {
      name,
      durationMs: options.durationMs ?? 60 * 60_000,
      ...(options.maxEnrollments !== undefined
        ? { maxEnrollments: options.maxEnrollments }
        : {}),
    },
    new AbortController(),
    null,
  );
  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.type, "worker.token.create", socket.sent[0]);
  return response.payload.data.token as string;
}

async function rotateThroughServe(
  f: Fixture,
  name: string,
  durationMs?: number,
): Promise<WorkerTokenRotateData> {
  const socket = createMockSocket();
  await handleWorkerTokenRotate(
    socket,
    f.ctx,
    "req-rotate",
    durationMs === undefined ? { name } : { name, durationMs },
    new AbortController(),
    null,
  );
  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.type, "worker.token.rotate", socket.sent[0]);
  return response.payload.data as WorkerTokenRotateData;
}

function connectWorker(
  gateway: WorkerGateway,
  rotation?: { credential: WorkerCredential; tokenFile?: string },
): RpcChannel {
  const workerChannel: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => attached.feed(data)),
  });
  const attached = gateway.attachTransport({
    send: (data) =>
      void Promise.resolve().then(() => workerChannel.handleRaw(data)),
  }, () => {
    attached.closed();
    workerChannel.close("control socket closed");
  });
  if (rotation !== undefined) {
    registerTokenRotationHandler({ channel: workerChannel, ...rotation });
  }
  return workerChannel;
}

function enroll(
  channel: RpcChannel,
  token: string,
  options: {
    instanceUuid?: string;
    machineId?: string;
    protocolVersion?: number;
  } = {},
): Promise<EnrollResult> {
  return channel.call<EnrollResult>(RemoteMethod.enroll, {
    token,
    instanceUuid: options.instanceUuid ?? "uuid-1",
    machineId: options.machineId ?? "machine-1",
    protocolVersion: options.protocolVersion ?? REMOTE_PROTOCOL_VERSION,
    swampVersion: "1.0.0",
    platform: "linux",
    arch: "x86_64",
    labels: {},
  });
}

Deno.test("worker token rotate through serve hands the worker its successor, which survives a restart", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-rot");
    const tokenFile = join(f.repoDir, "worker-token");
    await Deno.writeTextFile(tokenFile, `${original}\n`);
    const credential: WorkerCredential = { token: original };
    await enroll(connectWorker(f.gateway, { credential, tokenFile }), original);
    const [before] = f.gateway.boundTokens();

    const report = await rotateThroughServe(f, "w-rot");

    assertEquals(report.delivered, true);
    assertEquals(report.rotated, [{ worker: "w-rot", persisted: true }]);
    assertEquals(report.notRotated, []);
    assertEquals(credential.token, report.token);
    assertEquals(await Deno.readTextFile(tokenFile), `${report.token}\n`);
    assertEquals(report.token === original, false);
    const [after] = f.gateway.boundTokens();
    assertEquals(after.tokenCreatedAt === before.tokenCreatedAt, false);
    assertEquals(after.tokenCreatedAt > before.tokenCreatedAt, true);

    assertEquals(await f.revalidation.runOnce(), []);
    assertEquals(f.gateway.worker("w-rot")?.connected, true);

    // a reconnect presenting the token read back from the file binds the
    // successor mint
    await enroll(
      connectWorker(f.gateway),
      (await Deno.readTextFile(tokenFile)).trim(),
    );
    assertEquals(f.gateway.boundTokens(), [after]);
    assertEquals(f.gateway.worker("w-rot")?.connected, true);
  });
});

Deno.test("worker token rotate leaves an unrotated fleet member on the old token until it lapses, without expiring the token", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-fleet", {
      durationMs: 1_500,
      maxEnrollments: 2,
    });
    const credential: WorkerCredential = { token: original };
    await enroll(connectWorker(f.gateway, { credential }), original, {
      machineId: "machine-a",
    });
    await enroll(connectWorker(f.gateway), original, {
      instanceUuid: "uuid-b",
      machineId: "machine-b",
      protocolVersion: 7,
    });

    const report = await rotateThroughServe(f, "w-fleet", 60 * 60_000);

    assertEquals(report.rotated.length, 1);
    assertEquals(report.rotated[0].persisted, false);
    assertEquals(report.notRotated.length, 1);
    assertEquals(
      report.notRotated[0].reason,
      "protocol version 7 cannot rotate",
    );
    assertEquals(await f.revalidation.runOnce(), []);
    assertEquals(f.gateway.workers().length, 2);

    const straggler = report.notRotated[0].worker;
    await waitFor(
      () => f.gateway.worker(straggler) === null,
      "straggler removed when the old token lapses",
    );
    await f.gateway.settled();
    const record = (await f.gateway.readTokenRecords()).get("w-fleet");
    assertEquals(record?.state, "enrolled");
    assertEquals(record?.predecessor, undefined);
    assertEquals(f.gateway.worker(report.rotated[0].worker)?.connected, true);
    assertEquals(await f.revalidation.runOnce(), []);
  });
});

Deno.test("worker token rotate from the local CLI keeps connected workers on the old token", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-local");
    await enroll(connectWorker(f.gateway), original);

    const libCtx = createLibSwampContext();
    const events = await collect(
      workerTokenRotate(
        libCtx,
        await createWorkerTokenRotateDeps(libCtx, f.repoDir, f.repoContext),
        { name: "w-local" },
      ),
    );
    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed", JSON.stringify(events));

    assertEquals(await f.revalidation.runOnce(), []);
    assertEquals(f.gateway.worker("w-local")?.connected, true);
  });
});
