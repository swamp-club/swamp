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
 * Integration tests for authored-expression provenance across the workflow
 * seams that are NOT the plain fresh run (swamp-club#2172): resume,
 * --last-evaluated, and nested workflows.
 *
 * Each is an independent path with its own evaluator or its own re-parse of
 * step inputs. A fix applied only to the fresh path would leave these fully
 * exploitable while every fresh-path test stayed green, so each seam is
 * exercised here directly.
 *
 * Both tests drive a real run to failure and then resume it with `--from`,
 * which is the cheapest way to reach the resume seam: the alternative
 * (suspend-on-approval) needs an approval gate and a second actor.
 */

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import {
  collect,
  createLibSwampContext,
  createModelEvaluateDeps,
  modelEvaluate,
} from "../src/libswamp/mod.ts";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import {
  createWorkflowRunDeps,
  executeWorkflowWithLocks,
} from "../src/serve/deps.ts";
import { createEphemeralStore } from "../src/infrastructure/persistence/ephemeral_store.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const inputSchema = {
  type: "object" as const,
  properties: { identifier: { type: "string" as const } },
  required: ["identifier"],
};

/**
 * One shell step that echoes `run` and then fails, so the run reaches a
 * `failed` status that `resume --from` will accept. The command is echoed
 * before the failure, so if a runtime expression is wrongly resolved the
 * plaintext is in the event stream either way.
 */
function failingWorkflow(name: string, run: string): Workflow {
  return Workflow.create({
    name,
    inputs: inputSchema,
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
              { run: `${run} && exit 1` },
            ),
          }),
        ],
      }),
    ],
  });
}

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-resume-provenance-",
  });
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

/** Runs the workflow in-process and returns its run id and event stream. */
async function runWorkflow(
  repoDir: string,
  workflowName: string,
  inputs: Record<string, unknown>,
  lastEvaluated = false,
): Promise<{ runId: string; events: WorkflowRunEvent[] }> {
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

  let runId: string | undefined;
  const events: WorkflowRunEvent[] = [];
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflowName, inputs, lastEvaluated },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      events.push(event);
      if (event.kind === "started") runId = event.runId;
      if (event.kind === "completed") runId = event.run.id;
    },
    syncService,
  );

  if (!runId) throw new Error("no run id observed");
  return { runId, events };
}

/** Runs the workflow to failure and returns the failed run's id. */
async function runToFailure(
  repoDir: string,
  workflowName: string,
  inputs: Record<string, unknown>,
): Promise<string> {
  return (await runWorkflow(repoDir, workflowName, inputs)).runId;
}

/** Resumes the failed run from its only step and returns the event stream. */
async function resumeFromStep(
  repoDir: string,
  workflowName: string,
  runId: string,
  stepName: string,
): Promise<unknown[]> {
  const { repoDir: resolved, repoContext, datastoreConfig } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

  const deps = await createWorkflowRunDeps(
    resolved,
    repoContext,
    datastoreConfig,
  );
  const ephemeral = createEphemeralStore();
  try {
    const service = deps.createExecutionService(
      deps.workflowRepo,
      deps.runRepo,
      deps.repoDir,
      deps.catalogStore,
      ephemeral.repo,
      ephemeral.catalog,
    );

    const events: unknown[] = [];
    for await (
      const event of service.resume(workflowName, runId, {
        signal: new AbortController().signal,
        fromStep: stepName,
      })
    ) {
      events.push(event);
    }
    return events;
  } finally {
    await ephemeral.dispose?.();
  }
}

