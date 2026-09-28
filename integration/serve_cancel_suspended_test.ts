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
 * Integration tests for cancelling a suspended run through serve
 * (swamp-club#2514). A run suspended at a manual_approval gate, with no
 * process driving it, is cancelled through the HTTP cancel fallback and the
 * WebSocket workflow.cancel handler. Uses a real repository on disk and
 * grants loaded from a grants file. Also covers how the cancel serializes
 * with a resume, approve or reject of the same run in one serve process.
 */

import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import {
  handleWorkflowApprove,
  handleWorkflowCancel,
} from "../src/serve/handlers/workflow_handlers.ts";
import {
  type ActiveRun,
  ActiveRunRegistry,
} from "../src/serve/active_run_registry.ts";
import { RunEventBuffer } from "../src/serve/run_event_buffer.ts";
import { startDetachedResume } from "../src/serve/resume_launcher.ts";
import {
  cancelSuspendedRunInServe,
  SUSPENDED_RUN_BUSY_MESSAGE,
} from "../src/serve/suspended_run_cancel.ts";
import { RunCancelRegistry } from "../src/serve/run_cancel_registry.ts";
import { cancelExecution } from "../src/cli/commands/serve.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { parseGrantFile } from "../src/domain/access/grant_file.ts";
import {
  createFileGrantStore,
  reconcileAllFileGrants,
} from "../src/domain/access/grant_file_reconciler.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { validateGrantCondition } from "../src/infrastructure/cel/grant_condition_environment.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const GATE = "approve-deploy";

/** An operator who may run the gated workflows, and one limited to others. */
const GRANTS_FILE = `grants:
  - subject: user:operator
    effect: allow
    actions: [run, read]
    resource: "workflow:cancel-gated-*"
  - subject: user:outsider
    effect: allow
    actions: [run, read]
    resource: "workflow:cancel-other-*"
`;

const OPERATOR: Principal = { kind: "user", id: "operator" };
const OUTSIDER: Principal = { kind: "user", id: "outsider" };

function gatedWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: GATE,
            task: StepTask.manualApproval("Approve the deploy"),
          }),
        ],
      }),
    ],
  });
}

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-cancel-suspended-" });
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

interface Harness {
  ctx: ConnectionContext;
  registry: ActiveRunRegistry;
  workflow: Workflow;
  other: Workflow;
  runId: string;
  loader: PolicySnapshotLoader;
  audit: AuditEvent[];
}

/**
 * Loads the grants file the way serve does, runs a gated workflow until it
 * suspends with a serve instance id, and builds a token-mode connection
 * context. `other` is a second workflow the outsider may run.
 */
async function suspendAtGate(repoDir: string): Promise<Harness> {
  const workflow = gatedWorkflow(`cancel-gated-${crypto.randomUUID()}`);
  const other = gatedWorkflow(`cancel-other-${crypto.randomUUID()}`);
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  await workflowRepo.save(workflow);
  await workflowRepo.save(other);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

  const grantsFile = join(resolved, "grants.yaml");
  const parsed = parseGrantFile(
    grantsFile,
    GRANTS_FILE,
    validateGrantCondition,
  );
  assertEquals(parsed.errors, []);
  await reconcileAllFileGrants(
    new Map([[grantsFile, parsed.entries]]),
    createFileGrantStore(
      repoContext.definitionRepo,
      new YamlDefinitionRepository(
        resolved,
        undefined,
        repoContext.autoDefinitionsDir,
        false,
        repoContext.markDirty,
      ),
      repoContext.unifiedDataRepo,
    ),
  );
  const loader = new PolicySnapshotLoader(
    repoContext.unifiedDataRepo,
    repoContext.eventBus,
    "manual",
  );
  await loader.load();

  const instanceId = crypto.randomUUID();
  let runId: string | undefined;
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflow.name, inputs: {}, instanceId },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "started") runId = event.runId;
    },
    syncService,
    undefined,
    { syncGate: undefined },
  );
  if (!runId) throw new Error("no run id observed");

  const authConfig: ServeAuthConfig = {
    mode: "token",
    admins: [],
    allowedCollectives: [],
    allowedUsers: [],
    oauthProvider: "",
    groupsField: "",
    restrictedModelTypes: [],
    restrictedCommands: [],
    approveRequiresExplicitGrant: false,
  };
  const audit: AuditEvent[] = [];
  const registry = new ActiveRunRegistry();
  const ctx = {
    repoDir: resolved,
    repoContext,
    datastoreConfig,
    authConfig,
    policySnapshotLoader: loader,
    activeRunRegistry: registry,
    instanceId,
    auditEmitter: { emit: (event: AuditEvent) => audit.push(event) },
    serveOptions: { autoResume: false } as MergedServeOptions,
  } as unknown as ConnectionContext;
  return { ctx, registry, workflow, other, runId, loader, audit };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  await withRepo(async (repoDir) => {
    const h = await suspendAtGate(repoDir);
    try {
      await fn(h);
    } finally {
      await h.loader.dispose();
    }
  });
}

