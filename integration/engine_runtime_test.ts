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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { RunEventBuffer } from "../src/serve/run_event_buffer.ts";
import { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import { createServerTokenAuthDeps } from "../src/serve/token_auth.ts";
import {
  EngineRuntime,
  type EngineRuntimeOptions,
} from "../src/engine/runtime.ts";
import { encodeEngineFrame, ENGINE_PROTOCOL } from "../src/engine/protocol.ts";
import {
  createServeCtx,
  grant,
  saveModel,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createServerTokenCreateDeps,
  serverTokenCreate,
} from "../src/libswamp/access/token_create.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
} from "../src/libswamp/vaults/create.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import {
  type ConnectionContext,
  listTokenSessions,
  terminateTokenSessions,
} from "../src/serve/handlers/shared.ts";
import { localPageServices } from "../src/serve/local_engine_context.ts";
import type { ActionRunner } from "../src/serve/local/delegated_actions.ts";

await initializeLogging({});
type Frame = Record<string, unknown>;
function harness(
  context: ConnectionContext,
  options: Partial<Omit<EngineRuntimeOptions, "context" | "dispose">> = {},
) {
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const frames: Frame[] = [];
  let disposed = 0;
  const runtime = new EngineRuntime(
    {
      context,
      engineVersion: "test",
      gitSha: "test",
      ...options,
      dispose() {
        disposed++;
        return Promise.resolve();
      },
    },
    new WritableStream({
      write(bytes) {
        frames.push(
          JSON.parse(new TextDecoder().decode(bytes.subarray(4))) as Frame,
        );
      },
    }),
  );
  const task = runtime.serve(
    new ReadableStream({
      start(c) {
        input = c;
      },
    }),
  );
  let serial = 0;
  return {
    runtime,
    frames,
    task,
    get disposed() {
      return disposed;
    },
    async control(method: string, params: Frame = {}) {
      const id = String(++serial);
      input.enqueue(
        encodeEngineFrame({
          version: 1,
          generation: "test-generation",
          id,
          method,
          params,
        }),
      );
      await waitFor(
        () => frames.some((f) => f.id === id),
        `control ${method} answered`,
      );
      return frames.find((f) => f.id === id)!;
    },
  };
}

async function createCredential(repo: ServeRepo) {
  const lib = createLibSwampContext();
  const created = await collect(
    vaultCreate(lib, await createVaultCreateDeps(repo.repoDir), {
      vaultType: "local_encryption",
      name: "local",
      config: { auto_generate: true, base_dir: repo.repoDir },
      repoDir: repo.repoDir,
    }),
  );
  assertEquals(created.some((e) => e.kind === "error"), false);
  const minted = await collect(
    serverTokenCreate(
      lib,
      await createServerTokenCreateDeps(lib, repo.repoDir, repo.repoContext),
      {
        name: "engine-token",
        principalId: "user:caller",
        principalEmail: "caller@example.com",
        durationMs: 60_000,
        vaultName: "local",
      },
    ),
  );
  const result = minted.find((e) => e.kind === "completed");
  assertExists(result);
  if (result.kind !== "completed") throw new Error("mint failed");
  const vault = await VaultService.fromRepository(repo.repoDir);
  const secret = await vault.get(
    result.data.vaultRef.vaultName,
    result.data.vaultRef.secretKey,
    "test:engine",
  );
  return { credential: `engine-token.${secret}`, secret };
}

Deno.test("EngineRuntime: hello, refusal, quiescence and disposal are ordered", async () => {
  await withServeRepo(async (repo) => {
    const h = harness(createServeCtx(repo, [], { detached: true }));
    const hello = await h.control("hello", { profile: "local-v1" });
    assertEquals((hello.result as Frame).callerSessionIds, true);
    assertEquals((hello.result as Frame).authenticationDeadlines, true);
    // A hub compares this with the workspace it selected before routing.
    assertEquals((hello.result as Frame).repo, { path: repo.repoDir });
    const rejected = await h.control("session.open", {
      credential: "SECRET_CANARY",
      sourceIp: "127.0.0.1",
    });
    assertEquals((rejected.error as Frame).code, "unauthorized");
    assert(!JSON.stringify(h.frames).includes("SECRET_CANARY"));
    for (
      const deadlineMs of [
        "invalid",
        -1,
        0.5,
        ENGINE_PROTOCOL.limits.maxShutdownDeadlineMs + 1,
      ]
    ) {
      const invalid = await h.control("engine.quiesce", { deadlineMs });
      assertEquals((invalid.error as Frame).code, "invalid_request");
      assertEquals(h.runtime.status.state, "ready");
    }
    const stopped = await h.control("engine.quiesce");
    assertEquals(stopped.result, { quiescent: true });
    await h.task;
    assertEquals(h.disposed, 1);
    assertEquals(h.runtime.status.sessions, 0);
  });
});

Deno.test("EngineRuntime: real token sessions isolate public IDs and retain policy decisions", async () => {
  await withServeRepo(async (repo) => {
    const { credential, secret } = await createCredential(repo);
    const allowed = await saveModel(repo, "allowed");
    const denied = await saveModel(repo, "denied");
    const ctx = createServeCtx(repo, [
      grant({
        actions: ["read"],
        resource: { kind: "model", pattern: allowed.name },
      }),
    ], { detached: true });
    const h = harness(ctx);
    try {
      await h.control("hello", { profile: "local-v1" });
      const open = async () => {
        const response = await h.control("session.open", {
          credential,
          sourceIp: "127.0.0.1",
        });
        assertExists(response.result, JSON.stringify(response));
        return (response.result as { sessionId: string }).sessionId;
      };
      const a = await open();
      const b = await open();
      assert(a !== b);
      assertEquals((await h.control("engine.quiesce")).result, {
        quiescent: false,
      });
      await h.control("request.dispatch", {
        sessionId: a,
        request: {
          id: "shared",
          type: "model.get",
          payload: { modelIdOrName: allowed.name },
        },
      });
      await h.control("request.dispatch", {
        sessionId: b,
        request: {
          id: "shared",
          type: "model.get",
          payload: { modelIdOrName: denied.name },
        },
      });
      await waitFor(
        () =>
          h.frames.some((f) =>
            f.sessionId === a && (f.message as Frame)?.type === "model.get"
          ) && h.frames.some((f) =>
            f.sessionId === b && (f.message as Frame)?.type === "error"
          ),
        "both sessions completed",
      );
      assert(
        h.frames.some((f) =>
          f.sessionId === a && (f.message as Frame)?.type === "model.get"
        ),
      );
      assert(
        !h.frames.some((f) =>
          f.sessionId === b && (f.message as Frame)?.type === "model.get"
        ),
      );
      await h.control("request.dispatch", {
        sessionId: a,
        request: {
          id: "excluded",
          type: "vault.read-secret",
          payload: { secret: "SECOND_CANARY" },
        },
      });
      await waitFor(
        () => h.frames.some((f) => (f.message as Frame)?.id === "excluded"),
        "excluded operation rejected",
      );
      const refusal = h.frames.find((f) =>
        (f.message as Frame)?.id === "excluded"
      )!;
      assertEquals(
        ((refusal.message as Frame).error as Frame).code,
        "unsupported_operation",
      );
      assert(!JSON.stringify(h.frames).includes("SECOND_CANARY"));
      assert(!JSON.stringify(h.frames).includes(secret));
      await h.control("session.close", { sessionId: a });
      await h.control("session.close", { sessionId: b });
      await waitFor(
        () => h.runtime.status.requests === 0,
        "request handlers settled",
      );
      assertEquals((await h.control("engine.quiesce")).result, {
        quiescent: true,
      });
    } finally {
      if (h.runtime.status.state !== "stopped") {
        await h.control("engine.shutdown", { deadlineMs: 1 });
      }
      await h.task;
    }
    assertEquals(h.disposed, 1);
  });
});