Deno.test({
  name:
    "workflow resume: env expression injected through run inputs is not resolved",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SWAMP_TEST_2172_RESUME", "leaked-plaintext");
    try {
      await withRepo(async (repoDir) => {
        const workflow = failingWorkflow(
          "resume-injected-expression",
          'echo "VALUE=${{ inputs.identifier }}"',
        );
        await new YamlWorkflowRepository(repoDir).save(workflow);

        const runId = await runToFailure(repoDir, workflow.name, {
          identifier: "${{ env.SWAMP_TEST_2172_RESUME }}",
        });

        const events = await resumeFromStep(
          repoDir,
          workflow.name,
          runId,
          "echo",
        );
        const serialized = JSON.stringify(events);

        // The injected text did reach the resumed command — without this the
        // test could pass because the step never re-ran.
        assertEquals(
          serialized.includes("env.SWAMP_TEST_2172_RESUME"),
          true,
          `injected text never reached the resumed step: ${serialized}`,
        );
        assertEquals(
          serialized.includes("leaked-plaintext"),
          false,
          `resume seam resolved an environment variable from input text: ${serialized}`,
        );
      });
    } finally {
      Deno.env.delete("SWAMP_TEST_2172_RESUME");
    }
  },
});

Deno.test({
  name:
    "workflow resume: env expression written in the workflow source still resolves",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SWAMP_TEST_2172_RESUME_OK", "authored-value");
    try {
      await withRepo(async (repoDir) => {
        const workflow = failingWorkflow(
          "resume-authored-expression",
          'echo "VALUE=${{ env.SWAMP_TEST_2172_RESUME_OK }}"',
        );
        await new YamlWorkflowRepository(repoDir).save(workflow);

        const runId = await runToFailure(repoDir, workflow.name, {
          identifier: "unused",
        });

        const events = await resumeFromStep(
          repoDir,
          workflow.name,
          runId,
          "echo",
        );

        assertEquals(
          JSON.stringify(events).includes("VALUE=authored-value"),
          true,
          "authored env reference did not resolve on the resume path",
        );
      });
    } finally {
      Deno.env.delete("SWAMP_TEST_2172_RESUME_OK");
    }
  },
});

/**
 * --last-evaluated seam. The first run substitutes the injected text into the
 * cached evaluated workflow; the second run loads that cache and re-parses
 * the step inputs (execution_service.ts, lastEvaluated branch) to resolve
 * deferred expressions. The bracket-index env form is used because it is not
 * caught by the runtime gate at all — only the gate on that re-parse stops it.
 */
Deno.test({
  name:
    "workflow --last-evaluated: env expression cached from a prior run's inputs is not resolved",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SWAMP_TEST_2172_LASTEVAL", "leaked-plaintext");
    try {
      await withRepo(async (repoDir) => {
        const workflow = Workflow.create({
          name: "lasteval-injected-expression",
          inputs: inputSchema,
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "echo",
                  task: StepTask.directExecution(
                    "command/shell",
                    "lasteval-injected-shell",
                    "execute",
                    { run: 'echo "VALUE=${{ inputs.identifier }}"' },
                  ),
                }),
              ],
            }),
          ],
        });
        await new YamlWorkflowRepository(repoDir).save(workflow);

        const injected = "${{ env['SWAMP_TEST_2172_LASTEVAL'] }}";
        await runWorkflow(repoDir, workflow.name, { identifier: injected });
        const { events } = await runWorkflow(
          repoDir,
          workflow.name,
          { identifier: injected },
          true,
        );
        const serialized = JSON.stringify(events);

        assertEquals(
          serialized.includes("SWAMP_TEST_2172_LASTEVAL"),
          true,
          `injected text never reached the cached step: ${serialized}`,
        );
        assertEquals(
          serialized.includes("leaked-plaintext"),
          false,
          `--last-evaluated re-parse resolved an environment variable from cached input text: ${serialized}`,
        );
      });
    } finally {
      Deno.env.delete("SWAMP_TEST_2172_LASTEVAL");
    }
  },
});

/**
 * Nested-workflow seam. The parent's evaluator substitutes the run input into
 * the workflow step's inputs, and runWorkflowStep then re-parses those inputs
 * (execution_service.ts, nested-workflow branch) before handing them to the
 * child. The gate there uses the PARENT's authored set.
 */
