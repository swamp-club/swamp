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

import { assert, assertEquals, assertRejects } from "@std/assert";
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
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
} from "../src/libswamp/workflows/history_get.ts";
import type { WorkflowRunView } from "../src/libswamp/workflows/workflow_run_view.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withSpan } from "../src/infrastructure/tracing/mod.ts";
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  withObservedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import type { ResourceReadPolicy } from "../src/domain/workflows/step_output_resolver.ts";

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

Deno.test("step outputs: resolution exports catalog_open and output_walk phases with read, authorization and child-run counts, and resolves the same with tracing on or off (swamp-club#4002)", async () => {
  await withRepo(async (repo, dir) => {
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
          writeStep("write_own", "from-parent"),
          Step.create({ name: "child", task: StepTask.workflow("child-flow") }),
        ],
      })],
    }));
    const run = await (await service(repo, dir)).execute("parent-flow");
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));

    const resolve = (canRead?: ResourceReadPolicy, signal?: AbortSignal) => {
      const deps = createWorkflowHistoryGetDeps(
        dir,
        undefined,
        repo.workflowRepo,
        canRead,
      );
      return withSpan(
        "swamp.workflow.step_outputs.resolve",
        {},
        () => deps.resolveStepOutputs(run, signal),
      );
    };
    const allow = () => Promise.resolve(true);

    // Tracing off: the reference result.
    const untraced = await resolve(allow);
    assertEquals(untraced.main.write_own.outputs, {
      stdout: "from-parent",
      exitCode: 0,
    });

    await withObservedSpans(async (spans) => {
      assertEquals(await resolve(allow), untraced);
      const outer = findSpan(spans, "swamp.workflow.step_outputs.resolve");
      const [opening] = diagnosticPhases(spans, "catalog_open");
      const [walk] = diagnosticPhases(spans, "output_walk");
      assert(isChildOf(opening, outer));
      assert(isChildOf(walk, outer));
      const a = walk.attributes;
      assertEquals(a["swamp.diagnostic.area"], "step_outputs");
      assertEquals(a["swamp.diagnostic.result"], "completed");
      assertEquals(a["swamp.outcome"], "ok");
      assertEquals(a["swamp.diagnostic.cancel_observed"], undefined);
      assertEquals(a["swamp.diagnostic.resources_attempted"], 2);
      assertEquals(a["swamp.diagnostic.reads_succeeded"], 2);
      assertEquals(a["swamp.diagnostic.reads_missing"], 0);
      assertEquals(a["swamp.diagnostic.parse_failed"], 0);
      assertEquals(a["swamp.diagnostic.authorize_allowed"], 2);
      assertEquals(a["swamp.diagnostic.authorize_denied"], 0);
      assertEquals(a["swamp.diagnostic.child_run_lookups"], 1);
      assertEquals(a["swamp.diagnostic.child_runs_unique"], 1);
      assertEquals(a["swamp.diagnostic.child_runs_missing"], 0);
      assert((a["swamp.diagnostic.content_bytes"] as number) > 0);
      for (
        const work of [
          "authorize",
          "content_read",
          "json_parse",
          "child_run_lookup",
          "assemble",
        ]
      ) {
        assertEquals(typeof a[`swamp.diagnostic.${work}_work_ms`], "number");
      }
      assertEquals(outer.attributes["step_outputs.resources_read"], 2);
      assertEquals(outer.attributes["step_outputs.resources_denied"], 0);
      assertEquals(outer.attributes["step_outputs.child_runs_read"], 1);
    });

    // Denied: nothing is read, as before.
    await withObservedSpans(async (spans) => {
      const denied = await resolve(() => Promise.resolve(false));
      assertEquals(denied.main.write_own.outputs, undefined);
      const [walk] = diagnosticPhases(spans, "output_walk");
      assertEquals(walk.attributes["swamp.diagnostic.authorize_denied"], 2);
      assertEquals(walk.attributes["swamp.diagnostic.resources_attempted"], 0);
      assertEquals(walk.attributes["swamp.diagnostic.reads_succeeded"], 0);
      assertEquals(
        findSpan(spans, "swamp.workflow.step_outputs.resolve")
          .attributes["step_outputs.resources_denied"],
        2,
      );
    });

    // No read policy (the CLI): no authorization counters.
    await withObservedSpans(async (spans) => {
      assertEquals(await resolve(), untraced);
      const [walk] = diagnosticPhases(spans, "output_walk");
      assertEquals(
        walk.attributes["swamp.diagnostic.authorize_allowed"],
        undefined,
      );
      assertEquals(
        walk.attributes["swamp.diagnostic.owner_lookups"],
        undefined,
      );
      assertEquals(walk.attributes["swamp.diagnostic.resources_attempted"], 2);
    });

    // Cancelled before it starts: the walk ends cancelled with what it reached.
    await withObservedSpans(async (spans) => {
      const controller = new AbortController();
      controller.abort();
      await assertRejects(() => resolve(allow, controller.signal));
      const [walk] = diagnosticPhases(spans, "output_walk");
      assertEquals(walk.attributes["swamp.diagnostic.result"], "partial");
      assertEquals(walk.attributes["swamp.outcome"], "cancelled");
      assertEquals(walk.attributes["swamp.diagnostic.cancel_observed"], true);
      assertEquals(walk.attributes["swamp.diagnostic.resources_attempted"], 0);
      assertEquals(walk.attributes["swamp.diagnostic.child_runs_unique"], 0);
      // The step outputs span keeps its counts on a failed resolve too.
      assertEquals(
        findSpan(spans, "swamp.workflow.step_outputs.resolve")
          .attributes["step_outputs.resources_read"],
        0,
      );
    });

    // A failed authorization fails the walk with error, counted.
    await withObservedSpans(async (spans) => {
      await assertRejects(
        () => resolve(() => Promise.reject(new Error("policy unavailable"))),
        Error,
        "policy unavailable",
      );
      const [walk] = diagnosticPhases(spans, "output_walk");
      assertEquals(walk.attributes["swamp.outcome"], "error");
      assertEquals(walk.attributes["swamp.diagnostic.result"], "partial");
      assertEquals(walk.attributes["swamp.diagnostic.authorize_errors"], 1);
    });

    // A child run gone since: looked up, missing, and the parent unchanged.
    const child = await repo.workflowRepo.findByName("child-flow");
    await repo.workflowRunRepo.deleteAllByWorkflowId(child!.id);
    await withObservedSpans(async (spans) => {
      const outputs = await resolve(allow);
      assertEquals(outputs.main.child.outputs, undefined);
      assertEquals(outputs.main.write_own, untraced.main.write_own);
      const [walk] = diagnosticPhases(spans, "output_walk");
      assertEquals(walk.attributes["swamp.diagnostic.child_runs_missing"], 1);
      assertEquals(walk.attributes["swamp.diagnostic.resources_attempted"], 1);
    });
  });
});