Deno.test("EngineRuntime: bounded slow authentication leaves peers responsive and cancelled opens cannot publish", async () => {
  await withServeRepo(async (repo) => {
    const { credential } = await createCredential(repo);
    const h = harness(createServeCtx(repo, [], { detached: true }));
    const released = Promise.withResolvers<void>();
    let openings: Promise<Frame[]> | undefined;
    try {
      await h.control("hello", { profile: "local-v1" });
      const opened = await h.control("session.open", {
        sessionId: "established",
        credential,
        sourceIp: "127.0.0.1",
      });
      assertEquals(opened.result, { sessionId: "established" });
      await h.control("session.close", { sessionId: "established" });
      assertEquals(
        (await h.control("session.open", {
          sessionId: "established",
          credential,
          sourceIp: "127.0.0.1",
        })).result,
        { sessionId: "established" },
      );
      const definitionRepo = repo.repoContext.definitionRepo;
      const findByName = definitionRepo.findByName.bind(definitionRepo);
      let reads = 0;
      definitionRepo.findByName = async (type, name) => {
        if (name === "engine-token") {
          reads++;
          await released.promise;
        }
        return await findByName(type, name);
      };
      const ids = Array.from(
        { length: ENGINE_PROTOCOL.limits.engineAuthentications },
        (_, index) => `pending-${index}`,
      );
      openings = Promise.all(
        ids.map((sessionId) =>
          h.control("session.open", {
            sessionId,
            credential,
            sourceIp: "127.0.0.1",
          })
        ),
      );
      await waitFor(
        () => reads === ids.length,
        "all bounded auth reads entered",
      );
      assertEquals(h.runtime.status.requests, ids.length);
      const excess = await h.control("session.open", {
        sessionId: "excess",
        credential,
        sourceIp: "127.0.0.1",
      });
      assertEquals((excess.error as Frame).code, "too_many_authentications");
      assertEquals((await h.control("engine.quiesce")).result, {
        quiescent: false,
      });
      await h.control("request.dispatch", {
        sessionId: "established",
        request: { id: "responsive", type: "server.version" },
      });
      await waitFor(
        () => h.frames.some((f) => (f.message as Frame)?.id === "responsive"),
        "established session responds while authentication is blocked",
      );
      for (const sessionId of ids) {
        await h.control("session.close", { sessionId });
      }
      for (const response of await openings) {
        assertEquals((response.error as Frame).code, "engine_retiring");
      }
      assertEquals(h.runtime.status.requests, 0);
      assertEquals(h.runtime.status.authenticationWork, ids.length);
      assertEquals(h.runtime.status.sessions, 1);
      released.resolve();
      const reused = await h.control("session.open", {
        sessionId: ids[0],
        credential,
        sourceIp: "127.0.0.1",
      });
      assertEquals((reused.error as Frame).code, "engine_retiring");
    } finally {
      released.resolve();
      await openings;
      await h.control("engine.shutdown", { deadlineMs: 1000 });
      await h.task;
    }
  });
});

