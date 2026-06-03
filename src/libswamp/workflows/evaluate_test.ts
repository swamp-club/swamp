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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import {
  isWorkflowEvaluateAllData,
  workflowEvaluate,
  type WorkflowEvaluateAllData,
  type WorkflowEvaluateDeps,
  type WorkflowEvaluateEvent,
  type WorkflowEvaluateItemData,
} from "./evaluate.ts";

function makeWorkflow(overrides?: {
  name?: string;
  id?: string;
}): Workflow {
  return Workflow.fromData({
    id: overrides?.id ?? "00000000-0000-4000-8000-000000000001",
    name: overrides?.name ?? "my-workflow",
    inputs: {},
    jobs: [{
      name: "default",
      steps: [{
        name: "step-1",
        task: {
          type: "model_method",
          modelIdOrName: "test-model",
          methodName: "lookup",
        },
      }],
    }],
  });
}

function makeDeps(
  overrides?: Partial<WorkflowEvaluateDeps>,
): WorkflowEvaluateDeps {
  const workflow = makeWorkflow();

  return {
    findWorkflowById: () => Promise.resolve(workflow),
    findWorkflowByName: () => Promise.resolve(workflow),
    findAllWorkflows: () => Promise.resolve([workflow]),
    buildExpressionContext: () =>
      Promise.resolve(
        { model: {}, env: {} } as ReturnType<
          WorkflowEvaluateDeps["buildExpressionContext"]
        > extends Promise<infer T> ? T : never,
      ),
    evaluateCel: (expr: string) => expr,
    evaluateCelAsync: (expr: string) => Promise.resolve(expr),
    saveEvaluatedWorkflow: () => Promise.resolve(),
    getEvaluatedPath: (id) =>
      `/tmp/.swamp/workflows-evaluated/workflow-${id}.yaml`,
    ...overrides,
  };
}

