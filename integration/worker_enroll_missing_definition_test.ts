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
 * swamp-club#3074: an HA replica that has an enrollment token's record but
 * not yet its definition (the definition reaches it on the next runtime
 * data poll) must refuse enrollment without creating a definition of its
 * own. A second definition under the same name, with a new id, would hide
 * the token's record by name once pushed. Wires two real repos standing in
 * for two replicas, the real enrollment-token model, and a real
 * WorkerGateway on the replica that did not mint the token.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { copy, exists } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
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
import { handleWorkerTokenCreate } from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const VERSION = "20260101.120000.0";

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

interface Replica {
  repoDir: string;
  repoContext: RepositoryContext;
}

async function createReplica(prefix: string): Promise<Replica> {
  const repoDir = await Deno.makeTempDir({ prefix });
  const initEvents = await collect(
    repoInit(createLibSwampContext(), createRepoInitDeps(VERSION), {
      path: repoDir,
      force: false,
      version: VERSION,
      tools: [],
    }),
  );
  assertEquals(initEvents.some((event) => event.kind === "error"), false);
  return { repoDir, repoContext: createRepositoryContext({ repoDir }) };
}

async function removeReplica(replica: Replica): Promise<void> {
  replica.repoContext.catalogStore.close();
  if (Deno.build.os === "windows") {
    await Deno.remove(replica.repoDir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(replica.repoDir, { recursive: true });
  }
}

/** `_catalog.db` and its `-wal`/`-shm` sidecars. */
function isCatalogFile(name: string): boolean {
  return name === "_catalog.db" || name.startsWith("_catalog.db-");
}

/**
 * Copies one cache subdirectory from the minting replica, as a pull of that
 * subdirectory from the shared datastore would.
 */
async function pullSubdir(
  from: Replica,
  to: Replica,
  subdir: string,
): Promise<void> {
  const source = swampPath(from.repoDir, subdir);
  const target = swampPath(to.repoDir, subdir);
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    // The real remote never syncs the repo-local SQLite catalog.
    if (isCatalogFile(entry.name)) continue;
    await copy(join(source, entry.name), join(target, entry.name), {
      overwrite: true,
    });
  }
  to.repoContext.catalogStore.invalidate();
}

async function mintToken(minter: Replica, name: string): Promise<string> {
  const ctx = {
    repoDir: minter.repoDir,
    repoContext: minter.repoContext,
    datastoreConfig: { type: "filesystem" },
    datastoreResolver: {},
    authConfig: { mode: "none" },
  } as unknown as ConnectionContext;
  const socket = createMockSocket();
  await handleWorkerTokenCreate(
    socket,
    ctx,
    "req-create",
    { name, durationMs: 60 * 60_000 },
    new AbortController(),
    null,
  );
  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.type, "worker.token.create", socket.sent[0]);
  return response.payload.data.token as string;
}

/** The id in a token's definition file, or null when the file is absent. */
async function tokenDefinitionId(
  replica: Replica,
  name: string,
): Promise<string | null> {
  const path = join(
    replica.repoContext.autoDefinitionsDir,
    "swamp",
    "enrollment-token",
    `${name}.yaml`,
  );
  if (!await exists(path)) return null;
  const parsed = parseYaml(await Deno.readTextFile(path)) as { id: string };
  return parsed.id;
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

function enroll(channel: RpcChannel, token: string): Promise<EnrollResult> {
  return channel.call<EnrollResult>(RemoteMethod.enroll, {
    token,
    instanceUuid: crypto.randomUUID(),
    machineId: "machine-1",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    swampVersion: "1.0.0",
    platform: "linux",
    arch: "x86_64",
    labels: {},
  });
}

async function withReplicas(
  fn: (minter: Replica, peer: Replica, gateway: WorkerGateway) => Promise<void>,
): Promise<void> {
  const minter = await createReplica("swamp-enroll-minter-");
  const peer = await createReplica("swamp-enroll-peer-");
  // Replicas share the control-plane store that holds token secrets.
  const provider = new ControlPlaneVaultProvider(
    new FileSystemControlPlaneStore(swampPath(minter.repoDir)),
  );
  await provider.initialize();
  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "control_plane",
    provider,
  );
  const gateway = new WorkerGateway({
    repoDir: peer.repoDir,
    repoContext: peer.repoContext,
    capabilityService: { registerHandlers: () => {} },
    graceWindowMs: 60_000,
  });
  try {
    await fn(minter, peer, gateway);
  } finally {
    gateway.dispose();
    VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
    await removeReplica(minter);
    await removeReplica(peer);
  }
}

Deno.test("worker enroll on a replica without the token's definition creates none and succeeds after the poll", async () => {
  await withReplicas(async (minter, peer, gateway) => {
    const name = `peer-${crypto.randomUUID().slice(0, 8)}`;
    const token = await mintToken(minter, name);
    const mintedId = await tokenDefinitionId(minter, name);
    assertEquals(typeof mintedId, "string");

    // The peer before its next poll: the record arrived, the definition
    // did not.
    await pullSubdir(minter, peer, "data");
    const error = await assertRejects(
      () => enroll(connectWorker(gateway), token),
      RpcError,
    );
    assertEquals(error.code, "token_not_synced");
    assertEquals(await tokenDefinitionId(peer, name), null);

    // The poll brings the minted definition; enrollment redeems it.
    await pullSubdir(minter, peer, "auto-definitions");
    const result = await enroll(connectWorker(gateway), token);
    assertEquals(result.workerId, name);
    assertEquals(await tokenDefinitionId(peer, name), mintedId);
  });
});

Deno.test("worker enroll with an unknown token name is not found and creates no definition", async () => {
  await withReplicas(async (_minter, peer, gateway) => {
    const name = `unknown-${crypto.randomUUID().slice(0, 8)}`;
    const error = await assertRejects(
      () => enroll(connectWorker(gateway), `${name}.secret`),
      RpcError,
    );
    assertEquals(error.code, "token_not_found");
    assertEquals(await tokenDefinitionId(peer, name), null);
  });
});