Deno.test("EngineRuntime: shutdown cancels authentication waiters and quarantines unfinished providers", async () => {
  await withServeRepo(async (repo) => {
    const { credential } = await createCredential(repo);
    const h = harness(createServeCtx(repo, [], { detached: true }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const definitionRepo = repo.repoContext.definitionRepo;
    const findByName = definitionRepo.findByName.bind(definitionRepo);
    definitionRepo.findByName = async (type, name) => {
      if (name === "engine-token") {
        entered.resolve();
        await release.promise;
      }
      return await findByName(type, name);
    };
    await h.control("hello", { profile: "local-v1" });
    const opening = h.control("session.open", {
      sessionId: "abandoned",
      credential,
      sourceIp: "127.0.0.1",
    });
    await entered.promise;
    const shutdown = h.control("engine.shutdown", { deadlineMs: 1000 });
    try {
      await shutdown;
      await h.task;
      assertEquals(h.disposed, 1);
      assertEquals(h.runtime.status.requests, 0);
      assertEquals(h.runtime.status.authenticationWork, 1);
    } finally {
      release.resolve();
      const refused = await opening;
      assertEquals((refused.error as Frame).code, "session_closed");
      await shutdown;
      await h.task;
      await waitFor(
        () => h.runtime.status.authenticationWork === 0,
        "cancelled provider settled",
      );
    }
    assertEquals(h.disposed, 1);
    assertEquals(h.runtime.status.sessions, 0);
  });
});

Deno.test("EngineRuntime: hung authentication stays bounded until accepted work completes and the generation retires", async () => {
  await withServeRepo(async (repo) => {
    const { credential, secret } = await createCredential(repo);
    const model = await saveModel(repo, "accepted-before-auth-stall");
    const context = createServeCtx(repo, [grant({
      actions: ["read", "run"],
      resource: { kind: "model", pattern: model.name },
    })], { detached: true });
    const actions: string[] = [];
    const audit = new AuditEmitter([{
      name: "test",
      durable: false,
      write(events) {
        actions.push(...events.map((event) => event.action));
        return Promise.resolve();
      },
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }]);
    context.auditEmitter = audit;
    const base = await createServerTokenAuthDeps(
      repo.repoDir,
      repo.repoContext,
    );
    const release = Promise.withResolvers<void>();
    let blocked = false;
    let reads = 0;
    const deadlines: Array<
      { delayMs: number; expire: () => void; cancelled: boolean }
    > = [];
    const h = harness(context, {
      authenticationDeps: {
        // The record read: a recent vault match skips the secret read.
        async readToken(name) {
          if (blocked) {
            reads++;
            await release.promise;
          }
          return await base.readToken(name);
        },
        readSecret: () => Promise.resolve(secret),
      },
      scheduleAuthenticationDeadline(delayMs, expire) {
        const deadline = { delayMs, expire, cancelled: false };
        deadlines.push(deadline);
        return () => {
          deadline.cancelled = true;
        };
      },
    });
    const registry = context.activeRunRegistry!;
    const completion = Promise.withResolvers<void>();
    const run = new AbortController();
    const cancellable = new AbortController();
    const buffer = new RunEventBuffer(10);
    const runId = crypto.randomUUID();
    const cancelId = crypto.randomUUID();
    let openings: Promise<Frame[]> | undefined;
    let next: ReturnType<typeof harness> | undefined;
    try {
      await h.control("hello", { profile: "local-v1" });
      assertExists(
        (await h.control("session.open", {
          sessionId: "peer",
          credential,
          sourceIp: "127.0.0.1",
        })).result,
      );
      await audit.flush();
      assertEquals(
        actions.filter((action) => action === "auth.token.used").length,
        1,
      );
      for (
        const [id, controller, events] of [
          [runId, run, buffer],
          [cancelId, cancellable, new RunEventBuffer(10)],
        ] as const
      ) {
        registry.register({
          runId: id,
          kind: "method-run",
          resourceName: model.name,
          resourceId: model.id,
          resourceType: repo.modelType.normalized,
          methodName: "noop",
          controller,
          buffer: events,
          startedAt: new Date(),
          completion: completion.promise,
          principalId: "user:caller",
        });
      }
      await h.control("request.dispatch", {
        sessionId: "peer",
        request: { id: "observe", type: "run.attach", payload: { runId } },
      });
      blocked = true;
      openings = Promise.all(
        Array.from({ length: 64 }, (_, id) =>
          h.control("session.open", {
            sessionId: `hung-${id}`,
            credential,
            sourceIp: "127.0.0.1",
            authenticationTimeoutMs: 123,
          })),
      );
      await waitFor(() => reads === 64, "all provider reads blocked");
      assertEquals(h.runtime.status.authenticationWork, 64);
      const activeDeadline = deadlines.find((deadline) => !deadline.cancelled)!;
      assertEquals(activeDeadline.delayMs, 123);
      activeDeadline.expire();
      for (const response of await openings) {
        assertEquals((response.error as Frame).code, "engine_retiring");
      }
      assertEquals(h.runtime.status.state, "retiring");
      assertEquals(h.runtime.status.authenticationWork, 64);
      assertEquals(run.signal.aborted, false);
      assertEquals(cancellable.signal.aborted, false);
      assertEquals(deadlines.every((deadline) => deadline.cancelled), true);
      for (let attempt = 0; attempt < 3; attempt++) {
        assertEquals(
          ((await h.control("session.open", {
            credential,
            sourceIp: "127.0.0.1",
          })).error as Frame).code,
          "engine_retiring",
        );
      }
      assertEquals(reads, 64);
      assertEquals(
        ((await h.control("request.dispatch", {
          sessionId: "peer",
          request: { id: "new-run", type: "workflow.run", payload: {} },
        })).error as Frame).code,
        "engine_retiring",
      );
      assertEquals((await h.control("engine.quiesce")).result, {
        quiescent: false,
      });
      assertEquals(h.disposed, 0);
      await h.control("request.dispatch", {
        sessionId: "peer",
        request: { id: "still-readable", type: "server.version" },
      });
      await h.control("request.dispatch", {
        sessionId: "peer",
        request: { id: cancelId, type: "cancel" },
      });
      assertEquals(cancellable.signal.aborted, true);
      assertEquals(run.signal.aborted, false);
      buffer.push({
        kind: "progress",
        value: "peer completes while auth is quarantined",
      });
      buffer.finish({ kind: "done" });
      completion.resolve();
      registry.deregister(runId);
      registry.deregister(cancelId);
      await waitFor(
        () =>
          h.frames.some((frame) =>
            (frame.message as Frame)?.id === "observe" &&
            (frame.message as Frame)?.type === "done"
          ),
        "accepted observer received completion",
      );
      await waitFor(
        () => h.runtime.status.requests === 0,
        "accepted handlers settled",
      );
      assertEquals(
        (await h.control("engine.quiesce", { deadlineMs: 1000 })).result,
        { quiescent: true },
      );
      await h.task;
      assertEquals(h.disposed, 1);
      assertEquals(h.runtime.status.authenticationWork, 64);
      next = harness(context, {
        authenticationDeps: {
          readToken: base.readToken,
          readSecret: () => Promise.resolve(secret),
        },
      });
      await next.control("hello", { profile: "local-v1" });
      assertEquals(
        (await next.control("session.open", {
          sessionId: "recovered",
          credential,
          sourceIp: "127.0.0.1",
        })).result,
        { sessionId: "recovered" },
      );
      release.resolve();
      await waitFor(
        () => h.runtime.status.authenticationWork === 0,
        "late providers settled after retirement",
      );
      assertEquals(h.runtime.status.sessions, 0);
      await audit.flush();
      assertEquals(
        actions.filter((action) => action === "auth.token.used").length,
        2,
      );
    } finally {
      release.resolve();
      completion.resolve();
      registry.deregister(runId);
      registry.deregister(cancelId);
      await openings;
      if (h.runtime.status.state !== "stopped") {
        await h.control("engine.shutdown", { deadlineMs: 1000 });
      }
      await h.task;
      if (next) {
        await next.control("engine.shutdown", { deadlineMs: 1000 });
        await next.task;
      }
      await audit.close();
    }
  });
});

Deno.test("EngineRuntime: a large method replay and reconnect preserve peers, runs and session close codes", async () => {
  await withServeRepo(async (repo) => {
    const { credential } = await createCredential(repo);
    const model = await saveModel(repo, "replayed");
    const peerReadEntered = Promise.withResolvers<void>();
    const releasePeerRead = Promise.withResolvers<void>();
    const definitions = repo.repoContext.definitionRepo;
    const findByNameGlobal = definitions.findByNameGlobal;
    definitions.findByNameGlobal = async (idOrName) => {
      // The peer deliberately looks up the UUID while attach resolves the
      // recorded name. Keep the independent read pending through replay.
      if (idOrName === model.id) {
        peerReadEntered.resolve();
        await releasePeerRead.promise;
      }
      return await findByNameGlobal.call(definitions, idOrName);
    };
    const context = createServeCtx(repo, [grant({
      actions: ["read", "run"],
      resource: { kind: "model", pattern: model.name },
    })], { detached: true });
    const h = harness(context);
    const registry = context.activeRunRegistry!;
    const completion = Promise.withResolvers<void>();
    const buffer = new RunEventBuffer(1_000);
    for (let value = 0; value < 512; value++) {
      buffer.push({ kind: "progress", value });
    }
    const runId = crypto.randomUUID();
    const peerRunId = crypto.randomUUID();
    const run = new AbortController();
    const peerRun = new AbortController();
    for (
      const [id, controller, events] of [
        [runId, run, buffer],
        [peerRunId, peerRun, new RunEventBuffer(10)],
      ] as const
    ) {
      registry.register({
        runId: id,
        kind: "method-run",
        resourceName: model.name,
        resourceId: model.id,
        resourceType: repo.modelType.normalized,
        methodName: "noop",
        controller,
        buffer: events,
        startedAt: new Date(),
        completion: completion.promise,
        principalId: "user:caller",
      });
    }
    const open = async () => {
      const response = await h.control("session.open", {
        credential,
        sourceIp: "127.0.0.1",
      });
      assertExists(response.result, JSON.stringify(response));
      return (response.result as { sessionId: string }).sessionId;
    };
    const events = (id: string) =>
      h.frames.filter((frame) =>
        frame.sessionId === id && (frame.message as Frame)?.type === "event"
      );
    try {
      await h.control("hello", { profile: "local-v1" });
      const first = await open();
      const peer = await open();
      await h.control("request.dispatch", {
        sessionId: first,
        request: { id: "stream", type: "run.attach", payload: { runId } },
      });
      await h.control("request.dispatch", {
        sessionId: peer,
        request: {
          id: "peer",
          type: "model.get",
          payload: { modelIdOrName: model.id },
        },
      });
      await peerReadEntered.promise;
      await waitFor(
        () => events(first).length === 512,
        "large method replay delivered",
      );
      const peerAnswered = () =>
        h.frames.some((frame) =>
          frame.sessionId === peer &&
          (frame.message as Frame)?.id === "peer" &&
          (frame.message as Frame)?.type === "model.get"
        );
      assertEquals(peerAnswered(), false);
      releasePeerRead.resolve();
      // request.dispatch acknowledges admission, not the handler's completion.
      // Replaying one session cannot acknowledge another session's disk read.
      await waitFor(
        peerAnswered,
        "peer model read completed after its repository lookup",
      );
      assertEquals(h.runtime.status.state, "ready");
      assertEquals(run.signal.aborted, false);
      assertEquals(peerRun.signal.aborted, false);
      assertEquals(h.frames.some((frame) => frame.closed), false);

      await h.control("session.close", { sessionId: first });
      for (let value = 512; value < 768; value++) {
        buffer.push({ kind: "progress", value });
      }
      const reconnected = await open();
      await h.control("request.dispatch", {
        sessionId: reconnected,
        request: {
          id: "resume",
          type: "run.attach",
          payload: { runId, afterSeq: 512 },
        },
      });
      buffer.finish({ kind: "done" });
      await waitFor(
        () =>
          h.frames.some((frame) =>
            frame.sessionId === reconnected &&
            (frame.message as Frame)?.type === "done"
          ),
        "reconnected stream completed",
      );
      assertEquals(
        events(reconnected).map((frame) =>
          ((frame.message as Frame).event as Frame).seq
        ),
        Array.from({ length: 256 }, (_, index) => index + 513),
      );
      assertEquals(peerRun.signal.aborted, false);
      assertEquals(registry.size, 2);

      // A valid frame can exceed its session's available byte budget. That
      // subscriber closes while the other session and both accepted runs live.
      model.setGlobalArgument(
        "large",
        "x".repeat(8 * 1024 * 1024 - 100 * 1024),
      );
      await repo.repoContext.definitionRepo.save(repo.modelType, model);
      const oversized = await open();
      await h.control("request.dispatch", {
        sessionId: oversized,
        request: {
          id: "large",
          type: "model.get",
          payload: { modelIdOrName: model.name },
        },
      });
      await waitFor(
        () =>
          h.frames.some((frame) =>
            frame.sessionId === oversized &&
            (frame.closed as Frame)?.code === 1013
          ),
        "only the overflowing session closes",
      );
      await h.control("request.dispatch", {
        sessionId: peer,
        request: { id: "still-alive", type: "server.version" },
      });
      await waitFor(
        () =>
          h.frames.some((frame) =>
            frame.sessionId === peer &&
            (frame.message as Frame)?.id === "still-alive"
          ),
        "peer still receives replies after overflow",
      );
      assertEquals(h.runtime.status.state, "ready");
      assertEquals(run.signal.aborted, false);
      assertEquals(peerRun.signal.aborted, false);

      for (const code of [4002, 4003, 4004]) {
        const sessionId = await open();
        terminateTokenSessions("engine-token", {
          code,
          reason: `Session policy ${code}`,
          cause: "revoked",
          initiatedBy: "system",
        });
        await waitFor(
          () =>
            h.frames.some((frame) =>
              frame.sessionId === sessionId && frame.closed
            ),
          "policy close delivered",
        );
        const closed = h.frames.find((frame) =>
          frame.sessionId === sessionId && frame.closed
        )!.closed;
        assertEquals(closed, { code, reason: `Session policy ${code}` });
      }
      assertEquals(run.signal.aborted, false);
      assertEquals(peerRun.signal.aborted, false);
    } finally {
      releasePeerRead.resolve();
      definitions.findByNameGlobal = findByNameGlobal;
      completion.resolve();
      registry.deregister(runId);
      registry.deregister(peerRunId);
      await h.control("engine.shutdown", { deadlineMs: 1000 });
      await h.task;
    }
  });
});

Deno.test("EngineRuntime: a failed output pipe cancels blocked input and releases ownership", async () => {
  await withServeRepo(async (repo) => {
    let disposed = 0;
    let cancelled = 0;
    const output = new WritableStream<Uint8Array>({
      write: () => Promise.reject(undefined),
    });
    const runtime = new EngineRuntime({
      context: createServeCtx(repo),
      engineVersion: "test",
      gitSha: "test",
      dispose: () => {
        disposed++;
        return Promise.resolve();
      },
    }, output);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encodeEngineFrame({
            version: 1,
            generation: "one",
            id: "hello",
            method: "hello",
            params: { profile: "local-v1" },
          }),
        );
      },
      cancel() {
        cancelled++;
      },
    });
    await assertRejects(
      () => runtime.serve(input),
      Error,
      "Engine output unavailable",
    );
    assertEquals(disposed, 1);
    assertEquals(cancelled, 1);
    assertEquals(output.locked, false);
    assertEquals(input.locked, false);
  });
});

