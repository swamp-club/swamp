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

/**
 * swamp-club#2190: revoking an enrollment token cuts off workers already
 * connected on it. Wires a real repo, the real enrollment-token model (mint
 * through the serve handler, redeem through enrollment), a real
 * WorkerGateway, and the worker token revalidation pass.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  collect,
  createLibSwampContext,
  createRepoInitDeps,
  createWorkerTokenRevokeDeps,
  repoInit,
  workerTokenRevoke,
} from "../src/libswamp/mod.ts";
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
import { RpcChannel, RpcError } from "../src/domain/remote/rpc_channel.ts";
import {
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
} from "../src/domain/remote/protocol.ts";
import {
  handleWorkerTokenCreate,
  handleWorkerTokenRevoke,
} from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { WorkerTokenRevalidationService } from "../src/serve/worker_token_revalidation_service.ts";
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
    prefix: "swamp-worker-token-revoke-",
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

  // Serve boot registers the control-plane vault that holds token secrets.
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

async function mintToken(f: Fixture, name: string): Promise<string> {
  const socket = createMockSocket();
  await handleWorkerTokenCreate(
    socket,
    f.ctx,
    "req-create",
    { name, durationMs: 60 * 60_000 },
    new AbortController(),
    null,
  );
  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.type, "worker.token.create", socket.sent[0]);
  return response.payload.data.token as string;
}

/** An in-process worker attached to the gateway's control plane. */
function connectWorker(gateway: WorkerGateway): RpcChannel {
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
  return workerChannel;
}

function enroll(
  channel: RpcChannel,
  token: string,
  instanceUuid = "uuid-1",
): Promise<EnrollResult> {
  return channel.call<EnrollResult>(RemoteMethod.enroll, {
    token,
    instanceUuid,
    machineId: "machine-1",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    swampVersion: "1.0.0",
    platform: "linux",
    arch: "x86_64",
    labels: {},
  });
}

async function revokeLocally(f: Fixture, name: string): Promise<void> {
  const libCtx = createLibSwampContext();
  const events = await collect(
    workerTokenRevoke(
      libCtx,
      await createWorkerTokenRevokeDeps(libCtx, f.repoDir, f.repoContext),
      { name },
    ),
  );
  assertEquals(events.some((event) => event.kind === "error"), false);
}

Deno.test("worker token revoke through serve disconnects the connected worker at once", async () => {
  await withFixture(async (f) => {
    const token = await mintToken(f, "w-serve");
    const session = await enroll(connectWorker(f.gateway), token);
    assertEquals(f.gateway.worker("w-serve")?.connected, true);

    const socket = createMockSocket();
    await handleWorkerTokenRevoke(
      socket,
      f.ctx,
      "req-revoke",
      { name: "w-serve" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "worker.token.revoke", socket.sent[0]);
    assertEquals(response.payload.data.state, "revoked");
    assertEquals(response.payload.data.disconnectedWorkers, ["w-serve"]);
    assertEquals(f.gateway.worker("w-serve"), null);
    assertEquals(f.gateway.sessions.verify(session.sessionCredential), null);

    // The worker cannot come back on the revoked token; it treats this
    // rejection as permanent.
    const error = await assertRejects(
      () => enroll(connectWorker(f.gateway), token, "uuid-2"),
      RpcError,
    );
    assertEquals(error.message.includes("revoked"), true, error.message);
  });
});

Deno.test("worker token revoke from the local CLI is picked up by revalidation", async () => {
  await withFixture(async (f) => {
    const token = await mintToken(f, "w-local");
    const session = await enroll(connectWorker(f.gateway), token);

    await revokeLocally(f, "w-local");
    // The local revoke never touched the gateway.
    assertEquals(f.gateway.worker("w-local")?.connected, true);

    assertEquals(await f.revalidation.runOnce(), ["w-local"]);
    assertEquals(f.gateway.worker("w-local"), null);
    assertEquals(f.gateway.sessions.verify(session.sessionCredential), null);
  });
});

Deno.test("re-minting a revoked token name cuts off workers on the old mint only", async () => {
  await withFixture(async (f) => {
    const oldToken = await mintToken(f, "w-remint");
    await enroll(connectWorker(f.gateway), oldToken);
    const [oldMint] = f.gateway.boundTokens();

    await revokeLocally(f, "w-remint");
    const newToken = await mintToken(f, "w-remint");

    const cutOff = await f.revalidation.runOnce();
    assertEquals(cutOff, ["w-remint"]);
    assertEquals(f.gateway.worker("w-remint"), null);

    // A worker on the fresh mint stays connected across passes.
    await enroll(connectWorker(f.gateway), newToken, "uuid-2");
    assertEquals(await f.revalidation.runOnce(), []);
    assertEquals(f.gateway.worker("w-remint")?.connected, true);
    const [newMint] = f.gateway.boundTokens();
    assertEquals(newMint.tokenCreatedAt === oldMint.tokenCreatedAt, false);
  });
});

Deno.test("worker token revoke through serve still cuts workers off when the request was cancelled", async () => {
  await withFixture(async (f) => {
    const token = await mintToken(f, "w-cancel");
    await enroll(connectWorker(f.gateway), token);

    const controller = new AbortController();
    controller.abort();
    const socket = createMockSocket();
    await handleWorkerTokenRevoke(
      socket,
      f.ctx,
      "req-revoke",
      { name: "w-cancel" },
      controller,
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "error", socket.sent[0]);
    assertEquals(f.gateway.worker("w-cancel"), null);
  });
});
