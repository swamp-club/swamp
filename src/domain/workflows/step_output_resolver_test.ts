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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  liveStepOutputs,
  mergeStepOutputs,
  StepOutputResolver,
  type StepResourceRef,
  stepResourceRefs,
} from "./step_output_resolver.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { type StepRun, WorkflowRun } from "./workflow_run.ts";

function resourceRecord(
  name: string,
  version: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `data-${name}-${version}`,
    name,
    version,
    modelType: "command/shell",
    modelId: "model-1",
    modelName: "writer",
    specName: "result",
    contentType: "application/json",
    tags: { specName: "result" },
    // Persisted outputs carry no attributes (stripResourceContent).
    attributes: null,
    content: null,
    ...overrides,
  };
}

function modelMethodOutput(
  resources: Record<string, Record<string, Record<string, unknown>>>,
): Record<string, unknown> {
  return {
    type: "model_method",
    model: "writer",
    method: "execute",
    resources,
    files: {},
    dataArtifacts: [],
    dataHandles: [],
  };
}

/** Builds a run with one step per entry, each succeeded with its output. */
function runWithSteps(
  steps: Array<{ name: string; output: unknown; failed?: boolean }>,
): WorkflowRun {
  const workflow = Workflow.create({
    name: "child",
    jobs: [
      Job.create({
        name: "main",
        steps: steps.map((s) =>
          Step.create({
            name: s.name,
            task: StepTask.model("writer", "execute"),
          })
        ),
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  for (const s of steps) {
    const stepRun = job.getStep(s.name)!;
    stepRun.start();
    if (s.failed) stepRun.fail("boom");
    else stepRun.succeed(s.output);
  }
  return run;
}

function stepOf(run: WorkflowRun, name: string): StepRun {
  return run.getJob("main")!.getStep(name)!;
}

function readerFrom(
  store: Record<string, Record<string, unknown>>,
): (ref: StepResourceRef) => Promise<Record<string, unknown> | undefined> {
  return (ref) => Promise.resolve(store[`${ref.name}@${ref.version}`]);
}

Deno.test("mergeStepOutputs: later attribute sets win on key collision", () => {
  assertEquals(
    mergeStepOutputs([{ a: 1, b: 1 }, { b: 2, c: 3 }]),
    { a: 1, b: 2, c: 3 },
  );
});

Deno.test("mergeStepOutputs: returns undefined when nothing contributes", () => {
  assertEquals(mergeStepOutputs([]), undefined);
  assertEquals(mergeStepOutputs([{}, {}]), undefined);
});

Deno.test("mergeStepOutputs: keys are the union and the last writer wins", () => {
  fc.assert(
    fc.property(
      fc.array(fc.dictionary(fc.string(), fc.integer()), { maxLength: 6 }),
      (sets) => {
        const merged = mergeStepOutputs(sets) ?? {};
        const keys = new Set(sets.flatMap((s) => Object.keys(s)));
        assertEquals(new Set(Object.keys(merged)), keys);
        for (const key of keys) {
          const last = sets.findLast((s) => Object.hasOwn(s, key))!;
          assertEquals(merged[key], last[key]);
        }
      },
    ),
  );
});

Deno.test("stepResourceRefs: lists JSON resources in write order and skips others", () => {
  const refs = stepResourceRefs(modelMethodOutput({
    result: {
      a: resourceRecord("a", 1),
      b: resourceRecord("b", 2, { contentType: "text/plain" }),
    },
    state: { c: resourceRecord("c", 3) },
  }));
  assertEquals(refs.map((r) => `${r.name}@${r.version}`), ["a@1", "c@3"]);
  assertEquals(refs[0].dataId, "data-a-1");
  assertEquals(refs[0].tags, { specName: "result" });
});

Deno.test("stepResourceRefs: returns nothing for non-model_method outputs", () => {
  assertEquals(stepResourceRefs({ type: "workflow", runId: "r" }), []);
  assertEquals(stepResourceRefs(undefined), []);
  assertEquals(stepResourceRefs({ stdout: "x" }), []);
});

Deno.test("liveStepOutputs: merges attributes of the unstripped JSON resources", () => {
  const output = modelMethodOutput({
    result: {
      a: resourceRecord("a", 1, { attributes: { stdout: "hello", n: 1 } }),
      b: resourceRecord("b", 1, {
        contentType: "text/plain",
        attributes: { ignored: true },
      }),
    },
    extra: { c: resourceRecord("c", 1, { attributes: { n: 2 } }) },
  });
  assertEquals(liveStepOutputs(output), { stdout: "hello", n: 2 });
});

Deno.test("liveStepOutputs: returns undefined for a stripped output", () => {
  const output = modelMethodOutput({ result: { a: resourceRecord("a", 1) } });
  assertEquals(liveStepOutputs(output), undefined);
});

Deno.test("StepOutputResolver.resolve: reads a model_method step's outputs from the datastore", async () => {
  const run = runWithSteps([{
    name: "write",
    output: modelMethodOutput({
      result: { a: resourceRecord("a", 1), b: resourceRecord("b", 2) },
    }),
  }]);
  const resolver = new StepOutputResolver({
    readAttributes: readerFrom({
      "a@1": { stdout: "one", shared: "a" },
      "b@2": { exitCode: 0, shared: "b" },
    }),
  });

  const resolved = await resolver.resolve(stepOf(run, "write"));

  assertEquals(resolved.outputs, { stdout: "one", exitCode: 0, shared: "b" });
  assertEquals(resolved.attributesByDataId, {
    "data-a-1": { stdout: "one", shared: "a" },
    "data-b-2": { exitCode: 0, shared: "b" },
  });
});

Deno.test("StepOutputResolver.resolve: missing or unreadable data contributes nothing", async () => {
  const run = runWithSteps([{
    name: "write",
    output: modelMethodOutput({
      result: {
        gone: resourceRecord("gone", 1),
        broken: resourceRecord("broken", 1),
        ok: resourceRecord("ok", 1),
      },
    }),
  }]);
  const resolver = new StepOutputResolver({
    readAttributes: (ref) => {
      if (ref.name === "broken") return Promise.reject(new Error("corrupt"));
      if (ref.name === "ok") return Promise.resolve({ fine: true });
      return Promise.resolve(undefined);
    },
  });

  const resolved = await resolver.resolve(stepOf(run, "write"));

  assertEquals(resolved.outputs, { fine: true });
});

Deno.test("StepOutputResolver.resolve: a step with no readable resources has no outputs", async () => {
  const run = runWithSteps([{
    name: "write",
    output: modelMethodOutput({ result: { a: resourceRecord("a", 1) } }),
  }]);
  const resolver = new StepOutputResolver({ readAttributes: readerFrom({}) });

  const resolved = await resolver.resolve(stepOf(run, "write"));

  assertEquals(resolved.outputs, undefined);
});

Deno.test("StepOutputResolver.resolve: the read policy filters resources out", async () => {
  const run = runWithSteps([{
    name: "write",
    output: modelMethodOutput({
      result: {
        a: resourceRecord("a", 1),
        b: resourceRecord("b", 1, { modelId: "secret-model" }),
      },
    }),
  }]);
  const read: string[] = [];
  const resolver = new StepOutputResolver({
    readAttributes: (ref) => {
      read.push(ref.name);
      return Promise.resolve(ref.name === "a" ? { visible: 1 } : { hidden: 1 });
    },
    canRead: (ref) => Promise.resolve(ref.modelId !== "secret-model"),
  });

  const resolved = await resolver.resolve(stepOf(run, "write"));

  assertEquals(resolved.outputs, { visible: 1 });
  // A denied resource is never read.
  assertEquals(read, ["a"]);
});

Deno.test("StepOutputResolver.resolve: a workflow step resolves its child run's outputs", async () => {
  const child = runWithSteps([
    {
      name: "write_record",
      output: modelMethodOutput({ result: { a: resourceRecord("a", 1) } }),
    },
    {
      name: "failed_step",
      output: undefined,
      failed: true,
    },
    {
      name: "nested",
      output: { type: "workflow", workflowId: "g", runId: "grandchild" },
    },
  ]);
  const parent = runWithSteps([{
    name: "child",
    output: {
      type: "workflow",
      workflow: "child",
      workflowId: child.workflowId,
      runId: child.id,
      status: "succeeded",
    },
  }]);
  const lookups: string[] = [];
  const resolver = new StepOutputResolver({
    readAttributes: readerFrom({ "a@1": { stdout: "hello" } }),
    findChildRun: (workflowId, runId) => {
      lookups.push(`${workflowId}/${runId}`);
      return Promise.resolve(runId === child.id ? child : null);
    },
  });

  const resolved = await resolver.resolve(stepOf(parent, "child"));

  assertEquals(resolved.outputs, { write_record: { stdout: "hello" } });
  // The grandchild workflow step is not followed.
  assertEquals(lookups, [`${child.workflowId}/${child.id}`]);
});

Deno.test("StepOutputResolver.resolve: a workflow step without a child workflowId has no outputs", async () => {
  // Runs persisted before the child workflowId was recorded.
  const parent = runWithSteps([{
    name: "child",
    output: { type: "workflow", workflow: "child", runId: "r", outputs: {} },
  }]);
  const resolver = new StepOutputResolver({
    readAttributes: readerFrom({}),
    findChildRun: () => Promise.reject(new Error("must not be called")),
  });

  const resolved = await resolver.resolve(stepOf(parent, "child"));

  assertEquals(resolved.outputs, undefined);
});

Deno.test("StepOutputResolver.resolve: the read policy also filters a child run's outputs", async () => {
  const child = runWithSteps([
    {
      name: "public_step",
      output: modelMethodOutput({ result: { a: resourceRecord("a", 1) } }),
    },
    {
      name: "secret_step",
      output: modelMethodOutput({
        result: { s: resourceRecord("s", 1, { modelId: "secret-model" }) },
      }),
    },
  ]);
  const parent = runWithSteps([{
    name: "child",
    output: {
      type: "workflow",
      workflowId: child.workflowId,
      runId: child.id,
    },
  }]);
  const resolver = new StepOutputResolver({
    readAttributes: readerFrom({ "a@1": { visible: 1 }, "s@1": { key: "x" } }),
    findChildRun: () => Promise.resolve(child),
    canRead: (ref) => Promise.resolve(ref.modelId !== "secret-model"),
  });

  const resolved = await resolver.resolve(stepOf(parent, "child"));

  assertEquals(resolved.outputs, { public_step: { visible: 1 } });
});

Deno.test("StepOutputResolver.resolveChildOutputs: returns undefined when no child step has outputs", async () => {
  const child = runWithSteps([{ name: "noop", output: { executed: true } }]);
  const resolver = new StepOutputResolver({ readAttributes: readerFrom({}) });

  assertEquals(await resolver.resolveChildOutputs(child), undefined);
});