Deno.test("EngineRuntime: failed quiescence retains its cleanup failure and releases the writer", async () => {
  await withServeRepo(async (repo) => {
    let disposed = 0;
    const frames: Frame[] = [];
    const output = new WritableStream<Uint8Array>({
      write(bytes) {
        frames.push(
          JSON.parse(new TextDecoder().decode(bytes.subarray(4))) as Frame,
        );
      },
    });
    const runtime = new EngineRuntime({
      context: createServeCtx(repo),
      engineVersion: "test",
      gitSha: "test",
      dispose: () => {
        disposed++;
        return Promise.reject(new Error("cleanup failed"));
      },
    }, output);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encodeEngineFrame({
            version: 1,
            generation: "one",
            id: "hello",
            method: "hello",
            params: { profile: "local-v1" },
          }),
        );
        controller.enqueue(
          encodeEngineFrame({
            version: 1,
            generation: "one",
            id: "stop",
            method: "engine.quiesce",
          }),
        );
      },
    });
    await assertRejects(() => runtime.serve(input), Error, "cleanup failed");
    assertEquals(disposed, 1);
    assertEquals(output.locked, false);
    assertEquals(input.locked, false);
    const refusal = frames.find((frame) => frame.id === "stop");
    assertEquals((refusal?.error as Frame).code, "engine_error");
    assert(!JSON.stringify(frames).includes("cleanup failed"));
  });
});

