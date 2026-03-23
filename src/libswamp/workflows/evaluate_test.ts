// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
