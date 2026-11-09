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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import { consumeStream, withDefaults } from "../src/libswamp/stream.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
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
import { createWebhookUpdater } from "../src/serve/webhook_reload.ts";
import { parseWebhookConfig } from "../src/serve/serve_config.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";

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
      origin: { kind: "local" },
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
        [],
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

Deno.test({
  name:
    "webhook extension scheme: a pulled type from an untrusted collective is refused at startup, on reload and per delivery",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const type = `@test/pulled-token-${crypto.randomUUID()}`;
    let verified = 0;
    webhookTypeRegistry.register({
      type,
      name: "Pulled token",
      description: "Static secret token header from a pulled extension",
      createHandler: () => ({
        signatureHeader: TOKEN_HEADER,
        requiredHeaders: [TOKEN_HEADER],
        verify: (_body, headers, secret) => {
          verified++;
          return headers.get(TOKEN_HEADER) === secret;
        },
      }),
      origin: { kind: "pulled", extensionName: "@test/pulled-token" },
    });
    const flag = `/hooks/pulled:wf:s3cret:${type}`;
    const resolveType = (t: string) =>
      Promise.resolve(webhookTypeRegistry.has(t));

    const refusal = await resolveExtensionWebhookEndpoints(
      [await parseWebhookFlag(flag)],
      resolveType,
      ["swamp"],
    ).then(() => null, (e: Error) => e);
    assert(refusal !== null, "untrusted pulled type must be refused");
    assert(refusal.message.includes("swamp extension trust add test"));

    let trusted: readonly string[] = ["swamp", "test"];
    const endpoints = await resolveExtensionWebhookEndpoints(
      [await parseWebhookFlag(flag)],
      resolveType,
      trusted,
    );
    const service = new WebhookService({
      repoDir: "/nonexistent",
      repoContext: {} as unknown as RepositoryContext,
      datastoreConfig: {} as unknown as DatastoreConfig,
      endpoints,
      syncGate: undefined,
      trustedCollectives: () => trusted,
    });
    const updater = createWebhookUpdater({
      source: "config",
      service,
      parse: async (configs) =>
        await resolveExtensionWebhookEndpoints(
          await Promise.all(
            configs.map((c) => parseWebhookConfig(c)),
          ),
          resolveType,
          trusted,
        ),
    });

    try {
      trusted = ["swamp"];
      const reload = await updater([
        {
          route: "/hooks/pulled",
          workflow: "wf",
          secret: "s3cret",
          scheme: type,
        },
      ]).then(() => null, (e: Error) => e);
      assert(reload !== null, "reload must refuse the untrusted route");
      assertEquals(service.listEndpoints().map((e) => e.route), [
        "/hooks/pulled",
      ]);

      const res = await service.handleRequest(
        new Request("http://localhost/hooks/pulled", {
          method: "POST",
          headers: { [TOKEN_HEADER]: "s3cret" },
          body: "{}",
        }),
      );
      assertEquals(res?.status, 500);
      assertEquals(verified, 0);
    } finally {
      await service.stop();
      webhookTypeRegistry.invalidateType(type);
    }
  },
});
