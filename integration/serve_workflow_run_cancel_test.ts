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

import { join } from "@std/path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import {
  type ActiveRun,
  ActiveRunRegistry,
} from "../src/serve/active_run_registry.ts";
import { RunEventBuffer } from "../src/serve/run_event_buffer.ts";
import {
  type ExecutionType,
  RunCancelRegistry,
} from "../src/serve/run_cancel_registry.ts";
import {
  authorizeCancelRequest,
  respondToRunCancel,
} from "../src/cli/commands/serve.ts";
import {
  handleWorkflowCancel,
  handleWorkflowRun,
} from "../src/serve/handlers/workflow_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { parseGrantFile } from "../src/domain/access/grant_file.ts";
import { principalEntries } from "../src/domain/access/grant_file_test_helpers.ts";
import {
  createFileGrantStore,
  reconcileAllFileGrants,
} from "../src/domain/access/grant_file_reconciler.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { validateGrantCondition } from "../src/infrastructure/cel/grant_condition_environment.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const testOpts = { sanitizeOps: false, sanitizeResources: false };

const GRANTS_FILE = `grants:
  - subject: user:alice
    effect: allow
    actions: [run, approve, read]
    resource: "workflow:*"
  - subject: user:alice
    effect: deny
    actions: [approve]
    resource: "workflow:*"
    condition: "principal.sub == run.initiator.sub"
  - subject: user:bob
    effect: allow
    actions: [run, approve, read]
    resource: "workflow:*"
  - subject: user:zoe
    effect: allow
    actions: [read]
    resource: "workflow:*"
  - subject: user:zoe
    effect: allow
    actions: [approve]
    resource: "workflow:*"
    condition: 'run.initiator.sub == "nobody"'
  - subject: user:frank
    effect: allow
    actions: [run, read]
    resource: "workflow:gated-*"
  - subject: user:frank
    effect: allow
    actions: [run, read]
    resource: "workflow:parent-*"
  - subject: user:root
    effect: allow
    actions: [admin]
    resource: "access:*"
  - subject: user:ruth
    effect: allow
    actions: [admin]
    resource: "access:*"
  - subject: user:ruth
    effect: deny
    actions: [run]
    resource: "workflow:*"
`;

const user = (id: string): Principal => ({ kind: "user", id });

function gated(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "gate",
        task: StepTask.manualApproval("ok?"),
      })],
    })],
  });
}

