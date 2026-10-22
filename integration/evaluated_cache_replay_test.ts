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
 * A `--last-evaluated` run reads its evaluated cache once (swamp-club#3583):
 * superseding matches on that copy and execution replays it, so a cache
 * rewritten between the two cannot split them, and a run the input check
 * refuses supersedes nothing.
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  workflowRun,
  type WorkflowRunDeps,
  type WorkflowRunEvent,
} from "../src/libswamp/workflows/run.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createWorkflowEvaluateDeps,
  workflowEvaluate,
} from "../src/libswamp/workflows/evaluate.ts";
import { UserError } from "../src/domain/errors.ts";
import { ProvenanceMap } from "../src/domain/expressions/provenance_map.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

/** A repo with a behavior that records the `value` each run hands it. */
async function withRepo(
  fn: (
    repo: RepositoryContext,
    dir: string,
    executions: unknown[],
    type: ModelType,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cache-replay-" });
  const repo = createRepositoryContext({ repoDir: dir });
  const type = ModelType.create(`test/replay-${crypto.randomUUID()}`);
  const executions: unknown[] = [];
  modelRegistry.register({
    type,
    version: "2026.10.20.1",
    methods: {
      run: {
        description: "Capture the resolved value in process",
        arguments: z.object({ value: z.string() }),
        execute: (args) => {
          executions.push(args);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  try {
    await repo.definitionRepo.save(
      type,
      Definition.create({ name: "consumer" }),
    );
    await fn(repo, dir, executions, type);
  } finally {
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

for (const authored of [true, false]) {
  Deno.test(`workflow --last-evaluated: inherited input provenance survives definition evaluation and resume (${authored ? "authored" : "data"})`, async () => {
    await withRepo(async (repo, dir, executions, type) => {
      await withMockedEnv(
        { SWAMP_CACHED_INPUT: "resolved-parent-value" },
        async () => {
          await repo.definitionRepo.save(
            type,
            Definition.create({
              name: "consumer",
              methods: { run: { arguments: { value: "${{ inputs.value }}" } } },
            }),
          );
          const child = Workflow.create({
            name: "child",
            jobs: [Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "before",
                  task: StepTask.model("consumer", "run"),
                }),
                Step.create({
                  name: "gate",
                  task: StepTask.manualApproval("Continue?"),
                  dependsOn: [{
                    step: "before",
                    condition: TriggerCondition.succeeded(),
                  }],
                }),
                Step.create({
                  name: "after",
                  task: StepTask.model("consumer", "run"),
                  dependsOn: [{
                    step: "gate",
                    condition: TriggerCondition.succeeded(),
                  }],
                }),
              ],
            })],
          });
          const expression = "${{ env.SWAMP_CACHED_INPUT }}";
          const parent = Workflow.create({
            name: "parent",
            jobs: [Job.create({
              name: "main",
              steps: [Step.create({
                name: "child",
                task: StepTask.workflow(child.name, {
                  value: authored ? expression : "${{ inputs.value }}",
                }),
              })],
            })],
          });
          await repo.workflowRepo.save(child);
          await repo.workflowRepo.save(parent);
          const deps = await createWorkflowRunDeps(dir, repo, {
            type: "filesystem",
            path: join(dir, ".swamp"),
          });
          const service = () =>
            deps.createExecutionService(
              repo.workflowRepo,
              repo.workflowRunRepo,
              dir,
              repo.catalogStore,
            );
          const original = await service().execute(parent.name, {
            inputs: authored ? {} : { value: expression },
          });
          assertEquals(original.status, "suspended");
          const expected = {
            value: authored ? "resolved-parent-value" : expression,
          };
          assertEquals(executions, [expected]);
          const replay = await service().execute(child.name, {
            lastEvaluated: true,
          });
          assertEquals(replay.status, "suspended");
          assertEquals(executions, [expected, expected]);
          const gate = replay.getJob("main")!.getStep("gate")!;
          gate.recordApprovalDecision({
            approved: true,
            decidedBy: "user:test",
            decidedAt: new Date().toISOString(),
          });
          gate.succeed();
          await repo.workflowRunRepo.save(child.id, replay);
          await collect(service().resume(child.name, replay.id));
          const resumed = await repo.workflowRunRepo.findById(
            child.id,
            replay.id,
          );
          assertEquals(resumed?.status, "succeeded");
          assertEquals(executions, [expected, expected, expected]);
        },
      );
    });
  });
}

/** A step that captures `target`, then a gate that suspends the run. */
function gatedCapture(): Workflow {
  return Workflow.create({
    name: "pinned",
    inputs: {
      properties: { target: { type: "string" } },
      required: ["target"],
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "capture",
            task: StepTask.model("consumer", "run", {
              value: "${{ inputs.target }}",
            }),
          }),
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Proceed?"),
            dependsOn: [
              { step: "capture", condition: TriggerCondition.succeeded() },
            ],
          }),
        ],
      }),
    ],
  });
}

