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

import { assertEquals, assertExists } from "@std/assert";
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

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

/** A repo with a behavior that records the `value` each run hands it. */
async function withRepo(
  fn: (
    repo: RepositoryContext,
    dir: string,
    executions: unknown[],
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
    await fn(repo, dir, executions);
  } finally {
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
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
        findEvaluatedWorkflowCache: () => {
          loads++;
          return Promise.resolve(cacheA);
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
