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
 * Serve's background writers on a v3 datastore (swamp-club#3279).
 *
 * On v3 a repository context's hook refuses every write outside a unit of
 * work bound to it (`UnscopedWriteRefusedError`), and most of these paths
 * log and swallow their errors. So each test checks the outcome, not only
 * that nothing threw: the write is in the writer's checkout, and a second
 * checkout that catches up from the commit log holds the same records.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { withServerTokenLock } from "../src/infrastructure/persistence/server_token_lock.ts";
import {
  v3DatastoreFor,
  V3MaintenanceTimer,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../src/domain/models/access/server_token_model.ts";
import {
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
} from "../src/domain/models/worker/step_lease_model.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createServerTokenCreateDeps,
  serverTokenCreate,
} from "../src/libswamp/access/token_create.ts";
import {
  createServerTokenRevokeDeps,
  serverTokenRevoke,
} from "../src/libswamp/access/token_revoke.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { ScheduledExecutionService } from "../src/libswamp/workflows/scheduled_execution.ts";
import {
  reconcileRemoteInterruptedRuns,
  sweepStaleRecords,
} from "../src/serve/boot_reconciliation.ts";
import { interruptShutdownRuns } from "../src/serve/shutdown_interrupt.ts";
import {
  createServerTokenGcDeps,
  createServerTokenGcRepos,
} from "../src/serve/server_token_gc_deps.ts";
import { ServerTokenGcService } from "../src/serve/server_token_gc_service.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { parseWebhookFlag, WebhookService } from "../src/serve/webhook.ts";
import { hmacSha256Hex } from "../src/serve/webhook_verifiers.ts";
import { sweepContinuations } from "../src/serve/continuation_sweep_service.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import { continuationClaimsOver } from "../src/cli/repo_context.ts";
import { serveHolder } from "../src/domain/workflows/continuation_claim.ts";
import { acceptedOutcomeFor } from "../src/domain/workflows/signal_wait_store_test_helpers.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { createDeviceAuthDeps } from "../src/serve/device_auth_handler.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { GRANT_MODEL_TYPE } from "../src/domain/models/access/grant_model.ts";
import {
  createGrantWriteCommit,
  createGrantWriteTracking,
} from "../src/serve/grant_write_tracking.ts";
import { GrantsDirectoryPoller } from "../src/domain/access/grants_directory_poller.ts";
import type { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import { serverTokenModel } from "../src/domain/models/access/server_token_model.ts";
import {
  createServeCtx,
  errorFrame,
  sendRequest,
} from "./serve_request_harness.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";
import { assertCheckoutsAgree, withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const ONE_HOUR = 60 * 60 * 1000;

/** Runs `fn` in a commit-log root over A's context, as a seed must on v3. */
function inRoot<T>(repos: RowRepos, fn: () => Promise<T>): Promise<T> {
  return runInRootUnitOfWork(repos.a.repoContext, { flush: undefined }, fn);
}

/** A workflow run left `running` by serve instance `instanceId`. */
function runningRun(instanceId?: string): {
  workflowId: string;
  run: WorkflowRun;
} {
  const workflowId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  return {
    workflowId,
    run: WorkflowRun.fromData({
      id: crypto.randomUUID(),
      workflowId,
      workflowName: "background",
      status: "running",
      startedAt,
      ...(instanceId !== undefined ? { instanceId } : {}),
      jobs: [{
        jobName: "main",
        status: "running",
        startedAt,
        steps: [{ stepName: "noop", status: "running", startedAt }],
      }],
      tags: {},
    }),
  };
}

async function statusOf(
  repos: RowRepos,
  workflowId: string,
  runId: string,
): Promise<string | undefined> {
  const run = await repos.a.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflowId),
    runId as Parameters<
      RowRepos["a"]["repoContext"]["workflowRunRepo"]["findById"]
    >[1],
  );
  return run?.status;
}

/** A workflow whose only step is an approval gate, so its run suspends. */
function gatedWorkflow(name: string, schedule?: string): Workflow {
  return Workflow.create({
    name,
    ...(schedule !== undefined ? { trigger: { schedule } } : {}),
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "gate",
        task: StepTask.manualApproval("Approve?"),
      })],
    })],
  });
}

