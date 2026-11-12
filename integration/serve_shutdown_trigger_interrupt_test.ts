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
import { assertEquals } from "@std/assert";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { assessRecoveryForRun } from "../src/domain/workflows/recovery_assessment.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { handleWorkflowResume } from "../src/serve/handlers/workflow_handlers.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import {
  type DrainableTriggerSource,
  runShutdownDrain,
  SHUTDOWN_ABORT_GRACE_MS,
} from "../src/serve/shutdown_drain.ts";
import { interruptShutdownRuns } from "../src/serve/shutdown_interrupt.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { parseWebhookFlag, WebhookService } from "../src/serve/webhook.ts";
import { hmacSha256Hex } from "../src/serve/webhook_verifiers.ts";
import { ScheduledExecutionService } from "../src/libswamp/workflows/scheduled_execution.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const testOpts = { sanitizeOps: false, sanitizeResources: false };

type Trigger = "webhook" | "cron";

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-trigger-interrupt-",
  });
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

function statuses(run: WorkflowRun): Record<string, string> {
  const result: Record<string, string> = {};
  for (const jobRun of run.jobs) {
    result[jobRun.jobName] = jobRun.status;
    for (const step of jobRun.steps) {
      result[`${jobRun.jobName}/${step.stepName}`] = step.status;
    }
  }
  return result;
}

async function shutdownDuringTriggeredRun(
  trigger: Trigger,
  { cancelFirst }: { cancelFirst: boolean },
): Promise<void> {
  await withRepo(async (repoDir) => {
    const modelType = ModelType.create(
      `test/trigger-interrupt-${crypto.randomUUID()}`,
    );
    let waitStarted = false;
    // set once serve has shut down: the resumed method then finishes
    let released = false;
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {},
      methods: {
        wait: {
          description: "waits until the run is aborted, then fails",
          arguments: z.object({}),
          execute: (_args, context) => {
            if (released) return Promise.resolve({ dataHandles: [] });
            waitStarted = true;
            return new Promise((_resolve, reject) => {
              context.signal.addEventListener("abort", () => {
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                );
              }, { once: true });
            });
          },
        },
      },
    });

    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    try {
      const workflow = Workflow.create({
        name: `trigger-interrupt-${crypto.randomUUID()}`,
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "slow",
            task: StepTask.model("waiter", "wait"),
          })],
        })],
      });
      const workflowRepo = new YamlWorkflowRepository(repoDir);
      await workflowRepo.save(workflow);
      const {
        repoDir: resolved,
        repoContext,
        datastoreConfig,
        datastoreResolver,
        syncService,
      } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
      await repoContext.definitionRepo.save(
        modelType,
        Definition.create({ name: "waiter", type: modelType.normalized }),
      );

      let source: DrainableTriggerSource;
      let cancel: (runId: string) => boolean;
      if (trigger === "webhook") {
        const webhooks = new WebhookService({
          repoDir: resolved,
          repoContext,
          datastoreConfig,
          syncService,
          syncGate: undefined,
          runTracker: tracker,
          endpoints: [
            await parseWebhookFlag(`/hooks/deploy:${workflow.name}:secret`),
          ],
          initiatedBy: "service:webhook",
        });
        const body = "{}";
        const signature = await hmacSha256Hex(
          new TextEncoder().encode(body),
          "secret",
        );
        const response = await webhooks.handleRequest(
          new Request("http://localhost/hooks/deploy", {
            method: "POST",
            body,
            headers: { "x-hub-signature-256": `sha256=${signature}` },
          }),
        );
        assertEquals(response?.status, 200);
        source = webhooks;
        cancel = (runId) => webhooks.cancelByRunId(runId, "cancelled by user");
      } else {
        const scheduler = new ScheduledExecutionService({
          workflowRepo,
          repoDir: resolved,
          executeWorkflow: (input, signal, onEvent) =>
            executeWorkflowWithLocks(
              resolved,
              repoContext,
              datastoreConfig,
              input,
              signal,
              onEvent,
              syncService,
              tracker,
              { syncGate: undefined, triggerSource: "schedule" },
            ),
        });
        await scheduler.start();
        scheduler.enqueueForReplay({
          pendingRunId: "p-1",
          workflowIdOrName: workflow.name,
        });
        source = scheduler;
        cancel = (runId) => scheduler.cancelByRunId(runId, "cancelled by user");
      }
      await waitFor(() => waitStarted, "the triggered step to start");

      const runRepo = repoContext.workflowRunRepo;
      const workflowId = createWorkflowId(workflow.id);
      const [started] = await runRepo.findAllByWorkflowId(workflowId);
      if (cancelFirst) {
        assertEquals(cancel(started.id), true);
        await waitFor(
          () => tracker.findById(started.id)?.status === "cancelled",
          "the cancelled run to settle",
        );
      }

      const aborted = await runShutdownDrain({
        webhookService: trigger === "webhook" ? source : null,
        scheduledExecution: trigger === "cron" ? source : null,
        activeRunRegistry: null,
        drainTimeoutMs: 0,
        abortGraceMs: SHUTDOWN_ABORT_GRACE_MS,
      });
      const result = await interruptShutdownRuns(aborted, {
        repoContext,
        runTracker: tracker,
      });

      const [settled] = await runRepo.findAllByWorkflowId(workflowId);
      if (cancelFirst) {
        assertEquals(aborted, []);
        assertEquals(result.interrupted, []);
        assertEquals(settled.status, "cancelled");
        assertEquals(tracker.findById(settled.id)?.status, "cancelled");
        return;
      }
      assertEquals(aborted.map((run) => run.runId), [started.id]);
      assertEquals(result.interrupted, [started.id]);
      assertEquals(settled.status, "interrupted");
      assertEquals(settled.tags["interrupt_reason"], "server_shutdown");
      assertEquals(statuses(settled), {
        main: "unknown",
        "main/slow": "unknown",
      });
      assertEquals(tracker.findById(settled.id)?.status, "interrupted");

      const assessment = await assessRecoveryForRun(workflow, settled);
      assertEquals(assessment.unguardedSteps, ["slow"]);
      settled.resetUnknownStepsForRecovery();
      await runRepo.save(workflowId, settled);
      released = true;
      await handleWorkflowResume(
        { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket,
        {
          repoDir: resolved,
          repoContext,
          datastoreConfig,
          datastoreResolver,
          syncService,
          runTracker: tracker,
          authConfig: { mode: "none" },
          activeRunRegistry: new ActiveRunRegistry(),
        } as unknown as ConnectionContext,
        "resume-1",
        { workflowIdOrName: workflow.name, runId: settled.id },
        new AbortController(),
        null,
      );

      const [resumed] = await runRepo.findAllByWorkflowId(workflowId);
      assertEquals(resumed.status, "succeeded");
      // a row left cancelled is never reactivated, so the resume could not take it over
      assertEquals(tracker.findById(resumed.id)?.status, "completed");
    } finally {
      tracker.close();
      modelRegistry.invalidateType(modelType);
    }
  });
}

for (const trigger of ["webhook", "cron"] as const) {
  Deno.test({
    name:
      `serve shutdown: a ${trigger} run it stops mid-step is interrupted as unknown, settles its row interrupted, recovers and resumes (swamp-club#4656)`,
    ...testOpts,
    fn: () => shutdownDuringTriggeredRun(trigger, { cancelFirst: false }),
  });

  Deno.test({
    name:
      `serve shutdown: a ${trigger} run cancelled before shutdown stays cancelled (swamp-club#4656)`,
    ...testOpts,
    fn: () => shutdownDuringTriggeredRun(trigger, { cancelFirst: true }),
  });
}
