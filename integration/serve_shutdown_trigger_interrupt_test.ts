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
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
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
import { RunEventBuffer } from "../src/serve/run_event_buffer.ts";
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

type Trigger = "webhook" | "cron" | "api";

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
  {
    cancelFirst,
    ignoresAbort = false,
    cancelDuringCleanup = false,
    cleanupOutlastsCap = false,
  }: {
    cancelFirst: boolean;
    ignoresAbort?: boolean;
    /** shutdown lands while the cancelled run's cleanup is still running */
    cancelDuringCleanup?: boolean;
    /** and the cleanup takes longer than shutdown waits for it */
    cleanupOutlastsCap?: boolean;
  },
): Promise<void> {
  await withRepo(async (repoDir) => {
    const modelType = ModelType.create(
      `test/trigger-interrupt-${crypto.randomUUID()}`,
    );
    let waitStarted = false;
    // set once serve has shut down: the resumed method then finishes
    let released = false;
    const unblocked = Promise.withResolvers<void>();
    const cleanupCalls: string[] = [];
    let cleanupStarted = false;
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
            if (ignoresAbort) {
              return unblocked.promise.then(() => ({ dataHandles: [] }));
            }
            return new Promise((_resolve, reject) => {
              context.signal.addEventListener("abort", () => {
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                );
              }, { once: true });
            });
          },
        },
        record: {
          description: "records that a cleanup step ran",
          arguments: z.object({}),
          execute: async () => {
            cleanupStarted = true;
            // longer than the abort grace the shutdown below is given
            if (cancelDuringCleanup) {
              await new Promise((resolve) =>
                setTimeout(resolve, CLEANUP_STEP_MS)
              );
            }
            cleanupCalls.push("cleanup");
            return { dataHandles: [] };
          },
        },
      },
    });

    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    try {
      const workflow = Workflow.create({
        name: `trigger-interrupt-${crypto.randomUUID()}`,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "slow",
                task: StepTask.model("waiter", "wait"),
              }),
              Step.create({
                name: "rollback",
                task: StepTask.model("waiter", "record"),
                dependsOn: [{
                  step: "slow",
                  condition: TriggerCondition.failed(),
                }],
              }),
            ],
          }),
          Job.create({
            name: "teardown",
            dependsOn: [{ job: "main", condition: TriggerCondition.failed() }],
            steps: [Step.create({
              name: "undo",
              task: StepTask.model("waiter", "record"),
            })],
          }),
        ],
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

      let source: DrainableTriggerSource | null = null;
      let registry: ActiveRunRegistry | null = null;
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
      } else if (trigger === "cron") {
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
      } else {
        // as handleWorkflowRun does: the run is registered under its own id
        const apiRegistry = new ActiveRunRegistry();
        const controller = new AbortController();
        const runStarted = Promise.withResolvers<string>();
        const execution = executeWorkflowWithLocks(
          resolved,
          repoContext,
          datastoreConfig,
          { workflowIdOrName: workflow.name },
          controller.signal,
          (event) => {
            if (event.kind === "started" && event.parentRunId === undefined) {
              runStarted.resolve(event.runId);
            }
          },
          syncService,
          tracker,
          { syncGate: undefined, triggerSource: "api" },
        );
        execution.catch((error) => runStarted.reject(error));
        const runId = await runStarted.promise;
        apiRegistry.register({
          runId,
          kind: "workflow-run",
          resourceName: workflow.name,
          buffer: new RunEventBuffer(1),
          controller,
          startedAt: new Date(),
          completion: execution.then(
            () => apiRegistry.deregister(runId),
            () => apiRegistry.deregister(runId),
          ),
          principalId: null,
        });
        registry = apiRegistry;
        cancel = (id) => apiRegistry.cancel(id);
      }
      await waitFor(() => waitStarted, "the triggered step to start");

      const runRepo = repoContext.workflowRunRepo;
      const workflowId = createWorkflowId(workflow.id);
      const [started] = await runRepo.findAllByWorkflowId(workflowId);
      if (cancelFirst) {
        assertEquals(cancel(started.id), true);
        if (cancelDuringCleanup) {
          await waitFor(() => cleanupStarted, "the cancelled run's cleanup");
        } else {
          await waitFor(
            () => tracker.findById(started.id)?.status === "cancelled",
            "the cancelled run to settle",
          );
        }
      }

      const aborted = await runShutdownDrain({
        webhookService: trigger === "webhook" ? source : null,
        scheduledExecution: trigger === "cron" ? source : null,
        activeRunRegistry: registry,
        drainTimeoutMs: 0,
        abortGraceMs: ignoresAbort || cancelDuringCleanup
          ? 50
          : SHUTDOWN_ABORT_GRACE_MS,
        ...(cleanupOutlastsCap
          ? { cleanupGraceMs: () => CUT_OFF_CLEANUP_MS }
          : {}),
      });
      if (cleanupOutlastsCap) {
        const result = await interruptShutdownRuns(aborted, {
          repoContext,
          runTracker: tracker,
        });
        assertEquals(result.interrupted, []);
        assertEquals(result.cancelled, [started.id]);
        const [cut] = await runRepo.findAllByWorkflowId(workflowId);
        assertEquals(cut.status, "cancelled");
        assertEquals(tracker.findById(started.id)?.status, "cancelled");
        await waitFor(
          () =>
            registry
              ? registry.size === 0
              : !(source?.hasUnsettledRuns() ?? false),
          "the cut-off run's executor to settle",
        );
        const [settledLater] = await runRepo.findAllByWorkflowId(workflowId);
        assertEquals(settledLater.status, "cancelled");
        return;
      }
      if (ignoresAbort) {
        assertEquals(aborted.map((run) => run.runId), [started.id]);
        assertEquals(source?.hasUnsettledRuns(), true);
        unblocked.resolve();
        await waitFor(
          () => !(source?.hasUnsettledRuns() ?? false),
          "the run that ignored the abort to settle",
        );
        return;
      }
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
        assertEquals(cleanupCalls, ["cleanup", "cleanup"]);
        return;
      }
      assertEquals(cleanupCalls, []);
      assertEquals(aborted.map((run) => run.runId), [started.id]);
      assertEquals(result.interrupted, [started.id]);
      assertEquals(settled.status, "interrupted");
      assertEquals(settled.tags["interrupt_reason"], "server_shutdown");
      assertEquals(statuses(settled), {
        main: "unknown",
        "main/slow": "unknown",
        "main/rollback": "failed",
        teardown: "failed",
        "teardown/undo": "failed",
      });
      assertEquals(
        settled.getJob("main")!.getStep("rollback")!.settledByAbort,
        true,
      );
      assertEquals(
        settled.getJob("teardown")!.getStep("undo")!.settledByAbort,
        true,
      );
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
      assertEquals(statuses(resumed), {
        main: "succeeded",
        "main/slow": "succeeded",
        "main/rollback": "skipped",
        teardown: "skipped",
        "teardown/undo": "skipped",
      });
      assertEquals(cleanupCalls, []);
      // a row left cancelled is never reactivated, so the resume could not take it over
      assertEquals(tracker.findById(resumed.id)?.status, "completed");
    } finally {
      unblocked.resolve();
      tracker.close();
      modelRegistry.invalidateType(modelType);
    }
  });
}

