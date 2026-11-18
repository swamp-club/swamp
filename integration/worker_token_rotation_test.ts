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
  WorkerCapability,
} from "../src/domain/remote/protocol.ts";
import {
  handleWorkerTokenCreate,
  handleWorkerTokenReveal,
  handleWorkerTokenRevoke,
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
import { Definition } from "../src/domain/definitions/definition.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../src/domain/models/access/server_token_model.ts";
import {
  createWorkerTokenRevokeDeps,
  workerTokenRevoke,
} from "../src/libswamp/worker/token_revoke.ts";
import { workflowRun } from "../src/libswamp/workflows/run.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";

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

async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  options: { graceWindowMs?: number } = {},
): Promise<void> {
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
    graceWindowMs: options.graceWindowMs ?? 60_000,
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
    deliverRotation: async (name, token) => {
      await gateway.deliverCurrentMint(name, token);
    },
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
  return connectDroppableWorker(gateway, rotation).channel;
}

function connectDroppableWorker(
  gateway: WorkerGateway,
  rotation?: { credential: WorkerCredential; tokenFile?: string },
): { channel: RpcChannel; drop: () => void } {
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
  return {
    channel: workerChannel,
    drop: () => {
      attached.closed();
      workerChannel.close("control socket closed");
    },
  };
}

function enroll(
  channel: RpcChannel,
  token: string,
  options: {
    instanceUuid?: string;
    machineId?: string;
    canRotate?: boolean;
  } = {},
): Promise<EnrollResult> {
  return channel.call<EnrollResult>(RemoteMethod.enroll, {
    token,
    instanceUuid: options.instanceUuid ?? "uuid-1",
    machineId: options.machineId ?? "machine-1",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    swampVersion: "1.0.0",
    platform: "linux",
    arch: "x86_64",
    labels: {},
    ...(options.canRotate === false
      ? {}
      : { capabilities: [WorkerCapability.tokenRotate] }),
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

    await enroll(
      connectWorker(f.gateway),
      (await Deno.readTextFile(tokenFile)).trim(),
    );
    assertEquals(f.gateway.boundTokens(), [after]);
    assertEquals(f.gateway.worker("w-rot")?.connected, true);
  });
});

Deno.test("worker token rotate counts a machine that saved an earlier rotation and left as able to enroll, not retired", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-left", { maxEnrollments: 2 });
    const tokenFile = join(f.repoDir, "worker-token");
    await Deno.writeTextFile(tokenFile, `${original}\n`);
    const credential: WorkerCredential = { token: original };
    const worker = connectDroppableWorker(f.gateway, { credential, tokenFile });
    await enroll(worker.channel, original);

    const first = await rotateThroughServe(f, "w-left");
    assertEquals(first.rotated.map((r) => r.persisted), [true]);
    const afterFirst = (await f.gateway.readTokenRecords()).get("w-left");
    assertEquals(afterFirst?.bindings.map((b) => b.mint), [
      afterFirst?.createdAt,
    ]);

    worker.drop();
    await waitFor(
      () => f.gateway.workers().length === 0,
      "the stopped worker left the pool",
    );
    const second = await rotateThroughServe(f, "w-left");

    assertEquals(second.unconnectedBindings, 1);
    assertEquals(second.retiredBindings, 0);
    await enroll(
      connectWorker(f.gateway),
      (await Deno.readTextFile(tokenFile)).trim(),
    );
    assertEquals(f.gateway.workers().length, 1);
  }, { graceWindowMs: 20 });
});

Deno.test("worker token rotate counts a machine that took an earlier rotation in memory only and left as retired", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-mem", { maxEnrollments: 2 });
    const credential: WorkerCredential = { token: original };
    const worker = connectDroppableWorker(f.gateway, { credential });
    await enroll(worker.channel, original);

    const first = await rotateThroughServe(f, "w-mem");
    assertEquals(first.rotated.map((r) => r.persisted), [false]);

    worker.drop();
    await waitFor(
      () => f.gateway.workers().length === 0,
      "the stopped worker left the pool",
    );
    const second = await rotateThroughServe(f, "w-mem");

    assertEquals(second.unconnectedBindings, 0);
    assertEquals(second.retiredBindings, 1);
  }, { graceWindowMs: 20 });
});