Deno.test("EngineRuntime: quiescence times out within its supplied disposal budget without restarting shutdown", async () => {
  await withServeRepo(async (repo) => {
    const cleanup = Promise.withResolvers<void>();
    const deadlines: Array<{ delayMs: number; expire: () => void }> = [];
    const frames: Frame[] = [];
    let disposing = 0;
    const output = new WritableStream<Uint8Array>({
      write(bytes) {
        frames.push(JSON.parse(new TextDecoder().decode(bytes.subarray(4))));
      },
    });
    const runtime = new EngineRuntime({
      context: createServeCtx(repo),
      engineVersion: "test",
      gitSha: "test",
      dispose() {
        disposing++;
        return cleanup.promise;
      },
      scheduleDeadline(delayMs, expire) {
        deadlines.push({ delayMs, expire });
        return () => {};
      },
    }, output);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (
          const [id, method, params] of [
            ["hello", "hello", { profile: "local-v1" }],
            ["stop", "engine.quiesce", { deadlineMs: 75 }],
          ] as const
        ) {
          controller.enqueue(encodeEngineFrame({
            version: 1,
            generation: "one",
            id,
            method,
            params,
          }));
        }
      },
    });
    const outcome = runtime.serve(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waitFor(() => deadlines.length === 1, "quiescence deadline armed");
      assertEquals(deadlines[0].delayMs, 75);
      assertEquals(runtime.status.state, "quiescing");
      deadlines[0].expire();
      const failure = await outcome;
      assert(failure instanceof Error);
      assertEquals((failure as Error & { code: string }).code, "drain_timeout");
      assertEquals(runtime.status.state, "failed");
      assertEquals(deadlines.length, 1);
      assertEquals(disposing, 1);
      assertEquals(
        (frames.find((frame) => frame.id === "stop")!.error as Frame).code,
        "drain_timeout",
      );
      assertEquals(output.locked, false);
      assertEquals(input.locked, false);
    } finally {
      cleanup.resolve();
      await outcome;
    }
  });
});

Deno.test("EngineRuntime: a different generation cannot consume an old session channel", async () => {
  await withServeRepo(async (repo) => {
    let disposed = 0;
    const frames: Frame[] = [];
    const runtime = new EngineRuntime(
      {
        context: createServeCtx(repo),
        engineVersion: "test",
        gitSha: "test",
        dispose() {
          disposed++;
          return Promise.resolve();
        },
      },
      new WritableStream({
        write(bytes) {
          frames.push(
            JSON.parse(new TextDecoder().decode(bytes.subarray(4))) as Frame,
          );
        },
      }),
    );
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encodeEngineFrame({
            version: 1,
            generation: "old",
            id: "hello",
            method: "hello",
            params: { profile: "local-v1" },
          }),
        );
        controller.enqueue(
          encodeEngineFrame({
            version: 1,
            generation: "new",
            id: "wrong-generation",
            method: "engine.status",
          }),
        );
      },
    });
    await assertRejects(
      () => runtime.serve(input),
      Error,
      "Engine generation mismatch",
    );
    assertEquals(disposed, 1);
    assertEquals(
      frames.some((frame) => frame.id === "wrong-generation"),
      false,
    );
  });
});

