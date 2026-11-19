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

import { assertEquals, assertNotEquals } from "@std/assert";
import { Workflow } from "./workflow.ts";
import {
  analyzeWorkflowExpressions,
  changedStepTargets,
  isComputedStepTarget,
  reachableStepBehaviorNames,
  readsSelfOrInputs,
  stepBehaviorNames,
  stepRetargetSourcesChanged,
  type StepTarget,
  stepTargetKey,
  workflowStepTargets,
} from "./step_targets.ts";

function workflowWith(tasks: Record<string, unknown>[]): Workflow {
  return Workflow.fromData(
    {
      id: crypto.randomUUID(),
      name: "w",
      version: 1,
      jobs: [{
        name: "main",
        steps: tasks.map((task, i) => ({ name: `s${i}`, task })),
      }],
    } as unknown as Parameters<typeof Workflow.fromData>[0],
  );
}

Deno.test("workflowStepTargets: lists model, direct and nested workflow steps", () => {
  const workflow = workflowWith([
    { type: "model_method", modelIdOrName: "db", methodName: "get" },
    {
      type: "model_method",
      modelType: "@acme/thing",
      modelName: "t1",
      methodName: "create",
    },
    { type: "workflow", workflowIdOrName: "child" },
    { type: "assert", expr: "true", message: "ok" },
    { type: "manual_approval", prompt: "go?" },
  ]);
  assertEquals(workflowStepTargets(workflow), [
    {
      kind: "model",
      modelIdOrName: "db",
      methodName: "get",
      location: 'jobs[["main",0]].steps[["s0",0]]',
    },
    {
      kind: "direct",
      modelType: "@acme/thing",
      modelName: "t1",
      methodName: "create",
      location: 'jobs[["main",0]].steps[["s1",0]]',
    },
    {
      kind: "workflow",
      workflowIdOrName: "child",
      location: 'jobs[["main",0]].steps[["s2",0]]',
    },
  ]);
});

Deno.test("isComputedStepTarget: any name with an expression is computed", () => {
  const literal: StepTarget = {
    kind: "model",
    modelIdOrName: "db",
    methodName: "get",
  };
  const computed: StepTarget = {
    kind: "model",
    modelIdOrName: "${{ inputs.m }}",
    methodName: "get",
  };
  const computedMethod: StepTarget = {
    kind: "direct",
    modelType: "@acme/thing",
    modelName: "t1",
    methodName: "${{ self.item }}",
  };
  assertEquals(isComputedStepTarget(literal), false);
  assertEquals(isComputedStepTarget(computed), true);
  assertEquals(isComputedStepTarget(computedMethod), true);
  assertEquals(
    isComputedStepTarget({
      kind: "workflow",
      workflowIdOrName: "${{ inputs.w }}",
    }),
    true,
  );
});

Deno.test("readsSelfOrInputs: only targets computed from self or inputs", () => {
  const fromInputs: StepTarget = {
    kind: "model",
    modelIdOrName: "${{ inputs.m }}",
    methodName: "get",
  };
  const fromSteps: StepTarget = {
    kind: "model",
    modelIdOrName: "${{ steps.a.outputs.name }}",
    methodName: "get",
  };
  assertEquals(readsSelfOrInputs(fromInputs), true);
  assertEquals(readsSelfOrInputs(fromSteps), false);
  assertEquals(
    readsSelfOrInputs({ kind: "model", modelIdOrName: "db", methodName: "x" }),
    false,
  );
});

Deno.test("stepTargetKey: equal targets share a key, different ones do not", () => {
  const a: StepTarget = { kind: "model", modelIdOrName: "db", methodName: "x" };
  assertEquals(stepTargetKey(a), stepTargetKey({ ...a }));
  assertNotEquals(stepTargetKey(a), stepTargetKey({ ...a, methodName: "y" }));
});

Deno.test("stepTargetKey: only a self- or inputs-computed target depends on its step", () => {
  const literal: StepTarget = {
    kind: "model",
    modelIdOrName: "db",
    methodName: "x",
  };
  assertEquals(
    stepTargetKey({ ...literal, location: "jobs[0].steps[0]" }),
    stepTargetKey({ ...literal, location: "jobs[0].steps[1]" }),
  );
  const computed: StepTarget = {
    kind: "model",
    modelIdOrName: "${{ self.e }}",
    methodName: "x",
  };
  assertNotEquals(
    stepTargetKey({ ...computed, location: "jobs[0].steps[0]" }),
    stepTargetKey({ ...computed, location: "jobs[0].steps[1]" }),
  );
});

