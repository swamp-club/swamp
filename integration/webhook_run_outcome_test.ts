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
 * Integration tests for how WebhookService classifies a workflow run's
 * outcome (swamp-club#2303).
 *
 * WebhookService used to capture only the `started` and `completed` events
 * from the run stream, so a run that ended any other way fell into the
 * success branch and was logged as completed with an empty run id — and
 * counted in the "completed" bucket of the health endpoint's throughput
 * metrics. These tests pin the two outcomes that produce no `completed`
 * event: a run that errors before it starts, and a run that suspends on an
 * approval gate.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  repoInit,
  withDefaults,
} from "../src/libswamp/mod.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
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

/** A workflow whose only step is a manual approval gate, so the run suspends. */
function gatedWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "approval-step",
            task: StepTask.manualApproval("Do you approve?"),
          }),
        ],
      }),
    ],
  });
}

/**
 * Boots a real repo on a temp filesystem, optionally saving a workflow, and
 * drives one signed request through WebhookService. Returns every lifecycle
 * event the service emitted.
 */
async function runWebhook(
  flag: string,
  route: string,
  workflow: Workflow | undefined,
  settled: (events: readonly WebhookEvent[]) => boolean,
): Promise<WebhookEvent[]> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-webhook-outcome-" });
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

    if (workflow) {
      await new YamlWorkflowRepository(repoDir).save(workflow);
    }

    const {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      syncService,
    } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

    const service = new WebhookService({
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      endpoints: [await parseWebhookFlag(flag)],
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
        new Request(`http://localhost${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${signature}`,
          },
          body: BODY,
        }),
      );
      assert(response, "route should have matched");
      assertEquals(response.status, 200);
      assertEquals((await response.json()).status, "queued");

      await waitFor(
        () => settled(events),
        "webhook run to settle",
        { timeoutMs: 60_000 },
      );
      return events;
    } finally {
      await service.stop();
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "WebhookService: a run that errors before starting is reported as failed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // parseWebhookFlag does not check that the workflow exists, so the run
    // stream yields an `error` event and never a `completed` one — the exact
    // shape that used to be misreported as a completion.
    const events = await runWebhook(
      "/hooks/missing:no-such-workflow:shhh",
      "/hooks/missing",
      undefined,
      (evts) =>
        evts.some((e) =>
          e.kind === "webhook_failed" || e.kind === "webhook_completed"
        ),
    );

    const failed = events.find((e) => e.kind === "webhook_failed");
    assert(
      failed,
      `expected webhook_failed, got ${JSON.stringify(events)}`,
    );
    // Assert on the message, not just the event kind: the surrounding catch
    // block emits webhook_failed too, so a kind-only assertion would pass
    // even when the error arrived by the throwing path instead.
    assertStringIncludes(failed.error, "no-such-workflow");
    assertEquals(
      events.some((e) => e.kind === "webhook_completed"),
      false,
    );
  },
});

Deno.test({
  name: "WebhookService: a run suspended on an approval gate is not reported " +
    "as completed or failed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A gated run has not finished, so neither terminal event would be true.
    // Reporting it as failed would record a spurious failure against the
    // health endpoint for a run that is merely waiting on an approver.
    const events = await runWebhook(
      "/hooks/gated:gated-wf:shhh",
      "/hooks/gated",
      gatedWorkflow("gated-wf"),
      (evts) => evts.some((e) => e.kind === "webhook_queued"),
    );

    // The queue drains in order, so once the run has been dequeued and
    // suspended no terminal event will follow.
    await waitFor(
      () => events.some((e) => e.kind === "webhook_queued"),
      "webhook run to be queued",
      { timeoutMs: 60_000 },
    );

    assertEquals(
      events.filter((e) =>
        e.kind === "webhook_completed" || e.kind === "webhook_failed"
      ),
      [],
      `suspended run should emit no terminal event, got ${
        JSON.stringify(events)
      }`,
    );
  },
});