Deno.test("EngineRuntime: parent EOF bounds cancellation without closing stores under active work", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, undefined, { detached: true });
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const controller = new AbortController();
    const runId = crypto.randomUUID();
    ctx.activeRunRegistry!.register({
      runId,
      kind: "method-run",
      resourceName: "stuck",
      buffer: new RunEventBuffer(10),
      controller,
      startedAt: new Date(),
      completion,
      principalId: null,
    });
    const deadlines: Array<
      { delayMs: number; expire: () => void; cancelled: boolean }
    > = [];
    let disposed = 0;
    const output = new WritableStream<Uint8Array>({ write() {} });
    const runtime = new EngineRuntime({
      context: ctx,
      engineVersion: "test",
      gitSha: "test",
      dispose() {
        disposed++;
        return Promise.resolve();
      },
      scheduleDeadline(delayMs, expire) {
        const deadline = { delayMs, expire, cancelled: false };
        deadlines.push(deadline);
        return () => {
          deadline.cancelled = true;
        };
      },
    }, output);
    const outcome = runtime.serve(
      new ReadableStream<Uint8Array>({
        start(input) {
          input.close();
        },
      }),
    ).then(() => undefined, (error: unknown) => error);
    try {
      await waitFor(
        () => deadlines.length === 1,
        "graceful drain deadline armed",
      );
      assertEquals(controller.signal.aborted, false);
      deadlines[0].expire();
      await waitFor(() => deadlines.length === 2, "cancellation grace armed");
      assertEquals(controller.signal.aborted, true);
      assertEquals(deadlines[0].delayMs + deadlines[1].delayMs, 25_000);
      assertEquals(deadlines[1].delayMs, 5_000);
      deadlines[1].expire();
      const failure = await outcome;
      assert(failure instanceof Error);
      assertEquals((failure as Error & { code: string }).code, "drain_timeout");
      assertEquals(disposed, 0);
      assertEquals(output.locked, false);
      assertEquals(runtime.status.state, "failed");
      assertEquals(deadlines.every((deadline) => deadline.cancelled), true);
    } finally {
      complete();
      ctx.activeRunRegistry!.deregister(runId);
    }
  });
});

Deno.test("EngineRuntime: shutdown reserves persistence time after natural drain and cancellation", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, undefined, { detached: true });
    const completion = Promise.withResolvers<void>();
    const disposed = Promise.withResolvers<void>();
    const controller = new AbortController();
    const runId = crypto.randomUUID();
    ctx.activeRunRegistry!.register({
      runId,
      kind: "method-run",
      resourceName: "cooperative",
      buffer: new RunEventBuffer(10),
      controller,
      startedAt: new Date(),
      completion: completion.promise,
      principalId: null,
    });
    const deadlines: Array<{ delayMs: number; expire: () => void }> = [];
    let now = 0;
    let disposing = false;
    const runtime = new EngineRuntime({
      context: ctx,
      engineVersion: "test",
      gitSha: "test",
      now: () => now,
      dispose() {
        disposing = true;
        return disposed.promise;
      },
      scheduleDeadline(delayMs, expire) {
        deadlines.push({ delayMs, expire });
        return () => {};
      },
    }, new WritableStream({ write() {} }));
    const outcome = runtime.serve(
      new ReadableStream({
        start(input) {
          input.close();
        },
      }),
    );
    try {
      await waitFor(() => deadlines.length === 1, "natural drain armed");
      assertEquals(deadlines[0].delayMs, 20_000);
      now = 20_000;
      deadlines[0].expire();
      await waitFor(() => deadlines.length === 2, "cancellation grace armed");
      assertEquals(controller.signal.aborted, true);
      assertEquals(deadlines[1].delayMs, 5_000);
      assertEquals(disposing, false);
      now = 24_000;
      completion.resolve();
      await waitFor(
        () => disposing && deadlines.length === 3,
        "disposal armed",
      );
      assertEquals(deadlines[2].delayMs, 6_000);
      assertEquals(runtime.status.state, "draining");
      disposed.resolve();
      await outcome;
      assertEquals(runtime.status.state, "stopped");
    } finally {
      completion.resolve();
      disposed.resolve();
      ctx.activeRunRegistry!.deregister(runId);
      await outcome;
    }
  });
});

Deno.test("EngineRuntime: shutdown preserves a supplied budget above five minutes", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, undefined, { detached: true });
    const completion = Promise.withResolvers<void>();
    const controller = new AbortController();
    const runId = crypto.randomUUID();
    ctx.activeRunRegistry!.register({
      runId,
      kind: "method-run",
      resourceName: "long-running",
      buffer: new RunEventBuffer(10),
      controller,
      startedAt: new Date(),
      completion: completion.promise,
      principalId: null,
    });
    const deadlines: Array<{ delayMs: number; expire: () => void }> = [];
    let now = 0;
    const h = harness(ctx, {
      now: () => now,
      scheduleDeadline(delayMs, expire) {
        deadlines.push({ delayMs, expire });
        return () => {};
      },
    });
    await h.control("hello", { profile: "local-v1" });
    const shutdown = h.control("engine.shutdown", { deadlineMs: 600_000 });
    try {
      await waitFor(() => deadlines.length === 1, "natural drain armed");
      assertEquals(deadlines[0].delayMs, 590_000);
      assertEquals(controller.signal.aborted, false);
      now = 590_000;
      deadlines[0].expire();
      await waitFor(() => deadlines.length === 2, "cancellation grace armed");
      assertEquals(controller.signal.aborted, true);
      assertEquals(deadlines[1].delayMs, 5_000);
      completion.resolve();
      const stopped = await shutdown;
      assertEquals(stopped.error, undefined);
      await h.task;
      assertEquals(h.runtime.status.state, "stopped");
      assertEquals(h.disposed, 1);
    } finally {
      completion.resolve();
      ctx.activeRunRegistry!.deregister(runId);
      await shutdown;
      await h.task;
    }
  });
});

function pageHarness(
  ctx: ConnectionContext,
  options: Partial<Omit<EngineRuntimeOptions, "context" | "dispose">> = {},
) {
  return harness(ctx, { ...localPageServices(ctx), ...options });
}

async function openPage(
  h: ReturnType<typeof harness>,
  params: Frame = {},
): Promise<string> {
  const response = await h.control("session.open", {
    sessionId: crypto.randomUUID().replaceAll("-", ""),
    class: "page",
    sourceIp: "127.0.0.1",
    ...params,
  });
  assertExists(response.result, JSON.stringify(response));
  return (response.result as { sessionId: string }).sessionId;
}

function sessionMessages(h: ReturnType<typeof harness>, sessionId: string) {
  return h.frames.filter((f) => f.sessionId === sessionId && f.message)
    .map((f) => f.message as Frame);
}

function fakeActions(
  overrides: Partial<ActionRunner> = {},
): ActionRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run(_repoDir, args) {
      calls.push([...args]);
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ approved: true }),
        stderr: "",
      });
    },
    start(_repoDir, args) {
      calls.push([...args]);
      return { pid: 4242, exited: new Promise<number>(() => {}) };
    },
    watchRuns() {
      return { isRunning: () => true, close() {} };
    },
    ...overrides,
  };
}

