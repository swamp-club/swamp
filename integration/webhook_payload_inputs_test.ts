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
 * Integration tests for webhook payload extraction into workflow inputs (#717).
 *
 * Webhook runs flow through `executeWorkflowWithLocks` carrying a `webhook`
 * payload. The workflow's `trigger.inputs` CEL expressions are evaluated against
 * that payload BEFORE input validation, so a payload field can satisfy a
 * required input. These tests drive `executeWorkflowWithLocks` directly with a
 * payload (rather than standing up an HTTP server) and assert that the extracted
 * value reaches the workflow as a validated input.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  repoInit,
  withDefaults,
} from "../src/libswamp/mod.ts";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import type { WebhookPayload } from "../src/domain/expressions/model_resolver.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const requiredInputSchema = {
  type: "object" as const,
  properties: { identifier: { type: "string" as const } },
  required: ["identifier"],
};

/**
 * A workflow that requires `identifier` and maps it from the webhook payload via
 * trigger.inputs. The step echoes the resolved input so the evaluated workflow
 * carries the extracted value where we can assert on it.
 */
function webhookWorkflow(
  name: string,
  triggerInputs: Record<string, unknown>,
): Workflow {
  return Workflow.create({
    name,
    trigger: { inputs: triggerInputs },
    inputs: requiredInputSchema,
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
              { run: "echo ok", identifier: "${{ inputs.identifier }}" },
            ),
          }),
        ],
      }),
    ],
  });
}

async function runWebhook(
  repoDir: string,
  workflowName: string,
  webhook: WebhookPayload,
): Promise<WorkflowRunEvent[]> {
  const {
    repoDir: resolvedRepoDir,
    repoContext,
    datastoreConfig,
    syncService,
  } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

  const events: WorkflowRunEvent[] = [];
  await executeWorkflowWithLocks(
    resolvedRepoDir,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflowName, webhook },
    new AbortController().signal,
    (event) => events.push(event),
    syncService,
  );
  return events;
}

async function withRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-webhook-inputs-" });
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
    await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

function stepIdentifier(workflow: Workflow): unknown {
  const data = workflow.jobs[0].steps[0].task.data;
  return "inputs" in data ? data.inputs?.identifier : undefined;
}

Deno.test({
  name:
    "webhook run: a required input mapped from the payload resolves, validates, and reaches the step",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = webhookWorkflow("webhook-required-input", {
        identifier: "${{ webhook.body.data.issue.identifier }}",
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      const events = await runWebhook(repoDir, workflow.name, {
        body: { data: { issue: { identifier: "PLT-1057" } } },
        headers: { "x-linear-event": "Issue" },
        route: "/hooks/linear",
      });
      const kinds = events.map((e) => e.kind);

      assertEquals(
        kinds.some((k) => k === "error"),
        false,
        `unexpected error event: ${JSON.stringify(events)}`,
      );
      assertEquals(kinds.at(-1), "completed");

      const evaluated = await new YamlEvaluatedWorkflowRepository(repoDir)
        .findByName(workflow.name);
      assertEquals(stepIdentifier(evaluated!), "PLT-1057");
    });
  },
});

Deno.test({
  name:
    "webhook run: has()/ternary fallback selects an alternate payload field",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = webhookWorkflow("webhook-fallback-input", {
        identifier:
          "${{ has(webhook.body.data.issue) ? webhook.body.data.issue.identifier : webhook.body.data.identifier }}",
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      const events = await runWebhook(repoDir, workflow.name, {
        body: { data: { identifier: "FALLBACK-9" } },
        headers: {},
        route: "/hooks/linear",
      });

      assertEquals(events.map((e) => e.kind).at(-1), "completed");

      const evaluated = await new YamlEvaluatedWorkflowRepository(repoDir)
        .findByName(workflow.name);
      assertEquals(stepIdentifier(evaluated!), "FALLBACK-9");
    });
  },
});

Deno.test({
  name:
    "webhook run: a hard reference to a missing payload field surfaces an error",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = webhookWorkflow("webhook-missing-field", {
        identifier: "${{ webhook.body.data.issue.identifier }}",
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      // Payload has no data.issue — the strict resolver propagates the error.
      await assertRejects(() =>
        runWebhook(repoDir, workflow.name, {
          body: { data: {} },
          headers: {},
          route: "/hooks/linear",
        })
      );
    });
  },
});
