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

import { assert, assertEquals, assertRejects } from "@std/assert";
import fc from "fast-check";
import {
  createDataRepositoryAttributeReader,
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
import { RunSensitiveValues } from "../secrets/mod.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";

const REF = "${{ vault.get('prod', 'A') }}";
const PASSWORD_TAG = { "_swamp.sensitiveFields": JSON.stringify(["password"]) };

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
  assertEquals(liveStepOutputs(output).outputs, { stdout: "hello", n: 2 });
});

Deno.test("liveStepOutputs: a record missing what a reference needs is left out, as it is from the resolved outputs", () => {
  const output = modelMethodOutput({
    result: {
      a: resourceRecord("a", 1, { attributes: { n: 1 } }),
      b: resourceRecord("b", 1, { attributes: { n: 2 }, version: undefined }),
    },
  });
  const live = liveStepOutputs(output);
  assertEquals(live.outputs, { n: 1 });
  assertEquals(live.sources?.[0].records.map((r) => r.name), ["a"]);
});

Deno.test("liveStepOutputs: returns no outputs and no sources for a stripped output", () => {
  const output = modelMethodOutput({ result: { a: resourceRecord("a", 1) } });
  assertEquals(liveStepOutputs(output).outputs, undefined);
  assertEquals(liveStepOutputs(output).sources, undefined);
  assertEquals(liveStepOutputs(undefined).outputs, undefined);
});

Deno.test("liveStepOutputs: the sources are the records as stored, in write order, each with its namespace, tags and attributes (typed-secrets 4.2)", () => {
  const output = modelMethodOutput({
    result: {
      a: resourceRecord("a", 1, {
        namespace: "acme",
        tags: PASSWORD_TAG,
        attributes: { password: REF, user: "u" },
      }),
      skipped: resourceRecord("skipped", 1, {
        contentType: "text/plain",
        attributes: { ignored: true },
      }),
    },
    extra: {
      // An older record names no namespace: the reader's stands in.
      c: resourceRecord("c", 3, { attributes: { user: "v" } }),
    },
  });
  const live = liveStepOutputs(output, "acme");
  // The flat outputs keep the stored reference text; the sources keep the
  // record it came from, so the adapter can make it a Secret.
  assertEquals(live.outputs, { password: REF, user: "v" });
  assertEquals(live.sources, [{
    path: [],
    records: [
      {
        id: "data-a-1",
        name: "a",
        version: 1,
        namespace: "acme",
        modelName: "writer",
        tags: PASSWORD_TAG,
        attributes: { password: REF, user: "u" },
      },
      {
        id: "data-c-3",
        name: "c",
        version: 3,
        namespace: "acme",
        modelName: "writer",
        tags: { specName: "result" },
        attributes: { user: "v" },
      },
    ],
  }]);
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
  // The sources are the same reads in write order, each with the reader's
  // namespace, since the run record names none, and the record's tags.
  assertEquals(resolved.sources, [{
    path: [],
    records: [
      {
        id: "data-a-1",
        name: "a",
        version: 1,
        namespace: "",
        modelName: "writer",
        tags: { specName: "result" },
        attributes: { stdout: "one", shared: "a" },
      },
      {
        id: "data-b-2",
        name: "b",
        version: 2,
        namespace: "",
        modelName: "writer",
        tags: { specName: "result" },
        attributes: { exitCode: 0, shared: "b" },
      },
    ],
  }]);
});

Deno.test("StepOutputResolver.resolve: a source's namespace is the run record's when it has one and the reader's otherwise (typed-secrets 4.2)", async () => {
  const run = runWithSteps([{
    name: "write",
    output: modelMethodOutput({
      result: {
        a: resourceRecord("a", 1, { namespace: "acme", tags: PASSWORD_TAG }),
        b: resourceRecord("b", 1),
      },
    }),
  }]);
  const resolver = new StepOutputResolver({
    readAttributes: readerFrom({
      "a@1": { password: REF },
      "b@1": { user: "u" },
    }),
    namespace: "reader",
  });

  const resolved = await resolver.resolve(stepOf(run, "write"));

  assertEquals(resolved.sources?.[0].records.map((r) => r.namespace), [
    "acme",
    "reader",
  ]);
  assertEquals(resolved.sources?.[0].records[0].tags, PASSWORD_TAG);
  assertEquals(resolved.sources?.[0].records[0].attributes, { password: REF });
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
  assertEquals(resolved.sources?.[0].records.map((r) => r.name), ["ok"]);
});

