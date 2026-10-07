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
 * Non-regression for swamp-club#2464: giving scheduled and webhook runs a
 * service principal and authorizing them must not stop any existing webhook
 * or schedule. Grants are loaded from a grants file into a real repository on
 * disk the way serve loads them, and the trigger authorizer decides with the
 * real policy snapshot. Only an explicit deny naming a service principal
 * stops a run.
 */

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { parseGrantFile } from "../src/domain/access/grant_file.ts";
import {
  createFileGrantStore,
  reconcileAllFileGrants,
} from "../src/domain/access/grant_file_reconciler.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import type { AuthMode } from "../src/domain/access/serve_auth_config.ts";
import { principalToString } from "../src/domain/access/principal.ts";
import {
  SCHEDULER_PRINCIPAL,
  WEBHOOK_PRINCIPAL,
} from "../src/domain/access/service_principal.ts";
import { validateGrantCondition } from "../src/infrastructure/cel/grant_condition_environment.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { createTriggerAuthorizer } from "../src/serve/trigger_authorizer.ts";
import {
  auditScheduledEvent,
  auditWebhookEvent,
  createScheduledRunAuthorizer,
  createWebhookRunAuthorizer,
} from "../src/serve/trigger_audit.ts";
import { WebhookRejectionCoalescer } from "../src/serve/webhook_audit_coalescer.ts";
import {
  parseWebhookFlag,
  type WebhookEvent,
  WebhookService,
} from "../src/serve/webhook.ts";
import { hmacSha256Hex } from "../src/serve/webhook_verifiers.ts";
import {
  type ScheduledExecutionEvent,
  ScheduledExecutionService,
} from "../src/libswamp/workflows/scheduled_execution.ts";
import type { WorkflowRunInput } from "../src/libswamp/workflows/run.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const SECRET = "hook-secret";

/** Grants an existing deployment might hold; none can name a service. */
const LEGACY_GRANTS = `grants:
  - subject: user:alice
    effect: allow
    actions: [run, read]
    resource: "workflow:*"
  - subject: user:mallory
    effect: deny
    actions: [run]
    resource: "workflow:*"
  - subject: group:ops
    effect: deny
    actions: [run, write]
    resource: "workflow:*"
  - subject: idp-group:contractors
    effect: deny
    actions: [run]
    resource: "workflow:*"
`;

function denyServices(workflowName: string): string {
  return `${LEGACY_GRANTS}  - subject: service:webhook
    effect: deny
    actions: [run]
    resource: "workflow:${workflowName}"
  - subject: service:scheduler
    effect: deny
    actions: [run]
    resource: "workflow:${workflowName}"
`;
}

function gatedWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
}

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-trigger-nonreg-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

interface Scenario {
  mode: AuthMode;
  grants: string | null;
  approveRequiresExplicitGrant: boolean;
}

async function harness(repoDir: string, scenario: Scenario, name: string) {
  await new YamlWorkflowRepository(repoDir).save(gatedWorkflow(name));
  const opened = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "log",
  });
  const { repoContext } = opened;
  if (scenario.grants !== null) {
    const grantsFile = join(opened.repoDir, "grants.yaml");
    const parsed = parseGrantFile(
      grantsFile,
      scenario.grants,
      validateGrantCondition,
    );
    assertEquals(parsed.errors, []);
    await reconcileAllFileGrants(
      new Map([[grantsFile, parsed.entries]]),
      createFileGrantStore(
        repoContext.definitionRepo,
        new YamlDefinitionRepository(
          opened.repoDir,
          undefined,
          repoContext.autoDefinitionsDir,
          false,
          repoContext.markDirty,
        ),
        repoContext.unifiedDataRepo,
      ),
    );
  }
  const loader = new PolicySnapshotLoader(
    repoContext.unifiedDataRepo,
    repoContext.eventBus,
    "manual",
    { runImpliesApprove: !scenario.approveRequiresExplicitGrant },
  );
  await loader.load();

  const audit: AuditEvent[] = [];
  const auditCtx = {
    auditEmitter: {
      emit: (event: AuditEvent) => audit.push(event),
    } as unknown as AuditEmitter,
    instanceId: "i-test",
  };
  const authorizer = createTriggerAuthorizer({
    authMode: scenario.mode,
    policySnapshotLoader: loader,
    workflowRepo: repoContext.workflowRepo,
  });
  return { opened, auditCtx, audit, authorizer };
}

