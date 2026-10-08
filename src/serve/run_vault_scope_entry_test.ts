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
 * Serve's run entry points enter the vault scope of the principal that
 * triggered the run (swamp-club#2676): both `model.method.run` paths,
 * `workflow.run`, and resumes — which are held to the run's recorded
 * principal, never the resumer, and fail closed when the run recorded none.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import {
  createConditionEvaluator,
  type PolicySnapshotLoader,
} from "../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../domain/access/principal.ts";
import type { ServeAuthConfig } from "../domain/access/serve_auth_config.ts";
import { Definition } from "../domain/definitions/definition.ts";
import type { Grant } from "../domain/models/access/grant_model.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import { currentVaultAccess } from "../domain/vaults/run_vault_access.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { requireInitializedRepoUnlocked } from "../cli/repo_context.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../infrastructure/persistence/yaml_workflow_repository.ts";
import { ActiveRunRegistry } from "./active_run_registry.ts";
import { handleModelMethodRun } from "./handlers/model_handlers.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import {
  handleWorkflowResume,
  handleWorkflowRun,
} from "./handlers/workflow_handlers.ts";
import "../domain/models/models.ts";

await initializeLogging({});

/** What the probe method saw of its run's vault scope. */
interface Probe {
  scoped: boolean;
  erp?: boolean;
  roomcontrol?: boolean;
}

const BOT: Principal = { kind: "user", id: "bot" };
const ROOT: Principal = { kind: "user", id: "root" };

function grant(overrides: Partial<Grant>): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "bot" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "model", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** bot runs anything and reads only vault:roomcontrol; root runs anything. */
const GRANTS: Grant[] = [
  grant({}),
  grant({ resource: { kind: "workflow", pattern: "*" } }),
  grant({
    actions: ["read"],
    resource: { kind: "vault", pattern: "roomcontrol" },
  }),
  grant({ subject: { kind: "user", name: "root" } }),
  grant({
    subject: { kind: "user", name: "root" },
    resource: { kind: "workflow", pattern: "*" },
  }),
];

const AUTH: ServeAuthConfig = {
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
};

function mockSocket(): WebSocket & { sent: string[] } {
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

interface Harness {
  ctx: ConnectionContext;
  probes: Probe[];
  audits: AuditEvent[];
  /** Calls to the probe that fail before recording. */
  failNext: { count: number };
  definitionName: string;
}

async function withHarness(
  fn: (h: Harness) => Promise<void>,
  options: { registry?: boolean } = {},
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-run-vault-" });
  const type = ModelType.create(`test/vault-probe-${crypto.randomUUID()}`);
  const probes: Probe[] = [];
  const failNext = { count: 0 };
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    globalArguments: z.object({}),
    resources: {},
    methods: {
      probe: {
        description: "records the run's vault scope",
        kind: "read",
        arguments: z.object({}),
        execute: async () => {
          if (failNext.count > 0) {
            failNext.count--;
            throw new Error("probe failed on purpose");
          }
          const access = currentVaultAccess();
          probes.push({
            scoped: access !== undefined,
            erp: access && (await access.decide("erp", "read")).allowed,
            roomcontrol: access &&
              (await access.decide("roomcontrol", "read")).allowed,
          });
          // A refused read is audited.
          await access?.check("erp", "read", "password").catch(() => {});
          return {};
        },
      },
    },
  });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const definitionName = "probe-instance";
    await new YamlDefinitionRepository(repoDir).save(
      type,
      Definition.create({ name: definitionName, type: type.normalized }),
    );
    const { repoDir: resolved, repoContext, datastoreConfig } =
      await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
    const decisionService = new GrantBasedAccessDecisionService(
      new PolicySnapshot(GRANTS, [], createConditionEvaluator()),
    );
    const audits: AuditEvent[] = [];
    const ctx = {
      repoDir: resolved,
      repoContext,
      datastoreConfig,
      authConfig: AUTH,
      policySnapshotLoader: {
        decisionService,
        snapshot: decisionService.snapshot,
      } as unknown as PolicySnapshotLoader,
      auditEmitter: {
        emit: (event: AuditEvent) => audits.push(event),
      } as unknown as AuditEmitter,
      activeRunRegistry: options.registry ? new ActiveRunRegistry() : undefined,
      instanceId: crypto.randomUUID(),
    } as ConnectionContext;
    await fn({ ctx, probes, audits, failNext, definitionName });
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

const BOT_SCOPE: Probe = { scoped: true, erp: false, roomcontrol: true };

