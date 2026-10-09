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
 * Integration test for cancelling, through serve, a workflow that runs a
 * nested workflow step (swamp-club#2470). Uses a real repository on disk,
 * the detached `workflow.run` handler and the serve cancel path. The nested
 * step's method waits on its abort signal, as a long-running method that
 * honours cancellation does.
 */

import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { handleWorkflowRun } from "../src/serve/handlers/workflow_handlers.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { RunCancelRegistry } from "../src/serve/run_cancel_registry.ts";
import { cancelExecution } from "../src/cli/commands/serve.ts";
import { cancelSuspendedRunAndPush } from "../src/serve/suspended_run_cancel.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const testOpts = { sanitizeOps: false, sanitizeResources: false };

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-nested-cancel-" });
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

interface EventFrame {
  type: string;
  event?: { kind: string; runId?: string; parentRunId?: string };
}

Deno.test({
  name:
    "serve: cancelling a run by its id stops the nested workflow's method and cancels both runs (swamp-club#2470)",
  ...testOpts,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const modelType = ModelType.create(
        `test/nested-cancel-${crypto.randomUUID()}`,
      );
      let methodStarted = false;
      let methodAborted = false;
      modelRegistry.register({
        type: modelType,
        version: "2026.01.01.1",
        globalArguments: z.object({}),
        resources: {},
        methods: {
          wait: {
            description: "waits until the run is cancelled",
            arguments: z.object({}),
            execute: (_args, context) => {
              methodStarted = true;
              return new Promise((_resolve, reject) => {
                context.signal.addEventListener("abort", () => {
                  methodAborted = true;
                  reject(
                    new DOMException(
                      "The operation was aborted.",
                      "AbortError",
                    ),
                  );
                }, { once: true });
              });
            },
          },
        },
      });

      try {
        const child = Workflow.create({
          name: `nested-cancel-child-${crypto.randomUUID()}`,
          jobs: [Job.create({
            name: "child-job",
            steps: [Step.create({
              name: "slow",
              task: StepTask.model("waiter", "wait"),
            })],
          })],
        });
        const parent = Workflow.create({
          name: `nested-cancel-parent-${crypto.randomUUID()}`,
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "call-child",
              task: StepTask.workflow(child.name),
            })],
          })],
        });
        const workflowRepo = new YamlWorkflowRepository(repoDir);
        await workflowRepo.save(child);
        await workflowRepo.save(parent);
        const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
          await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
        await repoContext.definitionRepo.save(
          modelType,
          Definition.create({ name: "waiter", type: modelType.normalized }),
        );

        const registry = new ActiveRunRegistry();
        const ctx = {
          repoDir: resolved,
          repoContext,
          datastoreConfig,
          syncService,
          authConfig: { mode: "none" },
          activeRunRegistry: registry,
        } as unknown as ConnectionContext;
        const frames: EventFrame[] = [];
        const socket = {
          readyState: WebSocket.OPEN,
          send: (data: string) => frames.push(JSON.parse(data)),
        } as unknown as WebSocket;

        const handled = handleWorkflowRun(
          socket,
          ctx,
          "run-1",
          { workflowIdOrName: parent.name, inputs: {} },
          new AbortController(),
          null,
        );
        await waitFor(() => methodStarted, "the nested method to start");

        const started = frames.flatMap((f) =>
          f.type === "event" && f.event?.kind === "started" ? [f.event] : []
        );
        assertEquals(started.length, 2);
        const parentRunId = started[0].runId!;
        const childRunId = started[1].runId!;
        assertEquals(started[0].parentRunId, undefined);
        assertEquals(started[1].parentRunId, parentRunId);

        // The registry stays keyed on the run the request started.
        assert(registry.get(parentRunId) !== undefined);
        assertEquals(registry.get(childRunId), undefined);
        // A client that reconnects by the child's id reattaches to the parent.
        assertEquals(registry.findForAttach(childRunId)?.runId, parentRunId);

        const result = await cancelExecution("workflow-run", parentRunId, {
          cancelRegistry: new RunCancelRegistry(),
          activeRunRegistry: registry,
          reason: "cancelled by test",
        });
        assertEquals(result.status, "cancelled");
        assert(methodAborted, "the nested method saw the abort");
        await handled;

        const parentRun = await repoContext.workflowRunRepo.findById(
          createWorkflowId(parent.id),
          createWorkflowRunId(parentRunId),
        );
        const childRun = await repoContext.workflowRunRepo.findById(
          createWorkflowId(child.id),
          createWorkflowRunId(childRunId),
        );
        assertEquals(parentRun?.status, "cancelled");
        assertEquals(childRun?.status, "cancelled");
      } finally {
        modelRegistry.invalidateType(modelType);
      }
    });
  },
});