interface Harness {
  ctx: ConnectionContext;
  cancelRegistry: RunCancelRegistry;
  registry: ActiveRunRegistry;
  audit: AuditEvent[];
  repoDir: string;
  gatedName: string;
  gatedId: string;
  otherName: string;
  otherId: string;
  parentName: string;
  childName: string;
  start(
    name: string,
    initiatedBy?: string,
  ): Promise<{ runId: string; childId?: string }>;
  status(workflowName: string, runId: string): Promise<string | undefined>;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-cancel-" });
  try {
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const gatedWorkflow = gated(`gated-${crypto.randomUUID()}`);
    const other = gated(`other-${crypto.randomUUID()}`);
    const child = gated(`child-${crypto.randomUUID()}`);
    const parent = Workflow.create({
      name: `parent-${crypto.randomUUID()}`,
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "nested",
          task: StepTask.workflow(child.name),
        })],
      })],
    });
    const workflowRepo = new YamlWorkflowRepository(dir);
    for (const w of [gatedWorkflow, other, child, parent]) {
      await workflowRepo.save(w);
    }
    const { repoDir, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({
        repoDir: dir,
        outputMode: "log",
      });
    const grantsFile = join(repoDir, "grants.yaml");
    const parsed = parseGrantFile(
      grantsFile,
      GRANTS_FILE,
      validateGrantCondition,
    );
    assertEquals(parsed.errors, []);
    await reconcileAllFileGrants(
      new Map([[grantsFile, principalEntries(parsed.entries)]]),
      createFileGrantStore(
        repoContext.definitionRepo,
        new YamlDefinitionRepository(
          repoDir,
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
      signalRequiresExplicitGrant: false,
      tagRequiresExplicitGrant: false,
    };
    const instanceId = crypto.randomUUID();
    const audit: AuditEvent[] = [];
    const registry = new ActiveRunRegistry();
    const cancelRegistry = new RunCancelRegistry();
    const ctx = {
      repoDir,
      repoContext,
      datastoreConfig,
      datastoreResolver: {
        resolvePath: (subdir: string) => join(repoDir, ".swamp", subdir),
      },
      authConfig,
      policySnapshotLoader: loader,
      activeRunRegistry: registry,
      cancelRegistry,
      instanceId,
      auditEmitter: { emit: (event: AuditEvent) => audit.push(event) },
      serveOptions: { autoResume: false } as MergedServeOptions,
    } as unknown as ConnectionContext;
    try {
      await fn({
        ctx,
        cancelRegistry,
        registry,
        audit,
        repoDir,
        gatedName: gatedWorkflow.name,
        gatedId: gatedWorkflow.id,
        otherName: other.name,
        otherId: other.id,
        parentName: parent.name,
        childName: child.name,
        start: async (name, initiatedBy) => {
          let runId: string | undefined;
          let childId: string | undefined;
          await executeWorkflowWithLocks(
            repoDir,
            repoContext,
            datastoreConfig,
            { workflowIdOrName: name, inputs: {}, instanceId },
            new AbortController().signal,
            (event: WorkflowRunEvent) => {
              if (event.kind !== "started") return;
              if (event.parentRunId === undefined) runId = event.runId;
              else childId = event.runId;
            },
            syncService,
            undefined,
            { syncGate: undefined, initiatedBy },
          );
          if (!runId) throw new Error("no run id observed");
          return { runId, childId };
        },
        status: async (workflowName, runId) => {
          const workflow = await repoContext.workflowRepo.findByName(
            workflowName,
          );
          const run = await repoContext.workflowRunRepo.findById(
            createWorkflowId(workflow!.id),
            createWorkflowRunId(runId),
          );
          return run?.status;
        },
      });
    } finally {
      await loader.dispose();
    }
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// the route's two steps, as serve.ts runs them on the leader
async function post(
  h: Harness,
  who: string,
  executionId: string,
  executionType: ExecutionType = "workflow-run",
): Promise<Response> {
  const principal = user(who);
  const base = {
    principal,
    collectives: [],
    groups: [],
    sourceIp: "10.0.0.1",
    client: "direct:token",
  };
  const authorized = authorizeCancelRequest(
    h.ctx,
    h.ctx.policySnapshotLoader,
    { ...base, execution: { type: executionType, id: executionId } },
  );
  if ("refusal" in authorized) return authorized.refusal;
  return await respondToRunCancel(
    h.ctx,
    {
      req: new Request("http://serve.test/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      executionType,
      executionId,
      authority: authorized.authority,
      caller: base,
    },
    { cancelRegistry: h.cancelRegistry, activeRunRegistry: h.registry },
  );
}

async function overWs(
  h: Harness,
  who: string,
  runId: string,
  workflowIdOrName?: string,
) {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
  } as unknown as WebSocket;
  await handleWorkflowCancel(
    socket,
    h.ctx,
    "cancel-1",
    { runId, workflowIdOrName },
    new AbortController(),
    user(who),
  );
  return sent.map((s) => JSON.parse(s));
}

async function bodyWithoutId(response: Response, id: string) {
  return {
    status: response.status,
    body: (await response.text()).replaceAll(id, "<id>"),
  };
}

function activeRun(
  runId: string,
  kind: ActiveRun["kind"],
  resourceName: string,
  resourceId?: string,
) {
  const controller = new AbortController();
  return {
    controller,
    run: {
      runId,
      kind,
      resourceName,
      resourceId,
      buffer: new RunEventBuffer(16),
      controller,
      startedAt: new Date(),
      completion: new Promise<void>(() => {}),
      principalId: null,
      completedRun: {},
    } as ActiveRun,
  };
}

Deno.test({
  name: "per-run cancel: a run holder cancels their own run through the route",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const { runId } = await h.start(h.gatedName, "user:alice");
      const response = await post(h, "alice", runId);
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.status, "cancelled");
      assertEquals(body.reason, "cancelled by user:alice");
      assertEquals(await h.status(h.gatedName, runId), "cancelled");
    }),
});

Deno.test({
  name:
    "per-run cancel: run on the workflow reaches a colleague's run, as workflow.cancel does",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const viaRoute = await h.start(h.gatedName, "user:bob");
      assertEquals((await post(h, "alice", viaRoute.runId)).status, 200);
      assertEquals(await h.status(h.gatedName, viaRoute.runId), "cancelled");
      const viaWs = await h.start(h.gatedName, "user:bob");
      assertEquals(
        (await overWs(h, "alice", viaWs.runId))[0].payload.data.status,
        "cancelled",
      );
    }),
});

