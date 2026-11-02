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
import { assertEquals, assertRejects } from "@std/assert";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import type { WebhookPayload } from "../src/domain/expressions/model_resolver.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import type { TelemetryEntry } from "../src/domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../src/domain/telemetry/repositories.ts";
import { TelemetryService } from "../src/domain/telemetry/telemetry_service.ts";
import {
  clearActiveTelemetryService,
  setActiveTelemetryService,
} from "../src/cli/telemetry_integration.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";

await initializeLogging({});

class RecordingRepository implements TelemetryRepository {
  saved: TelemetryEntry[] = [];
  save(entry: TelemetryEntry): Promise<void> {
    this.saved.push(entry);
    return Promise.resolve();
  }
  findByDate(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  findByDateRange(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  deleteOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
  deleteAllOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
  findUnflushed(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  markFlushed(): Promise<boolean> {
    return Promise.resolve(true);
  }
  quarantine(): Promise<void> {
    return Promise.resolve();
  }
  deleteQuarantinedOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
}

const requiredInputSchema = {
  type: "object" as const,
  properties: { identifier: { type: "string" as const } },
  required: ["identifier"],
};

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
    undefined,
    { syncGate: undefined, triggerSource: "webhook" },
  );
  return events;
}

async function withRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-webhook-inputs-" });
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

function stepIdentifier(workflow: Workflow): unknown {
  const data = workflow.jobs[0].steps[0].task.data;
  if (!("inputs" in data) || typeof data.inputs === "string") return undefined;
  return data.inputs?.identifier;
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

Deno.test({
  name:
    "webhook run: records telemetry attributed to the webhook trigger, without the payload",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = webhookWorkflow("webhook-telemetry", {
        identifier: "${{ webhook.body.data.issue.identifier }}",
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      const repo = new RecordingRepository();
      setActiveTelemetryService(new TelemetryService(repo, "test"));
      try {
        const events = await runWebhook(repoDir, workflow.name, {
          body: {
            data: { issue: { identifier: "PLT-2001" } },
            secret: "super-secret-token",
          },
          headers: { authorization: "Bearer should-never-be-recorded" },
          route: "/hooks/linear",
        });
        assertEquals(events.at(-1)?.kind, "completed");

        // status is not asserted: this fixture passes the shell model an input
        // it does not accept, so the run fails; success and failure are pinned
        // in the scheduled tests
        const parents = repo.saved.filter((e) => !e.parentInvocationId);
        assertEquals(parents.length, 1);
        assertEquals(parents[0].triggerSource, "webhook");
        assertEquals(parents[0].invocation.command, "workflow");
        assertEquals(parents[0].invocation.subcommand, "run");

        // Webhook payloads are attacker-influenced and must never reach
        // telemetry. Serve-side entries are generated with no human present,
        // so this is asserted rather than assumed.
        const serialized = JSON.stringify(repo.saved.map((e) => e.toData()));
        assertEquals(serialized.includes("super-secret-token"), false);
        assertEquals(serialized.includes("should-never-be-recorded"), false);
        assertEquals(serialized.includes("PLT-2001"), false);
      } finally {
        clearActiveTelemetryService();
      }
    });
  },
});

/**
 * a webhook payload needs no repo write access to inject text; assert on what
 * the shell step printed, not the evaluated workflow on disk, which is
 * persisted before the runtime pass
 */
Deno.test({
  name:
    "webhook run: env expression injected through the payload never reaches the shell step",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMockedEnv(
      { SWAMP_TEST_2172_WEBHOOK: "leaked-plaintext" },
      async () => {
        await withRepo(async (repoDir) => {
          const workflow = Workflow.create({
            name: "webhook-injected-expression",
            trigger: {
              inputs: {
                identifier: "${{ webhook.body.data.issue.identifier }}",
              },
            },
            inputs: requiredInputSchema,
            jobs: [
              Job.create({
                name: "main",
                steps: [
                  Step.create({
                    name: "echo",
                    task: StepTask.directExecution(
                      "command/shell",
                      "webhook-injected-shell",
                      "execute",
                      { run: 'echo "VALUE=${{ inputs.identifier }}"' },
                    ),
                  }),
                ],
              }),
            ],
          });
          await new YamlWorkflowRepository(repoDir).save(workflow);

          const events = await runWebhook(repoDir, workflow.name, {
            body: {
              data: {
                issue: { identifier: "${{ env.SWAMP_TEST_2172_WEBHOOK }}" },
              },
            },
            headers: { "x-linear-event": "Issue" },
            route: "/hooks/linear",
          });

          const serialized = JSON.stringify(events);

          // The payload text did reach the command — without this the test could
          // pass because nothing was substituted at all.
          assertEquals(
            serialized.includes("env.SWAMP_TEST_2172_WEBHOOK"),
            true,
            `payload text never reached the step: ${serialized}`,
          );
          assertEquals(
            serialized.includes("leaked-plaintext"),
            false,
            `environment variable was resolved from webhook payload text: ${serialized}`,
          );
        });
      },
    );
  },
});

/**
 * the positive counterpart: without it the gate could pass by refusing every
 * env reference, including ones authors legitimately write
 */