interface Reply {
  type: string;
  payload?: { data: Record<string, unknown> };
  error?: { code: string; message: string };
}

async function cancelOverWs(
  h: Harness,
  principal: Principal,
  payload: { runId?: string; workflowIdOrName?: string } = {},
): Promise<Reply[]> {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
  } as unknown as WebSocket;
  await handleWorkflowCancel(
    socket,
    h.ctx,
    "cancel-1",
    { runId: h.runId, reason: "stuck gate", ...payload },
    new AbortController(),
    principal,
  );
  return sent.map((s) => JSON.parse(s));
}

async function loadRun(h: Harness): Promise<WorkflowRun | null> {
  return await h.ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(h.workflow.id),
    createWorkflowRunId(h.runId),
  );
}

function registeredResume(h: Harness): ActiveRun {
  return {
    runId: h.runId,
    kind: "workflow-resume",
    resourceName: h.workflow.name,
    buffer: new RunEventBuffer(10),
    controller: new AbortController(),
    startedAt: new Date(),
    completion: new Promise<void>(() => {}),
    principalId: null,
  };
}

const testOpts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  ...testOpts,
  name: "serve cancel: a serve-owned suspended run is cancelled over WebSocket",
  fn: () =>
    withHarness(async (h) => {
      assertEquals((await loadRun(h))?.instanceId, h.ctx.instanceId);
      assertEquals((await loadRun(h))?.status, "suspended");

      const replies = await cancelOverWs(h, OPERATOR);

      assertEquals(replies.length, 1);
      assertEquals(replies[0].type, "workflow.cancel", JSON.stringify(replies));
      assertEquals(replies[0].payload?.data, {
        runId: h.runId,
        workflowName: h.workflow.name,
        status: "cancelled",
      });
      const run = await loadRun(h);
      assertEquals(run?.status, "cancelled");
      assertEquals(
        run?.tags["cancel_reason"],
        "stuck gate (cancelled by user:operator)",
      );
      assertEquals(h.registry.reserve(h.runId) !== null, true);
    }),
});

Deno.test({
  ...testOpts,
  name:
    "serve cancel: a refused, missing or mismatched run gets one identical not-found reply",
  fn: () =>
    withHarness(async (h) => {
      const notFound = (id: string) => ({
        code: "workflow_cancel_failed",
        message: `No cancellable run with id ${id}`,
      });

      const denied = await cancelOverWs(h, OUTSIDER);
      assertEquals(denied.map((r) => r.error), [notFound(h.runId)]);

      // The outsider may run `other`, but the run belongs to `workflow`.
      const mismatched = await cancelOverWs(h, OUTSIDER, {
        workflowIdOrName: h.other.name,
      });
      assertEquals(mismatched.map((r) => r.error), [notFound(h.runId)]);

      const missingId = crypto.randomUUID();
      const missing = await cancelOverWs(h, OPERATOR, { runId: missingId });
      assertEquals(missing.map((r) => r.error), [notFound(missingId)]);

      for (const reply of [...denied, ...mismatched]) {
        assert(!JSON.stringify(reply).includes(h.workflow.name));
      }
      assertEquals((await loadRun(h))?.status, "suspended");
      const denials = h.audit.filter((e) => e.outcome === "denied");
      assertEquals(denials.length, 1);
      assertEquals(denials[0].resourceName, h.workflow.name);
    }),
});

Deno.test({
  ...testOpts,
  name: "serve cancel: the HTTP fallback cancels a suspended run by id alone",
  fn: () =>
    withHarness(async (h) => {
      const result = await cancelExecution("workflow-run", h.runId, {
        cancelRegistry: new RunCancelRegistry(),
        activeRunRegistry: h.registry,
        cancelSuspended: (id) =>
          cancelSuspendedRunInServe(
            h.ctx,
            { runId: id, reason: "cancelled via serve API" },
            () => true,
          ),
      });

      assertEquals(result.status, "cancelled");
      assertEquals((await loadRun(h))?.status, "cancelled");

      const again = await cancelExecution("workflow-run", h.runId, {
        cancelRegistry: new RunCancelRegistry(),
        activeRunRegistry: h.registry,
        cancelSuspended: (id) =>
          cancelSuspendedRunInServe(h.ctx, { runId: id, reason: "r" }, () =>
            true),
      });
      assertEquals(again.status, "not_found");
    }),
});