const CLEANUP_STEP_MS = 300;
// shorter than a cleanup step, so shutdown cuts the cleanup off
const CUT_OFF_CLEANUP_MS = CLEANUP_STEP_MS / 3;

const ARTICLED: Record<Trigger, string> = {
  webhook: "a webhook",
  cron: "a cron",
  api: "an API",
};

for (const trigger of ["webhook", "cron", "api"] as const) {
  Deno.test({
    name: `serve shutdown: ${
      ARTICLED[trigger]
    } run it stops mid-step is interrupted as unknown without running its cleanup, settles its row interrupted, recovers and resumes (swamp-club#4656)`,
    ...testOpts,
    fn: () => shutdownDuringTriggeredRun(trigger, { cancelFirst: false }),
  });

  Deno.test({
    name: `serve shutdown: ${
      ARTICLED[trigger]
    } run cancelled before shutdown stays cancelled and runs its cleanup (swamp-club#4656)`,
    ...testOpts,
    fn: () => shutdownDuringTriggeredRun(trigger, { cancelFirst: true }),
  });
}

for (const trigger of ["webhook", "cron", "api"] as const) {
  Deno.test({
    name: `serve shutdown: ${
      ARTICLED[trigger]
    } run cancelled before shutdown finishes its cleanup when that outlasts the abort grace, and stays cancelled`,
    ...testOpts,
    fn: () =>
      shutdownDuringTriggeredRun(trigger, {
        cancelFirst: true,
        cancelDuringCleanup: true,
      }),
  });
}

for (const trigger of ["webhook", "cron", "api"] as const) {
  Deno.test({
    name: `serve shutdown: ${
      ARTICLED[trigger]
    } run cancelled before shutdown whose cleanup outlasts the wait is saved cancelled, not left running for the next boot to reap`,
    ...testOpts,
    fn: () =>
      shutdownDuringTriggeredRun(trigger, {
        cancelFirst: true,
        cancelDuringCleanup: true,
        cleanupOutlastsCap: true,
      }),
  });
}

for (const trigger of ["webhook", "cron"] as const) {
  Deno.test({
    name: `serve shutdown: ${
      ARTICLED[trigger]
    } run whose method ignores the abort holds shutdown no longer than the abort grace`,
    ...testOpts,
    fn: () =>
      shutdownDuringTriggeredRun(trigger, {
        cancelFirst: false,
        ignoresAbort: true,
      }),
  });
}
