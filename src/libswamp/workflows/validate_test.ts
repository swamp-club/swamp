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

Deno.test("workflowValidate not-found error suggests closest match", async () => {
  const deps = makeDeps({
    findWorkflowByName: () => Promise.resolve(null),
    findAllWorkflows: () =>
      Promise.resolve([makeWorkflow("deploy-app"), makeWorkflow("test-app")]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-aplp",
    }),
  );
  const errEvent = events[1] as Extract<WorkflowValidateEvent, { kind: "error" }>;
  assertEquals(errEvent.error.message.includes("Did you mean 'deploy-app'"), true);
  assertEquals(
    errEvent.error.message.includes("Existing workflows: deploy-app, test-app"),
    true,
  );
});

Deno.test("workflowValidate not-found error explains file-path mistake", async () => {
  const deps = makeDeps({
    findWorkflowByName: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "workflows/fix.yaml",
    }),
  );
  const errEvent = events[1] as Extract<WorkflowValidateEvent, { kind: "error" }>;
  assertEquals(errEvent.error.message.includes("looks like a file path"), true);
  assertEquals(errEvent.error.message.includes("swamp workflow create"), true);
});

Deno.test("workflowValidate not-found error in empty repo is actionable", async () => {
  const deps = makeDeps({
    findWorkflowByName: () => Promise.resolve(null),
    findAllWorkflows: () => Promise.resolve([]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "fix-namespace",
    }),
  );
  const errEvent = events[1] as Extract<WorkflowValidateEvent, { kind: "error" }>;
  assertEquals(errEvent.error.message.includes("No workflows exist"), true);
  assertEquals(
    errEvent.error.message.includes("swamp workflow create fix-namespace"),
    true,
  );
});