Deno.test({
  name:
    "per-run cancel: refused, missing, malformed and another workflow's run answer identically and change nothing",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const { runId } = await h.start(h.gatedName, "user:alice");
      const { runId: otherRun } = await h.start(h.otherName, "user:alice");
      const missing = crypto.randomUUID();
      const expected = {
        status: 404,
        body: JSON.stringify({
          status: "not_found",
          message: "No cancellable workflow-run with id <id>",
        }),
      };
      for (const who of ["dan", "zoe"]) {
        assertEquals(
          await bodyWithoutId(await post(h, who, runId), runId),
          expected,
          who,
        );
        assertEquals(
          await bodyWithoutId(await post(h, who, missing), missing),
          expected,
          who,
        );
        assertEquals(
          await bodyWithoutId(await post(h, who, "not-a-uuid"), "not-a-uuid"),
          expected,
          who,
        );
      }
      assertEquals(
        await bodyWithoutId(await post(h, "frank", otherRun), otherRun),
        expected,
      );
      assertEquals(await h.status(h.gatedName, runId), "suspended");
      assertEquals(await h.status(h.otherName, otherRun), "suspended");
    }),
});

Deno.test({
  name:
    "per-run cancel: a finished run answers as a missing one, to a holder and an admin alike",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const { runId } = await h.start(h.gatedName, "user:alice");
      assertEquals((await post(h, "alice", runId)).status, 200);
      for (const who of ["alice", "root"]) {
        const again = await post(h, who, runId);
        assertEquals(again.status, 404, who);
        assertEquals(
          (await again.json()).message,
          `No cancellable workflow-run with id ${runId}`,
        );
      }
    }),
});

Deno.test({
  name:
    "per-run cancel: an admin, and an admin denied run, cancel with no per-run decision",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      for (const who of ["root", "ruth"]) {
        const { runId } = await h.start(h.gatedName, "user:alice");
        assertEquals((await post(h, who, runId)).status, 200, who);
        assertEquals(await h.status(h.gatedName, runId), "cancelled");
      }
      assertEquals(h.audit.filter((e) => e.category === "access"), []);
    }),
});

Deno.test({
  name:
    "per-run cancel: bulk and method-run routes stay admin, with their 403 and audit",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const principal = user("alice");
      const base = { principal, collectives: [], groups: [], sourceIp: "ip" };
      for (
        const execution of [undefined, {
          type: "method-run" as const,
          id: crypto.randomUUID(),
        }]
      ) {
        const result = authorizeCancelRequest(
          h.ctx,
          h.ctx.policySnapshotLoader,
          { ...base, execution },
        );
        assert("refusal" in result);
        assertEquals(result.refusal.status, 403);
        assertEquals(await result.refusal.json(), {
          status: "error",
          message: "Access denied: cancel requires admin permission",
        });
      }
      assertEquals(h.audit.map((e) => [e.action, e.outcome, e.detail]), [
        ["cancel.all", "denied", "admin required"],
        ["cancel", "denied", "admin required"],
      ]);
    }),
});

Deno.test({
  name:
    "per-run cancel: serve's restricted commands bind the route for a run holder, not an admin",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      (h.ctx.authConfig as { restrictedCommands: string[] })
        .restrictedCommands = ["workflow.cancel"];
      const { runId } = await h.start(h.gatedName, "user:alice");
      const refused = await post(h, "alice", runId);
      assertEquals(refused.status, 403);
      assertStringIncludes(
        (await refused.json()).message,
        "workflow.cancel is restricted to admins",
      );
      assertEquals(await h.status(h.gatedName, runId), "suspended");
      assertEquals((await post(h, "root", runId)).status, 200);
    }),
});

Deno.test({
  name:
    "per-run cancel: a run holder is refused when the audit log cannot record it",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const ctx = h.ctx as unknown as Record<string, unknown>;
      ctx.auditFailOpen = false;
      ctx.auditWal = { isFull: true };
      const { runId } = await h.start(h.gatedName, "user:alice");
      assertEquals((await post(h, "alice", runId)).status, 503);
      assertEquals(await h.status(h.gatedName, runId), "suspended");
    }),
});

