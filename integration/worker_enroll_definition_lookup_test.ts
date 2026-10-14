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

/**
 * swamp-club#3405: serve's control-plane runs (enrollment-token redeem,
 * worker enroll and set_status) resolve their definitions by type, so a user
 * definition in models/ that shares a token's name but has another type
 * neither shadows the token nor fails the enrollment. Wires a real repo, the
 * real enrollment-token and worker models, and a real WorkerGateway with its
 * default model runner.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
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
import { handleWorkerTokenCreate } from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const VERSION = "20260101.120000.0";

Deno.test("worker enroll ignores a user definition of another type that shares the token's name", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-enroll-lookup-" });
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
  const disconnected: string[] = [];
  const gateway = new WorkerGateway({
    repoDir,
    repoContext,
    capabilityService: { registerHandlers: () => {} },
    graceWindowMs: 60_000,
    onWorkerDisconnected: (worker) => disconnected.push(worker.name),
  });
  try {
    const name = `lookup-${crypto.randomUUID().slice(0, 8)}`;
    const socket = {
      readyState: WebSocket.OPEN,
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data);
      },
      close() {},
    };
    await handleWorkerTokenCreate(
      socket as unknown as WebSocket,
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
    const created = JSON.parse(socket.sent[0]);
    assertEquals(created.type, "worker.token.create", socket.sent[0]);
    const token = created.payload.data.token as string;

    // A user definition under models/ with the token's name and another type.
    const userDir = join(repoDir, "models", "command", "shell");
    await Deno.mkdir(userDir, { recursive: true });
    await Deno.writeTextFile(
      join(userDir, `${name}.yaml`),
      [
        "type: command/shell",
        "typeVersion: 2026.02.09.1",
        `id: ${crypto.randomUUID()}`,
        `name: ${name}`,
        "version: 1",
        "tags: {}",
        "globalArguments:",
        "  run: echo hello",
        "methods: {}",
        "",
      ].join("\n"),
    );

    const workerChannel: RpcChannel = new RpcChannel({
      send: (data) => void Promise.resolve().then(() => attached.feed(data)),
    });
    const attached = gateway.attachTransport({
      send: (data) =>
        void Promise.resolve().then(() => workerChannel.handleRaw(data)),
    });
    const result = await workerChannel.call<EnrollResult>(
      RemoteMethod.enroll,
      {
        token,
        instanceUuid: crypto.randomUUID(),
        machineId: "machine-1",
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        swampVersion: "1.0.0",
        platform: "linux",
        arch: "x86_64",
        labels: {},
      },
    );
    assertEquals(result.workerId, name);
    assertEquals(gateway.worker(name)?.connected, true);

    // The disconnect record runs set_status through the same lookup.
    attached.closed();
    workerChannel.close("test done");
    await waitFor(() => disconnected.includes(name), "disconnect seen");
    // Runs on the gateway's transition tail, after the disconnect record.
    await gateway.revokeToken("no-such-token", "revoked");
    await waitFor(async () => {
      const path = join(
        repoContext.autoDefinitionsDir,
        "swamp",
        "worker",
      );
      for await (const entry of Deno.readDir(path)) {
        if (entry.name.endsWith(".yaml")) return true;
      }
      return false;
    }, "worker definition created in auto-definitions");
  } finally {
    gateway.dispose();
    VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
