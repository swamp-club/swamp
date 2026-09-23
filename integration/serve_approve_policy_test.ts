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
 * Integration tests for the approval policy (swamp-club#2384): a run
 * suspended at a manual_approval gate, decided through the serve handlers,
 * with grants loaded from a grants file into a real repository on disk. By
 * default a run grant also permits deciding the gate; with
 * approveRequiresExplicitGrant a principal needs a grant that names approve.
 */

import { join } from "@std/path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
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
  handleWorkflowApprove,
  handleWorkflowReject,
} from "../src/serve/handlers/workflow_handlers.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import type { Principal } from "../src/domain/access/principal.ts";
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

/** The reporter's shape: a machine principal granted run and read only. */
const GRANTS_FILE = `grants:
  - subject: user:swamp-resumer
    effect: allow
    actions: [run, read]
    resource: "workflow:*"
  - subject: user:release-approver
    effect: allow
    actions: [approve]
    resource: "workflow:*"
`;

const RESUMER: Principal = { kind: "user", id: "swamp-resumer" };
const APPROVER: Principal = { kind: "user", id: "release-approver" };

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
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-approve-policy-" });
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
  workflow: Workflow;
  runId: string;
  loader: PolicySnapshotLoader;
}

/**
 * Loads the grants file the way serve does, runs the workflow until it
 * suspends at its gate, and builds a token-mode connection context whose
 * policy loader applies the given approval policy.
 */
async function suspendAtGate(
  repoDir: string,
  approveRequiresExplicitGrant: boolean,
): Promise<Harness> {
  const workflow = gatedWorkflow(`approve-policy-${crypto.randomUUID()}`);
  await new YamlWorkflowRepository(repoDir).save(workflow);
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
    { runImpliesApprove: !approveRequiresExplicitGrant },
  );
  await loader.load();

  let runId: string | undefined;
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflow.name, inputs: {} },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "started") runId = event.runId;
    },
    syncService,
  );
  if (!runId) throw new Error("no run id observed");

  const authConfig: ServeAuthConfig = {
    mode: "token",
    admins: ["user:admin"],
    allowedCollectives: [],
    allowedUsers: [],
    oauthProvider: "",
    groupsField: "",
    restrictedModelTypes: [],
    restrictedCommands: [],
    approveRequiresExplicitGrant,
  };
  const ctx = {
    repoDir: resolved,
    repoContext,
    datastoreConfig,
    authConfig,
    policySnapshotLoader: loader,
    activeRunRegistry: new ActiveRunRegistry(),
    serveOptions: { autoResume: false } as MergedServeOptions,
  } as ConnectionContext;
  return { ctx, workflow, runId, loader };
}

interface Reply {
  type: string;
  error?: { code: string; message: string };
}

function mockSocket(): { socket: WebSocket; replies: () => Reply[] } {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
  } as unknown as WebSocket;
  return { socket, replies: () => sent.map((s) => JSON.parse(s)) };
}

async function approve(h: Harness, principal: Principal): Promise<Reply> {
  const { socket, replies } = mockSocket();
  await handleWorkflowApprove(
    socket,
    h.ctx,
    "approve-1",
    { workflowIdOrName: h.workflow.name, stepName: GATE, runId: h.runId },
    new AbortController(),
    principal,
  );
  return replies()[0];
}

async function reject(h: Harness, principal: Principal): Promise<Reply> {
  const { socket, replies } = mockSocket();
  await handleWorkflowReject(
    socket,
    h.ctx,
    "reject-1",
    { workflowIdOrName: h.workflow.name, stepName: GATE, runId: h.runId },
    new AbortController(),
    principal,
  );
  return replies()[0];
}

async function gate(
  h: Harness,
): Promise<{ status?: string; decidedBy?: string; approved?: boolean }> {
  const run = await h.ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(h.workflow.id),
    createWorkflowRunId(h.runId),
  );
  const step = run?.getJob("main")?.getStep(GATE);
  return {
    status: step?.status,
    decidedBy: step?.approvalDecision?.decidedBy,
    approved: step?.approvalDecision?.approved,
  };
}

Deno.test({
  name:
    "approve policy: by default a run-only principal can decide a gate (unchanged semantics)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const h = await suspendAtGate(repoDir, false);
      try {
        const reply = await approve(h, RESUMER);
        assertEquals(reply.type, "workflow.approve", JSON.stringify(reply));
        const decided = await gate(h);
        assertEquals(decided.approved, true);
        assertEquals(decided.decidedBy, "user:swamp-resumer");
      } finally {
        await h.loader.dispose();
      }
    });
  },
});

Deno.test({
  name:
    "approve policy: with an explicit grant required, a run-only principal cannot approve and the gate keeps waiting",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const h = await suspendAtGate(repoDir, true);
      try {
        const denied = await approve(h, RESUMER);
        assertEquals(denied.type, "error", JSON.stringify(denied));
        assertStringIncludes(denied.error!.message, "Access denied");
        assertEquals(await gate(h), {
          status: "waiting_approval",
          decidedBy: undefined,
          approved: undefined,
        });

        const allowed = await approve(h, APPROVER);
        assertEquals(allowed.type, "workflow.approve", JSON.stringify(allowed));
        const decided = await gate(h);
        assertEquals(decided.approved, true);
        assertEquals(decided.decidedBy, "user:release-approver");
      } finally {
        await h.loader.dispose();
      }
    });
  },
});

Deno.test({
  name:
    "approve policy: with an explicit grant required, a run-only principal cannot reject either",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const h = await suspendAtGate(repoDir, true);
      try {
        const denied = await reject(h, RESUMER);
        assertEquals(denied.type, "error", JSON.stringify(denied));
        assertEquals((await gate(h)).status, "waiting_approval");

        const allowed = await reject(h, APPROVER);
        assertEquals(allowed.type, "workflow.reject", JSON.stringify(allowed));
        const decided = await gate(h);
        assertEquals(decided.approved, false);
        assertEquals(decided.decidedBy, "user:release-approver");
      } finally {
        await h.loader.dispose();
      }
    });
  },
});