/** Whether A's commit log holds a commit of a workflow run's partition. */
async function runCommitted(
  repos: RowRepos,
  datastorePath: string,
): Promise<boolean> {
  const config = repos.a.datastoreConfig;
  if (isCustomDatastoreConfig(config)) return false;
  const handle = v3DatastoreFor(repos.repoA, {
    ...config,
    path: datastorePath,
  });
  return (await handle.commitStore.changesSince(0, 100_000)).some((change) =>
    change.commit.partition.toString().startsWith("run--")
  );
}

Deno.test("v3 serve background: boot reconciliation interrupts a dead instance's run and commits it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { workflowId, run } = runningRun("dead-instance");
    await inRoot(
      repos,
      () =>
        repos.a.repoContext.workflowRunRepo.save(
          createWorkflowId(workflowId),
          run,
        ),
    );
    const controlPlaneStore = new FileSystemControlPlaneStore(
      join(repos.repoA, "control-plane"),
    );
    const now = Date.now();
    await controlPlaneStore.put(
      "heartbeats/dead-instance",
      new TextEncoder().encode(JSON.stringify({
        instanceId: "dead-instance",
        hostname: "other-host",
        pid: 1,
        startedAt: new Date(now - 300_000).toISOString(),
        heartbeatAt: new Date(now - 120_000).toISOString(),
      })),
    );
    const reaped = await reconcileRemoteInterruptedRuns({
      controlPlaneStore,
      instanceId: "self-instance",
      runTracker: {
        findAllRunning: () => [],
        complete: () => {},
      } as unknown as Parameters<
        typeof reconcileRemoteInterruptedRuns
      >[0]["runTracker"],
      workflowRunRepo: repos.a.repoContext.workflowRunRepo,
      markDirty: repos.a.repoContext.markDirty,
    });
    assertEquals(reaped, 1);
    assertEquals(await statusOf(repos, workflowId, run.id), "interrupted");
    assert(
      await assertCheckoutsAgree(repos, datastorePath, "boot reconciliation") >
        0,
    );
  });
});

Deno.test("v3 serve background: the stale-record sweep expires an active lease and commits it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const deps = await createWorkerModelRunDeps(
      repos.repoA,
      repos.a.repoContext,
    );
    await inRoot(repos, async () => {
      for await (
        const event of modelMethodRun(createLibSwampContext({}), deps, {
          modelIdOrName: STEP_LEASE_INSTANCE_NAME,
          methodName: "acquire",
          inputs: {
            leaseId: "lease-1",
            dispatchId: "d-1",
            workerName: "w1",
            modelType: "command/shell",
            modelId: "m1",
            methodName: "execute",
          },
          lastEvaluated: false,
          typeArg: STEP_LEASE_MODEL_TYPE.normalized,
          definitionName: STEP_LEASE_INSTANCE_NAME,
          skipAllReports: true,
        })
      ) {
        if (event.kind === "error") throw new Error(event.error.message);
      }
    });
    const result = await sweepStaleRecords({
      repoContext: repos.a.repoContext,
    });
    assertEquals(result.leases, 1);
    assert(await assertCheckoutsAgree(repos, datastorePath, "sweep") > 0);
  });
});

Deno.test("v3 serve background: shutdown interrupts an aborted run and commits it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { workflowId, run } = runningRun();
    await inRoot(
      repos,
      () =>
        repos.a.repoContext.workflowRunRepo.save(
          createWorkflowId(workflowId),
          run,
        ),
    );
    const result = await interruptShutdownRuns(
      [{ runId: run.id, kind: "workflow-run", startedAt: new Date() }],
      { repoContext: repos.a.repoContext },
    );
    assertEquals(result.interrupted, [run.id]);
    assertEquals(await statusOf(repos, workflowId, run.id), "interrupted");
    assert(await assertCheckoutsAgree(repos, datastorePath, "shutdown") > 0);
  });
});