Deno.test("step outputs: a run whose steps wrote nothing exports a completed walk of zeros and no owner index check (swamp-club#4002)", async () => {
  await withRepo(async (repo, dir) => {
    await repo.workflowRepo.save(Workflow.create({
      name: "quiet-flow",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "read",
          task: StepTask.model("reader", "read", { value: "nothing" }),
        })],
      })],
    }));
    const run = await (await service(repo, dir)).execute("quiet-flow");
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    const deps = createWorkflowHistoryGetDeps(
      dir,
      undefined,
      repo.workflowRepo,
      () => Promise.resolve(true),
    );
    await withObservedSpans(async (spans) => {
      await withSpan(
        "swamp.workflow.step_outputs.resolve",
        {},
        () => deps.resolveStepOutputs(run),
      );
      const [walk] = diagnosticPhases(spans, "output_walk");
      assertEquals(walk.attributes["swamp.diagnostic.result"], "completed");
      for (
        const counter of [
          "resources_attempted",
          "authorize_allowed",
          "authorize_denied",
          "owner_lookups",
          "reads_succeeded",
          "reads_missing",
          "content_bytes",
          "child_run_lookups",
          "child_runs_unique",
        ]
      ) {
        assertEquals(walk.attributes[`swamp.diagnostic.${counter}`], 0);
      }
      assertEquals(diagnosticPhases(spans, "owner_index"), []);
    });
  });
});
