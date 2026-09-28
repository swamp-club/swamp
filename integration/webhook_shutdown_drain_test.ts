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
 * Integration tests for draining webhook runs on serve shutdown
 * (swamp-club#2484).
 *
 * `swamp serve` used to abort every in-flight webhook run the moment SIGTERM
 * arrived. These tests drive a real WebhookService on a temp repo with a
 * model method that blocks until the test releases it, and pin both halves
 * of the new behaviour: a drain long enough lets the run succeed, and a drain
 * that times out leaves the run for stop() to abort.
 */

import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  repoInit,
  withDefaults,
} from "../src/libswamp/mod.ts";
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

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const SECRET = "shhh";
const BODY = '{"event":"push"}';
const ROUTE = "/hooks/slow";

interface Harness {
  readonly service: WebhookService;
  readonly events: WebhookEvent[];
  /** Resolves the blocked model method so the run can finish. */
  release(): void;
  /** True once the model method is running. */
  started(): boolean;
  /** True if the model method saw its abort signal fire. */
  aborted(): boolean;
  deliver(): Promise<Response>;
}

/**
 * Boots a real repo whose only workflow runs a model method that blocks until
 * released or aborted, and wires a WebhookService to it.
 */
async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-webhook-drain-" });
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

    const gate = Promise.withResolvers<void>();
    let started = false;
    let aborted = false;
    // A per-run type name keeps each test's closure its own under --repeats.
    const type = ModelType.create(`test/drain-${crypto.randomUUID()}`);
    modelRegistry.register({
      type,
      version: "2026.09.28.1",
      resources: {},
      methods: {
        block: {
          description: "Block until released or aborted",
          arguments: z.object({}),
          execute: async (_args, context) => {
            started = true;
            await new Promise<void>((resolve, reject) => {
              gate.promise.then(resolve);
              context.signal.addEventListener("abort", () => {
                aborted = true;
                reject(context.signal.reason);
              }, { once: true });
            });
            return { dataHandles: [] };
          },
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
      type,
      Definition.create({ name: "blocker" }),
    );
    await repoContext.workflowRepo.save(Workflow.create({
      name: "slow-wf",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "block",
          task: StepTask.model("blocker", "block", {}),
        })],
      })],
    }));

    const service = new WebhookService({
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      endpoints: [await parseWebhookFlag(`${ROUTE}:slow-wf:${SECRET}`)],
      syncService,
      syncGate: undefined,
    });
    const events: WebhookEvent[] = [];
    service.setEventHandler((event) => events.push(event));

    const deliver = async () => {
      const signature = await hmacSha256Hex(
        new TextEncoder().encode(BODY),
        SECRET,
      );
      const response = await service.handleRequest(
        new Request(`http://localhost${ROUTE}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${signature}`,
          },
          body: BODY,
        }),
      );
      assert(response, "route should have matched");
      return response;
    };

    try {
      await fn({
        service,
        events,
        release: () => gate.resolve(),
        started: () => started,
        aborted: () => aborted,
        deliver,
      });
    } finally {
      gate.resolve();
      await service.stop();
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "WebhookService.drain: an in-flight run finishes instead of aborting",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withHarness(async (h) => {
      const accepted = await h.deliver();
      assertEquals(accepted.status, 200);
      await waitFor(h.started, "model method to start", { timeoutMs: 60_000 });

      const drain = h.service.drain(60_000);

      // New deliveries are turned away while the drain runs.
      const rejected = await h.deliver();
      assertEquals(rejected.status, 503);
      assertEquals(rejected.headers.get("retry-after"), "5");
      await rejected.body?.cancel();

      h.release();
      await drain;

      assertEquals(h.aborted(), false);
      assert(
        h.events.some((e) => e.kind === "webhook_completed"),
        `expected webhook_completed, got ${JSON.stringify(h.events)}`,
      );
      assertEquals(h.events.some((e) => e.kind === "webhook_failed"), false);
    });
  },
});

Deno.test({
  name:
    "WebhookService.drain: a run still going at the deadline is aborted by stop",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withHarness(async (h) => {
      await (await h.deliver()).body?.cancel();
      await waitFor(h.started, "model method to start", { timeoutMs: 60_000 });

      await h.service.drain(1);
      assertEquals(h.aborted(), false);

      await h.service.stop();
      assertEquals(h.aborted(), true);
      assertEquals(
        h.events.some((e) => e.kind === "webhook_completed"),
        false,
      );
    });
  },
});