Deno.test({
  name:
    "per-run cancel: audits an allowed, a refused and an absent cancel with who and which client",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const { runId } = await h.start(h.gatedName, "user:alice");
      const missing = crypto.randomUUID();
      await post(h, "dan", runId);
      await post(h, "dan", missing);
      await post(h, "alice", runId);
      const rows = h.audit.map((e) => ({
        category: e.category,
        action: e.action,
        outcome: e.outcome,
        kind: e.resourceKind,
        name: e.resourceName,
        who: e.principalId,
        client: e.client,
        detail: e.detail,
      }));
      assertEquals(rows, [
        {
          category: "access",
          action: "run",
          outcome: "denied",
          kind: "workflow",
          name: h.gatedName,
          who: "dan",
          client: "direct:token",
          detail: "unauthorized",
        },
        {
          category: "execution",
          action: "cancel",
          outcome: "denied",
          kind: "workflow",
          name: runId,
          who: "dan",
          client: "direct:token",
          detail: "run required",
        },
        {
          category: "execution",
          action: "cancel",
          outcome: "failure",
          kind: "workflow",
          name: missing,
          who: "dan",
          client: "direct:token",
          detail: `No cancellable workflow-run with id ${missing}`,
        },
        {
          category: "execution",
          action: "cancel",
          outcome: "success",
          kind: "workflow",
          name: runId,
          who: "alice",
          client: "direct:token",
          detail: "cancelled",
        },
      ]);
      assertEquals(h.audit[0].requestId, h.audit[1].requestId);
    }),
});

function fakeTriggerHolder(runId: string, name: string, id?: string) {
  const aborted: string[] = [];
  return {
    aborted,
    holder: {
      workflowOfRun: (r: string) => r === runId ? { id, name } : undefined,
      cancelByRunId: (r: string) => {
        if (r !== runId) return false;
        aborted.push(r);
        return true;
      },
    },
  };
}

const HOLDER_KINDS = ["attached", "scheduled", "webhook", "active"] as const;

function holdRun(
  h: Harness,
  kind: typeof HOLDER_KINDS[number],
  runId: string,
  name: string,
  id: string,
): () => boolean {
  const ctx = h.ctx as unknown as Record<string, unknown>;
  if (kind === "attached") {
    const controller = new AbortController();
    h.cancelRegistry.register("workflow-run", runId, controller, { id, name });
    return () => controller.signal.aborted;
  }
  if (kind === "active") {
    const { run, controller } = activeRun(runId, "workflow-run", name, id);
    h.registry.register(run);
    return () => controller.signal.aborted;
  }
  const { holder, aborted } = fakeTriggerHolder(runId, name, id);
  ctx[kind === "scheduled" ? "scheduledExecution" : "webhookRuns"] = holder;
  return () => aborted.length > 0;
}

for (const kind of HOLDER_KINDS) {
  Deno.test({
    name:
      `per-run cancel: a stored record under an allowed workflow does not authorize aborting a ${kind} run of another`,
    ...testOpts,
    fn: () =>
      withHarness(async (h) => {
        // frank holds run on the gated workflow's record, nothing on other
        const { runId } = await h.start(h.gatedName, "user:frank");
        const aborted = holdRun(h, kind, runId, h.otherName, h.otherId);
        const response = await post(h, "frank", runId);
        assertEquals(response.status, 404);
        assertEquals(aborted(), false);
        assertEquals(await h.status(h.gatedName, runId), "suspended");
        const replies = await overWs(h, "frank", runId);
        assertEquals(
          replies[0].error.message,
          `No cancellable run with id ${runId}`,
        );
        assertEquals(aborted(), false);
      }),
  });

  if (kind === "active") continue;
  Deno.test({
    name: `per-run cancel: a run holder aborts a ${kind} run on either route`,
    ...testOpts,
    fn: () =>
      withHarness(async (h) => {
        const viaRoute = crypto.randomUUID();
        const routeAborted = holdRun(h, kind, viaRoute, h.gatedName, h.gatedId);
        assertEquals((await post(h, "frank", viaRoute)).status, 200);
        assertEquals(routeAborted(), true);
        const viaWs = crypto.randomUUID();
        const wsAborted = holdRun(h, kind, viaWs, h.gatedName, h.gatedId);
        assertEquals(
          (await overWs(h, "frank", viaWs))[0].payload.data.status,
          "cancellation_requested",
        );
        assertEquals(wsAborted(), true);
      }),
  });
}

Deno.test({
  name:
    "per-run cancel: a method run held under the id is not a run holder's to abort",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const id = crypto.randomUUID();
      const { run, controller } = activeRun(id, "method-run", h.gatedName);
      h.registry.register(run);
      assertEquals((await post(h, "alice", id)).status, 404);
      assertEquals(controller.signal.aborted, false);
    }),
});

