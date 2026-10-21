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
 * Integration tests for cancelling a webhook-triggered workflow run through
 * serve's cancel paths (swamp-club#3740). A real WebhookService runs a real
 * workflow on a temp repository; its one step waits on its abort signal, as a
 * long-running method that honours cancellation does. The run is cancelled
 * through `cancelExecution` and `cancelAllExecutions`, wired to the service
 * the way serve wires them.
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
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { RunCancelRegistry } from "../src/serve/run_cancel_registry.ts";
import {
  cancelAllExecutions,
  cancelExecution,
} from "../src/cli/commands/serve.ts";
import {
  parseWebhookFlag,
  type WebhookEvent,
  WebhookService,
} from "../src/serve/webhook.ts";
import { hmacSha256Hex } from "../src/serve/webhook_verifiers.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const testOpts = { sanitizeOps: false, sanitizeResources: false };
const SECRET = "shhh";
const BODY = '{"event":"push"}';

interface Started {
  service: WebhookService;
  events: WebhookEvent[];
  runId: string;
  workflow: Workflow;
  repoContext: Awaited<
    ReturnType<typeof requireInitializedRepoUnlocked>
  >["repoContext"];
  methodAborted: () => boolean;
}

/**
 * Starts a webhook run of a workflow whose step waits until it is aborted,
 * and hands `fn` the service once the run has started.
 */
async function withStartedWebhookRun(
  fn: (started: Started) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-webhook-cancel-" });
  const modelType = ModelType.create(
    `test/webhook-cancel-${crypto.randomUUID()}`,
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
                new DOMException("The operation was aborted.", "AbortError"),
              );
            }, { once: true });
          });
        },
      },
    },
  });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const workflow = Workflow.create({
      name: `webhook-cancel-${crypto.randomUUID()}`,
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "slow",
          task: StepTask.model("waiter", "wait"),
        })],
      })],
    });
    await new YamlWorkflowRepository(repoDir).save(workflow);
    const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
    await repoContext.definitionRepo.save(
      modelType,
      Definition.create({ name: "waiter", type: modelType.normalized }),
    );

    const service = new WebhookService({
      repoDir: resolved,
      repoContext,
      datastoreConfig,
      endpoints: [
        await parseWebhookFlag(`/hooks/cancel:${workflow.name}:${SECRET}`),
      ],
      syncService,
      syncGate: undefined,
    });
    const events: WebhookEvent[] = [];
    service.setEventHandler((event) => events.push(event));
    try {
      const signature = await hmacSha256Hex(
        new TextEncoder().encode(BODY),
        SECRET,
      );
      const response = await service.handleRequest(
        new Request("http://localhost/hooks/cancel", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${signature}`,
          },
          body: BODY,
        }),
      );
      assertEquals(response?.status, 200);
      await response?.body?.cancel();
      await waitFor(() => methodStarted, "the step's method to start", {
        timeoutMs: 60_000,
      });
      const started = events.find((e) => e.kind === "webhook_started");
      assert(started?.kind === "webhook_started", "webhook run started");

      await fn({
        service,
        events,
        runId: started.runId,
        workflow,
        repoContext,
        methodAborted: () => methodAborted,
      });
    } finally {
      await service.stop();
    }
  } finally {
    modelRegistry.invalidateType(modelType);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function assertCancelled(
  started: Started,
  reason: string,
): Promise<void> {
  await waitFor(
    () => started.events.some((e) => e.kind === "webhook_failed"),
    "the webhook run to settle",
    { timeoutMs: 60_000 },
  );
  assert(started.methodAborted(), "the step's method saw the abort");
  const failed = started.events.find((e) => e.kind === "webhook_failed");
  assertEquals(
    failed?.kind === "webhook_failed" && failed.error,
    "workflow was cancelled",
  );
  const run = await started.repoContext.workflowRunRepo.findById(
    createWorkflowId(started.workflow.id),
    createWorkflowRunId(started.runId),
  );
  assertEquals(run?.status, "cancelled");
  assertEquals(run?.tags["cancel_reason"], reason);
}

Deno.test({
  name:
    "serve: cancelling a webhook-triggered run by its id aborts and cancels it (swamp-club#3740)",
  ...testOpts,
  fn: async () => {
    await withStartedWebhookRun(async (started) => {
      const reason = "cancelled by test";
      const result = await cancelExecution("workflow-run", started.runId, {
        cancelRegistry: new RunCancelRegistry(),
        activeRunRegistry: new ActiveRunRegistry(),
        reason,
        webhookCancelByRunId: (id) => started.service.cancelByRunId(id, reason),
        cancelSuspended: () =>
          Promise.reject(new Error("a webhook run is not a persisted cancel")),
      });
      assertEquals(result.status, "cancellation_requested");
      await assertCancelled(started, reason);
    });
  },
});

Deno.test({
  name:
    "serve: cancelling all runs includes webhook-triggered runs (swamp-club#3740)",
  ...testOpts,
  fn: async () => {
    await withStartedWebhookRun(async (started) => {
      const reason = "cancel all by test";
      const count = cancelAllExecutions(
        {
          cancelRegistry: new RunCancelRegistry(),
          activeRunRegistry: new ActiveRunRegistry(),
          webhookCancelAll: (r) => started.service.cancelAllRuns(r),
        },
        undefined,
        reason,
      );
      assertEquals(count, 1);
      await assertCancelled(started, reason);
    });
  },
});