Deno.test("StepOutputResolver.resolve: a step with no readable resources has no outputs and no sources", async () => {
  const run = runWithSteps([{
    name: "write",
    output: modelMethodOutput({ result: { a: resourceRecord("a", 1) } }),
  }]);
  const resolver = new StepOutputResolver({ readAttributes: readerFrom({}) });

  const resolved = await resolver.resolve(stepOf(run, "write"));

  assertEquals(resolved.outputs, undefined);
  assertEquals(resolved.sources, undefined);
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

Deno.test("StepOutputResolver.resolve: stops between resources once its signal aborts (swamp-club#3968)", async () => {
  const run = runWithSteps([{
    name: "write",
    output: modelMethodOutput({
      result: { a: resourceRecord("a", 1), b: resourceRecord("b", 1) },
    }),
  }]);
  const controller = new AbortController();
  const checked: string[] = [];
  const read: string[] = [];
  const resolver = new StepOutputResolver({
    readAttributes: (ref) => {
      read.push(ref.name);
      // The request is cancelled while its first resource is read.
      controller.abort(new Error("request cancelled"));
      return Promise.resolve({ value: 1 });
    },
    canRead: (ref) => {
      checked.push(ref.name);
      return Promise.resolve(true);
    },
    signal: controller.signal,
  });

  await assertRejects(
    () => resolver.resolve(stepOf(run, "write")),
    Error,
    "request cancelled",
  );
  assertEquals(checked, ["a"]);
  assertEquals(read, ["a"]);
});

Deno.test("StepOutputResolver.resolve: a cancelled read checks no policy and reads no child run", async () => {
  const controller = new AbortController();
  controller.abort(new Error("request cancelled"));
  let calls = 0;
  const resolver = new StepOutputResolver({
    readAttributes: () => {
      calls++;
      return Promise.resolve({});
    },
    findChildRun: () => {
      calls++;
      return Promise.resolve(null);
    },
    canRead: () => {
      calls++;
      return Promise.resolve(true);
    },
    signal: controller.signal,
  });
  const run = runWithSteps([
    {
      name: "write",
      output: modelMethodOutput({ result: { a: resourceRecord("a", 1) } }),
    },
    {
      name: "child",
      output: { type: "workflow", workflowId: "w", runId: "r" },
    },
  ]);

  await assertRejects(() => resolver.resolve(stepOf(run, "write")));
  await assertRejects(() => resolver.resolve(stepOf(run, "child")));
  assertEquals(calls, 0);
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
  // Each child step's sources are grouped under its name.
  assertEquals(resolved.sources, [{
    path: ["write_record"],
    records: [{
      id: "data-a-1",
      name: "a",
      version: 1,
      namespace: "",
      modelName: "writer",
      tags: { specName: "result" },
      attributes: { stdout: "hello" },
    }],
  }]);
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

  const resolved = await resolver.resolveChildOutputs(child);
  assertEquals(resolved.outputs, undefined);
  assertEquals(resolved.sources, undefined);
});

Deno.test("createDataRepositoryAttributeReader: keeps stored references for the evaluator to adapt (swamp-club#2171)", async () => {
  const stored = {
    token: "${{ vault.get('prod-vault', 'api-token') }}",
    plain: "${{ vault.get('prod-vault', 'api-token') }}",
  };
  const dataRepo = {
    getContent: () =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(stored))),
  } as unknown as UnifiedDataRepository;
  const ref: StepResourceRef = {
    dataId: "data-1",
    modelType: "command/shell",
    modelId: "model-1",
    modelName: "writer",
    specName: "creds",
    contentType: "application/json",
    name: "creds",
    version: 1,
    tags: { "_swamp.sensitiveFields": JSON.stringify(["token"]) },
  };

  const sensitiveValues = new RunSensitiveValues();
  const resolved = await createDataRepositoryAttributeReader(dataRepo)(ref);
  assertEquals(resolved?.token, stored.token);
  assertEquals(resolved?.plain, stored.plain);
  assertEquals(sensitiveValues.list(), []);

  // Without a vault service (display paths) references stay as stored.
  const raw = await createDataRepositoryAttributeReader(dataRepo)(ref);
  assertEquals(raw?.token, stored.token);
});

Deno.test("StepOutputResolver.resolve: a wait_for_signal step's outputs are its payload and receipt, with no datastore read", async () => {
  const signal = {
    id: "33333333-3333-4333-8333-333333333333",
    waitId: "44444444-4444-4444-8444-444444444444",
    receivedAt: "2026-01-01T00:00:00.000Z",
    submittedBy: "ada",
  };
  const run = runWithSteps([{
    name: "review",
    output: { type: "wait_for_signal", payload: { verdict: "ship" }, signal },
  }]);
  let reads = 0;
  const resolver = new StepOutputResolver({
    readAttributes: () => {
      reads++;
      return Promise.resolve(undefined);
    },
  });

  const resolved = await resolver.resolve(stepOf(run, "review"));

  assertEquals(resolved.outputs, { payload: { verdict: "ship" }, signal });
  assertEquals(resolved.sources, undefined);
  assertEquals(resolved.attributesByDataId, {});
  assertEquals(reads, 0);
});

Deno.test("StepOutputResolver.resolveChildOutputs: a step name repeated across jobs: the later job's outputs and sources replace the earlier's, and a step named __proto__ is an own key", async () => {
  const deploy = () =>
    Step.create({ name: "deploy", task: StepTask.model("writer", "execute") });
  const workflow = Workflow.create({
    name: "child",
    jobs: [
      Job.create({ name: "a", steps: [deploy()] }),
      Job.create({
        name: "b",
        steps: [
          deploy(),
          Step.create({
            name: "__proto__",
            task: StepTask.model("writer", "execute"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  for (const job of run.jobs) {
    job.start();
    for (const step of job.steps) {
      const name = `${job.jobName}-${step.stepName}`;
      step.start();
      step.succeed(
        modelMethodOutput({ result: { [name]: resourceRecord(name, 1) } }),
      );
    }
  }
  const resolver = new StepOutputResolver({
    readAttributes: readerFrom({
      "a-deploy@1": { x: 1, onlyA: true },
      "b-deploy@1": { x: 2 },
      "b-__proto__@1": { p: true },
    }),
  });

  const resolved = await resolver.resolveChildOutputs(run);

  assertEquals(Object.keys(resolved.outputs!).sort(), ["__proto__", "deploy"]);
  assertEquals(resolved.outputs!.deploy, { x: 2 });
  assert(Object.hasOwn(resolved.outputs!, "__proto__"));
  assertEquals(
    Object.getOwnPropertyDescriptor(resolved.outputs!, "__proto__")!.value,
    { p: true },
  );
  assertEquals(
    resolved.sources!.map((g) => [g.path, g.records.map((r) => r.name)]),
    [[["deploy"], ["b-deploy"]], [["__proto__"], ["b-__proto__"]]],
  );
});
