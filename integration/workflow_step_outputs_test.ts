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
 * Step outputs (`steps.<name>.outputs`) end to end (swamp-club#2386).
 *
 * The run record keeps no resource attributes (swamp-club#1673), so a step's
 * outputs come from its full output during a live run and from the datastore
 * everywhere else: on resume, for a child workflow, and in workflow history.
 * The earlier unit tests built step outputs carrying a field real runs never
 * produce, so they passed while every real run failed. These tests wire the
 * execution service, the data repository, the run repository and workflow
 * history together in-process against a real temp repo.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import {
  createLibSwampContext,
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
  type WorkflowRunView,
} from "../src/libswamp/mod.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

const WriteArgs = z.object({ text: z.string() });
const ReadArgs = z.object({ value: z.string() });

async function withRepo(
  fn: (
    repo: RepositoryContext,
    dir: string,
    received: string[],
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-step-outputs-" });
  const repo = createRepositoryContext({ repoDir: dir });
  const type = ModelType.create(`test/outputs-${crypto.randomUUID()}`);
  const received: string[] = [];
  modelRegistry.register({
    type,
    version: "2026.09.23.1",
    resources: {
      result: {
        description: "What the writer produced",
        schema: z.object({ stdout: z.string(), exitCode: z.number() }),
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {
      write: {
        description: "Write a result resource",
        arguments: WriteArgs,
        execute: async (args, context) => {
          const handle = await context.writeResource!("result", "result", {
            stdout: WriteArgs.parse(args).text,
            exitCode: 0,
          });
          return { dataHandles: [handle] };
        },
      },
      read: {
        description: "Record the value it received",
        arguments: ReadArgs,
        execute: (args) => {
          received.push(ReadArgs.parse(args).value);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  for (const name of ["writer", "reader"]) {
    await repo.definitionRepo.save(type, Definition.create({ name }));
  }
  try {
    await fn(repo, dir, received);
  } finally {
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function writeStep(name: string, text: string): Step {
  return Step.create({
    name,
    task: StepTask.model("writer", "write", { text }),
  });
}

function readStep(value: string, after: string): Step {
  return Step.create({
    name: "read",
    task: StepTask.model("reader", "read", { value }),
    dependsOn: [{ step: after, condition: TriggerCondition.succeeded() }],
  });
}

async function service(repo: RepositoryContext, dir: string) {
  const deps = await createWorkflowRunDeps(dir, repo, {
    type: "filesystem",
    path: join(dir, ".swamp"),
  });
  return deps.createExecutionService(
    repo.workflowRepo,
    repo.workflowRunRepo,
    dir,
    repo.catalogStore,
  );
}

async function history(
  repo: RepositoryContext,
  dir: string,
  workflow: string,
  includeOutputs: boolean,
): Promise<WorkflowRunView> {
  const deps = createWorkflowHistoryGetDeps(dir, undefined, repo.workflowRepo);
  let view: WorkflowRunView | undefined;
  for await (
    const event of workflowHistoryGet(
      createLibSwampContext(),
      deps,
      workflow,
      { includeOutputs },
    )
  ) {
    if (event.kind === "completed") view = event.data;
    if (event.kind === "error") throw new Error(event.error.message);
  }
  return view!;
}

function stepView(view: WorkflowRunView, step: string) {
  return view.jobs.flatMap((j) => j.steps).find((s) => s.name === step)!;
}

Deno.test("step outputs: a downstream step reads an upstream step's resource attributes", async () => {
  await withRepo(async (repo, dir, received) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "outputs-flow",
      jobs: [Job.create({
        name: "main",
        steps: [
          writeStep("write_record", "hello"),
          readStep("${{ steps.write_record.outputs.stdout }}", "write_record"),
        ],
      })],
    }));

    // Before the fix: "Invalid expression: No such key: outputs".
    const run = await (await service(repo, dir)).execute("outputs-flow");
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(received, ["hello"]);

    // The run record itself keeps no attribute values.
    const saved = await repo.workflowRunRepo.findById(
      createWorkflowId(run.workflowId),
      run.id,
    );
    assertEquals(JSON.stringify(saved!.toData()).includes("hello"), false);

    // History reads them back from the datastore only when asked.
    const withOutputs = await history(repo, dir, "outputs-flow", true);
    assertEquals(stepView(withOutputs, "write_record").outputs, {
      stdout: "hello",
      exitCode: 0,
    });
    const withoutOutputs = await history(repo, dir, "outputs-flow", false);
    assertEquals(stepView(withoutOutputs, "write_record").outputs, undefined);
  });
});

Deno.test("step outputs: a parent step reads a child workflow's outputs by child step", async () => {
  await withRepo(async (repo, dir, received) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "child-flow",
      jobs: [Job.create({
        name: "main",
        steps: [writeStep("write_record", "from-child")],
      })],
    }));
    await repo.workflowRepo.save(Workflow.create({
      name: "parent-flow",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({ name: "child", task: StepTask.workflow("child-flow") }),
          readStep("${{ steps.child.outputs.write_record.stdout }}", "child"),
        ],
      })],
    }));

    const run = await (await service(repo, dir)).execute("parent-flow");
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(received, ["from-child"]);

    const view = await history(repo, dir, "parent-flow", true);
    assertEquals(stepView(view, "child").outputs, {
      write_record: { stdout: "from-child", exitCode: 0 },
    });
  });
});

Deno.test("step outputs: a resumed run reads earlier step outputs from the datastore", async () => {
  await withRepo(async (repo, dir, received) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "gated-flow",
      jobs: [Job.create({
        name: "main",
        steps: [
          writeStep("write_record", "before-the-gate"),
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Continue?"),
            dependsOn: [
              { step: "write_record", condition: TriggerCondition.succeeded() },
            ],
          }),
          readStep("${{ steps.write_record.outputs.stdout }}", "gate"),
        ],
      })],
    }));

    const suspended = await (await service(repo, dir)).execute("gated-flow");
    assertEquals(suspended.status, "suspended");
    assertEquals(received, []);

    const workflowId = createWorkflowId(suspended.workflowId);
    const toApprove = (await repo.workflowRunRepo.findById(
      workflowId,
      suspended.id,
    ))!;
    const gate = toApprove.getJob("main")!.getStep("gate")!;
    gate.recordApprovalDecision({
      approved: true,
      decidedBy: "user:test",
      decidedAt: new Date().toISOString(),
    });
    gate.succeed();
    await repo.workflowRunRepo.save(workflowId, toApprove);

    // A fresh service: nothing from the first process is in memory.
    let resumed: WorkflowRun | undefined;
    for await (
      const event of (await service(repo, dir)).resume(
        "gated-flow",
        suspended.id,
      )
    ) {
      if (event.kind === "completed") resumed = event.run;
    }
    assertEquals(resumed?.status, "succeeded");
    assertEquals(received, ["before-the-gate"]);
  });
});