Deno.test("workflowEvaluate single workflow yields evaluating then completed", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowEvaluateEvent>(
    workflowEvaluate(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      inputs: {},
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "evaluating" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    WorkflowEvaluateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowEvaluateItemData;
  assertEquals(data.name, "my-workflow");
  assertEquals(typeof data.outputPath, "string");
});

Deno.test("workflowEvaluate single workflow not found yields error", async () => {
  const deps = makeDeps({
    findWorkflowByName: () => Promise.resolve(null),
    findWorkflowById: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowEvaluateEvent>(
    workflowEvaluate(createLibSwampContext(), deps, {
      workflowIdOrName: "missing",
      inputs: {},
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<
    WorkflowEvaluateEvent,
    { kind: "error" }
  >;
  assertEquals(error.error.code, "not_found");
});

Deno.test("workflowEvaluate all workflows yields completed with AllData", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowEvaluateEvent>(
    workflowEvaluate(createLibSwampContext(), deps, {
      inputs: {},
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "evaluating" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    WorkflowEvaluateEvent,
    { kind: "completed" }
  >;
  assertEquals(isWorkflowEvaluateAllData(completed.data), true);
  const data = completed.data as WorkflowEvaluateAllData;
  assertEquals(data.total, 1);
  assertEquals(data.items.length, 1);
});

Deno.test("workflowEvaluate workflow without expressions yields hadExpressions=false", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowEvaluateEvent>(
    workflowEvaluate(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      inputs: {},
    }),
  );

  const completed = events[1] as Extract<
    WorkflowEvaluateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowEvaluateItemData;
  assertEquals(data.hadExpressions, false);
});

// --- forEach self.* in modelIdOrName / methodName tests ---

function makeForEachWorkflow(overrides: {
  modelIdOrName: string;
  methodName: string;
  forEachIn: string;
  forEachItem: string;
  stepName: string;
  inputs?: Record<string, unknown>;
}): Workflow {
  return Workflow.fromData({
    id: "00000000-0000-4000-8000-000000000002",
    name: "foreach-workflow",
    inputs: {},
    jobs: [{
      name: "default",
      steps: [{
        name: overrides.stepName,
        forEach: {
          item: overrides.forEachItem,
          in: overrides.forEachIn,
        },
        task: {
          type: "model_method",
          modelIdOrName: overrides.modelIdOrName,
          methodName: overrides.methodName,
          ...(overrides.inputs ? { inputs: overrides.inputs } : {}),
        },
      }],
    }],
  });
}

// deno-lint-ignore no-explicit-any
function contextAwareEvaluateCel(expr: string, ctx?: any): unknown {
  const parts = expr.trim().split(".");
  // deno-lint-ignore no-explicit-any
  let value: any = ctx;
  for (const part of parts) {
    if (value == null) return expr;
    value = value[part];
  }
  return value ?? expr;
}

function makeForEachDeps(
  workflow: Workflow,
  overrides?: Partial<WorkflowEvaluateDeps>,
): WorkflowEvaluateDeps {
  return {
    findWorkflowById: () => Promise.resolve(workflow),
    findWorkflowByName: () => Promise.resolve(workflow),
    findAllWorkflows: () => Promise.resolve([workflow]),
    buildExpressionContext: () =>
      Promise.resolve(
        { model: {}, env: {}, self: {} } as ReturnType<
          WorkflowEvaluateDeps["buildExpressionContext"]
        > extends Promise<infer T> ? T : never,
      ),
    evaluateCel: contextAwareEvaluateCel,
    evaluateCelAsync: (expr: string, ctx?: unknown) =>
      Promise.resolve(contextAwareEvaluateCel(expr, ctx)),
    saveEvaluatedWorkflow: () => Promise.resolve(),
    getEvaluatedPath: (id) =>
      `/tmp/.swamp/workflows-evaluated/workflow-${id}.yaml`,
    ...overrides,
  };
}

async function evaluateForEachWorkflow(
  workflow: Workflow,
  overrides?: Partial<WorkflowEvaluateDeps>,
): Promise<WorkflowEvaluateItemData> {
  const deps = makeForEachDeps(workflow, overrides);
  const events = await collect<WorkflowEvaluateEvent>(
    workflowEvaluate(createLibSwampContext(), deps, {
      workflowIdOrName: "foreach-workflow",
      inputs: {},
    }),
  );
  const completed = events[events.length - 1] as Extract<
    WorkflowEvaluateEvent,
    { kind: "completed" }
  >;
  return completed.data as WorkflowEvaluateItemData;
}

interface ModelMethodTaskData {
  type: "model_method";
  modelIdOrName: string;
  methodName: string;
  inputs?: Record<string, unknown>;
}

function asModelMethodTask(
  // deno-lint-ignore no-explicit-any
  task: any,
): ModelMethodTaskData {
  return task as ModelMethodTaskData;
}

Deno.test("forEach: resolves self.* in modelIdOrName", async () => {
  const workflow = makeForEachWorkflow({
    modelIdOrName: "${{ self.region }}",
    methodName: "lookup",
    forEachIn: "${{ items }}",
    forEachItem: "region",
    stepName: "step-${{ self.region }}",
  });

  const data = await evaluateForEachWorkflow(workflow, {
    buildExpressionContext: () =>
      Promise.resolve(
        { model: {}, env: {}, self: {}, items: ["us-east-1", "eu-west-1"] } as // deno-lint-ignore no-explicit-any
        any,
      ),
  });

  assertEquals(data.forEachExpanded, true);
  const steps = data.jobs![0].steps;
  assertEquals(steps.length, 2);
  assertEquals(asModelMethodTask(steps[0].task).modelIdOrName, "us-east-1");
  assertEquals(asModelMethodTask(steps[1].task).modelIdOrName, "eu-west-1");
});

Deno.test("forEach: resolves interpolated self.* in modelIdOrName", async () => {
  const workflow = makeForEachWorkflow({
    modelIdOrName: "aws-alarms-${{ self.region }}",
    methodName: "get_summary",
    forEachIn: "${{ items }}",
    forEachItem: "region",
    stepName: "step-${{ self.region }}",
  });

  const data = await evaluateForEachWorkflow(workflow, {
    buildExpressionContext: () =>
      Promise.resolve(
        { model: {}, env: {}, self: {}, items: ["us-east-1", "eu-west-1"] } as // deno-lint-ignore no-explicit-any
        any,
      ),
  });

  const steps = data.jobs![0].steps;
  assertEquals(
    asModelMethodTask(steps[0].task).modelIdOrName,
    "aws-alarms-us-east-1",
  );
  assertEquals(
    asModelMethodTask(steps[1].task).modelIdOrName,
    "aws-alarms-eu-west-1",
  );
});

Deno.test("forEach: resolves self.* in methodName", async () => {
  const workflow = makeForEachWorkflow({
    modelIdOrName: "my-model",
    methodName: "${{ self.method }}",
    forEachIn: "${{ items }}",
    forEachItem: "method",
    stepName: "step-${{ self.method }}",
  });

  const data = await evaluateForEachWorkflow(workflow, {
    buildExpressionContext: () =>
      Promise.resolve(
        { model: {}, env: {}, self: {}, items: ["validate", "transform"] } as // deno-lint-ignore no-explicit-any
        any,
      ),
  });

  const steps = data.jobs![0].steps;
  assertEquals(asModelMethodTask(steps[0].task).methodName, "validate");
  assertEquals(asModelMethodTask(steps[1].task).methodName, "transform");
});

Deno.test("forEach: leaves vault expressions in modelIdOrName unresolved", async () => {
  const workflow = makeForEachWorkflow({
    modelIdOrName: "${{ vault.get('model-name') }}",
    methodName: "lookup",
    forEachIn: "${{ items }}",
    forEachItem: "region",
    stepName: "step-${{ self.region }}",
  });

  const data = await evaluateForEachWorkflow(workflow, {
    buildExpressionContext: () =>
      Promise.resolve(
        { model: {}, env: {}, self: {}, items: ["us-east-1"] } as // deno-lint-ignore no-explicit-any
        any,
      ),
  });

  const steps = data.jobs![0].steps;
  assertEquals(
    asModelMethodTask(steps[0].task).modelIdOrName,
    "${{ vault.get('model-name') }}",
  );
});

Deno.test("forEach: resolves self.* in modelIdOrName with object iteration", async () => {
  const workflow = makeForEachWorkflow({
    modelIdOrName: "device-${{ self.entry.key }}",
    methodName: "scan",
    forEachIn: "${{ items }}",
    forEachItem: "entry",
    stepName: "step-${{ self.entry.key }}",
  });

  const data = await evaluateForEachWorkflow(workflow, {
    buildExpressionContext: () =>
      Promise.resolve(
        {
          model: {},
          env: {},
          self: {},
          items: { alpha: "a-config", beta: "b-config" },
        } as // deno-lint-ignore no-explicit-any
        any,
      ),
  });

  const steps = data.jobs![0].steps;
  assertEquals(steps.length, 2);
  assertEquals(asModelMethodTask(steps[0].task).modelIdOrName, "device-alpha");
  assertEquals(asModelMethodTask(steps[1].task).modelIdOrName, "device-beta");
});

Deno.test("isWorkflowEvaluateAllData: returns true for AllData, false for ItemData", () => {
  const allData: WorkflowEvaluateAllData = {
    items: [],
    total: 0,
    evaluated: 0,
  };
  assertEquals(isWorkflowEvaluateAllData(allData), true);

  const itemData: WorkflowEvaluateItemData = {
    id: "test",
    name: "test",
    hadExpressions: false,
  };
  assertEquals(isWorkflowEvaluateAllData(itemData), false);
});
