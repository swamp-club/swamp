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

import { join } from "@std/path";
import { assertEquals, assertRejects } from "@std/assert";
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
import type { TelemetryEntry } from "../src/domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../src/domain/telemetry/repositories.ts";
import { TelemetryService } from "../src/domain/telemetry/telemetry_service.ts";
import {
  clearActiveTelemetryService,
  setActiveTelemetryService,
} from "../src/cli/telemetry_integration.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

/** Minimal spool that records what a run wrote. */
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
    undefined,
    { triggerSource: "webhook" },
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

        // Exactly one parent entry for the run, attributed to the webhook
        // trigger. The status is deliberately not asserted here: this
        // fixture's step passes an input the shell model does not accept, so
        // the run fails — the surrounding tests only ever asserted that the
        // payload value reached the evaluated workflow. Success and failure
        // statuses are pinned in the scheduled tests, where the fixture runs
        // clean.
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
 * swamp-club#2172 — a webhook payload is the purest form of the injection this
 * issue is about: the attacker needs no write access to the repo at all, only
 * the ability to POST. TriggerInputResolver splices payload text into the run's
 * inputs, the CEL pass splices those into the definition, and before the
 * authored-expression gate the runtime pass re-parsed that tree and resolved
 * whatever looked like a vault or env reference.
 *
 * This drives the whole path — trigger resolution, workflow evaluation, step
 * options, step context, runtime pass, step execution — so it covers the
 * plumbing as well as the gate.
 *
 * The assertion is on what the shell step actually ran and printed, NOT on the
 * evaluated workflow on disk: that artifact is persisted *before* the runtime
 * pass, so it shows the raw text whether or not the gate works. `env.*` is used
 * because it is the variant with no redaction anywhere — if the gate fails, the
 * plaintext is simply there in the output.
 */
Deno.test({
  name:
    "webhook run: env expression injected through the payload never reaches the shell step",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SWAMP_TEST_2172_WEBHOOK", "leaked-plaintext");
    try {
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
    } finally {
      Deno.env.delete("SWAMP_TEST_2172_WEBHOOK");
    }
  },
});

/**
 * The positive counterpart: an env reference written in the workflow source
 * still resolves at the step, in the same run shape as the test above. Without
 * this, the gate could "pass" by refusing everything — including the references
 * authors legitimately write.
 */
Deno.test({
  name:
    "webhook run: env expression written in the workflow source still resolves",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SWAMP_TEST_2172_AUTHORED", "authored-value");
    try {
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
                    { run: 'echo "VALUE=${{ env.SWAMP_TEST_2172_AUTHORED }}"' },
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
    } finally {
      Deno.env.delete("SWAMP_TEST_2172_AUTHORED");
    }
  },
});

/**
 * The bypass found in adversarial review of the first fix. The runtime pass
 * only sees expressions classified as runtime, and the classifier used to
 * recognise only the dotted form of an env reference. The bracket-index form
 * slipped past it, and the step executor's second CEL pass over the
 * already-substituted step inputs evaluated it with the process environment
 * in scope. Two things now stop it, and this test fails if either is undone
 * on its own: every env form is classified as runtime, and the second pass is
 * gated on the authored set like the runtime pass is.
 */
Deno.test({
  name:
    "webhook run: bracket-index env expression injected through the payload never reaches the shell step",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SWAMP_TEST_2172_BRACKET", "leaked-plaintext");
    try {
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
    } finally {
      Deno.env.delete("SWAMP_TEST_2172_BRACKET");
    }
  },
});

/**
 * A non-runtime CEL expression injected through the payload must be just as
 * inert at the second pass: here it names another record through
 * data.latest(). The runtime gate never sees this shape, so only the gate on
 * the step-input pass stops it.
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
      const events = await runWebhook(repoDir, workflow.name, {
        body: { data: { issue: { identifier: injected } } },
        headers: { "x-linear-event": "Issue" },
        route: "/hooks/linear",
      });

      // The command the shell actually received must still carry the raw
      // expression text (the shell provider brace-escapes it, so match on
      // the CEL body), proving it was neither evaluated nor stripped. The
      // run's recorded inputs echo the raw text regardless, so look only at
      // what the step printed.
      const printed = events
        .filter((e) => e.kind === "method_output")
        .map((e) => JSON.stringify(e))
        .join("\n");
      assertEquals(
        printed.includes(
          "data.latest('webhook-injected-data-shell', 'result').attributes.command",
        ),
        true,
        `injected data.latest() text was evaluated or altered: ${printed}`,
      );
    });
  },
});
