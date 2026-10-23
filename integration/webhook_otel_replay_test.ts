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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { waitFor } from "@swamp-club/swamp-testing";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withCapturedSpans } from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../src/infrastructure/tracing/execution_observer.ts";
import { parseWebhookFlag, WebhookService } from "../src/serve/webhook.ts";
import { replayPendingRuns } from "../src/serve/boot_reconciliation.ts";

await initializeLogging({});

Deno.test("webhook telemetry: malformed remote timestamps cannot discard replayed deliveries", async () => {
  const dir = await Deno.makeTempDir();
  const store = new RunTrackerStore(join(dir, "runs.db"));
  const controlPlaneStore = new FileSystemControlPlaneStore(dir);
  let executions = 0;
  const timestamps = [{ toString: null }, [], 123, null, "invalid date"];
  const service = new WebhookService({
    repoDir: dir,
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [await parseWebhookFlag("/hooks/gh:deploy:secret")],
    runTracker: store,
    executeWorkflow: (_dir, _context, _config, input) => {
      assertEquals(input.webhook?.body, { version: 1 });
      executions++;
      return Promise.resolve();
    },
  });
  try {
    for (const createdAt of timestamps) {
      const id = crypto.randomUUID();
      await controlPlaneStore.put(
        `pending-runs/${id}`,
        new TextEncoder().encode(JSON.stringify({
          id,
          source: "webhook",
          workflowIdOrName: "deploy",
          route: "/hooks/gh",
          payload: JSON.stringify({
            body: { version: 1 },
            headers: {},
            route: "/hooks/gh",
          }),
          createdAt,
        })),
      );
    }
    assertEquals(
      await replayPendingRuns({
        runTracker: store,
        controlPlaneStore,
        webhookService: service,
        configuredWebhookWorkflows: new Set(["deploy"]),
        configuredWebhookRoutes: new Set(["/hooks/gh"]),
        configuredCronWorkflows: new Set(),
      }),
      timestamps.length,
    );
    await waitFor(
      () => executions === timestamps.length,
      "all malformed-timestamp deliveries executed",
    );
    // Replay must not take its discard/error path and delete remote deliveries.
    assertEquals(
      (await controlPlaneStore.list("pending-runs/")).length,
      timestamps.length,
    );
  } finally {
    await service.stop();
    store.close();
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

Deno.test("webhook telemetry: persisted receipt survives store reopen and boot replay with original queue age", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "runs.db");
  const id = crypto.randomUUID();
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const spanId = "b7ad6b7169203331";
  const original = new Date("2026-01-01T00:00:00Z");
  let store = new RunTrackerStore(path);
  try {
    store.enqueuePendingRun({
      id,
      source: "webhook",
      workflowIdOrName: "deploy",
      route: "/hooks/gh",
      payload: JSON.stringify({
        body: { version: 1 },
        headers: {},
        route: "/hooks/gh",
      }),
      receiptTrace: { traceparent: `00-${traceId}-${spanId}-01` },
      createdAt: original.toISOString(),
    });
    store.close();
    store = new RunTrackerStore(path);
    await withCapturedSpans(async (spans) => {
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      installExecutionObserver();
      let executions = 0;
      const service = new WebhookService({
        repoDir: dir,
        syncGate: undefined,
        repoContext: {} as RepositoryContext,
        datastoreConfig: {} as DatastoreConfig,
        endpoints: [await parseWebhookFlag("/hooks/gh:deploy:secret")],
        runTracker: store,
        now: () => original.getTime() + 60_000,
        executeWorkflow: (_dir, _context, _config, input) => {
          assertEquals(input.webhook?.body, { version: 1 });
          executions++;
          return Promise.resolve();
        },
      });
      try {
        assertEquals(
          await replayPendingRuns({
            runTracker: store,
            webhookService: service,
            configuredWebhookWorkflows: new Set(["deploy"]),
            configuredWebhookRoutes: new Set(["/hooks/gh"]),
            configuredCronWorkflows: new Set(),
          }),
          1,
        );
        await waitFor(() => executions === 1, "persisted delivery executed");
        await service.stop();
        assertEquals(store.findAllPendingRuns(), []);
        const run = spans.find((span) => span.name === "swamp.webhook.run")!;
        assertEquals(run.attributes["swamp.webhook.receipt_id"], id);
        assertEquals(run.attributes["swamp.webhook.queue_wait_ms"], 60_000);
        assertEquals(run.parentSpanId, undefined);
        assertEquals(run.links[0].context.traceId, traceId);
        assertEquals(run.links[0].context.spanId, spanId);
      } finally {
        await service.stop();
        uninstallExecutionObserver();
        propagation.disable();
      }
    });
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});