Deno.test({
  name:
    "per-run cancel: cancelling a parent cancels a child the caller has no grant on, and the reply names it only to a reader",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const hidden = await h.start(h.parentName, "user:bob");
      assert(hidden.childId);
      assertEquals((await post(h, "frank", hidden.childId)).status, 404);
      const response = await post(h, "frank", hidden.runId);
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.status, "cancelled");
      assertEquals(body.cancelledNestedRuns, undefined);
      assertEquals(await h.status(h.childName, hidden.childId), "cancelled");

      const shown = await h.start(h.parentName, "user:bob");
      const reader = await (await post(h, "bob", shown.runId)).json();
      assertEquals(
        reader.cancelledNestedRuns.map((r: { runId: string }) => r.runId),
        [shown.childId],
      );

      const asAdmin = await h.start(h.parentName, "user:bob");
      const admin = await (await post(h, "root", asAdmin.runId)).json();
      assertEquals(
        admin.cancelledNestedRuns.map((r: { runId: string }) => r.runId),
        [asAdmin.childId],
      );
      assertEquals(
        h.audit.filter((e) => e.action === "cancel" && e.outcome === "success")
          .map((e) => [e.resourceName, e.principalId]),
        [
          [hidden.runId, "frank"],
          [shown.runId, "bob"],
          [asAdmin.runId, "root"],
        ],
      );
    }),
});

Deno.test({
  name:
    "per-run cancel: a run that gains a holder while it is decided is decided again on the holder",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const { runId } = await h.start(h.gatedName, "user:frank");
      const repo = h.ctx.repoContext.workflowRepo;
      const findById = repo.findById.bind(repo);
      let aborted = () => false;
      let held = false;
      repo.findById = (...args: Parameters<typeof repo.findById>) => {
        if (!held) {
          held = true;
          aborted = holdRun(h, "attached", runId, h.otherName, h.otherId);
        }
        return findById(...args);
      };
      assertEquals((await post(h, "frank", runId)).status, 404);
      assertEquals(aborted(), false);
      assertEquals(await h.status(h.gatedName, runId), "suspended");
    }),
});

Deno.test({
  name:
    "per-run cancel: a grant revoked between the decision and the save refuses the stored run",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const { runId } = await h.start(h.gatedName, "user:alice");
      const service = h.ctx.policySnapshotLoader!.decisionService;
      let runDecisions = 0;
      const ctx = h.ctx as unknown as Record<string, unknown>;
      ctx.policySnapshotLoader = {
        decisionService: {
          decide: (...args: Parameters<typeof service.decide>) => {
            if (args[1] === "run" && ++runDecisions > 1) return null;
            return service.decide(...args);
          },
        },
      };
      assertEquals((await post(h, "alice", runId)).status, 404);
      assertEquals(await h.status(h.gatedName, runId), "suspended");
    }),
});

Deno.test({
  name:
    "per-run cancel: a lookup that fails answers as a missing run and is audited",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const { runId } = await h.start(h.gatedName, "user:alice");
      const repo = h.ctx.repoContext.workflowRunRepo;
      repo.findGlobalById = () =>
        Promise.reject(new Error("unreadable record"));
      const replied = await bodyWithoutId(await post(h, "dan", runId), runId);
      assertEquals(replied, {
        status: 404,
        body: JSON.stringify({
          status: "not_found",
          message: "No cancellable workflow-run with id <id>",
        }),
      });
      assertEquals(
        h.audit.map((e) => [e.action, e.outcome, e.principalId, e.detail]),
        [["cancel", "failure", "dan", "unreadable record"]],
      );
    }),
});

Deno.test({
  name:
    "per-run cancel: a held run renamed during the run is decided on its id, not the name another workflow took",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const runId = crypto.randomUUID();
      // the holder recorded a name frank holds run on, under other's id
      const aborted = holdRun(h, "scheduled", runId, h.gatedName, h.otherId);
      assertEquals((await post(h, "frank", runId)).status, 404);
      assertEquals(aborted(), false);
    }),
});

Deno.test({
  name: "per-run cancel: an attached run registers the workflow it runs",
  ...testOpts,
  fn: () =>
    withHarness(async (h) => {
      const ctx = h.ctx as unknown as Record<string, unknown>;
      delete ctx.activeRunRegistry;
      let held: unknown;
      const socket = {
        readyState: WebSocket.OPEN,
        send: (data: string) => {
          const frame = JSON.parse(data);
          if (frame.type === "event" && frame.event?.kind === "started") {
            held = h.cancelRegistry.workflowOf(
              "workflow-run",
              frame.event.runId,
            );
          }
        },
      } as unknown as WebSocket;
      await handleWorkflowRun(
        socket,
        h.ctx,
        "run-1",
        { workflowIdOrName: h.gatedName, inputs: {} },
        new AbortController(),
        user("alice"),
      );
      assertEquals(held, { id: h.gatedId, name: h.gatedName });
    }),
});
