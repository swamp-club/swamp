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
 * Remote execution integration tests (design/remote-execution.md).
 *
 * Runs a real orchestrator assembly (worker gateway + capability service +
 * dispatch service + HTTP data plane on one localhost listener) and a real
 * worker (`runWorker` over an actual WebSocket): token mint and redemption
 * through the built-in models against a real datastore and vault, dispatch
 * of a method that exercises the capability verbs, environment shipping,
 * lease lifecycle, scheduling, and cancel propagation.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";

import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  createVaultCreateDeps,
  createWorkerModelRunDeps,
  modelMethodRun,
  repoInit,
  vaultCreate,
  withDefaults,
} from "../src/libswamp/mod.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { defineModel, modelRegistry } from "../src/domain/models/model.ts";
import type { MethodContext } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { DispatchService } from "../src/serve/dispatch_service.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import { runWorker } from "../src/worker/connect.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  tokenSecretKey,
} from "../src/domain/models/worker/enrollment_token_model.ts";
import { sweepStaleRecords } from "../src/serve/boot_reconciliation.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const IT_TYPE = ModelType.create("swamp/remote-it");
const IT_DEFINITION_ID = "7d4f2a1e-1111-4222-8333-444455556666";

defineModel({
  type: IT_TYPE,
  version: "2026.06.09.1",
  resources: {
    "result": {
      description: "integration result",
      schema: z.object({
        echo: z.string(),
        sawEnv: z.string().optional(),
        priorWasNull: z.boolean().optional(),
        vaultRoundTrip: z.string().optional(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    "log": {
      description: "integration log",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    run: {
      description: "exercise the capability verbs",
      kind: "action",
      arguments: z.object({
        echo: z.string(),
        mode: z.enum(["normal", "hang"]).default("normal"),
      }),
      execute: async (args, context: MethodContext) => {
        const input = args as { echo: string; mode: "normal" | "hang" };
        if (input.mode === "hang") {
          await new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new DOMException("hung step aborted", "AbortError")),
            );
          });
        }

        // Live-log contract: each line durable per request.
        const writer = context.createFileWriter!("log", "log-main");
        await writer.writeLine("line one");
        await writer.writeLine("line two");
        const logHandle = await writer.finalize();

        // Reads ride getData; the first run sees no prior version.
        const prior = await context.readResource!("result-main");

        // Vault writes and reads proxy home.
        await context.vaultService!.put("local", "from-method", "round-trip");
        const vaultRoundTrip = await context.vaultService!.get(
          "local",
          "from-method",
        );

        const resultHandle = await context.writeResource!(
          "result",
          "result-main",
          {
            echo: input.echo,
            sawEnv: Deno.env.get("REMOTE_IT_ENV"),
            priorWasNull: prior === null,
            vaultRoundTrip,
          },
        );
        return { dataHandles: [resultHandle, logHandle] };
      },
    },
  },
});

interface Orchestrator {
  repoDir: string;
  repoContext: ReturnType<typeof createRepositoryContext>;
  gateway: WorkerGateway;
  dispatchService: DispatchService;
  serverUrl: string;
  shutdown: () => Promise<void>;
  mintToken: (name: string) => Promise<string>;
  runModelMethod: (input: {
    typeArg: string;
    definitionName: string;
    methodName: string;
    inputs: Record<string, unknown>;
  }) => Promise<void>;
}

async function startOrchestrator(
  repoDir: string,
  opts?: { skipInit?: boolean },
): Promise<Orchestrator> {
  if (!opts?.skipInit) {
    const libCtx = createLibSwampContext({});
    await consumeStream(
      repoInit(libCtx, createRepoInitDeps("20260101.120000.0"), {
        path: repoDir,
        force: false,
        version: "20260101.120000.0",
      }),
      withDefaults({
        error: (event) => {
          throw new Error(String(event.error?.message ?? "repo init failed"));
        },
      }),
    );
    await consumeStream(
      vaultCreate(libCtx, await createVaultCreateDeps(repoDir), {
        vaultType: "local_encryption",
        name: "local",
        config: { auto_generate: true, base_dir: repoDir },
        repoDir,
      }),
      withDefaults({
        error: (event) => {
          throw new Error(
            String(event.error?.message ?? "vault create failed"),
          );
        },
      }),
    );
  }

  const repoContext = createRepositoryContext({ repoDir });

  const runModelMethod = async (input: {
    typeArg: string;
    definitionName: string;
    methodName: string;
    inputs: Record<string, unknown>;
  }) => {
    const deps = await createWorkerModelRunDeps(repoDir, repoContext);
    for await (
      const event of modelMethodRun(createLibSwampContext({}), deps, {
        modelIdOrName: input.definitionName,
        methodName: input.methodName,
        inputs: input.inputs,
        lastEvaluated: false,
        typeArg: input.typeArg,
        definitionName: input.definitionName,
      })
    ) {
      if (event.kind === "error") {
        const detail = event.error as { message?: unknown };
        throw new Error(String(detail?.message ?? "model method failed"));
      }
    }
  };

  const capabilityService = new CapabilityService({ repoDir, repoContext });
  const dispatches = new DispatchRegistry();
  const bundles = new BundleRegistry();
  const dispatchService = new DispatchService({
    repoDir,
    repoContext,
    dispatches,
    bundles,
    queueTimeoutMs: 15_000,
    captureEnvironment: () => ({ REMOTE_IT_ENV: "shipped-value" }),
  });
  const gateway = new WorkerGateway({
    repoDir,
    repoContext,
    capabilityService,
    graceWindowMs: 1_000,
    onWorkerIdle: (worker) => dispatchService.notifyWorkerIdle(worker),
    onGraceExpired: (worker) => dispatchService.notifyGraceExpired(worker),
    onWorkerEnrolled: (worker) => dispatchService.notifyWorkerEnrolled(worker),
  });
  dispatchService.bindGateway(gateway);
  const dataPlane = new DataPlane({
    repoDir,
    repoContext,
    sessions: gateway.sessions,
    dispatches,
    bundles,
    onFirstWrite: (dispatch) => dispatchService.recordFirstWrite(dispatch),
  });
  dispatchService.setOnDispatchEnd((id) => dataPlane.releaseDispatch(id));

  await sweepStaleRecords({ repoDir, repoContext });

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const upgrade = req.headers.get("upgrade") ?? "";
      if (upgrade.toLowerCase() === "websocket") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        const attachment = gateway.attachTransport({
          send: (data) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(data);
            }
          },
        });
        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            attachment.feed(event.data);
          }
        };
        socket.onclose = () => attachment.closed();
        return response;
      }
      const dataPlaneResponse = await dataPlane.handle(req);
      if (dataPlaneResponse) {
        return dataPlaneResponse;
      }
      return new Response("Not found", { status: 404 });
    },
  );
  const port = server.addr.port;

  const mintToken = async (name: string): Promise<string> => {
    await runModelMethod({
      typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
      definitionName: name,
      methodName: "mint",
      inputs: { durationMs: 10 * 60 * 1000, vaultName: "local" },
    });
    const vault = await VaultService.fromRepository(repoDir);
    const plaintext = await vault.get("local", tokenSecretKey(name));
    return `${name}.${plaintext}`;
  };

  return {
    repoDir,
    repoContext,
    gateway,
    dispatchService,
    serverUrl: `ws://127.0.0.1:${port}`,
    shutdown: async () => {
      await server.shutdown();
    },
    mintToken,
    runModelMethod,
  };
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-remote-it-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function remoteStepRequest(overrides?: {
  placement?: {
    target?: string;
    labels?: Record<string, string>;
    queueTimeoutMs?: number;
  };
  methodArgs?: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  return {
    placement: overrides?.placement ?? { labels: { tier: "it" } },
    modelDef: modelRegistry.get(IT_TYPE)!,
    modelType: IT_TYPE,
    modelId: IT_DEFINITION_ID,
    methodName: "run",
    definitionName: "remote-it-def",
    definitionTags: {},
    definitionMeta: {
      id: IT_DEFINITION_ID,
      name: "remote-it-def",
      version: 1,
      tags: {},
    },
    globalArgs: {},
    methodArgs: overrides?.methodArgs ?? { echo: "over the wire" },
    workflowName: "it-workflow",
    stepName: "it-step",
    signal: overrides?.signal,
  };
}

Deno.test({
  name:
    "remote execution: enroll over a real socket, dispatch, verbs, leases, scheduling, cancel",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const orchestrator = await startOrchestrator(dir);
      const workerStop = new AbortController();
      let workerDone: Promise<void> | null = null;
      try {
        const token = await orchestrator.mintToken("it-worker");

        workerDone = runWorker({
          url: orchestrator.serverUrl,
          token,
          labels: { tier: "it" },
          swampVersion: "test",
          cacheDir: join(dir, "worker-cache"),
          signal: workerStop.signal,
        });
        await waitFor(
          () => orchestrator.gateway.workers().length === 1,
          "worker enrollment",
        );
        const snapshot = orchestrator.gateway.worker("it-worker");
        assertEquals(snapshot?.status, "idle");
        assertEquals(snapshot?.labels, { tier: "it" });

        // ── Full dispatch exercising the capability verbs ────────────────
        const result = await orchestrator.dispatchService.executeRemote(
          remoteStepRequest(),
        );
        assertEquals(
          result.outputs.map((o) => o.specName).sort(),
          ["log", "result"],
        );

        // The written resource is durable in the orchestrator's datastore,
        // with the shipped environment visible during execution only.
        const content = await orchestrator.repoContext.unifiedDataRepo
          .getContent(IT_TYPE, IT_DEFINITION_ID, "result-main");
        const attributes = JSON.parse(new TextDecoder().decode(content!));
        assertEquals(attributes.echo, "over the wire");
        assertEquals(attributes.sawEnv, "shipped-value");
        assertEquals(attributes.priorWasNull, true);
        assertEquals(attributes.vaultRoundTrip, "round-trip");
        assertEquals(Deno.env.get("REMOTE_IT_ENV"), undefined);

        // The live-log file accumulated both durable lines.
        const log = await orchestrator.repoContext.unifiedDataRepo.getContent(
          IT_TYPE,
          IT_DEFINITION_ID,
          "log-main",
        );
        assertEquals(
          new TextDecoder().decode(log!),
          "line one\nline two\n",
        );

        // The vault write the method performed landed in the real vault.
        const vault = await VaultService.fromRepository(dir);
        assertEquals(await vault.get("local", "from-method"), "round-trip");

        // The lease lifecycle is queryable swamp data: completed, hasWrites.
        const leases = await orchestrator.repoContext.dataQueryService.query(
          'modelType == "swamp/step-lease" && specName == "lease"',
          { loadAttributes: true },
        ) as Array<{ attributes?: Record<string, unknown> }>;
        assertEquals(leases.length, 1);
        assertEquals(leases[0].attributes?.state, "completed");
        assertEquals(leases[0].attributes?.hasWrites, true);
        assertEquals(leases[0].attributes?.workerName, "it-worker");

        // A second run sees the first run's data (read-your-own-writes).
        const second = await orchestrator.dispatchService.executeRemote(
          remoteStepRequest({ methodArgs: { echo: "again" } }),
        );
        assertEquals(second.outputs.length, 2);
        const after = JSON.parse(
          new TextDecoder().decode(
            (await orchestrator.repoContext.unifiedDataRepo.getContent(
              IT_TYPE,
              IT_DEFINITION_ID,
              "result-main",
            ))!,
          ),
        );
        assertEquals(after.priorWasNull, false);

        // ── Scheduling: no-match placement queues then times out ────────
        const queueTimeout = await assertRejects(
          () =>
            orchestrator.dispatchService.executeRemote(
              remoteStepRequest({
                placement: { target: "ghost", queueTimeoutMs: 1_500 },
              }),
            ),
          Error,
        );
        assertStringIncludes(queueTimeout.message, "target 'ghost'");

        const targeted = await orchestrator.dispatchService.executeRemote(
          remoteStepRequest({
            placement: { target: "it-worker" },
            methodArgs: { echo: "targeted" },
          }),
        );
        assertEquals(targeted.outputs.length, 2);

        // ── Cancel propagation ───────────────────────────────────────────
        const cancel = new AbortController();
        const hung = orchestrator.dispatchService.executeRemote(
          remoteStepRequest({
            methodArgs: { echo: "never", mode: "hang" },
            signal: cancel.signal,
          }),
        );
        await waitFor(
          () => orchestrator.gateway.worker("it-worker")?.status === "busy",
          "hung dispatch to start",
        );
        // Busy flips before the dispatch frame is sent (the durable status
        // write sits between); give the frame time to reach the worker so
        // the abort exercises the cooperative cancel path, not the
        // pre-send fast path.
        await new Promise((r) => setTimeout(r, 300));
        cancel.abort();
        await assertRejects(() => hung, Error);
        await waitFor(
          () => orchestrator.gateway.worker("it-worker")?.status === "idle",
          "worker to return to idle after cancel",
        );

        // The worker is still usable after a cancelled dispatch.
        const postCancel = await orchestrator.dispatchService.executeRemote(
          remoteStepRequest({ methodArgs: { echo: "post-cancel" } }),
        );
        assertEquals(postCancel.outputs.length, 2);

        // ── Data plane authentication ────────────────────────────────────
        const unauthenticated = await fetch(
          orchestrator.serverUrl.replace("ws://", "http://") +
            "/data/resource",
          { method: "POST", body: "{}" },
        );
        assertEquals(unauthenticated.status, 401);
        await unauthenticated.body?.cancel();
      } finally {
        workerStop.abort();
        if (workerDone) {
          await workerDone.catch(() => {});
        }
        await orchestrator.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "remote execution: elastic queueing — empty pool queues, worker enrolls, step dispatches",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const orchestrator = await startOrchestrator(dir);
      const workerStop = new AbortController();
      let workerDone: Promise<void> | null = null;
      try {
        const token = await orchestrator.mintToken("queue-worker");

        const pending = orchestrator.dispatchService.executeRemote(
          remoteStepRequest({
            placement: { labels: { tier: "it" }, queueTimeoutMs: 10_000 },
          }),
        );

        await new Promise((r) => setTimeout(r, 200));

        assertEquals(orchestrator.gateway.workers().length, 0);

        workerDone = runWorker({
          url: orchestrator.serverUrl,
          token,
          labels: { tier: "it" },
          swampVersion: "test",
          cacheDir: join(dir, "worker-cache"),
          signal: workerStop.signal,
        });

        const result = await pending;
        assertEquals(result.outputs.length, 2);

        await waitFor(
          () => orchestrator.gateway.worker("queue-worker")?.status === "idle",
          "worker to return to idle",
        );
      } finally {
        workerStop.abort();
        if (workerDone) await workerDone.catch(() => {});
        await orchestrator.shutdown();
      }
    });
  },
});