Deno.test({
  ...testOpts,
  name:
    "serve cancel: a resume registered first is aborted and its record is not overwritten",
  fn: () =>
    withHarness(async (h) => {
      const resume = registeredResume(h);
      h.registry.register(resume);

      const replies = await cancelOverWs(h, OPERATOR);

      assertEquals(replies[0].type, "workflow.cancel", JSON.stringify(replies));
      assertEquals(replies[0].payload?.data.status, "cancellation_requested");
      assertEquals(resume.controller.signal.aborted, true);
      const reason = resume.controller.signal.reason;
      assertEquals(
        reason instanceof Error ? reason.message : reason,
        "stuck gate (cancelled by user:operator)",
      );
      assertEquals((await loadRun(h))?.status, "suspended");
    }),
});

Deno.test({
  ...testOpts,
  name: "serve cancel: a refused caller cannot abort a registered resume",
  fn: () =>
    withHarness(async (h) => {
      const resume = registeredResume(h);
      h.registry.register(resume);

      const replies = await cancelOverWs(h, OUTSIDER);

      assertEquals(replies.map((r) => r.error?.code), [
        "workflow_cancel_failed",
      ]);
      assert(!JSON.stringify(replies).includes(h.workflow.name));
      assertEquals(resume.controller.signal.aborted, false);
    }),
});

Deno.test({
  ...testOpts,
  name:
    "serve cancel: a held reservation refuses a resume, an approve and a second cancel",
  fn: () =>
    withHarness(async (h) => {
      const release = h.registry.reserve(h.runId);
      if (!release) throw new Error("expected a reservation");
      try {
        const resumed = await startDetachedResume(h.ctx, h.registry, {
          workflowIdOrName: h.workflow.name,
          runId: h.runId,
          principalId: null,
        });
        assertEquals(resumed.ok, false);
        if (!resumed.ok) {
          assertEquals(resumed.code, "reserved");
          assertEquals(resumed.message, SUSPENDED_RUN_BUSY_MESSAGE);
        }

        const sent: string[] = [];
        await handleWorkflowApprove(
          {
            readyState: WebSocket.OPEN,
            send: (data: string) => sent.push(data),
          } as unknown as WebSocket,
          h.ctx,
          "approve-1",
          { workflowIdOrName: h.workflow.name, stepName: GATE },
          new AbortController(),
          OPERATOR,
        );
        const approved = sent.map((s) => JSON.parse(s) as Reply);
        assertEquals(approved.map((r) => r.error?.message), [
          SUSPENDED_RUN_BUSY_MESSAGE,
        ]);
        assertEquals(
          (await loadRun(h))?.getJob("main")?.getStep(GATE)?.status,
          "waiting_approval",
        );

        const cancelled = await cancelOverWs(h, OPERATOR);
        assertEquals(cancelled.map((r) => r.error?.message), [
          SUSPENDED_RUN_BUSY_MESSAGE,
        ]);
        assertEquals((await loadRun(h))?.status, "suspended");
      } finally {
        release();
      }
    }),
});

Deno.test({
  ...testOpts,
  name: "serve cancel: a resume attempted after the cancel refuses the run",
  fn: () =>
    withHarness(async (h) => {
      await cancelOverWs(h, OPERATOR);

      const resumed = await startDetachedResume(h.ctx, h.registry, {
        workflowIdOrName: h.workflow.name,
        runId: h.runId,
        suspendedOnly: true,
        principalId: null,
      });

      assertEquals(resumed.ok, false);
      assertEquals((await loadRun(h))?.status, "cancelled");
      assertEquals(h.registry.get(h.runId), undefined);
    }),
});

Deno.test({
  ...testOpts,
  name: "serve cancel: a failed save still releases the reservation",
  fn: () =>
    withHarness(async (h) => {
      const runRepo = h.ctx.repoContext.workflowRunRepo;
      const failing = Object.create(runRepo);
      failing.save = () => Promise.reject(new Error("disk full"));
      const ctx = {
        ...h.ctx,
        repoContext: { ...h.ctx.repoContext, workflowRunRepo: failing },
      } as ConnectionContext;

      let threw = false;
      try {
        await cancelSuspendedRunInServe(
          ctx,
          { runId: h.runId, reason: "r" },
          () => true,
        );
      } catch {
        threw = true;
      }

      assertEquals(threw, true);
      const release = h.registry.reserve(h.runId);
      assertEquals(release !== null, true);
      release?.();
      assertEquals((await loadRun(h))?.status, "suspended");
    }),
});
