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
import { extractModelReferencesFromWorkflow } from "./model_reference_extractor.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import type { WorkflowRepository } from "./repositories.ts";
import type { WorkflowId } from "./workflow_id.ts";
import { createWorkflowId } from "./workflow_id.ts";

/** Minimal fake workflow repository for testing. */
class FakeWorkflowRepo implements WorkflowRepository {
  private workflows: Map<string, Workflow> = new Map();

  addWorkflow(w: Workflow) {
    this.workflows.set(w.name, w);
  }

  async findById(_id: WorkflowId) {
    await Promise.resolve();
    return null;
  }

  async findByName(name: string) {
    await Promise.resolve();
    return this.workflows.get(name) ?? null;
  }

  async findAll() {
    await Promise.resolve();
    return [...this.workflows.values()];
  }

  async save(_w: Workflow) {
    await Promise.resolve();
  }

  async delete(_id: WorkflowId) {
    await Promise.resolve();
  }

  nextId(): WorkflowId {
    return createWorkflowId(crypto.randomUUID());
  }

  getPath(_id: WorkflowId): string {
    return "";
  }
}

function makeWorkflow(
  name: string,
  steps: Step[],
): Workflow {
  const job = Job.create({ name: "test-job", steps });
  return Workflow.create({ name, jobs: [job] });
}

Deno.test("extractModelReferencesFromWorkflow - extracts model references from steps", async () => {
  const step1 = Step.create({
    name: "step1",
    task: StepTask.model("my-server", "getInfo"),
  });
  const step2 = Step.create({
    name: "step2",
    task: StepTask.model("my-db", "backup"),
  });

  const workflow = makeWorkflow("test-wf", [step1, step2]);
  const repo = new FakeWorkflowRepo();

  const refs = await extractModelReferencesFromWorkflow(workflow, repo);
  assertEquals(refs, ["my-server", "my-db"]);
});

Deno.test("extractModelReferencesFromWorkflow - returns null for CEL expressions in model reference", async () => {
  const step = Step.create({
    name: "step1",
    task: StepTask.model("${{ inputs.model_name }}", "getInfo"),
  });

  const workflow = makeWorkflow("test-wf", [step]);
  const repo = new FakeWorkflowRepo();

  const refs = await extractModelReferencesFromWorkflow(workflow, repo);
  assertEquals(refs, null);
});

Deno.test("extractModelReferencesFromWorkflow - follows nested workflows", async () => {
  const innerStep = Step.create({
    name: "inner-step",
    task: StepTask.model("inner-model", "run"),
  });
  const innerWorkflow = makeWorkflow("inner-wf", [innerStep]);

  const outerStep1 = Step.create({
    name: "outer-step",
    task: StepTask.model("outer-model", "check"),
  });
  const outerStep2 = Step.create({
    name: "nested-step",
    task: StepTask.workflow("inner-wf"),
  });
  const outerWorkflow = makeWorkflow("outer-wf", [outerStep1, outerStep2]);

  const repo = new FakeWorkflowRepo();
  repo.addWorkflow(innerWorkflow);

  const refs = await extractModelReferencesFromWorkflow(outerWorkflow, repo);
  assertEquals(refs, ["outer-model", "inner-model"]);
});

Deno.test("extractModelReferencesFromWorkflow - handles single model reference", async () => {
  const step = Step.create({
    name: "single-step",
    task: StepTask.model("only-model", "check"),
  });
  const workflow = makeWorkflow("single-wf", [step]);
  const repo = new FakeWorkflowRepo();

  const refs = await extractModelReferencesFromWorkflow(workflow, repo);
  assertEquals(refs, ["only-model"]);
});

Deno.test("extractModelReferencesFromWorkflow - returns null for CEL in nested workflow reference", async () => {
  const step = Step.create({
    name: "step1",
    task: StepTask.workflow("${{ inputs.wf }}"),
  });

  const workflow = makeWorkflow("test-wf", [step]);
  const repo = new FakeWorkflowRepo();

  const refs = await extractModelReferencesFromWorkflow(workflow, repo);
  assertEquals(refs, null);
});
