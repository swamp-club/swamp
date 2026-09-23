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
 * Integration tests for auto-resume on approval (swamp-club#2377): a run
 * suspended at a manual_approval gate, approved through the serve handler,
 * against a real repository on disk. With auto-resume in effect, serve
 * continues the run itself and the post-gate step executes; without it, the
 * run stays suspended until someone resumes it.
 */

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { handleWorkflowApprove } from "../src/serve/handlers/workflow_handlers.ts";
import { autoResumeAfterApproval } from "../src/serve/resume_launcher.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const modeNone: ServeAuthConfig = {
  mode: "none",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
  restrictedModelTypes: [],
  restrictedCommands: [],
  approveRequiresExplicitGrant: false,
};

/** A gate, then a shell step that only runs once the gate is approved. */
function gatedWorkflow(name: string, autoResume?: boolean): Workflow {
  return Workflow.create({
    name,
    autoResume,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "approve-deploy",
            task: StepTask.manualApproval("Approve the deploy"),
          }),
          Step.create({
            name: "deploy",
            task: StepTask.directExecution(
              "command/shell",
              `${name}-shell`,
              "execute",
              { run: "echo post-gate-step-ran" },
            ),
            dependsOn: [{
              step: "approve-deploy",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      }),
    ],
  });
}

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-auto-resume-" });
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

interface MockSocket {
  sent: string[];
  readyState: number;
  send(data: string): void;
}

/**
 * Runs the workflow until it suspends at the gate, approves the gate through
 * the serve handler, and returns what the handler answered.
 */
async function suspendAndApprove(
  repoDir: string,
  workflow: Workflow,
  serveAutoResume: boolean,
): Promise<{
  ctx: ConnectionContext;
  registry: ActiveRunRegistry;
  runId: string;
  data: Record<string, unknown>;
}> {
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

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
    undefined,
    { syncGate: undefined },
  );
  if (!runId) throw new Error("no run id observed");

  const registry = new ActiveRunRegistry();
  const ctx = {
    repoDir: resolved,
    repoContext,
    datastoreConfig,
    authConfig: modeNone,
    activeRunRegistry: registry,
    serveOptions: { autoResume: serveAutoResume } as MergedServeOptions,
  } as ConnectionContext;

  const socket: MockSocket = {
    sent: [],
    readyState: WebSocket.OPEN,
    send(data: string) {
      this.sent.push(data);
    },
  };
  await handleWorkflowApprove(
    socket as unknown as WebSocket,
    ctx,
    "approve-1",
    { workflowIdOrName: workflow.name, stepName: "approve-deploy", runId },
    new AbortController(),
    null,
  );

  const reply = JSON.parse(socket.sent[0]);
  assertEquals(reply.type, "workflow.approve", JSON.stringify(reply));
  return { ctx, registry, runId, data: reply.payload.data };
}

async function runStatus(
  ctx: ConnectionContext,
  workflow: Workflow,
  runId: string,
): Promise<{ status?: string; deploy?: string }> {
  const run = await ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(runId),
  );
  return {
    status: run?.status,
    deploy: run?.getJob("main")?.getStep("deploy")?.status,
  };
}

Deno.test({
  name: "auto-resume: an opted-in run continues past its gate after approval",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = gatedWorkflow("auto-resume-opted-in", true);
      const { ctx, registry, runId, data } = await suspendAndApprove(
        repoDir,
        workflow,
        false,
      );

      assertEquals(data.autoResumed, true);
      await waitFor(
        async () =>
          (await runStatus(ctx, workflow, runId)).status === "succeeded",
        "auto-resumed run succeeds",
      );
      assertEquals((await runStatus(ctx, workflow, runId)).deploy, "succeeded");
      await waitFor(
        () => registry.get(runId) === undefined,
        "run deregistered",
      );
    });
  },
});

Deno.test({
  name:
    "auto-resume: the server flag covers a workflow that declares no inputs",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = gatedWorkflow("auto-resume-server-flag");
      const { ctx, registry, runId, data } = await suspendAndApprove(
        repoDir,
        workflow,
        true,
      );

      assertEquals(data.autoResumed, true);
      await waitFor(
        async () =>
          (await runStatus(ctx, workflow, runId)).status === "succeeded",
        "auto-resumed run succeeds",
      );
      await waitFor(
        () => registry.get(runId) === undefined,
        "run deregistered",
      );
    });
  },
});

Deno.test({
  name: "auto-resume: off by default, the approved run stays suspended",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = gatedWorkflow("auto-resume-default-off");
      const { ctx, registry, runId, data } = await suspendAndApprove(
        repoDir,
        workflow,
        false,
      );

      assertEquals(data.autoResumed, false);
      assertEquals(data.allGatesDecided, true);
      assertEquals(registry.get(runId), undefined);
      assertEquals(await runStatus(ctx, workflow, runId), {
        status: "suspended",
        deploy: "pending",
      });
    });
  },
});

Deno.test({
  name: "auto-resume: never retries a failed run, even one eligible for retry",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      // A failed shell step with nothing else unfinished: a manual resume
      // with --run would retry it, so only suspendedOnly stops auto-resume.
      const workflow = Workflow.create({
        name: "auto-resume-failed-run",
        autoResume: true,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "deploy",
                task: StepTask.directExecution(
                  "command/shell",
                  "auto-resume-failed-run-shell",
                  "execute",
                  { run: "exit 1" },
                ),
              }),
            ],
          }),
        ],
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);
      const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
        await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

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
        undefined,
        { syncGate: undefined },
      );
      if (!runId) throw new Error("no run id observed");

      const registry = new ActiveRunRegistry();
      const audit: string[] = [];
      const ctx = {
        repoDir: resolved,
        repoContext,
        datastoreConfig,
        authConfig: modeNone,
        activeRunRegistry: registry,
        serveOptions: { autoResume: false } as MergedServeOptions,
        auditEmitter: {
          emit: (event: { action: string }) => audit.push(event.action),
        },
      } as unknown as ConnectionContext;
      assertEquals((await runStatus(ctx, workflow, runId)).status, "failed");

      const launched = await autoResumeAfterApproval(
        ctx,
        {
          workflowName: workflow.name,
          runId,
          decidedBy: "user:approver",
          allGatesDecided: true,
        },
        "user:approver",
      );

      assertEquals(launched, false);
      assertEquals(registry.get(runId), undefined);
      assertEquals(audit, ["workflow.auto_resume_failed"]);
      assertEquals(await runStatus(ctx, workflow, runId), {
        status: "failed",
        deploy: "failed",
      });
    });
  },
});