Deno.test({
  name:
    "serve: cancelling a suspended parent by its id cancels the suspended nested run with it (swamp-club#2867)",
  ...testOpts,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const child = Workflow.create({
        name: `nested-gate-child-${crypto.randomUUID()}`,
        jobs: [Job.create({
          name: "child-job",
          steps: [Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve the child"),
          })],
        })],
      });
      const parent = Workflow.create({
        name: `nested-gate-parent-${crypto.randomUUID()}`,
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "call-child",
            task: StepTask.workflow(child.name),
          })],
        })],
      });
      const workflowRepo = new YamlWorkflowRepository(repoDir);
      await workflowRepo.save(child);
      await workflowRepo.save(parent);
      const {
        repoDir: resolved,
        repoContext,
        datastoreConfig,
        datastoreResolver,
        syncService,
      } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

      const registry = new ActiveRunRegistry();
      const ctx = {
        repoDir: resolved,
        repoContext,
        datastoreConfig,
        datastoreResolver,
        syncService,
        authConfig: { mode: "none" },
        activeRunRegistry: registry,
      } as unknown as ConnectionContext;
      const frames: EventFrame[] = [];
      const socket = {
        readyState: WebSocket.OPEN,
        send: (data: string) => frames.push(JSON.parse(data)),
      } as unknown as WebSocket;

      // The parent suspends on the child, which suspends at its gate.
      await handleWorkflowRun(
        socket,
        ctx,
        "run-1",
        { workflowIdOrName: parent.name, inputs: {} },
        new AbortController(),
        null,
      );
      const runRepo = repoContext.workflowRunRepo;
      const [parentRun] = await runRepo.findAllByWorkflowId(
        createWorkflowId(parent.id),
      );
      const [childRun] = await runRepo.findAllByWorkflowId(
        createWorkflowId(child.id),
      );
      assertEquals(parentRun.status, "suspended");
      assertEquals(childRun.status, "suspended");
      await waitFor(
        () => registry.get(parentRun.id) === undefined,
        "the suspended parent to leave the registry",
      );

      const result = await cancelExecution("workflow-run", parentRun.id, {
        cancelRegistry: new RunCancelRegistry(),
        activeRunRegistry: registry,
        reason: "cancelled by test",
        cancelSuspended: (id) =>
          cancelSuspendedRunAndPush(
            ctx,
            { runId: id, reason: "cancelled by test" },
            () => true,
          ),
      });
      assertEquals(result.status, "cancelled");
      assertEquals(result.cancelledNestedRuns?.map((r) => r.runId), [
        childRun.id,
      ]);
      assertEquals(result.detachedNestedRuns, undefined);

      const endedParent = await runRepo.findById(
        createWorkflowId(parent.id),
        parentRun.id,
      );
      const endedChild = await runRepo.findById(
        createWorkflowId(child.id),
        childRun.id,
      );
      assertEquals(endedParent?.status, "cancelled");
      assertEquals(endedChild?.status, "cancelled");
      assert(endedChild?.tags["cancel_reason"].includes(parentRun.id));
      // Neither id is left reserved.
      for (const id of [parentRun.id, childRun.id]) {
        const release = registry.reserve(id);
        assert(release, "the cancel released its reservation");
        release();
      }
    });
  },
});