Deno.test("analyzeWorkflowExpressions: includes assert predicates written without ${{ }}", () => {
  const workflow = workflowWith([
    {
      type: "model_method",
      modelIdOrName: "db",
      methodName: "get",
      inputs: { x: '${{ data.latest("prod", "s") }}' },
    },
    {
      type: "assert",
      expr: 'model.method("prod", "destroy") != null',
      message: "m",
    },
  ]);
  const analyzed = analyzeWorkflowExpressions(workflow);
  const assert = analyzed.find((a) => a.raw.startsWith("model.method"));
  assertEquals(assert?.references.runTargets, [
    { model: "prod", method: "destroy" },
  ]);
  assertEquals(
    analyzed.some((a) => a.references.dataTargets.has("prod")),
    true,
  );
});

Deno.test("stepRetargetSourcesChanged: inputs and forEach changes count, a retag does not", () => {
  const base = (over: Record<string, unknown> = {}) =>
    Workflow.fromData(
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "w",
        version: 1,
        inputs: {
          type: "object",
          properties: { m: { type: "string", default: "dev-db" } },
        },
        jobs: [{
          name: "main",
          steps: [{
            name: "s",
            forEach: { item: "x", in: "${{ inputs.items }}" },
            task: {
              type: "model_method",
              modelIdOrName: "${{ inputs.m }}",
              methodName: "get",
            },
          }],
        }],
        ...over,
      } as unknown as Parameters<typeof Workflow.fromData>[0],
    );
  const before = base();
  assertEquals(
    stepRetargetSourcesChanged(before, base({ tags: { a: "b" } })),
    false,
  );
  assertEquals(
    stepRetargetSourcesChanged(
      before,
      base({
        inputs: {
          type: "object",
          properties: { m: { type: "string", default: "prod-db" } },
        },
      }),
    ),
    true,
  );
  const otherItems = base().toData() as unknown as {
    jobs: { steps: { forEach: { in: string } }[] }[];
  };
  otherItems.jobs[0].steps[0].forEach.in = '${{ ["prod-db"] }}';
  assertEquals(
    stepRetargetSourcesChanged(
      before,
      Workflow.fromData(
        otherItems as unknown as Parameters<typeof Workflow.fromData>[0],
      ),
    ),
    true,
  );
});

Deno.test("step scopes: removing an earlier step leaves later steps' scopes alone", () => {
  const task = {
    type: "model_method",
    modelIdOrName: "${{ self.e }}",
    methodName: "get",
    inputs: { x: '${{ data.latest("prod", "s") }}' },
  };
  const make = (names: string[]) =>
    Workflow.fromData(
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "w",
        version: 1,
        jobs: [{
          name: "main",
          steps: names.map((name) => ({ name, task })),
        }],
      } as unknown as Parameters<typeof Workflow.fromData>[0],
    );
  const before = make(["first", "keep"]);
  const after = make(["keep"]);
  const keyOf = (w: Workflow) =>
    workflowStepTargets(w).filter((t) => t.location?.includes('"keep"'))
      .map(stepTargetKey);
  assertEquals(keyOf(after), keyOf(before));
  const pathsOf = (w: Workflow) =>
    analyzeWorkflowExpressions(w).flatMap((e) =>
      e.paths.filter((p) => p.includes('"keep"'))
    );
  assertEquals(pathsOf(after), pathsOf(before));
});

Deno.test("changedStepTargets: a changed, renamed or moved step counts; one left alone does not", () => {
  const restricted = {
    name: "shell",
    task: {
      type: "model_method",
      modelIdOrName: "deploy",
      methodName: "execute",
      inputs: { command: "echo ok" },
    },
  };
  const other = {
    name: "other",
    task: { type: "model_method", modelIdOrName: "db", methodName: "get" },
  };
  const make = (jobs: { name: string; steps: unknown[] }[]) =>
    Workflow.fromData(
      {
        id: "00000000-0000-4000-8000-000000000003",
        name: "w",
        version: 1,
        jobs,
      } as unknown as Parameters<typeof Workflow.fromData>[0],
    );
  const changedNames = (after: Workflow) =>
    changedStepTargets(before, after).map((t) =>
      t.kind === "model" ? t.modelIdOrName : t.kind
    );
  const before = make([{ name: "main", steps: [restricted, other] }]);

  assertEquals(
    changedNames(make([{ name: "main", steps: [restricted, other] }])),
    [],
  );
  const withInputs = structuredClone(restricted);
  withInputs.task.inputs.command = "rm -rf /";
  assertEquals(
    changedNames(make([{ name: "main", steps: [withInputs, other] }])),
    ["deploy"],
  );
  const dependent = {
    ...restricted,
    dependsOn: [{ step: "other", condition: { type: "succeeded" } }],
  };
  assertEquals(
    changedNames(make([{ name: "main", steps: [dependent, other] }])),
    ["deploy"],
  );
  assertEquals(
    changedNames(
      make([{
        name: "main",
        steps: [{ ...restricted, name: "renamed" }, other],
      }]),
    ),
    ["deploy"],
  );
  assertEquals(
    changedNames(
      make([
        { name: "main", steps: [other] },
        { name: "second", steps: [restricted] },
      ]),
    ),
    ["deploy"],
  );
  const inserted = {
    name: "first",
    task: { type: "model_method", modelIdOrName: "cache", methodName: "get" },
  };
  assertEquals(
    changedNames(
      make([{ name: "main", steps: [inserted, restricted, other] }]),
    ),
    ["cache"],
  );
  const otherChanged = structuredClone(other);
  otherChanged.task.methodName = "list";
  assertEquals(
    changedNames(make([{ name: "main", steps: [restricted, otherChanged] }])),
    ["db"],
  );
  assertEquals(changedNames(make([{ name: "main", steps: [other] }])), []);
});

