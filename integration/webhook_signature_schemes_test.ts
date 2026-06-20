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
 * Integration tests for pluggable webhook signature verification (#716).
 *
 * These drive WebhookService.handleRequest with real signed HTTP requests for
 * non-github schemes, asserting that a correctly-signed request is accepted
 * (queued) and a forged one is rejected (401). Timestamps for the timestamped
 * schemes are generated at request time so they fall inside the tolerance
 * window. The actual workflow execution is exercised by #717's tests; here we
 * focus on the verification gate, so the queued workflow can be a trivial echo.
 */

import { assertEquals } from "@std/assert";
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
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { parseWebhookFlag, WebhookService } from "../src/serve/webhook.ts";
import { hmacSha256Hex } from "../src/serve/webhook_verifiers.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const SECRET = "shhh";

function echoWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "echo",
            task: StepTask.directExecution(
              "command/shell",
              `${name}-shell`,
              "execute",
              { run: "echo ok" },
            ),
          }),
        ],
      }),
    ],
  });
}

async function withService(
  flag: string,
  workflowName: string,
  fn: (service: WebhookService) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-webhook-schemes-" });
  try {
    await consumeStream(
      repoInit(
        createLibSwampContext({}),
        createRepoInitDeps("20260101.120000.0"),
        { path: repoDir, force: false, version: "20260101.120000.0" },
      ),
      withDefaults({
        error: (event) => {
          throw new Error(String(event.error?.message ?? "repo init failed"));
        },
      }),
    );

    await new YamlWorkflowRepository(repoDir).save(echoWorkflow(workflowName));

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
      endpoints: [parseWebhookFlag(flag)],
      syncService,
    });

    try {
      await fn(service);
    } finally {
      await service.stop();
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

function post(route: string, headers: HeadersInit, body: string): Request {
  return new Request(`http://localhost${route}`, {
    method: "POST",
    headers,
    body,
  });
}

Deno.test({
  name: "webhook scheme: a valid linear signature is accepted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withService(
      "/hooks/linear:linear-wf:shhh:linear",
      "linear-wf",
      async (service) => {
        const body = '{"action":"create"}';
        const sig = await hmacSha256Hex(new TextEncoder().encode(body), SECRET);
        const res = await service.handleRequest(
          post("/hooks/linear", { "linear-signature": sig }, body),
        );
        assertEquals(res?.status, 200);
        assertEquals((await res!.json()).status, "queued");
      },
    );
  },
});

Deno.test({
  name: "webhook scheme: a forged linear signature is rejected with 401",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withService(
      "/hooks/linear:linear-wf:shhh:linear",
      "linear-wf",
      async (service) => {
        const res = await service.handleRequest(
          post(
            "/hooks/linear",
            { "linear-signature": "00".repeat(32) },
            '{"action":"create"}',
          ),
        );
        assertEquals(res?.status, 401);
      },
    );
  },
});

Deno.test({
  name: "webhook scheme: a fresh valid stripe signature is accepted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withService(
      "/hooks/stripe:stripe-wf:shhh:stripe",
      "stripe-wf",
      async (service) => {
        const body = '{"id":"evt_1"}';
        const t = Math.floor(Date.now() / 1000);
        const v1 = await hmacSha256Hex(
          new TextEncoder().encode(`${t}.${body}`),
          SECRET,
        );
        const res = await service.handleRequest(
          post(
            "/hooks/stripe",
            { "stripe-signature": `t=${t},v1=${v1}` },
            body,
          ),
        );
        assertEquals(res?.status, 200);
      },
    );
  },
});

Deno.test({
  name: "webhook scheme: a stale stripe timestamp is rejected with 401",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withService(
      "/hooks/stripe:stripe-wf:shhh:stripe",
      "stripe-wf",
      async (service) => {
        const body = '{"id":"evt_1"}';
        const t = Math.floor(Date.now() / 1000) - 3600;
        const v1 = await hmacSha256Hex(
          new TextEncoder().encode(`${t}.${body}`),
          SECRET,
        );
        const res = await service.handleRequest(
          post(
            "/hooks/stripe",
            { "stripe-signature": `t=${t},v1=${v1}` },
            body,
          ),
        );
        assertEquals(res?.status, 401);
      },
    );
  },
});
