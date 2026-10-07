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
 * Serve's other ways into a run's vault scope (swamp-club#2676), wired from
 * real components against a real repository with local_encryption vaults:
 *
 * - scheduler and webhook queue entries each start outside any scope, so
 *   different workflows' `vaults:` lists (and a scope the delivery arrived
 *   in) never leak into each other;
 * - a worker's `resolveSecret`, `putSecret` and data-plane sensitive write
 *   are held to the dispatching run's scope, and the data plane stores in
 *   the configured default vault the pre-run check approved;
 * - an HTTP request serve answers starts outside any run's scope, even when
 *   Deno hands the handler the async context a run left behind.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import {
  SCHEDULER_PRINCIPAL,
  WEBHOOK_PRINCIPAL,
} from "../src/domain/access/service_principal.ts";
import type { ModelDefinition } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  currentVaultAccess,
  RunVaultAccess,
  runWithVaultAccess,
} from "../src/domain/vaults/run_vault_access.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ScheduledExecutionService } from "../src/libswamp/workflows/scheduled_execution.ts";
import { unscopedHttpHandler } from "../src/cli/commands/serve.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import {
  createRunVaultScope,
  runVaultScopeContext,
  serviceRunVaultScope,
} from "../src/serve/run_vault_access_policy.ts";
import { parseWebhookFlag, WebhookService } from "../src/serve/webhook.ts";
import { hmacSha256Hex } from "../src/serve/webhook_verifiers.ts";
import "../src/domain/models/models.ts";
import {
  BOT,
  createVault,
  grant,
  runnerGrants,
  SECRETS,
  stepOf,
  vaultDenials,
  type VaultScopeFixture,
  withVaultScopeFixture,
} from "./serve_run_vault_scope_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

/** A workflow allowed only `vaults`, reading erp then roomcontrol. */
function listedReads(name: string, vaults: string[]): Workflow {
  return Workflow.create({
    name,
    vaults,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "erp",
            task: StepTask.model("erp-reader", "read"),
          }),
          Step.create({
            name: "rc",
            task: StepTask.model("rc-reader", "read"),
            dependsOn: [{
              step: "erp",
              condition: TriggerCondition.completed(),
            }],
          }),
        ],
      }),
    ],
  });
}

/** A scope a delivery might arrive in: it refuses every vault. */
const STRAY_SCOPE = RunVaultAccess.create({
  allowedVaults: [],
  allowListSource: "stray",
});

async function latestRun(
  f: VaultScopeFixture,
  workflow: Workflow,
): Promise<WorkflowRun | null> {
  return await f.repo.repoContext.workflowRunRepo.findLatestByWorkflowId(
    createWorkflowId(workflow.id),
  );
}

function finished(run: WorkflowRun | null): boolean {
  return run?.status === "succeeded" || run?.status === "failed";
}

/** Each workflow read only the vault its own list allows. */
function assertOwnListOnly(only: WorkflowRun, other: WorkflowRun): void {
  // only-rc: roomcontrol allowed, erp refused by its own list.
  assertStringIncludes(
    stepOf(only, "main", "erp").error ?? "",
    `not in the vaults list of workflow '${only.workflowName}'`,
  );
  assertEquals(stepOf(only, "main", "rc").status, "succeeded");
  // only-erp: erp allowed, roomcontrol refused by its own list.
  assertEquals(stepOf(other, "main", "erp").status, "succeeded");
  assertStringIncludes(
    stepOf(other, "main", "rc").error ?? "",
    `not in the vaults list of workflow '${other.workflowName}'`,
  );
}

/** The trigger principal may read both vaults: only the lists differ. */
function triggerGrants(subject: string) {
  return [
    ...runnerGrants(subject),
    grant(subject, "vault", "erp"),
    grant(subject, "vault", "roomcontrol"),
  ];
}