Deno.test("stepBehaviorNames: lists each named behavior once across workflows and leaves out one named by expression", () => {
  const first = workflowWith([
    { type: "model_method", modelIdOrName: "db", methodName: "get" },
    { type: "model_method", modelIdOrName: "cache", methodName: "get" },
    {
      type: "model_method",
      modelType: "@acme/thing",
      modelName: "t1",
      methodName: "create",
    },
    { type: "workflow", workflowIdOrName: "child" },
  ]);
  const second = workflowWith([
    { type: "model_method", modelIdOrName: "db", methodName: "put" },
  ]);
  assertEquals(stepBehaviorNames([first, second]), ["db", "cache"]);

  const computed = workflowWith([
    { type: "model_method", modelIdOrName: "db", methodName: "get" },
    {
      type: "model_method",
      modelIdOrName: "${{ self.item }}",
      methodName: "get",
    },
  ]);
  assertEquals(stepBehaviorNames([computed]), ["db"]);
});

function model(name: string): Record<string, unknown> {
  return { type: "model_method", modelIdOrName: name, methodName: "run" };
}

function call(ref: string): Record<string, unknown> {
  return { type: "workflow", workflowIdOrName: ref };
}

function lookupOf(
  workflows: Record<string, Workflow>,
  asked: string[] = [],
): (idOrName: string) => Promise<Workflow | null> {
  return (idOrName) => {
    asked.push(idOrName);
    if (idOrName === "unreadable") {
      return Promise.reject(new Error("cannot read"));
    }
    return Promise.resolve(workflows[idOrName] ?? null);
  };
}

Deno.test("reachableStepBehaviorNames: adds the names of children and grandchildren once each", async () => {
  const grandchild = workflowWith([model("deep"), model("shared")]);
  const child = workflowWith([model("shared"), call("grandchild")]);
  const parent = workflowWith([model("top"), call("child")]);

  assertEquals(
    await reachableStepBehaviorNames(
      [parent],
      lookupOf({ child, grandchild }),
    ),
    ["top", "shared", "deep"],
  );
});

Deno.test("reachableStepBehaviorNames: a cycle of workflows ends, each looked up once per reference", async () => {
  const child = workflowWith([model("inner"), call("parent")]);
  const parent = workflowWith([model("outer"), call("child")]);
  const asked: string[] = [];

  assertEquals(
    await reachableStepBehaviorNames(
      [parent],
      lookupOf({ parent, child }, asked),
    ),
    ["outer", "inner"],
  );
  assertEquals(asked, ["child", "parent"]);
});

Deno.test("reachableStepBehaviorNames: skips a child the lookup does not find or cannot read", async () => {
  const parent = workflowWith([
    model("top"),
    call("absent"),
    call("unreadable"),
  ]);

  assertEquals(
    await reachableStepBehaviorNames([parent], lookupOf({})),
    ["top"],
  );
});

Deno.test("reachableStepBehaviorNames: never looks up a child named by expression, and leaves out direct and computed names", async () => {
  const child = workflowWith([model("never")]);
  const parent = workflowWith([
    call("${{ inputs.wf }}"),
    {
      type: "model_method",
      modelType: "@acme/thing",
      modelName: "direct",
      methodName: "run",
    },
    model("${{ self.item }}"),
    model("literal"),
  ]);
  const asked: string[] = [];

  assertEquals(
    await reachableStepBehaviorNames([parent], lookupOf({ child }, asked)),
    ["literal"],
  );
  assertEquals(asked, []);
});
