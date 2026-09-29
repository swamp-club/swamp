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
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import type { WorkflowId } from "./workflow_id.ts";
import { findWorkflowById, findWorkflowByIdOrName } from "./workflow_lookup.ts";

function workflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("ok"),
          }),
        ],
      }),
    ],
  });
}

function repoOf(workflows: Workflow[]) {
  const idLookups: string[] = [];
  return {
    idLookups,
    findByName: (name: string) =>
      Promise.resolve(workflows.find((w) => w.name === name) ?? null),
    findById: (id: WorkflowId) => {
      idLookups.push(id);
      return Promise.resolve(workflows.find((w) => w.id === id) ?? null);
    },
  };
}

Deno.test("findWorkflowByIdOrName: finds a workflow by name", async () => {
  const deploy = workflow("deploy");
  const repo = repoOf([deploy]);
  assertEquals((await findWorkflowByIdOrName(repo, "deploy"))?.id, deploy.id);
});

Deno.test("findWorkflowByIdOrName: falls back to an exact id", async () => {
  const deploy = workflow("deploy");
  const repo = repoOf([deploy]);
  assertEquals((await findWorkflowByIdOrName(repo, deploy.id))?.id, deploy.id);
});

Deno.test("findWorkflowByIdOrName: a workflow named with another's UUID wins over that id", async () => {
  const target = workflow("target");
  const impostor = workflow(target.id);
  const repo = repoOf([target, impostor]);
  assertEquals(
    (await findWorkflowByIdOrName(repo, target.id))?.id,
    impostor.id,
  );
  assertEquals(repo.idLookups, []);
});

Deno.test("findWorkflowByIdOrName: a missed non-UUID name never tries an id lookup", async () => {
  const repo = repoOf([workflow("deploy")]);
  assertEquals(await findWorkflowByIdOrName(repo, "missing"), null);
  assertEquals(repo.idLookups, []);
});

Deno.test("findWorkflowById: ignores names, even UUID-shaped ones", async () => {
  const target = workflow("target");
  const impostor = workflow(target.id);
  const repo = repoOf([target, impostor]);
  assertEquals((await findWorkflowById(repo, target.id))?.id, target.id);
});

Deno.test("findWorkflowById: returns null for a non-UUID without scanning", async () => {
  const repo = repoOf([workflow("deploy")]);
  assertEquals(await findWorkflowById(repo, "deploy"), null);
  assertEquals(repo.idLookups, []);
});

Deno.test("findWorkflowById: with an expected name, only a workflow with both the id and the name", async () => {
  const target = workflow("target");
  // A copied file: another workflow that kept target's id.
  const copy = Workflow.fromData({
    ...workflow("copy").toData(),
    id: target.id,
  });
  const repo = repoOf([copy, target]);
  assertEquals(
    (await findWorkflowById(repo, target.id, "target"))?.name,
    "target",
  );
  assertEquals((await findWorkflowById(repo, target.id, "copy"))?.name, "copy");
  assertEquals(await findWorkflowById(repo, target.id, "other"), null);
});