Deno.test({
  name:
    "workflow nested: env expression injected through the parent's inputs is not resolved for the child",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SWAMP_TEST_2172_NESTED", "leaked-plaintext");
    try {
      await withRepo(async (repoDir) => {
        const repo = new YamlWorkflowRepository(repoDir);
        const child = Workflow.create({
          name: "nested-child",
          inputs: inputSchema,
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "echo",
                  task: StepTask.directExecution(
                    "command/shell",
                    "nested-child-shell",
                    "execute",
                    { run: 'echo "VALUE=${{ inputs.identifier }}"' },
                  ),
                }),
              ],
            }),
          ],
        });
        const parent = Workflow.create({
          name: "nested-parent",
          inputs: inputSchema,
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "call-child",
                  task: StepTask.workflow("nested-child", {
                    identifier: "${{ inputs.identifier }}",
                  }),
                }),
              ],
            }),
          ],
        });
        await repo.save(child);
        await repo.save(parent);

        const { events } = await runWorkflow(repoDir, parent.name, {
          identifier: "${{ env['SWAMP_TEST_2172_NESTED'] }}",
        });
        const serialized = JSON.stringify(events);

        assertEquals(
          serialized.includes("SWAMP_TEST_2172_NESTED"),
          true,
          `injected text never reached the child step: ${serialized}`,
        );
        assertEquals(
          serialized.includes("leaked-plaintext"),
          false,
          `nested-workflow re-parse resolved an environment variable from parent input text: ${serialized}`,
        );
      });
    } finally {
      Deno.env.delete("SWAMP_TEST_2172_NESTED");
    }
  },
});

/**
 * --last-evaluated after a source edit. The first run writes the workflow
 * cache together with the source's authored set. A standalone `model
 * evaluate` then rewrites the step's definition cache with only the
 * definition's own provenance, and the workflow source is edited so it no
 * longer contains the env expression. Only the set persisted with the
 * workflow cache can now vouch for the cached step input.
 */
Deno.test({
  name:
    "workflow --last-evaluated: authored env expression survives a source edit via persisted provenance",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SWAMP_TEST_2172_CACHED", "cached-authored");
    try {
      await withRepo(async (repoDir) => {
        const definition = Definition.create({
          name: "lasteval-edited-shell",
          methods: { execute: { arguments: { run: "echo placeholder" } } },
        });
        await new YamlDefinitionRepository(repoDir).save(
          ModelType.create("command/shell"),
          definition,
        );
        const build = (run: string): Workflow =>
          Workflow.fromData({
            id: "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f",
            name: "lasteval-edited-source",
            inputs: undefined,
            jobs: [
              Job.create({
                name: "main",
                steps: [
                  Step.create({
                    name: "echo",
                    task: StepTask.modelMethod(definition.name, "execute", {
                      run,
                    }),
                  }),
                ],
              }).toData(),
            ],
          });
        const workflowRepo = new YamlWorkflowRepository(repoDir);
        const original = build(
          "echo \"VALUE=${{ env['SWAMP_TEST_2172_CACHED'] }}\"",
        );
        await workflowRepo.save(original);
        await runWorkflow(repoDir, original.name, {});

        const evaluateEvents = await collect(modelEvaluate(
          createLibSwampContext(),
          createModelEvaluateDeps(repoDir),
          { modelIdOrName: definition.name },
        ));
        assertEquals(evaluateEvents.filter((e) => e.kind === "error"), []);

        await workflowRepo.save(build('echo "VALUE=edited"'));
        const { events } = await runWorkflow(repoDir, original.name, {}, true);
        const serialized = JSON.stringify(events);
        assertEquals(
          serialized.includes("cached-authored"),
          true,
          `cached authored expression was not resolved: ${serialized}`,
        );
      });
    } finally {
      Deno.env.delete("SWAMP_TEST_2172_CACHED");
    }
  },
});