async function start(
  deps: WorkflowRunDeps,
  input: { lastEvaluated?: boolean; inputs?: Record<string, unknown> },
): Promise<WorkflowRunEvent[]> {
  const events: WorkflowRunEvent[] = [];
  for await (
    const event of workflowRun(createLibSwampContext(), deps, {
      workflowIdOrName: "pinned",
      ...input,
    })
  ) {
    events.push(event);
  }
  return events;
}

function suspendedRun(events: WorkflowRunEvent[]) {
  const event = events.find((e) => e.kind === "suspended");
  assertExists(event, JSON.stringify(events.map((e) => e.kind)));
  return event.run;
}

for (const key of ["__proto__", "prototype"]) {
  Deno.test(`workflow --last-evaluated: ${key} stays pinned through evaluation, approval and resume`, async () => {
    await withRepo(async (repo, dir, executions) => {
      const expression = "${{ inputs[" + JSON.stringify(key) + "] }}";
      const workflow = Workflow.create({
        name: "pinned",
        jobs: [Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval(expression),
            }),
            Step.create({
              name: "deploy",
              task: StepTask.model("consumer", "run", { value: expression }),
              dependsOn: [{
                step: "gate",
                condition: TriggerCondition.succeeded(),
              }],
            }),
          ],
        })],
      });
      const inputs = Object.fromEntries([[key, "scratch"]]);
      await repo.workflowRepo.save(workflow);
      const evaluated = await collect(workflowEvaluate(
        createLibSwampContext(),
        createWorkflowEvaluateDeps(dir, repo.workflowRepo),
        { workflowIdOrName: workflow.name, inputs },
      ));
      assertEquals(evaluated.at(-1)?.kind, "completed");
      const cached = await new YamlEvaluatedWorkflowRepository(dir)
        .findByNameWithProvenance(workflow.name);
      assertEquals(cached?.evaluatedInputs, inputs);
      const deps = await createWorkflowRunDeps(dir, repo, {
        type: "filesystem",
        path: join(dir, ".swamp"),
      });
      const replay = suspendedRun(await start(deps, { lastEvaluated: true }));
      const saved = await repo.workflowRunRepo.findById(
        workflow.id,
        createWorkflowRunId(replay.id),
      );
      assertExists(saved);
      assertEquals(saved.inputs, inputs);
      const gate = saved.getJob("main")!.getStep("gate")!;
      assertEquals(gate.approvalPrompt, "scratch");
      gate.recordApprovalDecision({
        approved: true,
        decidedBy: "user:test",
        decidedAt: new Date().toISOString(),
      });
      gate.succeed();
      await repo.workflowRunRepo.save(workflow.id, saved);
      const service = () =>
        deps.createExecutionService(
          repo.workflowRepo,
          repo.workflowRunRepo,
          dir,
          repo.catalogStore,
        );
      const error = await assertRejects(
        () =>
          collect(
            service().resume(workflow.name, replay.id, {
              inputs: Object.fromEntries([[key, "protected"]]),
            }),
          ),
        UserError,
      );
      assertEquals(error.code, "resume_input_immutable");
      assertEquals(executions, []);
      assertEquals(
        (await repo.workflowRunRepo.findById(
          workflow.id,
          createWorkflowRunId(replay.id),
        ))?.inputs,
        inputs,
      );
      await collect(service().resume(workflow.name, replay.id, { inputs }));
      assertEquals(executions, [{ value: "scratch" }]);
    });
  });
}