Deno.test("EngineRuntime: a page session needs no credential and reads as the anonymous local caller", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "visible");
    // Token mode with no grants: a cli caller could read nothing.
    const ctx = createServeCtx(repo, [], { detached: true });
    const h = pageHarness(ctx);
    const hello = await h.control("hello", { profile: "local-v1" });
    assertEquals((hello.result as Frame).callerClasses, ["cli", "page"]);
    assertEquals((hello.result as Frame).mode, "full");
    assertEquals((hello.result as Frame).extensions, true);
    const id = await openPage(h);
    assertEquals(listTokenSessions(), []);
    await h.control("request.dispatch", {
      sessionId: id,
      request: {
        id: "read",
        type: "model.get",
        payload: { modelIdOrName: model.name },
      },
    });
    await waitFor(
      () => sessionMessages(h, id).some((m) => m.id === "read"),
      "page read answered",
    );
    assertEquals(
      sessionMessages(h, id).find((m) => m.id === "read")?.type,
      "model.get",
    );
    assertEquals((await h.control("engine.quiesce")).result, {
      quiescent: false,
    });
    await h.control("session.close", { sessionId: id });
    assertEquals((await h.control("engine.quiesce")).result, {
      quiescent: true,
    });
    await h.task;
  });
});

Deno.test("EngineRuntime: a page may not send what the dashboard never sends", async () => {
  await withServeRepo(async (repo) => {
    const h = pageHarness(createServeCtx(repo, [], { detached: true }));
    try {
      await h.control("hello", { profile: "local-v1" });
      const id = await openPage(h);
      for (const type of ["workflow.run", "model.method.run", "vault.get"]) {
        await h.control("request.dispatch", {
          sessionId: id,
          request: { id: type, type, payload: {} },
        });
      }
      await waitFor(
        () => sessionMessages(h, id).length === 3,
        "every refusal answered",
      );
      assertEquals(
        sessionMessages(h, id).find((m) => m.id === "workflow.run"),
        {
          type: "error",
          id: "workflow.run",
          error: {
            code: "not_available_locally",
            message:
              "workflow.run is not available on the local dashboard. Run it with the swamp CLI, or through swamp serve.",
          },
        },
      );
    } finally {
      await h.control("engine.shutdown");
      await h.task;
    }
  });
});

Deno.test("EngineRuntime: a page cancel reaches the engine only for a read it sent", async () => {
  await withServeRepo(async (repo) => {
    const h = pageHarness(createServeCtx(repo, [], { detached: true }));
    try {
      await h.control("hello", { profile: "local-v1" });
      const id = await openPage(h);
      await h.control("request.dispatch", {
        sessionId: id,
        request: { id: "never-sent", type: "cancel" },
      });
      assertEquals(h.runtime.status.requests, 0);
      await h.control("request.dispatch", {
        sessionId: id,
        request: { id: "sub", type: "audit.subscribe", payload: {} },
      });
      await h.control("request.dispatch", {
        sessionId: id,
        request: { id: "sub", type: "cancel" },
      });
      await waitFor(
        () => sessionMessages(h, id).some((m) => m.id === "sub"),
        "subscription answered",
      );
      assert(!sessionMessages(h, id).some((m) => m.id === "never-sent"));
    } finally {
      await h.control("engine.shutdown");
      await h.task;
    }
  });
});

Deno.test("EngineRuntime: a page approve runs the CLI and replies with its JSON", async () => {
  await withServeRepo(async (repo) => {
    const actions = fakeActions();
    const ctx = createServeCtx(repo, [], { detached: true });
    const h = harness(ctx, {
      ...localPageServices(ctx),
      page: { ...localPageServices(ctx).page, actions },
    });
    try {
      await h.control("hello", { profile: "local-v1" });
      const id = await openPage(h);
      await h.control("request.dispatch", {
        sessionId: id,
        request: {
          id: "a1",
          type: "workflow.approve",
          payload: {
            workflowIdOrName: "deploy",
            runId: "0123abcd-0000",
            stepName: "gate",
            reason: "looks good",
          },
        },
      });
      await h.control("request.dispatch", {
        sessionId: id,
        request: {
          id: "a2",
          type: "workflow.reject",
          payload: {
            workflowIdOrName: "--all",
            runId: "0123abcd-0000",
            stepName: "gate",
          },
        },
      });
      await waitFor(
        () => sessionMessages(h, id).length === 2,
        "both actions answered",
      );
      assertEquals(sessionMessages(h, id).find((m) => m.id === "a1"), {
        type: "workflow.approve",
        id: "a1",
        payload: { data: { approved: true } },
      });
      assertEquals(sessionMessages(h, id).find((m) => m.id === "a2"), {
        type: "error",
        id: "a2",
        error: {
          code: "workflow_reject_failed",
          message: `The workflow "--all" can't start with "-".`,
        },
      });
      assertEquals(actions.calls, [[
        "workflow",
        "approve",
        "deploy",
        "gate",
        "--run=0123abcd-0000",
        "--reason=looks good",
        "--json",
      ]]);
    } finally {
      await h.control("engine.shutdown");
      await h.task;
    }
  });
});

Deno.test("EngineRuntime: a page resume says started once its run runs, then done, and its detach stays in the engine", async () => {
  await withServeRepo(async (repo) => {
    let exit!: (code: number) => void;
    let polls = 0;
    const actions = fakeActions({
      start: () => ({
        pid: 7,
        exited: new Promise<number>((resolve) => exit = resolve),
      }),
      watchRuns: () => ({ isRunning: () => ++polls > 1, close() {} }),
    });
    const ctx = createServeCtx(repo, [], { detached: true });
    const h = harness(ctx, {
      ...localPageServices(ctx),
      page: { ...localPageServices(ctx).page, actions },
    });
    try {
      await h.control("hello", { profile: "local-v1" });
      const id = await openPage(h);
      await h.control("request.dispatch", {
        sessionId: id,
        request: {
          id: "r1",
          type: "workflow.resume",
          payload: { workflowIdOrName: "deploy", runId: "0123abcd-0000" },
        },
      });
      await waitFor(
        () => sessionMessages(h, id).some((m) => m.type === "event"),
        "resume started",
      );
      assertEquals(sessionMessages(h, id), [{
        type: "event",
        id: "r1",
        payload: { runId: "0123abcd-0000" },
      }]);
      assertEquals(h.runtime.status.requests, 0);
      await h.control("request.dispatch", {
        sessionId: id,
        request: { id: "r1", type: "cancel" },
      });
      exit(0);
      await waitFor(
        () => sessionMessages(h, id).some((m) => m.type === "done"),
        "resume done",
      );
      assertEquals(sessionMessages(h, id).at(-1), { type: "done", id: "r1" });
    } finally {
      await h.control("engine.shutdown");
      await h.task;
    }
  });
});

