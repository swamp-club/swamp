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
 * Integration test for webhook extension schemes (#2204).
 *
 * Wires a webhook extension type registered in the real registry through
 * startup resolution, WebhookService.handleRequest, the run tracker, and
 * workflow execution: the extension verifies a static token header, reshapes
 * the body, and returns a custom acknowledgement while still enqueueing.
 */

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  repoInit,
  withDefaults,
} from "../src/libswamp/mod.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import type { PendingRunEntry } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import {
  parseWebhookFlag,
  resolveExtensionWebhookEndpoints,
  type WebhookEvent,
  WebhookService,
} from "../src/serve/webhook.ts";
import { webhookTypeRegistry } from "../src/domain/webhooks/webhook_type_registry.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const TOKEN_HEADER = "x-telegram-bot-api-secret-token";

Deno.test({
  name:
    "webhook extension scheme: verified request is transformed, acknowledged, and run",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const type = `@test/static-token-${crypto.randomUUID()}`;
    webhookTypeRegistry.register({
      type,
      name: "Static token",
      description: "Static secret token header",
      createHandler: () => ({
        signatureHeader: TOKEN_HEADER,
        requiredHeaders: [TOKEN_HEADER],
        verify: (_body, headers, secret) =>
          headers.get(TOKEN_HEADER) === secret,
        transform: (body) => ({ update: body }),
        respond: () => ({ status: 202, body: "ok", enqueue: true }),
      }),
    });

    const repoDir = await Deno.makeTempDir({ prefix: "swamp-webhook-ext-" });
    try {
      await consumeStream(
        repoInit(
          createLibSwampContext({}),
          createRepoInitDeps("20260101.120000.0"),
          {
            path: repoDir,
            force: false,
            tools: [],
            version: "20260101.120000.0",
          },
        ),
        withDefaults({
          error: (event) => {
            throw new Error(String(event.error?.message ?? "repo init failed"));
          },
        }),
      );
      await new YamlWorkflowRepository(repoDir).save(
        Workflow.create({
          name: "bot-wf",
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "echo",
                  task: StepTask.directExecution(
                    "command/shell",
                    "bot-wf-shell",
                    "execute",
                    { run: "echo ok" },
                  ),
                }),
              ],
            }),
          ],
        }),
      );

      const {
        repoDir: resolvedRepoDir,
        repoContext,
        datastoreConfig,
        syncService,
      } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

      const endpoints = await resolveExtensionWebhookEndpoints(
        [await parseWebhookFlag(`/hooks/bot:bot-wf:s3cret:${type}`)],
        (t) => Promise.resolve(webhookTypeRegistry.has(t)),
      );

      const runTracker = new RunTrackerStore(join(repoDir, "run-tracker.db"));
      const pending: PendingRunEntry[] = [];
      const enqueue = runTracker.enqueuePendingRun.bind(runTracker);
      runTracker.enqueuePendingRun = (entry) => {
        pending.push(entry);
        enqueue(entry);
      };

      const service = new WebhookService({
        repoDir: resolvedRepoDir,
        repoContext,
        datastoreConfig,
        endpoints,
        syncService,
        syncGate: undefined,
        runTracker,
      });
      const events: WebhookEvent[] = [];
      service.setEventHandler((event) => events.push(event));

      try {
        const res = await service.handleRequest(
          new Request("http://localhost/hooks/bot", {
            method: "POST",
            headers: { [TOKEN_HEADER]: "s3cret", "x-event": "message" },
            body: '{"update_id":7}',
          }),
        );
        assertEquals(res?.status, 202);
        assertEquals(await res!.text(), "ok");

        await waitFor(
          () =>
            events.some((e) =>
              e.kind === "webhook_completed" || e.kind === "webhook_failed"
            ),
          "webhook run to finish",
          { timeoutMs: 60_000 },
        );
        assert(
          events.some((e) => e.kind === "webhook_completed"),
          JSON.stringify(events),
        );

        assertEquals(pending.length, 1);
        const payload = JSON.parse(pending[0].payload ?? "{}");
        assertEquals(payload.body, { update: { update_id: 7 } });
        assertEquals(payload.headers[TOKEN_HEADER], undefined);
        assertEquals(payload.headers["x-event"], "message");
      } finally {
        await service.stop();
        runTracker.close();
      }
    } finally {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});