Deno.test("workflow --last-evaluated: superseding and execution use the one cache copy the start loaded (swamp-club#3583)", async () => {
  await withRepo(async (repo, dir, executions) => {
    const workflow = gatedCapture();
    await repo.workflowRepo.save(workflow);
    const deps = await createWorkflowRunDeps(dir, repo, {
      type: "filesystem",
      path: join(dir, ".swamp"),
    });
    const caches = new YamlEvaluatedWorkflowRepository(dir);

    // Two fresh runs suspend at the gate. The second rewrites the by-name
    // cache, as any evaluation does.
    const first = suspendedRun(
      await start(deps, { inputs: { target: "scratch" } }),
    );
    const cacheA = await caches.findByNameWithProvenance(workflow.name);
    assertExists(cacheA);
    assertEquals(cacheA.evaluatedInputs, { target: "scratch" });
    const second = suspendedRun(
      await start(deps, { inputs: { target: "other" } }),
    );
    assertEquals(
      (await caches.findByNameWithProvenance(workflow.name))?.evaluatedInputs,
      { target: "other" },
    );
    assertEquals(executions, [{ value: "scratch" }, { value: "other" }]);

    // The start loads the cache once and hands that copy on: superseding
    // matches on its inputs and execution replays it, though the by-name
    // cache has changed.
    let loads = 0;
    const events = await start(
      {
        ...deps,
        supersede: {
          ...deps.supersede!,
          evaluatedCache: () => {
            loads++;
            return Promise.resolve(cacheA);
          },
        },
      },
      { lastEvaluated: true },
    );
    assertEquals(loads, 1);
    const superseded = events.find((e) => e.kind === "superseded_runs");
    assertExists(superseded, JSON.stringify(events.map((e) => e.kind)));
    assertEquals(superseded.cancelledRunIds, [first.id]);
    const replayed = suspendedRun(events);
    assertEquals(replayed.inputs, { target: "scratch" });
    assertEquals(executions.at(-1), { value: "scratch" });

    // The predecessor matched on other inputs is untouched, and the by-name
    // cache was never read for this run.
    const workflowId = createWorkflowId(workflow.id);
    assertEquals(
      (await repo.workflowRunRepo.findById(
        workflowId,
        createWorkflowRunId(second.id),
      ))?.status,
      "suspended",
    );
    assertEquals(
      (await repo.workflowRunRepo.findById(
        workflowId,
        createWorkflowRunId(first.id),
      ))?.status,
      "cancelled",
    );
    assertEquals(
      (await caches.findByNameWithProvenance(workflow.name))?.evaluatedInputs,
      { target: "other" },
    );
  });
});