async function deliver(service: WebhookService, body = '{"ref":"main"}') {
  const signature = await hmacSha256Hex(new TextEncoder().encode(body), SECRET);
  return await service.handleRequest(
    new Request("http://localhost/hooks/gh", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": `sha256=${signature}` },
    }),
    "203.0.113.9",
  );
}

const MODES: AuthMode[] = ["none", "token", "oauth"];
const GRANT_SETS: Array<[string, string | null]> = [
  ["no grants", null],
  ["legacy user/group/idp-group grants", LEGACY_GRANTS],
];

for (const mode of MODES) {
  for (const [label, grants] of GRANT_SETS) {
    for (const approveRequiresExplicitGrant of [false, true]) {
      const scenario = { mode, grants, approveRequiresExplicitGrant };
      const title =
        `mode ${mode}, ${label}, explicit approve ${approveRequiresExplicitGrant}`;

      Deno.test(`trigger non-regression: an existing webhook still queues and runs (${title})`, async () => {
        await withRepo(async (repoDir) => {
          const name = `hook-${crypto.randomUUID()}`;
          const h = await harness(repoDir, scenario, name);
          const events: WebhookEvent[] = [];
          const coalescer = new WebhookRejectionCoalescer();
          const service = new WebhookService({
            repoDir: h.opened.repoDir,
            repoContext: h.opened.repoContext,
            datastoreConfig: h.opened.datastoreConfig,
            endpoints: [
              await parseWebhookFlag(`/hooks/gh:${name}:${SECRET}`),
            ],
            syncService: h.opened.syncService,
            syncGate: undefined,
            initiatedBy: principalToString(WEBHOOK_PRINCIPAL),
            authorizeRun: createWebhookRunAuthorizer(h.authorizer, h.auditCtx),
          });
          service.setEventHandler((event) => {
            auditWebhookEvent(h.auditCtx, event, coalescer);
            events.push(event);
          });

          const response = await deliver(service);
          assertEquals(response?.status, 200);
          assertEquals(await response!.json(), {
            status: "queued",
            workflow: name,
          });
          await waitFor(
            () => events.some((e) => e.kind === "webhook_started"),
            "webhook run started",
          );
          await service.stop();

          assertEquals(events.some((e) => e.kind === "webhook_denied"), false);
          const runs = await h.opened.repoContext.workflowRunRepo
            .findAllGlobal();
          assertEquals(runs.length, 1);
          assertEquals(runs[0].run.initiatedBy, "service:webhook");
          assertEquals(runs[0].run.triggerSource, "webhook");
          assertEquals(
            h.audit.filter((e) => e.action === "workflow.webhook.fire")
              .length,
            1,
          );
        });
      });

      Deno.test(`trigger non-regression: an existing schedule still runs (${title})`, async () => {
        await withRepo(async (repoDir) => {
          const name = `cron-${crypto.randomUUID()}`;
          const h = await harness(repoDir, scenario, name);
          const executed: WorkflowRunInput[] = [];
          const events: ScheduledExecutionEvent[] = [];
          const service = new ScheduledExecutionService({
            workflowRepo: h.opened.repoContext.workflowRepo,
            repoDir: h.opened.repoDir,
            initiatedBy: principalToString(SCHEDULER_PRINCIPAL),
            authorizeRun: createScheduledRunAuthorizer(
              h.authorizer,
              h.auditCtx,
            ),
            executeWorkflow: (input, _signal, onEvent) => {
              executed.push(input);
              onEvent({ kind: "started", runId: "run-1" } as never);
              onEvent(
                { kind: "completed", run: { status: "succeeded" } } as never,
              );
              return Promise.resolve();
            },
          });
          await service.start((event) => {
            auditScheduledEvent(h.auditCtx, event);
            events.push(event);
          });
          service.enqueueForReplay({
            pendingRunId: "p-1",
            workflowIdOrName: name,
          });
          await waitFor(() => executed.length === 1, "scheduled run");
          await service.stop();

          assertEquals(executed[0].initiatedBy, "service:scheduler");
          assertEquals(executed[0].workflowIdOrName, name);
          assertEquals(
            h.audit.filter((e) => e.action === "workflow.schedule.fire")
              .length,
            1,
          );
        });
      });
    }
  }
}