Deno.test({
  name:
    "webhook run: env expression written in the workflow source still resolves",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMockedEnv(
      { SWAMP_TEST_2172_WEBHOOK_AUTHORED: "authored-value" },
      async () => {
        await withRepo(async (repoDir) => {
          const workflow = Workflow.create({
            name: "webhook-authored-expression",
            trigger: {
              inputs: {
                identifier: "${{ webhook.body.data.issue.identifier }}",
              },
            },
            inputs: requiredInputSchema,
            jobs: [
              Job.create({
                name: "main",
                steps: [
                  Step.create({
                    name: "echo",
                    task: StepTask.directExecution(
                      "command/shell",
                      "webhook-authored-shell",
                      "execute",
                      {
                        run:
                          'echo "VALUE=${{ env.SWAMP_TEST_2172_WEBHOOK_AUTHORED }}"',
                      },
                    ),
                  }),
                ],
              }),
            ],
          });
          await new YamlWorkflowRepository(repoDir).save(workflow);

          const events = await runWebhook(repoDir, workflow.name, {
            body: { data: { issue: { identifier: "PLT-1" } } },
            headers: { "x-linear-event": "Issue" },
            route: "/hooks/linear",
          });

          const serialized = JSON.stringify(events);
          assertEquals(
            serialized.includes("VALUE=authored-value"),
            true,
            `authored env reference did not resolve: ${serialized}`,
          );
        });
      },
    );
  },
});

/**
 * the bracket-index env form must be classified as runtime and the step-input
 * second pass gated on the authored set; the test fails if either is undone
 * alone
 */
Deno.test({
  name:
    "webhook run: bracket-index env expression injected through the payload never reaches the shell step",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMockedEnv(
      { SWAMP_TEST_2172_BRACKET: "leaked-plaintext" },
      async () => {
        await withRepo(async (repoDir) => {
          const workflow = Workflow.create({
            name: "webhook-injected-bracket-expression",
            trigger: {
              inputs: {
                identifier: "${{ webhook.body.data.issue.identifier }}",
              },
            },
            inputs: requiredInputSchema,
            jobs: [
              Job.create({
                name: "main",
                steps: [
                  Step.create({
                    name: "echo",
                    task: StepTask.directExecution(
                      "command/shell",
                      "webhook-injected-bracket-shell",
                      "execute",
                      { run: 'echo "VALUE=${{ inputs.identifier }}"' },
                    ),
                  }),
                ],
              }),
            ],
          });
          await new YamlWorkflowRepository(repoDir).save(workflow);

          const events = await runWebhook(repoDir, workflow.name, {
            body: {
              data: {
                issue: { identifier: "${{ env['SWAMP_TEST_2172_BRACKET'] }}" },
              },
            },
            headers: { "x-linear-event": "Issue" },
            route: "/hooks/linear",
          });

          const serialized = JSON.stringify(events);
          assertEquals(
            serialized.includes("SWAMP_TEST_2172_BRACKET"),
            true,
            `payload text never reached the step: ${serialized}`,
          );
          assertEquals(
            serialized.includes("leaked-plaintext"),
            false,
            `bracket-index env reference was resolved from webhook payload text: ${serialized}`,
          );
        });
      },
    );
  },
});

/**
 * a non-runtime CEL expression injected via the payload must be inert at the
 * second pass; the runtime gate never sees it, so only the step-input pass gate
 * stops it
 */
Deno.test({
  name:
    "webhook run: data.latest() expression injected through the payload is not evaluated",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = Workflow.create({
        name: "webhook-injected-data-expression",
        trigger: {
          inputs: {
            identifier: "${{ webhook.body.data.issue.identifier }}",
          },
        },
        inputs: requiredInputSchema,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "echo",
                task: StepTask.directExecution(
                  "command/shell",
                  "webhook-injected-data-shell",
                  "execute",
                  { run: 'echo "VALUE=${{ inputs.identifier }}"' },
                ),
              }),
            ],
          }),
        ],
      });
      await new YamlWorkflowRepository(repoDir).save(workflow);

      const injected =
        "${{ data.latest('webhook-injected-data-shell', 'result').attributes.command }}";
      await runWebhook(repoDir, workflow.name, {
        body: { data: { issue: { identifier: injected } } },
        headers: { "x-linear-event": "Issue" },
        route: "/hooks/linear",
      });

      // the shell must print the raw text unevaluated and unstripped; read the
      // shell model's result record, since the run's recorded inputs echo the
      // raw text regardless
      const { repoContext } = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "log",
      });
      const results = await repoContext.dataQueryService.query(
        'modelName == "webhook-injected-data-shell" && specName == "result"',
        { loadAttributes: true },
      ) as Array<{ attributes?: Record<string, unknown> }>;
      assertEquals(results.length, 1, "the shell step must record its result");
      assertEquals(
        results[0].attributes?.command,
        Deno.build.os === "windows"
          ? 'echo "VALUE=${env:__SWAMP_IN_0}"'
          : 'echo "VALUE=${__SWAMP_IN_0}"',
      );
      assertEquals(
        (results[0].attributes?.stdout as string).trim(),
        `VALUE=${injected}`,
        "injected data.latest() text was evaluated or altered",
      );
    });
  },
});