Deno.test("worker token rotate leaves an unrotated fleet member on the old token until it lapses, without expiring the token", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-fleet", {
      durationMs: 3_000,
      maxEnrollments: 2,
    });
    const credential: WorkerCredential = { token: original };
    await enroll(connectWorker(f.gateway, { credential }), original, {
      machineId: "machine-a",
    });
    await enroll(connectWorker(f.gateway), original, {
      instanceUuid: "uuid-b",
      machineId: "machine-b",
      canRotate: false,
    });

    const report = await rotateThroughServe(f, "w-fleet", 60 * 60_000);

    assertEquals(report.rotated.length, 1);
    assertEquals(report.rotated[0].persisted, false);
    assertEquals(report.notRotated.length, 1);
    assertEquals(
      report.notRotated[0].reason,
      "its swamp version cannot take a rotated token",
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

async function rotateLocally(
  f: Fixture,
  name: string,
  durationMs?: number,
): Promise<WorkerTokenRotateData> {
  const libCtx = createLibSwampContext();
  const events = await collect(
    workerTokenRotate(
      libCtx,
      await createWorkerTokenRotateDeps(libCtx, f.repoDir, f.repoContext),
      durationMs === undefined ? { name } : { name, durationMs },
    ),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error(`local rotation failed: ${JSON.stringify(events)}`);
  }
  return completed.data;
}

Deno.test("worker token rotate from the local CLI reaches connected workers at the next token check", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-local");
    const credential: WorkerCredential = { token: original };
    await enroll(connectWorker(f.gateway, { credential }), original);
    const [before] = f.gateway.boundTokens();

    const rotated = await rotateLocally(f, "w-local");
    assertEquals(rotated.delivered, false);
    assertEquals(credential.token, original);

    assertEquals(await f.revalidation.runOnce(), []);
    assertEquals(credential.token, rotated.token);
    const [after] = f.gateway.boundTokens();
    assertEquals(after.tokenCreatedAt > before.tokenCreatedAt, true);
    assertEquals(f.gateway.worker("w-local")?.connected, true);
  });
});

Deno.test("a workflow step that rotates the token on serve reaches the worker at the next token check", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-flow");
    const credential: WorkerCredential = { token: original };
    await enroll(connectWorker(f.gateway, { credential }), original);
    await f.repoContext.workflowRepo.save(Workflow.create({
      name: "rotate-flow",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "rotate",
          task: StepTask.model("w-flow", "rotate", {
            durationMs: 60 * 60_000,
          }),
        })],
      })],
    }));

    const deps = await createWorkflowRunDeps(f.repoDir, f.repoContext, {
      type: "filesystem",
      path: swampPath(f.repoDir),
    });
    const events = await collect(
      workflowRun(createLibSwampContext(), deps, {
        workflowIdOrName: "rotate-flow",
      }),
    );
    const completed = events.find((e) => e.kind === "completed");
    assertEquals(
      completed?.kind === "completed" ? completed.run.status : undefined,
      "succeeded",
      JSON.stringify(events.filter((e) => e.kind === "error")),
    );
    assertEquals(credential.token, original);

    assertEquals(await f.revalidation.runOnce(), []);
    assertEquals(credential.token === original, false);

    const record = (await f.gateway.readTokenRecords()).get("w-flow");
    assertEquals(f.gateway.boundTokens(), [{
      tokenName: "w-flow",
      tokenCreatedAt: record!.createdAt,
    }]);
    assertEquals(f.gateway.worker("w-flow")?.connected, true);
    assertEquals(await f.revalidation.runOnce(), []);
  });
});

Deno.test("a local revoke, re-mint and rotate before a token check never reaches the worker on the revoked mint", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-remint");
    const credential: WorkerCredential = { token: original };
    await enroll(connectWorker(f.gateway, { credential }), original);

    const libCtx = createLibSwampContext();
    const revoked = await collect(
      workerTokenRevoke(
        libCtx,
        await createWorkerTokenRevokeDeps(libCtx, f.repoDir, f.repoContext),
        { name: "w-remint" },
      ),
    );
    assertEquals(revoked.some((event) => event.kind === "error"), false);
    await mintToken(f, "w-remint");
    await rotateLocally(f, "w-remint");

    assertEquals(await f.revalidation.runOnce(), ["w-remint"]);
    assertEquals(credential.token, original);
    assertEquals(f.gateway.worker("w-remint"), null);
  });
});