Deno.test({
  name:
    "serve trigger vault scope: scheduler queue entries with different workflows' vaults lists never leak scopes into each other",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const onlyRc = listedReads("cron-only-rc", ["roomcontrol"]);
      const onlyErp = listedReads("cron-only-erp", ["erp"]);
      await f.repo.repoContext.workflowRepo.save(onlyRc);
      await f.repo.repoContext.workflowRepo.save(onlyErp);
      const scheduler = new ScheduledExecutionService({
        workflowRepo: f.repo.repoContext.workflowRepo,
        repoDir: f.repo.repoDir,
        initiatedBy: "service:scheduler",
        // As serve wires its executor.
        executeWorkflow: (input, signal, onEvent) =>
          executeWorkflowWithLocks(
            f.repo.repoDir,
            f.repo.repoContext,
            f.repo.datastoreConfig,
            input,
            signal,
            onEvent,
            undefined,
            undefined,
            {
              syncGate: undefined,
              triggerSource: "schedule",
              initiatedBy: input.initiatedBy,
              vaultAccess: serviceRunVaultScope(
                runVaultScopeContext(f.ctx),
                SCHEDULER_PRINCIPAL,
              ),
            },
          ),
      });
      try {
        // Both fire from inside a scope that refuses every vault.
        runWithVaultAccess(STRAY_SCOPE, () => {
          scheduler.enqueueForReplay({
            pendingRunId: crypto.randomUUID(),
            workflowIdOrName: onlyRc.name,
          });
          scheduler.enqueueForReplay({
            pendingRunId: crypto.randomUUID(),
            workflowIdOrName: onlyErp.name,
          });
        });
        await waitFor(
          async () =>
            finished(await latestRun(f, onlyRc)) &&
            finished(await latestRun(f, onlyErp)),
          "both scheduled runs finished",
        );
      } finally {
        await scheduler.stop();
      }
      assertOwnListOnly(
        (await latestRun(f, onlyRc))!,
        (await latestRun(f, onlyErp))!,
      );
      assertEquals(
        new Set(f.seen),
        new Set([SECRETS.roomcontrol, SECRETS.erp]),
      );
      assertEquals(
        new Set(vaultDenials(f.audits).map((d) => d.principalId)),
        new Set(["scheduler"]),
      );
    }, { grants: triggerGrants("service:scheduler") }),
});