Deno.test({
  name: "remote execution: boot reconciliation marks stale records",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      let orchestrator = await startOrchestrator(dir);
      const workerStop = new AbortController();
      let workerDone: Promise<void> | null = null;
      try {
        const token = await orchestrator.mintToken("recon-worker");

        workerDone = runWorker({
          url: orchestrator.serverUrl,
          token,
          labels: { tier: "it" },
          swampVersion: "test",
          cacheDir: join(dir, "worker-cache"),
          signal: workerStop.signal,
        });

        await waitFor(
          () => orchestrator.gateway.workers().length === 1,
          "worker enrollment",
        );

        const result = await orchestrator.dispatchService.executeRemote(
          remoteStepRequest(),
        );
        assertEquals(result.outputs.length, 2);
      } finally {
        workerStop.abort();
        if (workerDone) await workerDone.catch(() => {});
        await orchestrator.shutdown();
      }

      // After first shutdown, the worker record should still show as
      // non-disconnected (shutdown doesn't clean up worker model state).
      // Second boot runs reconciliation and sweeps stale records.
      orchestrator = await startOrchestrator(dir, { skipInit: true });
      try {
        const leases = await orchestrator.repoContext.dataQueryService.query(
          'modelType == "swamp/step-lease" && attributes.state == "active"',
          { loadAttributes: true },
        ) as Array<{ attributes?: Record<string, unknown> }>;
        assertEquals(leases.length, 0);

        const pending = await orchestrator.repoContext.dataQueryService.query(
          'modelType == "swamp/pending-dispatch" && attributes.state == "waiting"',
          { loadAttributes: true },
        ) as Array<{ attributes?: Record<string, unknown> }>;
        assertEquals(pending.length, 0);

        const workers = await orchestrator.repoContext.dataQueryService.query(
          'modelType == "swamp/worker" && name == "state-main" && attributes.status != "disconnected"',
          { loadAttributes: true },
        ) as Array<{ attributes?: Record<string, unknown> }>;
        assertEquals(workers.length, 0);
      } finally {
        await orchestrator.shutdown();
      }
    });
  },
});

Deno.test({
  name: "remote execution: a wrong token is rejected and the worker stops",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const orchestrator = await startOrchestrator(dir);
      try {
        await orchestrator.mintToken("real-worker");
        const error = await assertRejects(
          () =>
            runWorker({
              url: orchestrator.serverUrl,
              token: "real-worker.wrong-secret",
              swampVersion: "test",
              cacheDir: join(dir, "worker-cache"),
            }),
          Error,
        );
        assertStringIncludes(error.message, "does not match");
        assertEquals(orchestrator.gateway.workers().length, 0);
      } finally {
        await orchestrator.shutdown();
      }
    });
  },
});