Deno.test("a worker that cannot take a rotated token is not sent one and is cut off when the old token lapses", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-old", { durationMs: 3_000 });
    await enroll(connectWorker(f.gateway), original, { canRotate: false });

    await rotateLocally(f, "w-old", 60 * 60_000);

    assertEquals(await f.revalidation.runOnce(), []);
    assertEquals(await f.revalidation.runOnce(), []);
    const [bound] = f.gateway.boundTokens();
    const record = (await f.gateway.readTokenRecords()).get("w-old");
    assertEquals(bound.tokenCreatedAt, record?.predecessor?.createdAt);

    await waitFor(
      () => f.gateway.worker("w-old") === null,
      "the worker removed when the old token lapses",
    );
  });
});

Deno.test("worker token rotate from the local CLI never rotates another behavior with the name", async () => {
  await withFixture(async (f) => {
    await f.repoContext.definitionRepo.save(
      SERVER_TOKEN_MODEL_TYPE,
      Definition.create({
        name: "srv",
        type: SERVER_TOKEN_MODEL_TYPE.normalized,
        globalArguments: {},
      }),
    );

    const libCtx = createLibSwampContext();
    const events = await collect(
      workerTokenRotate(
        libCtx,
        await createWorkerTokenRotateDeps(libCtx, f.repoDir, f.repoContext),
        { name: "srv" },
      ),
    );

    const error = events.find((e) => e.kind === "error");
    assertEquals(error?.kind, "error", JSON.stringify(events));
    if (error?.kind === "error") {
      assertEquals(error.error.code, "model_not_found");
      assertEquals(
        error.error.message.includes("swamp worker token list"),
        true,
        error.error.message,
      );
    }
  });
});

Deno.test("worker token reveal through serve returns the token a lost rotation reply carried", async () => {
  await withFixture(async (f) => {
    const original = await mintToken(f, "w-reveal");
    await enroll(connectWorker(f.gateway), original, { canRotate: false });
    const report = await rotateThroughServe(f, "w-reveal");

    const socket = createMockSocket();
    await handleWorkerTokenReveal(
      socket,
      f.ctx,
      "req-reveal",
      { name: "w-reveal" },
      new AbortController(),
      null,
    );
    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "worker.token.reveal", socket.sent[0]);
    assertEquals(response.payload.data.token, report.token);
    assertEquals(response.payload.data.expired, false);
  });
});

Deno.test("worker token rotate writes a successor key cloud vaults accept", async () => {
  await withFixture(async (f) => {
    await mintToken(f, "w-key");
    await rotateThroughServe(f, "w-key");
    const record = (await f.gateway.readTokenRecords()).get("w-key");
    assertEquals(
      record?.secretKey.startsWith("worker-rotated-token-w-key-"),
      true,
    );
    assertEquals(/^[a-z0-9-]+$/.test(record?.secretKey ?? ""), true);
  });
});

Deno.test("worker token rotate racing a revoke through serve never loses the rotation or un-revokes the token", async () => {
  await withFixture(async (f) => {
    for (let round = 0; round < 4; round++) {
      const name = `w-race-${round}`;
      await mintToken(f, name);
      const rotateSocket = createMockSocket();
      const revokeSocket = createMockSocket();
      await Promise.all([
        handleWorkerTokenRotate(
          rotateSocket,
          f.ctx,
          "req-rotate",
          { name },
          new AbortController(),
          null,
        ),
        handleWorkerTokenRevoke(
          revokeSocket,
          f.ctx,
          "req-revoke",
          { name },
          new AbortController(),
          null,
        ),
      ]);
      const rotated = JSON.parse(rotateSocket.sent[0]);
      const record = (await f.gateway.readTokenRecords()).get(name);
      assertEquals(record?.state, "revoked", rotateSocket.sent[0]);
      if (rotated.type === "worker.token.rotate") {
        assertEquals(record?.predecessor !== undefined, true);
        assertEquals(
          record?.secretKey.startsWith(`worker-rotated-token-${name}-`),
          true,
        );
      } else {
        assertEquals(rotated.type, "error");
        assertEquals(record?.predecessor, undefined);
      }
    }
  });
});