Deno.test({
  name:
    "serve trigger vault scope: webhook queue entries with different workflows' vaults lists never leak scopes into each other",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const onlyRc = listedReads("hook-only-rc", ["roomcontrol"]);
      const onlyErp = listedReads("hook-only-erp", ["erp"]);
      await f.repo.repoContext.workflowRepo.save(onlyRc);
      await f.repo.repoContext.workflowRepo.save(onlyErp);
      const service = new WebhookService({
        repoDir: f.repo.repoDir,
        repoContext: f.repo.repoContext,
        datastoreConfig: f.repo.datastoreConfig,
        endpoints: [
          await parseWebhookFlag(`/hooks/rc:${onlyRc.name}:shhh`),
          await parseWebhookFlag(`/hooks/erp:${onlyErp.name}:shhh`),
        ],
        syncGate: undefined,
        initiatedBy: "service:webhook",
        // As serve wires it.
        createVaultAccess: () =>
          serviceRunVaultScope(runVaultScopeContext(f.ctx), WEBHOOK_PRINCIPAL),
      });
      const body = '{"event":"push"}';
      const signature = await hmacSha256Hex(
        new TextEncoder().encode(body),
        "shhh",
      );
      const deliver = (route: string) =>
        service.handleRequest(
          new Request(`http://localhost${route}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": `sha256=${signature}`,
            },
            body,
          }),
        );
      try {
        // Both arrive inside a scope that refuses every vault.
        await runWithVaultAccess(STRAY_SCOPE, async () => {
          for (const route of ["/hooks/rc", "/hooks/erp"]) {
            const response = await deliver(route);
            assertEquals(response?.status, 200);
            await response?.body?.cancel();
          }
        });
        await waitFor(
          async () =>
            finished(await latestRun(f, onlyRc)) &&
            finished(await latestRun(f, onlyErp)),
          "both webhook runs finished",
        );
      } finally {
        await service.stop();
      }
      assertOwnListOnly(
        (await latestRun(f, onlyRc))!,
        (await latestRun(f, onlyErp))!,
      );
      assertEquals(
        new Set(vaultDenials(f.audits).map((d) => d.principalId)),
        new Set(["webhook"]),
      );
    }, { grants: triggerGrants("service:webhook") }),
});

/** The bot's run scope, as serve captures it for a session. */
function botScope(f: VaultScopeFixture): RunVaultAccess {
  return createRunVaultScope(runVaultScopeContext(f.ctx), {
    source: "session",
    principal: BOT,
    idpGroups: [],
    collectives: [],
  })!.access;
}

/** bot reads roomcontrol and reads and writes outputs; nothing else. */
const WORKER_GRANTS = [
  ...runnerGrants("user:bot"),
  grant("user:bot", "vault", "roomcontrol"),
  grant("user:bot", "vault", "outputs", ["read", "write"]),
  grant("user:bot", "vault", "outputs2", ["read", "write"]),
];

/** A dispatch of the bot's run to worker `w1`. */
function botDispatch(
  f: VaultScopeFixture,
  modelDef: ModelDefinition,
): DispatchRegistry {
  const dispatches = new DispatchRegistry();
  dispatches.register({
    workerName: "w1",
    dispatchId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    modelDef,
    modelType: modelDef.type,
    modelId: crypto.randomUUID(),
    methodName: "run",
    definitionName: "remote-def",
    definitionTags: {},
    vaultAccess: botScope(f),
  });
  return dispatches;
}

Deno.test({
  name:
    "serve worker vault scope: resolveSecret and putSecret are held to the dispatching run's principal",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const modelDef: ModelDefinition = {
        type: ModelType.create(`test/remote-${crypto.randomUUID()}`),
        version: "2026.10.07.1",
        methods: {},
      };
      const capabilities = new CapabilityService({
        repoDir: f.repo.repoDir,
        repoContext: f.repo.repoContext,
        dispatches: botDispatch(f, modelDef),
      });
      const refusal = async (call: () => Promise<unknown>) => {
        try {
          await call();
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      const read = (vaultName: string, annotation = false) =>
        refusal(() =>
          capabilities.resolveSecret("w1", {
            vaultName,
            secretKey: "password",
            ...(annotation ? { annotation } : {}),
          })
        );
      assertStringIncludes(await read("erp") ?? "", "vault 'erp' is refused");
      assertStringIncludes(
        await read("erp", true) ?? "",
        "vault 'erp' is refused",
      );
      assertEquals(await read("roomcontrol"), undefined);
      const write = (vaultName: string) =>
        refusal(() =>
          capabilities.putSecret("w1", {
            vaultName,
            secretKey: "from-worker",
            secretValue: "worker-value",
          })
        );
      assertStringIncludes(
        await write("roomcontrol") ?? "",
        "Writing vault 'roomcontrol' is refused",
      );
      assertStringIncludes(
        await write("erp") ?? "",
        "Writing vault 'erp' is refused",
      );
      assertEquals(await write("outputs"), undefined);
      const vaults = await f.vaults();
      assertEquals(await vaults.get("outputs", "from-worker"), "worker-value");
      assertEquals((await vaults.list("erp")).includes("from-worker"), false);
      assertEquals(
        new Set(vaultDenials(f.audits).map((d) => d.resourceName)),
        new Set(["erp", "roomcontrol"]),
      );
      assertEquals(currentVaultAccess(), undefined);
    }, { grants: WORKER_GRANTS }),
});

Deno.test({
  name:
    "serve worker vault scope: a data-plane sensitive write lands in the configured default vault, not the first user vault, under the run's scope",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      // A second vault the bot may write, so a configured default that is
      // not the first-listed user vault always exists, whatever order the
      // vault configs are listed in.
      await createVault(f.repo.repoDir, "outputs2");
      const first = (await f.vaults()).getUserVaultNames()[0];
      const target = first === "outputs" ? "outputs2" : "outputs";
      const botWritesFirst = first === "outputs" || first === "outputs2";
      const modelDef: ModelDefinition = {
        type: ModelType.create(`test/remote-${crypto.randomUUID()}`),
        version: "2026.10.07.1",
        resources: {
          creds: {
            description: "worker credential",
            schema: z.object({
              token: z.string().meta({ sensitive: true }),
            }),
            lifetime: "infinite",
            garbageCollection: 5,
          },
        },
        methods: {},
      };
      const write = async (defaultVaultName?: string) => {
        const plane = new DataPlane({
          repoDir: f.repo.repoDir,
          repoContext: f.repo.repoContext,
          sessions: {
            verify: (c) =>
              c === "worker-credential" ? { workerId: "w1" } : null,
          },
          dispatches: botDispatch(f, modelDef),
          bundles: new BundleRegistry(),
          createVaultService: () =>
            VaultService.fromRepository(f.repo.repoDir, { defaultVaultName }),
        });
        const response = await plane.handle(
          new Request("http://dataplane/data/resource", {
            method: "POST",
            headers: { authorization: "Bearer worker-credential" },
            body: JSON.stringify({
              specName: "creds",
              name: "main",
              data: { token: "worker-token" },
            }),
          }),
        );
        return { status: response?.status, text: await response?.text() };
      };
      // Wired as serve now wires it: the run deps' default vault.
      const wired = await write(target);
      assertEquals(wired.status, 200, wired.text);
      const vaults = await f.vaults();
      const stored = await vaults.list(target);
      assertEquals(stored.length, 1);
      assertEquals(await vaults.get(target, stored[0]), "worker-token");
      // Without it, the write targets the first user vault instead: refused
      // when the bot may not write it, and never the configured default.
      const before = await vaults.list(first);
      const unwired = await write(undefined);
      if (botWritesFirst) {
        assertEquals(unwired.status, 200, unwired.text);
        assertEquals((await vaults.list(first)).length, before.length + 1);
      } else {
        assert(unwired.status !== 200, unwired.text);
        assertStringIncludes(
          unwired.text ?? "",
          `Writing vault '${first}' is refused`,
        );
        assertEquals(await vaults.list(first), before);
      }
      assertEquals((await vaults.list(target)).length, 1);
      assertEquals(currentVaultAccess(), undefined);
    }, { grants: WORKER_GRANTS }),
});

Deno.test({
  name:
    "serve ingress vault scope: an HTTP request starts outside any run's scope even when Deno hands it a run's leftover context",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const seenScoped: Record<string, boolean> = {};
      const reads: Record<string, string> = {};
      const handler = (label: string) => async () => {
        seenScoped[label] = currentVaultAccess() !== undefined;
        try {
          await (await f.vaults()).get("erp", "password");
          reads[label] = "ok";
        } catch (error) {
          reads[label] = error instanceof Error ? error.message : String(error);
        }
        return new Response("ok");
      };
      const raw = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen() {} },
        handler("raw"),
      );
      const wrapped = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen() {} },
        unscopedHttpHandler(handler("wrapped")),
      );
      try {
        // A run loads a module for the first time, as a run that pulls an
        // extension or a lazily imported service does.
        await runWithVaultAccess(botScope(f), async () => {
          await import(
            `data:text/javascript,export default ${
              JSON.stringify(crypto.randomUUID())
            }`
          );
        });
        for (const server of [raw, wrapped]) {
          const response = await fetch(
            `http://127.0.0.1:${server.addr.port}/`,
          );
          await response.body?.cancel();
        }
      } finally {
        await raw.shutdown();
        await wrapped.shutdown();
      }
      assertEquals(seenScoped.wrapped, false);
      assertEquals(reads.wrapped, "ok");
      // Where the runtime does leak the context, an unwrapped handler is
      // held to the run's principal: the reason serve wraps its handler.
      if (seenScoped.raw) {
        assertStringIncludes(reads.raw, "vault 'erp' is refused");
      }
    }, { grants: WORKER_GRANTS }),
});