Deno.test("v3 serve background: server token GC collects a revoked token and commits the deletes", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const provider = new ControlPlaneVaultProvider(
      new FileSystemControlPlaneStore(swampPath(repos.repoA)),
    );
    await provider.initialize();
    VaultService.registerGlobalProvider(
      TOKEN_SECRETS_VAULT_NAME,
      "control_plane",
      provider,
    );
    const libCtx = createLibSwampContext();
    const ctx = repos.a.repoContext;
    await inRoot(repos, async () => {
      for (const name of ["keep-tok", "revoked-tok"]) {
        const events = await collect(
          serverTokenCreate(
            libCtx,
            await createServerTokenCreateDeps(libCtx, repos.repoA, ctx),
            {
              name,
              principalId: `user:${name}`,
              principalEmail: `${name}@example.com`,
              durationMs: ONE_HOUR,
              vaultName: TOKEN_SECRETS_VAULT_NAME,
            },
          ),
        );
        assert(
          events.some((e) => e.kind === "completed"),
          JSON.stringify(events),
        );
      }
      const revoked = await collect(
        serverTokenRevoke(
          libCtx,
          await createServerTokenRevokeDeps(libCtx, repos.repoA, ctx),
          { name: "revoked-tok" },
        ),
      );
      assertEquals(revoked.some((e) => e.kind === "error"), false);
    });

    const datastoreConfig = repos.a.datastoreConfig;
    const service = new ServerTokenGcService(
      createServerTokenGcDeps({
        intervalMs: ONE_HOUR,
        gracePeriodMs: ONE_HOUR,
        dataQueryService: ctx.dataQueryService,
        ...createServerTokenGcRepos(repos.repoA, ctx),
        vaultService: await VaultService.fromRepository(repos.repoA),
        libCtx,
        withTokenLock: (name, fn) =>
          withServerTokenLock(datastoreConfig, name, fn),
      }),
    );
    assertEquals(await service.runOnce(), 1);
    assertEquals(
      await ctx.definitionRepo.findByName(
        SERVER_TOKEN_MODEL_TYPE,
        "revoked-tok",
      ),
      null,
    );
    assertExists(
      await ctx.definitionRepo.findByName(SERVER_TOKEN_MODEL_TYPE, "keep-tok"),
    );
    assert(await assertCheckoutsAgree(repos, datastorePath, "token GC") > 0);
  });
});

Deno.test({
  name: "v3 serve background: a webhook-triggered run commits its record",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await new YamlWorkflowRepository(repos.repoA).save(
        gatedWorkflow("hooked"),
      );
      const service = new WebhookService({
        repoDir: repos.repoA,
        repoContext: repos.a.repoContext,
        datastoreConfig: repos.a.datastoreConfig,
        endpoints: [await parseWebhookFlag("/hooks/v3:hooked:shhh")],
        syncService: undefined,
        syncGate: undefined,
      });
      try {
        const body = '{"event":"push"}';
        const signature = await hmacSha256Hex(
          new TextEncoder().encode(body),
          "shhh",
        );
        const response = await service.handleRequest(
          new Request("http://localhost/hooks/v3", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": `sha256=${signature}`,
            },
            body,
          }),
        );
        assertEquals(response?.status, 200);
        await response?.body?.cancel();
        await waitFor(
          () => runCommitted(repos, datastorePath),
          "the webhook run's record to be committed",
          { timeoutMs: 60_000 },
        );
      } finally {
        await service.stop();
      }
      assert(await assertCheckoutsAgree(repos, datastorePath, "webhook") > 0);
    });
  },
});

Deno.test({
  name: "v3 serve background: a scheduled run commits its record",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await new YamlWorkflowRepository(repos.repoA).save(
        gatedWorkflow("nightly", "0 0 1 1 *"),
      );
      const ctx = repos.a.repoContext;
      const service = new ScheduledExecutionService({
        workflowRepo: ctx.workflowRepo,
        repoDir: repos.repoA,
        executeWorkflow: (input, signal, onEvent) =>
          executeWorkflowWithLocks(
            repos.repoA,
            ctx,
            repos.a.datastoreConfig,
            input,
            signal,
            onEvent,
            undefined,
            undefined,
            { syncGate: undefined, triggerSource: "schedule" },
          ),
      });
      try {
        await service.start(() => {});
        service.enqueueForReplay({
          pendingRunId: crypto.randomUUID(),
          workflowIdOrName: "nightly",
        });
        await waitFor(
          () => runCommitted(repos, datastorePath),
          "the scheduled run's record to be committed",
          { timeoutMs: 60_000 },
        );
      } finally {
        await service.stop();
      }
      assert(await assertCheckoutsAgree(repos, datastorePath, "schedule") > 0);
    });
  },
});

Deno.test("v3 serve background: serve's maintenance timer compacts and collects over the real datastore", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const config = repos.a.datastoreConfig;
    if (isCustomDatastoreConfig(config)) throw new Error("filesystem only");
    const timer = new V3MaintenanceTimer(
      v3DatastoreFor(repos.repoA, { ...config, path: datastorePath }),
      60_000,
    );
    timer.tick();
    await timer.stop();
  });
});