Deno.test("workflow --last-evaluated: a run the input check refuses supersedes nothing (swamp-club#3583)", async () => {
  await withRepo(async (repo, dir, executions) => {
    const workflow = gatedCapture();
    await repo.workflowRepo.save(workflow);
    const deps = await createWorkflowRunDeps(dir, repo, {
      type: "filesystem",
      path: join(dir, ".swamp"),
    });
    const predecessor = suspendedRun(
      await start(deps, { inputs: { target: "scratch" } }),
    );
    const workflowId = createWorkflowId(workflow.id);
    const runsBefore =
      (await repo.workflowRunRepo.findAllByWorkflowId(workflowId)).length;

    // An input the cache was evaluated with another value for.
    const events = await start(deps, {
      lastEvaluated: true,
      inputs: { target: "third" },
    });
    assertEquals(events.map((e) => e.kind).includes("superseded_runs"), false);
    const error = events.find((e) => e.kind === "error");
    assertExists(error, JSON.stringify(events.map((e) => e.kind)));
    assertEquals(
      error.error.message.includes(
        'was evaluated with other values for --input "target"',
      ),
      true,
      error.error.message,
    );
    assertEquals(error.error.message.includes("third"), false);

    assertEquals(executions, [{ value: "scratch" }]);
    assertEquals(
      (await repo.workflowRunRepo.findById(
        workflowId,
        createWorkflowRunId(predecessor.id),
      ))?.status,
      "suspended",
    );
    assertEquals(
      (await repo.workflowRunRepo.findAllByWorkflowId(workflowId)).length,
      runsBefore,
    );
  });
});

Deno.test("workflow evaluate: the untyped pass writes what the raw evaluator wrote: inputs spliced, forEach expanded under self names, a deferred target and a guard left raw, and the persisted map recorded (typed-secrets 4.4)", async () => {
  await withRepo(async (repo, dir) => {
    const workflow = Workflow.create({
      name: "legacy-pass",
      inputs: {
        properties: { region: { type: "string" } },
        required: ["region"],
      },
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "first",
            task: StepTask.model("consumer", "run", {
              value: "${{ inputs.region }}-${{ 1 + 1 }}",
            }),
          }),
          Step.create({
            name: "deploy-${{ self.env }}",
            forEach: { item: "env", in: '${{ ["a", "b"] }}' },
            task: StepTask.model("consumer", "run", {
              value: "${{ self.env }}",
            }),
          }),
          Step.create({
            name: "after",
            task: StepTask.model("${{ steps.first.outputs.name }}", "run", {
              value: "x",
            }),
            dependsOn: [{
              step: "first",
              condition: TriggerCondition.succeeded(),
            }],
          }),
          Step.create({
            name: "guarded",
            guard: '${{ inputs.region == "eu" }}',
            task: StepTask.model("consumer", "run", { value: "g" }),
          }),
        ],
      })],
    });
    await repo.workflowRepo.save(workflow);
    const events = await collect(workflowEvaluate(
      createLibSwampContext(),
      createWorkflowEvaluateDeps(dir, repo.workflowRepo),
      { workflowIdOrName: workflow.name, inputs: { region: "eu" } },
    ));
    assertEquals(events.at(-1)?.kind, "completed");
    const cached = await new YamlEvaluatedWorkflowRepository(dir)
      .findByNameWithProvenance(workflow.name);
    assertExists(cached);
    const steps = cached.workflow.jobs[0].steps;
    const taskOf = (i: number) =>
      steps[i].task.data as {
        modelIdOrName?: string;
        inputs?: Record<string, unknown>;
      };
    assertEquals(steps.map((s) => s.name), [
      "first",
      "deploy-a",
      "deploy-b",
      "after",
      "guarded",
    ]);
    assertEquals(taskOf(0).inputs, { value: "eu-2" });
    assertEquals(taskOf(1).inputs, { value: "a" });
    assertEquals(taskOf(2).inputs, { value: "b" });
    assertEquals(taskOf(3).modelIdOrName, "${{ steps.first.outputs.name }}");
    assertEquals(steps[4].guard, '${{ inputs.region == "eu" }}');
    assertEquals(cached.evaluatedInputs, { region: "eu" });
    // The operator's input is data where it was spliced, in both maps.
    const path = "jobs[0].steps[0].task.inputs.value";
    assertEquals(
      cached.provenance instanceof ProvenanceMap &&
        cached.provenance.overlapsData(path, 0, 2),
      true,
    );
    assertEquals(
      cached.persistedProvenance instanceof ProvenanceMap &&
        cached.persistedProvenance.overlapsData(path, 0, 2),
      true,
    );
    assertEquals(cached.writtenReferences, []);
  });
});
