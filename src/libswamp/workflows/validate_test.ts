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
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowValidationResult } from "../../domain/workflows/validation_service.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  isWorkflowValidateAllData,
  workflowValidate,
  type WorkflowValidateData,
  type WorkflowValidateDeps,
  type WorkflowValidateEvent,
} from "./validate.ts";

function makeWorkflow(name = "my-workflow"): Workflow {
  return Workflow.create({ name });
}

function makeDeps(
  overrides?: Partial<WorkflowValidateDeps>,
): WorkflowValidateDeps {
  const workflow = makeWorkflow();
  return {
    findWorkflowById: () => Promise.resolve(workflow),
    findWorkflowByName: () => Promise.resolve(workflow),
    findAllWorkflows: () => Promise.resolve([workflow]),
    validate: () =>
      Promise.resolve([
        WorkflowValidationResult.pass("schema"),
        WorkflowValidationResult.pass("refs"),
      ]),
    ...overrides,
  };
}

Deno.test("workflowValidate single workflow yields completed", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowValidateData;
  assertEquals(data.passed, true);
});

Deno.test("workflowValidate single workflow with a failing validation reports passed=false", async () => {
  // Guards the exit-code path: a failing validation result (e.g. an
  // unresolvable step-input type, see swamp-club#506) must surface as
  // passed=false so the CLI exits non-zero rather than reporting PASSED.
  const deps = makeDeps({
    validate: () =>
      Promise.resolve([
        WorkflowValidationResult.pass("schema"),
        WorkflowValidationResult.fail(
          "step inputs",
          "type could not be resolved",
        ),
      ]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowValidateData;
  assertEquals(data.passed, false);
});

Deno.test("workflowValidate all workflows yields aggregate", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  assertEquals(isWorkflowValidateAllData(completed.data), true);
});

Deno.test("workflowValidate by UUID uses findById", async () => {
  let usedFindById = false;
  const deps = makeDeps({
    findWorkflowById: () => {
      usedFindById = true;
      return Promise.resolve(makeWorkflow("wf"));
    },
    findWorkflowByName: () => {
      throw new Error("should not be called");
    },
  });
  await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );
  assertEquals(usedFindById, true);
});

Deno.test("workflowValidate: warning does not affect passed aggregation", async () => {
  const deps = makeDeps({
    validate: () =>
      Promise.resolve([
        WorkflowValidationResult.pass("schema"),
        WorkflowValidationResult.warning(
          "step inputs (model not found, skipped)",
          "Model instance not found",
        ),
      ]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowValidateData;
  assertEquals(data.passed, true);
  assertEquals(data.totalWarnings, 1);
  const warningItem = data.validations.find((v) => v.warning);
  assertEquals(warningItem?.passed, true);
  assertEquals(warningItem?.warning, true);
  assertEquals(warningItem?.error?.includes("not found"), true);
});

Deno.test("workflowValidate yields error when not found", async () => {
  const deps = makeDeps({
    findWorkflowByName: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "missing",
    }),
  );

  assertEquals(events[1].kind, "error");
});
