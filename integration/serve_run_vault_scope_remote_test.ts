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
 * Remote placement under a run's vault scope (swamp-club#2676), with a real
 * orchestrator assembly (worker gateway, capability service, dispatch
 * service, data plane on one localhost listener) and a real worker over a
 * WebSocket, as in `remote_execution_test.ts`:
 *
 * - a remote step's `context.vaultService` writes and reads (putSecret /
 *   resolveSecret) are held to the dispatching run's principal, and a grant
 *   added mid-flight applies to the next dispatch;
 * - the control-plane work around it — enrollment redeem (which reads the
 *   token secret from a vault), step-lease transitions and worker prune —
 *   succeeds while a restrictive scope is ambient.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { GrantBasedAccessDecisionService } from "../src/domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import { createConditionEvaluator } from "../src/domain/access/policy_snapshot_loader.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../src/domain/models/worker/enrollment_token_model.ts";
import { tokenSecretKey } from "../src/domain/models/worker/enrollment_token_model.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import {
  type RunVaultAccess,
  runWithVaultAccess,
} from "../src/domain/vaults/run_vault_access.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { consumeStream, withDefaults } from "../src/libswamp/stream.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
} from "../src/libswamp/vaults/create.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { DispatchService } from "../src/serve/dispatch_service.ts";
import { handleWorkerPrune } from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { createRunVaultScope } from "../src/serve/run_vault_access_policy.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { runWorker, type WorkerExitResult } from "../src/worker/connect.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import "../src/domain/models/models.ts";
import { IT_DEFINITION_ID, IT_TYPE } from "./remote_execution_test_model.ts";
import { grant, runnerGrants } from "./serve_run_vault_scope_harness.ts";

await initializeLogging({});

const RUNNER_ENTRY = join(
  dirname(fromFileUrl(import.meta.url)),
  "test_fixtures",
  "remote_it_runner_entry.ts",
);
const TEST_RUNNER_COMMAND = {
  cmd: Deno.execPath(),
  args: [
    "run",
    "--unstable-bundle",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "--allow-net",
    "--allow-sys",
    RUNNER_ENTRY,
  ],
};

interface Orchestrator {
  repoDir: string;
  repoContext: ReturnType<typeof createRepositoryContext>;
  gateway: WorkerGateway;
  dispatchService: DispatchService;
  serverUrl: string;
  audits: AuditEvent[];
  /** The bot's run scope, decided against the current grants. */
  botScope(): RunVaultAccess;
  setGrants(grants: Grant[]): void;
  shutdown(): Promise<void>;
}

/**
 * bot runs anything and reads only roomcontrol: it may neither read nor
 * write `local`, the vault the test model and the enrollment token use.
 */
const RESTRICTED: Grant[] = [
  ...runnerGrants("user:bot"),
  grant("user:bot", "vault", "roomcontrol"),
];

async function initRepo(repoDir: string): Promise<void> {
  const libCtx = createLibSwampContext({});
  await consumeStream(
    repoInit(libCtx, createRepoInitDeps("20260101.120000.0"), {
      path: repoDir,
      force: false,
      version: "20260101.120000.0",
      tools: [],
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
        throw new Error(String(event.error?.message ?? "vault create failed"));
      },
    }),
  );
}

async function startOrchestrator(repoDir: string): Promise<Orchestrator> {
  await initRepo(repoDir);
  const repoContext = createRepositoryContext({ repoDir });
  let service = new GrantBasedAccessDecisionService(
    new PolicySnapshot(RESTRICTED, [], createConditionEvaluator()),
  );
  const audits: AuditEvent[] = [];
  const scopeContext = {
    authMode: "token" as const,
    policySnapshotLoader: {
      get decisionService() {
        return service;
      },
    },
    auditEmitter: {
      emit: (event: AuditEvent) => audits.push(event),
    } as unknown as AuditEmitter,
    instanceId: crypto.randomUUID(),
  };
  const botScope = () =>
    createRunVaultScope(scopeContext, {
      source: "session",
      principal: { kind: "user", id: "bot" },
      idpGroups: [],
      collectives: [],
    })!.access;

  const capabilityService = new CapabilityService({ repoDir, repoContext });
  const dispatches = new DispatchRegistry();
  const bundles = new BundleRegistry();
  const dispatchService = new DispatchService({
    repoDir,
    repoContext,
    dispatches,
    bundles,
    queueTimeoutMs: 15_000,
    captureEnvironment: () => ({}),
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

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        const attachment = gateway.attachTransport({
          send: (data) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(data);
          },
        });
        // Every gateway message — enrollment included — is handled while
        // the bot's restrictive scope is ambient, as a leaked run context
        // would leave it.
        socket.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          const data = event.data;
          runWithVaultAccess(botScope(), () => attachment.feed(data));
        };
        socket.onclose = () => attachment.closed();
        return response;
      }
      return await dataPlane.handle(req) ??
        new Response("Not found", { status: 404 });
    },
  );

  return {
    repoDir,
    repoContext,
    gateway,
    dispatchService,
    serverUrl: `ws://127.0.0.1:${server.addr.port}`,
    audits,
    botScope,
    setGrants(grants) {
      service = new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
      );
    },
    shutdown: () => server.shutdown(),
  };
}