Deno.test("EngineRuntime: a page resume that stops before its run starts names the command", async () => {
  await withServeRepo(async (repo) => {
    const actions = fakeActions({
      start: () => ({ pid: 7, exited: Promise.resolve(3) }),
      watchRuns: () => ({ isRunning: () => false, close() {} }),
    });
    const ctx = createServeCtx(repo, [], { detached: true });
    const h = harness(ctx, {
      ...localPageServices(ctx),
      page: { ...localPageServices(ctx).page, actions },
    });
    try {
      await h.control("hello", { profile: "local-v1" });
      const id = await openPage(h);
      await h.control("request.dispatch", {
        sessionId: id,
        request: {
          id: "r1",
          type: "workflow.resume",
          payload: { workflowIdOrName: "deploy", runId: "0123abcd-0000" },
        },
      });
      await waitFor(
        () => sessionMessages(h, id).length === 1,
        "resume failed",
      );
      assertEquals(sessionMessages(h, id)[0], {
        type: "error",
        id: "r1",
        error: {
          code: "workflow_resume_failed",
          message:
            "The resume stopped before its run started (exit 3). Run `swamp workflow resume deploy --run=0123abcd-0000` in this repo to see why.",
        },
      });
    } finally {
      await h.control("engine.shutdown");
      await h.task;
    }
  });
});

Deno.test("EngineRuntime: shutdown stops a page action still running", async () => {
  await withServeRepo(async (repo) => {
    let aborted = false;
    const actions = fakeActions({
      run: (_repoDir, _args, signal) =>
        new Promise((resolve) =>
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve({ code: 1, stdout: "", stderr: "killed" });
          })
        ),
    });
    const ctx = createServeCtx(repo, [], { detached: true });
    const h = harness(ctx, {
      ...localPageServices(ctx),
      page: { ...localPageServices(ctx).page, actions },
    });
    await h.control("hello", { profile: "local-v1" });
    const id = await openPage(h);
    await h.control("request.dispatch", {
      sessionId: id,
      request: {
        id: "c1",
        type: "workflow.cancel",
        payload: { workflowIdOrName: "deploy", runId: "0123abcd-0000" },
      },
    });
    assertEquals(h.runtime.status.requests, 1);
    await h.control("engine.shutdown");
    await h.task;
    assert(aborted);
  });
});

Deno.test("EngineRuntime: a one-shot page session answers one HTTP read and closes", async () => {
  await withServeRepo(async (repo) => {
    const h = pageHarness(createServeCtx(repo, [], { detached: true }));
    try {
      await h.control("hello", { profile: "local-v1" });
      const refusals: Array<[string, Frame, string]> = [
        ["model.get", { modelIdOrName: "x" }, "use_websocket"],
        ["workflow.run", {}, "use_websocket"],
        ["data.query", "not-an-object" as unknown as Frame, "invalid_request"],
      ];
      for (const [type, payload, code] of refusals) {
        const id = await openPage(h, { oneShot: true });
        const refused = await h.control("request.dispatch", {
          sessionId: id,
          http: true,
          request: { id: "q", type, payload },
        });
        assertEquals((refused.error as Frame)?.code, code, type);
        await h.control("session.close", { sessionId: id });
      }
      const id = await openPage(h, { oneShot: true });
      await h.control("request.dispatch", {
        sessionId: id,
        http: true,
        request: { id: "q", type: "data.query", payload: { predicate: "" } },
      });
      await waitFor(
        () => h.frames.some((f) => f.sessionId === id && f.closed),
        "one-shot session closed",
      );
      assertEquals(
        (h.frames.find((f) => f.sessionId === id && f.closed)!.closed as Frame)
          .code,
        1000,
      );
      assert(sessionMessages(h, id).some((m) => m.id === "q"));
      const second = await h.control("request.dispatch", {
        sessionId: id,
        http: true,
        request: { id: "q2", type: "data.query", payload: {} },
      });
      assertEquals((second.error as Frame).code, "unknown_session");
    } finally {
      await h.control("engine.shutdown");
      await h.task;
    }
  });
});

Deno.test("EngineRuntime: a read-only engine refuses cli sessions and a cli-only engine refuses pages", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [], { detached: true });
    const page = localPageServices(ctx);
    const readOnly = harness(page.page.context, { ...page, mode: "read-only" });
    const hello = await readOnly.control("hello", { profile: "local-v1" });
    assertEquals((hello.result as Frame).callerClasses, ["page"]);
    assertEquals((hello.result as Frame).mode, "read-only");
    const cli = await readOnly.control("session.open", {
      credential: "SECRET_CANARY",
      sourceIp: "127.0.0.1",
    });
    assertEquals((cli.error as Frame).code, "unsupported_profile");
    await readOnly.control("engine.shutdown");
    await readOnly.task;

    const cliOnly = harness(ctx);
    await cliOnly.control("hello", { profile: "local-v1" });
    const refused = await cliOnly.control("session.open", {
      class: "page",
      sourceIp: "127.0.0.1",
    });
    assertEquals((refused.error as Frame).code, "unsupported_profile");
    await cliOnly.control("engine.shutdown");
    await cliOnly.task;
  });
});

Deno.test("EngineRuntime: health.snapshot answers from the composed collector", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [], { detached: true });
    const h = harness(ctx, {
      ...localPageServices(ctx),
      health: () => Promise.resolve({ status: "ok", activeRuns: [] }),
    });
    await h.control("hello", { profile: "local-v1" });
    const snapshot = await h.control("health.snapshot");
    assertEquals(snapshot.result, { status: "ok", activeRuns: [] });
    await h.control("engine.shutdown");
    await h.task;
    const bare = harness(ctx);
    await bare.control("hello", { profile: "local-v1" });
    assertEquals(
      ((await bare.control("health.snapshot")).error as Frame).code,
      "unsupported_operation",
    );
    await bare.control("engine.shutdown");
    await bare.task;
  });
});