for (const registry of [false, true]) {
  const branch = registry ? "detached" : "attached";
  Deno.test({
    name:
      `handleModelMethodRun: the ${branch} path runs the method in the caller's vault scope`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () =>
      withHarness(async ({ ctx, probes, audits, definitionName }) => {
        const socket = mockSocket();
        await handleModelMethodRun(
          socket,
          ctx,
          "req-1",
          { modelIdOrName: definitionName, methodName: "probe" },
          new AbortController(),
          BOT,
        );
        await waitFor(() => probes.length === 1, "probe ran");
        assertEquals(probes[0], BOT_SCOPE);
        await waitFor(() => audits.length === 1, "refusal audited");
        assertEquals(audits[0].category, "secrets");
        assertEquals(audits[0].resourceName, "erp");
      }, { registry }),
  });
}

function probeWorkflow(name: string, definitionName: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "probe",
            task: StepTask.model(definitionName, "probe"),
          }),
        ],
      }),
    ],
  });
}

async function runAs(
  ctx: ConnectionContext,
  workflow: Workflow,
  principal: Principal,
): Promise<string> {
  await new YamlWorkflowRepository(ctx.repoDir).save(workflow);
  const socket = mockSocket();
  await handleWorkflowRun(
    socket,
    ctx,
    "run-1",
    { workflowIdOrName: workflow.name },
    new AbortController(),
    principal,
  );
  const started = socket.sent.map((s) => JSON.parse(s)).find((f) =>
    f.type === "event" && f.event?.kind === "started"
  );
  return started.event.runId as string;
}

async function loadRun(
  ctx: ConnectionContext,
  workflow: Workflow,
  runId: string,
): Promise<WorkflowRun | null> {
  return await ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(runId),
  );
}

Deno.test({
  name:
    "handleWorkflowRun: runs steps in the caller's vault scope and records the triggering principal",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withHarness(async ({ ctx, probes, audits, definitionName }) => {
      const workflow = probeWorkflow("vault-scope-run", definitionName);
      const runId = await runAs(ctx, workflow, BOT);
      assertEquals(probes, [BOT_SCOPE]);
      const run = await loadRun(ctx, workflow, runId);
      assertEquals(run?.triggeringPrincipal, {
        kind: "user",
        id: "bot",
        membership: { localGroups: [], idpGroups: [], collectives: [] },
      });
      assertEquals(audits.length, 1);
      assertEquals(audits[0].detail?.includes(`run=${runId}`), true);
    }),
});

for (const registry of [false, true]) {
  const branch = registry ? "detached" : "attached";
  Deno.test({
    name:
      `handleWorkflowResume: the ${branch} resume is held to the triggering principal, not the resumer`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () =>
      withHarness(async ({ ctx, probes, failNext, definitionName }) => {
        const workflow = probeWorkflow(
          `vault-resume-${branch}`,
          definitionName,
        );
        failNext.count = 1;
        const runId = await runAs(ctx, workflow, BOT);
        assertEquals((await loadRun(ctx, workflow, runId))?.status, "failed");
        // root holds no vault grant: in its own scope erp would be readable.
        await handleWorkflowResume(
          mockSocket(),
          ctx,
          "resume-1",
          { workflowIdOrName: workflow.name, runId },
          new AbortController(),
          ROOT,
        );
        await waitFor(() => probes.length === 1, "resumed probe ran");
        assertEquals(probes[0], BOT_SCOPE);
      }, { registry }),
  });

  Deno.test({
    name:
      `handleWorkflowResume: the ${branch} resume of a run that recorded no principal fails closed`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () =>
      withHarness(async ({ ctx, probes, failNext, definitionName }) => {
        const workflow = probeWorkflow(
          `vault-resume-legacy-${branch}`,
          definitionName,
        );
        failNext.count = 1;
        const runId = await runAs(ctx, workflow, BOT);
        // As an older release or replica would have saved it.
        const run = await loadRun(ctx, workflow, runId);
        const { triggeringPrincipal: _dropped, ...legacy } = run!.toData();
        await ctx.repoContext.workflowRunRepo.save(
          createWorkflowId(workflow.id),
          WorkflowRun.fromData(legacy),
        );
        await handleWorkflowResume(
          mockSocket(),
          ctx,
          "resume-1",
          { workflowIdOrName: workflow.name, runId },
          new AbortController(),
          ROOT,
        );
        await waitFor(() => probes.length === 1, "resumed probe ran");
        assertEquals(probes[0], {
          scoped: true,
          erp: false,
          roomcontrol: false,
        });
      }, { registry }),
  });
}