/** Mints an enrollment token whose secret is stored in the `local` vault. */
async function mintEnrollmentToken(
  o: Orchestrator,
  name: string,
): Promise<string> {
  const deps = await createWorkerModelRunDeps(o.repoDir, o.repoContext);
  for await (
    const event of modelMethodRun(createLibSwampContext({}), deps, {
      modelIdOrName: name,
      methodName: "mint",
      inputs: { durationMs: 600_000, vaultName: "local" },
      lastEvaluated: false,
      typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
      definitionName: name,
    })
  ) {
    if (event.kind === "error") {
      throw new Error(String((event.error as { message?: unknown }).message));
    }
  }
  const vault = await VaultService.fromRepository(o.repoDir);
  return `${name}.${await vault.get("local", tokenSecretKey(name))}`;
}

function remoteStep(echo: string) {
  return {
    placement: { labels: { tier: "it" } },
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
    methodArgs: { echo },
    workflowName: "it-workflow",
    stepName: "it-step",
  };
}

async function leaseStates(o: Orchestrator): Promise<unknown[]> {
  const leases = await o.repoContext.dataQueryService.query(
    'modelType == "swamp/step-lease" && specName == "lease"',
    { loadAttributes: true },
  ) as Array<{ attributes?: Record<string, unknown> }>;
  return leases.map((l) => l.attributes?.state);
}

Deno.test({
  name:
    "serve remote vault scope: a remote step's vault writes are held to the dispatching run; enrollment, leases and prune run outside it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-remote-scope-" });
    const o = await startOrchestrator(dir);
    const workerStop = new AbortController();
    let workerDone: Promise<WorkerExitResult> | null = null;
    try {
      const token = await mintEnrollmentToken(o, "scope-worker");
      workerDone = runWorker({
        url: o.serverUrl,
        token,
        labels: { tier: "it" },
        swampVersion: "test",
        cacheDir: join(dir, "worker-cache"),
        signal: workerStop.signal,
        runnerCommand: TEST_RUNNER_COMMAND,
      });
      // Redeem read the token secret from `local` under the bot's scope,
      // which may not read it: control-plane work runs outside the scope.
      await waitFor(
        () => o.gateway.worker("scope-worker")?.status === "idle",
        "worker enrollment",
      );

      // The remote method writes `local` through putSecret: refused.
      let refusal = "";
      try {
        await runWithVaultAccess(
          o.botScope(),
          () => o.dispatchService.executeRemote(remoteStep("refused")),
        );
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      assertStringIncludes(refusal, "Writing vault 'local' is refused");
      const vault = await VaultService.fromRepository(dir);
      assertEquals((await vault.list("local")).includes("from-method"), false);
      assert(
        o.audits.some((e) =>
          e.resourceName === "local" && e.outcome === "denied" &&
          e.principalId === "bot"
        ),
        "the refused putSecret is audited",
      );

      // Granted read and write on `local`, the next dispatch succeeds.
      o.setGrants([
        ...RESTRICTED,
        grant("user:bot", "vault", "local", ["read", "write"]),
      ]);
      await waitFor(
        () => o.gateway.worker("scope-worker")?.status === "idle",
        "worker idle again",
      );
      const result = await runWithVaultAccess(
        o.botScope(),
        () => o.dispatchService.executeRemote(remoteStep("granted")),
      );
      assertEquals(result.outputs.length, 2);
      assertEquals(await vault.get("local", "from-method"), "round-trip");

      // Lease transitions for both dispatches were recorded, though each
      // chained from inside the bot's scope.
      const states = await leaseStates(o);
      assertEquals(states.length, 2);
      assertEquals(states.includes("completed"), true, JSON.stringify(states));

      // Worker prune, entered under the restrictive scope, completes.
      o.setGrants(RESTRICTED);
      const sent: string[] = [];
      const socket = {
        readyState: WebSocket.OPEN,
        send: (data: string) => sent.push(data),
        close() {},
      } as unknown as WebSocket;
      const opened = await requireInitializedRepoUnlocked({
        repoDir: dir,
        outputMode: "log",
      });
      const ctx = {
        repoDir: opened.repoDir,
        repoContext: opened.repoContext,
        authConfig: { mode: "none" },
        datastoreResolver: opened.datastoreResolver,
      } as unknown as ConnectionContext;
      await runWithVaultAccess(o.botScope(), () =>
        handleWorkerPrune(
          socket,
          ctx,
          "prune-1",
          { dryRun: true },
          new AbortController(),
          null,
        ));
      opened.repoContext.catalogStore.close();
      const reply = JSON.parse(sent.at(-1) ?? "{}");
      assertEquals(reply.type, "worker.prune", JSON.stringify(reply));
    } finally {
      workerStop.abort();
      if (workerDone) await workerDone.catch(() => {});
      await o.shutdown();
      o.repoContext.catalogStore.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