/** Registers the control-plane vault serve keeps token secrets in. */
async function registerTokenVault(repos: RowRepos): Promise<void> {
  const provider = new ControlPlaneVaultProvider(
    new FileSystemControlPlaneStore(swampPath(repos.repoA)),
  );
  await provider.initialize();
  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "control_plane",
    provider,
  );
}

Deno.test({
  name:
    "v3 serve background: the continuation sweep resumes a settled run and commits it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      const ctx = repos.a.repoContext;
      const model = Definition.create({ name: "shipper", globalArguments: {} });
      const workflow = Workflow.create({
        name: "release",
        autoResume: true,
        jobs: [Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "review",
              task: StepTask.waitForSignal(3600, {
                type: "object",
                additionalProperties: false,
                required: ["verdict"],
                properties: { verdict: { type: "string", enum: ["ship"] } },
              }),
            }),
            Step.create({
              name: "ship",
              task: StepTask.modelMethod(model.name, "noop"),
              dependsOn: [{
                step: "review",
                condition: TriggerCondition.succeeded(),
              }],
            }),
          ],
        })],
      });
      await inRoot(repos, async () => {
        await ctx.definitionRepo.save(repos.modelType, model);
        await ctx.workflowRepo.save(workflow);
      });

      const frames = await sendRequest(createServeCtx(repos.serveRepo), {
        type: "workflow.run",
        id: crypto.randomUUID(),
        payload: { workflowIdOrName: workflow.name },
      }, null);
      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
      const [summary] = await ctx.workflowRunRepo.findSummariesByStatus(
        workflow.id,
        "suspended",
      );
      assertExists(summary, "the run suspended on its wait");
      const run = await ctx.workflowRunRepo.findById(
        createWorkflowId(workflow.id),
        createWorkflowRunId(summary.id),
      );
      assertExists(run);
      const wait = run.findSignalWaits()[0].wait!;
      const support = ctx.signalWaits;
      assert(support?.supported, "the datastore holds wait records");
      await support.store.settle({
        ...acceptedOutcomeFor(wait, { verdict: "ship" }, { runId: run.id }),
        workflowId: run.workflowId,
      });

      const registry = new ActiveRunRegistry();
      const sweeper: ConnectionContext = {
        ...createServeCtx(repos.serveRepo, undefined, {
          activeRunRegistry: registry,
        }),
        instanceId: "sweeper",
        serveOptions: { autoResume: false } as MergedServeOptions,
        auditEmitter: { emit: () => {} } as unknown as AuditEmitter,
        repoContext: {
          ...ctx,
          continuationClaims: continuationClaimsOver(
            new FileSystemControlPlaneStore(swampPath(repos.repoA)),
            serveHolder("sweeper"),
          ),
        },
      };
      const swept = await sweepContinuations(sweeper, { takeover: true });
      assertEquals(swept.launched, 1);
      await waitFor(() => registry.size === 0, "the resume to finish");
      assertEquals(await statusOf(repos, workflow.id, run.id), "succeeded");
      assert(await assertCheckoutsAgree(repos, datastorePath, "sweep") > 0);
    });
  },
});

Deno.test("v3 serve background: the device-auth mint commits the token it writes", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await registerTokenVault(repos);
    const ctx = repos.a.repoContext;
    const deps = createDeviceAuthDeps(
      {
        ...createServeCtx(repos.serveRepo).authConfig,
        oauthClientId: "client",
      },
      "secret",
      repos.repoA,
      ctx,
    );
    const credential = await deps.mintServerToken(
      "user:someone",
      "someone@example.com",
      ["acme"],
      [],
      repos.repoA,
      ctx,
    );
    const tokenName = credential.split(".")[0];
    assertExists(
      await ctx.definitionRepo.findByName(SERVER_TOKEN_MODEL_TYPE, tokenName),
    );
    assert(await assertCheckoutsAgree(repos, datastorePath, "mint") > 0);
  });
});

const GRANT_FILE = `grants:
  - subject: "user:alice"
    effect: allow
    actions: [read]
    resource: "data:*"
`;

/** A policy loader that reads nothing: the handlers only reload it. */
const NOOP_POLICY_LOADER = {
  load: () => Promise.resolve(undefined),
  loadWithCounts: () =>
    Promise.resolve({ snapshot: undefined, grantCount: 0, groupCount: 0 }),
} as unknown as PolicySnapshotLoader;