for (const mode of ["token", "oauth"] as const) {
  Deno.test(`trigger non-regression: only an explicit service deny stops a run (mode ${mode})`, async () => {
    await withRepo(async (repoDir) => {
      const name = `denied-${crypto.randomUUID()}`;
      const h = await harness(repoDir, {
        mode,
        grants: denyServices(name),
        approveRequiresExplicitGrant: false,
      }, name);
      const events: WebhookEvent[] = [];
      const service = new WebhookService({
        repoDir: h.opened.repoDir,
        repoContext: h.opened.repoContext,
        datastoreConfig: h.opened.datastoreConfig,
        endpoints: [await parseWebhookFlag(`/hooks/gh:${name}:${SECRET}`)],
        syncService: h.opened.syncService,
        syncGate: undefined,
        initiatedBy: principalToString(WEBHOOK_PRINCIPAL),
        authorizeRun: createWebhookRunAuthorizer(h.authorizer, h.auditCtx),
      });
      service.setEventHandler((event) => events.push(event));

      const response = await deliver(service);
      assertEquals(response?.status, 200);
      await waitFor(
        () => events.some((e) => e.kind === "webhook_denied"),
        "webhook run refused",
      );
      await service.stop();

      assertEquals(
        (await h.opened.repoContext.workflowRunRepo.findAllGlobal()).length,
        0,
      );
      const denial = h.audit.find((e) => e.category === "access");
      assertEquals(denial?.outcome, "denied");
      assertEquals(denial?.initiatedBy, "service:webhook");
      assertEquals(denial?.sourceIp, "203.0.113.9");
    });
  });
}

Deno.test("trigger non-regression: a webhook for a missing workflow still fails as webhook_failed", async () => {
  await withRepo(async (repoDir) => {
    const h = await harness(repoDir, {
      mode: "token",
      grants: LEGACY_GRANTS,
      approveRequiresExplicitGrant: false,
    }, `present-${crypto.randomUUID()}`);
    const events: WebhookEvent[] = [];
    const service = new WebhookService({
      repoDir: h.opened.repoDir,
      repoContext: h.opened.repoContext,
      datastoreConfig: h.opened.datastoreConfig,
      endpoints: [await parseWebhookFlag(`/hooks/gh:no-such-wf:${SECRET}`)],
      syncService: h.opened.syncService,
      syncGate: undefined,
      initiatedBy: principalToString(WEBHOOK_PRINCIPAL),
      authorizeRun: createWebhookRunAuthorizer(h.authorizer, h.auditCtx),
    });
    service.setEventHandler((event) => events.push(event));

    const response = await deliver(service);
    assertEquals(response?.status, 200);
    await waitFor(
      () => events.some((e) => e.kind === "webhook_failed"),
      "webhook run failed",
    );
    await service.stop();
    assertEquals(events.some((e) => e.kind === "webhook_denied"), false);
  });
});

Deno.test("trigger non-regression: a throwing audit emitter leaves the webhook response unchanged", async () => {
  await withRepo(async (repoDir) => {
    const name = `hook-${crypto.randomUUID()}`;
    const h = await harness(repoDir, {
      mode: "token",
      grants: null,
      approveRequiresExplicitGrant: false,
    }, name);
    const brokenAudit = {
      auditEmitter: {
        emit: () => {
          throw new Error("audit sink down");
        },
      } as unknown as AuditEmitter,
    };
    const events: WebhookEvent[] = [];
    const coalescer = new WebhookRejectionCoalescer();
    const service = new WebhookService({
      repoDir: h.opened.repoDir,
      repoContext: h.opened.repoContext,
      datastoreConfig: h.opened.datastoreConfig,
      endpoints: [await parseWebhookFlag(`/hooks/gh:${name}:${SECRET}`)],
      syncService: h.opened.syncService,
      syncGate: undefined,
      initiatedBy: principalToString(WEBHOOK_PRINCIPAL),
      authorizeRun: createWebhookRunAuthorizer(h.authorizer, brokenAudit),
    });
    service.setEventHandler((event) => {
      auditWebhookEvent(brokenAudit, event, coalescer);
      events.push(event);
    });

    const response = await deliver(service);
    assertEquals(response?.status, 200);
    assertEquals(await response!.json(), { status: "queued", workflow: name });
    await waitFor(
      () => events.some((e) => e.kind === "webhook_started"),
      "webhook run started",
    );
    await service.stop();
  });
});
