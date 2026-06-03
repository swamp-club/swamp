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
import { assertPathArrayEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  type DependencyResolverContext,
  resolveWorkflowDependencies,
} from "./extension_dependency_resolver.ts";
import { Workflow } from "../workflows/workflow.ts";
import { Job } from "../workflows/job.ts";
import { Step } from "../workflows/step.ts";
import { StepTask } from "../workflows/step_task.ts";
import { ModelType } from "../models/model_type.ts";
import type { WorkflowRepository } from "../workflows/repositories.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { WorkflowId } from "../workflows/workflow_id.ts";
import type { Definition, DefinitionId } from "../definitions/definition.ts";

function makeWorkflow(
  name: string,
  steps: Step[],
): Workflow {
  const wf = Workflow.create({ name });
  const job = Job.create({ name: "main", steps });
  wf.addJob(job);
  return wf;
}

function makeModelMethodStep(
  stepName: string,
  modelName: string,
  methodName: string,
): Step {
  return Step.create({
    name: stepName,
    task: StepTask.modelMethod(modelName, methodName),
  });
}

function makeWorkflowStep(stepName: string, workflowName: string): Step {
  return Step.create({
    name: stepName,
    task: StepTask.workflow(workflowName),
  });
}

function makeMockContext(
  workflows: Map<string, Workflow>,
  definitionTypes: Map<string, ModelType>,
): DependencyResolverContext {
  const workflowRepo: WorkflowRepository = {
    findByName: (name: string) => Promise.resolve(workflows.get(name) ?? null),
    findById: (_id: WorkflowId) => Promise.resolve(null),
    findAll: () => Promise.resolve([...workflows.values()]),
    save: (_wf: Workflow) => Promise.resolve(),
    delete: (_id: WorkflowId) => Promise.resolve(),
    nextId: () => {
      throw new Error("not implemented");
    },
    getPath: (id: WorkflowId) => `/fake/workflows/${id}.yaml`,
  };

  const definitionRepo: DefinitionRepository = {
    findByNameGlobal: (name: string) => {
      const type = definitionTypes.get(name);
      if (!type) return Promise.resolve(null);
      return Promise.resolve({
        definition: { name } as Definition,
        type,
      });
    },
    findById: (_type: ModelType, _id: DefinitionId) => Promise.resolve(null),
    findAll: (_type: ModelType) => Promise.resolve([]),
    findByName: (_type: ModelType, _name: string) => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    save: (_type: ModelType, _def: Definition) => Promise.resolve(),
    delete: (_type: ModelType, _id: DefinitionId) => Promise.resolve(),
    nextId: () => {
      throw new Error("not implemented");
    },
    getPath: (_type: ModelType, _id: DefinitionId) => "/fake/path",
  };

  return {
    workflowRepo,
    definitionRepo,
    modelsDir: "/repo/extensions/models",
  };
}

Deno.test("resolveWorkflowDependencies resolves model_method tasks", async () => {
  const step = makeModelMethodStep("deploy", "my-deploy", "run");
  const wf = makeWorkflow("deploy-wf", [step]);

  const workflows = new Map([["deploy-wf", wf]]);
  const defs = new Map([
    ["my-deploy", ModelType.create("@myuser/deploy")],
  ]);
  const ctx = makeMockContext(workflows, defs);

  const result = await resolveWorkflowDependencies(["deploy-wf"], ctx);
  assertPathArrayEquals(result.modelFiles, [
    "/repo/extensions/models/@myuser/deploy/model.ts",
  ]);
  assertEquals(result.unresolvedModels, []);
  assertEquals(result.skippedBuiltinModels, []);
});

Deno.test("resolveWorkflowDependencies skips built-in models", async () => {
  const step = makeModelMethodStep("run-shell", "my-shell", "run");
  const wf = makeWorkflow("shell-wf", [step]);

  const workflows = new Map([["shell-wf", wf]]);
  const defs = new Map([
    ["my-shell", ModelType.create("command/shell")],
  ]);
  const ctx = makeMockContext(workflows, defs);

  const result = await resolveWorkflowDependencies(["shell-wf"], ctx);
  assertEquals(result.modelFiles, []);
  assertEquals(result.skippedBuiltinModels, ["command/shell"]);
});

Deno.test("resolveWorkflowDependencies reports unresolved models", async () => {
  const step = makeModelMethodStep("deploy", "nonexistent", "run");
  const wf = makeWorkflow("deploy-wf", [step]);

  const workflows = new Map([["deploy-wf", wf]]);
  const defs = new Map<string, ModelType>();
  const ctx = makeMockContext(workflows, defs);

  const result = await resolveWorkflowDependencies(["deploy-wf"], ctx);
  assertEquals(result.modelFiles, []);
  assertEquals(result.unresolvedModels, ["nonexistent"]);
});

Deno.test("resolveWorkflowDependencies handles nested workflow tasks", async () => {
  const innerStep = makeModelMethodStep("inner-step", "inner-model", "run");
  const innerWf = makeWorkflow("inner-wf", [innerStep]);

  const outerStep = makeWorkflowStep("call-inner", "inner-wf");
  const outerWf = makeWorkflow("outer-wf", [outerStep]);

  const workflows = new Map([
    ["outer-wf", outerWf],
    ["inner-wf", innerWf],
  ]);
  const defs = new Map([
    ["inner-model", ModelType.create("@myuser/inner")],
  ]);
  const ctx = makeMockContext(workflows, defs);

  const result = await resolveWorkflowDependencies(["outer-wf"], ctx);
  assertPathArrayEquals(result.modelFiles, [
    "/repo/extensions/models/@myuser/inner/model.ts",
  ]);
  assertEquals(result.workflowFiles.length, 2);
});

Deno.test("resolveWorkflowDependencies handles circular workflow references", async () => {
  const stepA = makeWorkflowStep("call-b", "wf-b");
  const wfA = makeWorkflow("wf-a", [stepA]);

  const stepB = makeWorkflowStep("call-a", "wf-a");
  const wfB = makeWorkflow("wf-b", [stepB]);

  const workflows = new Map([
    ["wf-a", wfA],
    ["wf-b", wfB],
  ]);
  const ctx = makeMockContext(workflows, new Map());

  // Should not hang — visited set prevents infinite recursion
  const result = await resolveWorkflowDependencies(["wf-a"], ctx);
  assertEquals(result.workflowFiles.length, 2);
});

Deno.test("resolveWorkflowDependencies handles missing workflow gracefully", async () => {
  const ctx = makeMockContext(new Map(), new Map());
  const result = await resolveWorkflowDependencies(["nonexistent-wf"], ctx);
  assertEquals(result.modelFiles, []);
  assertEquals(result.workflowFiles, []);
});