async function grantCount(repos: RowRepos): Promise<number> {
  return (await repos.a.repoContext.dataQueryService.query(
    `modelType == "${GRANT_MODEL_TYPE.normalized}"`,
  )).length;
}

Deno.test("v3 serve background: access.reload commits the grants it reconciles", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await Deno.mkdir(join(repos.repoA, "grants"), { recursive: true });
    await Deno.writeTextFile(
      join(repos.repoA, "grants", "team.yaml"),
      GRANT_FILE,
    );
    const serveCtx = {
      ...createServeCtx(repos.serveRepo),
      policySnapshotLoader: NOOP_POLICY_LOADER,
    } as ConnectionContext;
    const frames = await sendRequest(serveCtx, {
      type: "access.reload",
      id: crypto.randomUUID(),
    }, null);
    assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
    assert(await grantCount(repos) > 0, "the reload wrote a grant");
    assert(await assertCheckoutsAgree(repos, datastorePath, "reload") > 0);
  });
});

Deno.test({
  name:
    "v3 serve background: the grants poller commits the grants it reconciles",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      const ctx = repos.a.repoContext;
      const grantsDir = join(repos.repoA, "grants");
      await Deno.mkdir(grantsDir, { recursive: true });
      // As serve builds them (src/cli/commands/serve.ts).
      const autoDefRepo = new YamlDefinitionRepository(
        repos.repoA,
        undefined,
        ctx.autoDefinitionsDir,
        false,
        ctx.markDirty,
      );
      const grantWrites = createGrantWriteTracking(
        ctx.definitionRepo,
        autoDefRepo,
        ctx.unifiedDataRepo,
      );
      const poller = new GrantsDirectoryPoller({
        grantsDir,
        fileGrantStore: grantWrites.fileGrantStore,
        policySnapshotLoader: NOOP_POLICY_LOADER,
        pollIntervalMs: 10,
        commitReconcile: createGrantWriteCommit(undefined, grantWrites, {
          syncService: undefined,
          markDirty: ctx.markDirty,
          namespace: undefined,
        }),
      });
      await poller.start();
      try {
        await Deno.writeTextFile(join(grantsDir, "team.yaml"), GRANT_FILE);
        await waitFor(
          async () => await grantCount(repos) > 0,
          "the poller to reconcile the new grant",
        );
      } finally {
        await poller.stop();
      }
      assert(await assertCheckoutsAgree(repos, datastorePath, "poller") > 0);
    });
  },
});

Deno.test("v3 serve background: a collective refresh's token update commits (as serve's refresh deps write it)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await registerTokenVault(repos);
    const libCtx = createLibSwampContext();
    const ctx = repos.a.repoContext;
    await inRoot(repos, async () => {
      const events = await collect(
        serverTokenCreate(
          libCtx,
          await createServerTokenCreateDeps(libCtx, repos.repoA, ctx),
          {
            name: "member-tok",
            principalId: "user:member",
            principalEmail: "member@example.com",
            durationMs: ONE_HOUR,
            vaultName: TOKEN_SECRETS_VAULT_NAME,
          },
        ),
      );
      assert(
        events.some((e) => e.kind === "completed"),
        JSON.stringify(events),
      );
    });
    // serve.ts's updateTokenCollectives: the same writer, in a root over the
    // context. Its deps are a closure inside serveCommand, so they are
    // mirrored here rather than imported.
    const def = await ctx.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      "member-tok",
    );
    assertExists(def);
    const { writeResource } = createResourceWriter(
      ctx.unifiedDataRepo,
      SERVER_TOKEN_MODEL_TYPE,
      def.id,
      serverTokenModel.resources!,
      undefined,
      undefined,
      undefined,
      undefined,
      "member-tok",
    );
    const content = await ctx.unifiedDataRepo.getContent(
      SERVER_TOKEN_MODEL_TYPE,
      def.id,
      "token-main",
    );
    assertExists(content);
    const record = JSON.parse(new TextDecoder().decode(content));
    await runInRootUnitOfWork(
      ctx,
      { flush: undefined },
      () =>
        writeResource("token", "token-main", {
          ...record,
          collectives: ["acme", "beta"],
        }),
    );
    assert(await assertCheckoutsAgree(repos, datastorePath, "refresh") > 0);
  });
});
