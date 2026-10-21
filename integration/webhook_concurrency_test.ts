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
 * Integration tests for concurrent webhook runs (swamp-club#3665).
 *
 * The first two drive a real WebhookService on a temp repo through the real
 * workflow executor: runs of different workflows overlap, and runs of the
 * same route overlap too while a step on the same model still waits for its
 * lock. The last wires the service to a real run tracker, the shutdown
 * drain and boot replay, so pending entries survive a restart with runs
 * in flight.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { consumeStream, withDefaults } from "../src/libswamp/stream.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import {
  parseWebhookFlag,
  type WebhookEvent,
  WebhookService,
} from "../src/serve/webhook.ts";
import { hmacSha256Hex } from "../src/serve/webhook_verifiers.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { runShutdownDrain } from "../src/serve/shutdown_drain.ts";
import { replayPendingRuns } from "../src/serve/boot_reconciliation.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const SECRET = "shhh";
const BODY = '{"event":"push"}';

async function delivery(route: string): Promise<Request> {
  const signature = await hmacSha256Hex(
    new TextEncoder().encode(BODY),
    SECRET,
  );
  return new Request(`http://localhost${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: BODY,
  });
}

function completedRuns(events: WebhookEvent[], workflow: string): number {
  return events.filter((e) =>
    e.kind === "webhook_completed" && e.workflowName === workflow
  ).length;
}

interface Harness {
  readonly service: WebhookService;
  readonly events: WebhookEvent[];
  /** Times the blocking model method was entered. */
  entered(): number;
  /** Releases every blocking model method entered so far. */
  release(): void;
}

/**
 * Boots a real repo with two webhook routes: `/hooks/slow` runs a model
 * method that blocks until released, `/hooks/fast` one that returns at once.
 */
async function withHarness(
  maxConcurrentRuns: number,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-webhook-conc-" });
  const gates: Array<() => void> = [];
  try {
    await consumeStream(
      repoInit(
        createLibSwampContext({}),
        createRepoInitDeps("20260101.120000.0"),
        {
          path: repoDir,
          force: false,
          version: "20260101.120000.0",
          tools: [],
        },
      ),
      withDefaults({
        error: (event) => {
          throw new Error(String(event.error?.message ?? "repo init failed"));
        },
      }),
    );

    // Per-run type names keep each test's closures their own under --repeats.
    const blockType = ModelType.create(
      `test/conc-block-${crypto.randomUUID()}`,
    );
    const fastType = ModelType.create(`test/conc-fast-${crypto.randomUUID()}`);
    modelRegistry.register({
      type: blockType,
      version: "2026.10.21.1",
      resources: {},
      methods: {
        block: {
          description: "Block until released or aborted",
          arguments: z.object({}),
          execute: async (_args, context) => {
            await new Promise<void>((resolve, reject) => {
              gates.push(resolve);
              context.signal.addEventListener(
                "abort",
                () => reject(context.signal.reason),
                { once: true },
              );
            });
            return { dataHandles: [] };
          },
        },
      },
    });
    modelRegistry.register({
      type: fastType,
      version: "2026.10.21.1",
      resources: {},
      methods: {
        run: {
          description: "Return at once",
          arguments: z.object({}),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      },
    });

    const {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      syncService,
    } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
    await repoContext.definitionRepo.save(
      blockType,
      Definition.create({ name: "blocker" }),
    );
    await repoContext.definitionRepo.save(
      fastType,
      Definition.create({ name: "quick" }),
    );
    for (
      const [workflow, model, method] of [
        ["slow-wf", "blocker", "block"],
        ["fast-wf", "quick", "run"],
      ]
    ) {
      await repoContext.workflowRepo.save(Workflow.create({
        name: workflow,
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: method,
            task: StepTask.model(model, method, {}),
          })],
        })],
      }));
    }

    const service = new WebhookService({
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      endpoints: [
        await parseWebhookFlag(`/hooks/slow:slow-wf:${SECRET}`),
        await parseWebhookFlag(`/hooks/fast:fast-wf:${SECRET}`),
      ],
      syncService,
      syncGate: undefined,
      maxConcurrentRuns,
    });
    const events: WebhookEvent[] = [];
    service.setEventHandler((event) => events.push(event));

    const release = () => {
      for (const open of gates.splice(0)) open();
    };
    try {
      await fn({ service, events, entered: () => gates.length, release });
    } finally {
      release();
      await service.stop();
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "WebhookService: a delivery on another route completes while a slow run is still in flight",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withHarness(2, async (h) => {
      await (await h.service.handleRequest(await delivery("/hooks/slow")))
        ?.body?.cancel();
      await waitFor(() => h.entered() === 1, "slow run blocked in its step");

      await (await h.service.handleRequest(await delivery("/hooks/fast")))
        ?.body?.cancel();
      await waitFor(
        () => completedRuns(h.events, "fast-wf") === 1,
        "fast run completed",
      );
      assertEquals(completedRuns(h.events, "slow-wf"), 0);

      h.release();
      await waitFor(
        () => completedRuns(h.events, "slow-wf") === 1,
        "slow run completed",
      );
    });
  },
});

Deno.test({
  name:
    "WebhookService: same-route runs are both in flight while a step on the same model waits for its lock",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withHarness(2, async (h) => {
      for (let i = 0; i < 2; i++) {
        await (await h.service.handleRequest(await delivery("/hooks/slow")))
          ?.body?.cancel();
      }
      await waitFor(
        () => h.events.filter((e) => e.kind === "webhook_started").length === 2,
        "both runs started",
      );
      await waitFor(() => h.entered() === 1, "first run holds the step");
      assertEquals(h.service.queueStatus("/hooks/slow").active, 2);
      assertEquals(h.service.queueStatus("/hooks/slow").queued, 0);

      h.release();
      await waitFor(() => h.entered() === 1, "second run took the lock");
      h.release();
      await waitFor(
        () => completedRuns(h.events, "slow-wf") === 2,
        "both runs completed",
      );
      assertEquals(h.service.queueStatus("/hooks/slow").active, 0);
    });
  },
});

Deno.test({
  name:
    "WebhookService: a shutdown with runs in flight keeps the queued delivery for the next boot to replay",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-webhook-replay-" });
    const tracker = new RunTrackerStore(join(dir, "runs.db"));
    try {
      const gates: Array<() => void> = [];
      const replayed: boolean[] = [];
      const executeWorkflow = ((
        _repoDir: string,
        _repoContext: unknown,
        _datastoreConfig: unknown,
        _input: unknown,
        _signal: AbortSignal,
        onEvent: (event: unknown) => void,
      ) => {
        onEvent({ kind: "started", runId: crypto.randomUUID() });
        return new Promise<void>((resolve) => gates.push(resolve)).then(() =>
          onEvent({ kind: "completed", run: { status: "succeeded" } })
        );
      }) as unknown as NonNullable<
        ConstructorParameters<typeof WebhookService>[0]["executeWorkflow"]
      >;
      const build = async () => {
        const service = new WebhookService({
          repoDir: dir,
          repoContext: {} as unknown as RepositoryContext,
          datastoreConfig: {} as unknown as DatastoreConfig,
          endpoints: [await parseWebhookFlag(`/hooks/slow:slow-wf:${SECRET}`)],
          syncGate: undefined,
          runTracker: tracker,
          maxConcurrentRuns: 2,
          executeWorkflow,
        });
        service.setEventHandler((event) => {
          if (event.kind === "webhook_started") replayed.push(event.replayed);
        });
        return service;
      };

      const first = await build();
      for (let i = 0; i < 3; i++) {
        await (await first.handleRequest(await delivery("/hooks/slow")))
          ?.body?.cancel();
      }
      await waitFor(() => gates.length === 2, "two runs in flight");
      assertEquals(tracker.findAllPendingRuns().length, 1);

      const shutdown = runShutdownDrain({
        webhookService: first,
        scheduledExecution: null,
        activeRunRegistry: null,
        drainTimeoutMs: 60_000,
        abortGraceMs: 0,
      });
      for (const open of gates.splice(0)) open();
      await shutdown;
      assertEquals(replayed, [false, false]);
      assertEquals(tracker.findAllPendingRuns().length, 1);

      const second = await build();
      try {
        const count = await replayPendingRuns({
          runTracker: tracker,
          webhookService: second,
          configuredWebhookWorkflows: new Set(["slow-wf"]),
          configuredWebhookRoutes: new Set(["/hooks/slow"]),
          configuredCronWorkflows: new Set(),
        });
        assertEquals(count, 1);
        await waitFor(() => gates.length === 1, "replayed run in flight");
        assertEquals(replayed, [false, false, true]);
        assertEquals(tracker.findAllPendingRuns().length, 0);
        for (const open of gates.splice(0)) open();
      } finally {
        await second.stop();
      }
    } finally {
      tracker.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
