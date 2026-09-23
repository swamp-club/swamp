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
import {
  workflowApprove,
  type WorkflowApproveDeps,
  type WorkflowApproveEvent,
} from "./approve.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";

function makeWorkflow(gateNames: string[]): Workflow {
  return Workflow.create({
    name: "gated",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          ...gateNames.map((name) =>
            Step.create({
              name,
              task: StepTask.manualApproval(`Approve ${name}`),
            })
          ),
          Step.create({
            name: "deploy",
            task: StepTask.model("deployer", "run"),
          }),
        ],
      }),
    ],
  });
}

/** Suspends a run with every named gate parked in waiting_approval. */
function suspendAtGates(workflow: Workflow, gateNames: string[]): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  for (const name of gateNames) {
    const step = job.getStep(name)!;
    step.start();
    step.waitForApproval();
  }
  run.suspend();
  return run;
}

function makeDeps(workflow: Workflow, run: WorkflowRun): WorkflowApproveDeps {
  return {
    workflowRepo: {
      findByName: (name: string) =>
        Promise.resolve(name === workflow.name ? workflow : null),
      findById: () => Promise.resolve(null),
    } as unknown as WorkflowApproveDeps["workflowRepo"],
    runRepo: {
      findById: () => Promise.resolve(run),
      findAllByWorkflowId: () => Promise.resolve([run]),
      save: () => Promise.resolve(),
    } as unknown as WorkflowApproveDeps["runRepo"],
  };
}

async function approve(
  deps: WorkflowApproveDeps,
  stepName: string,
): Promise<WorkflowApproveEvent | undefined> {
  const events = await collect<WorkflowApproveEvent>(
    workflowApprove(createLibSwampContext(), deps, {
      workflowIdOrName: "gated",
      stepName,
      decidedBy: "approver",
    }),
  );
  return events.at(-1);
}

Deno.test("workflowApprove: reports allGatesDecided when the last gate is approved", async () => {
  const workflow = makeWorkflow(["gate"]);
  const run = suspendAtGates(workflow, ["gate"]);

  const last = await approve(makeDeps(workflow, run), "gate");

  assertEquals(last?.kind, "completed");
  if (last?.kind === "completed") {
    assertEquals(last.data.allGatesDecided, true);
    assertEquals(last.data.runId, run.id);
    assertEquals(last.data.workflowName, "gated");
  }
});

Deno.test("workflowApprove: reports allGatesDecided false while a sibling gate still waits", async () => {
  const workflow = makeWorkflow(["gate-a", "gate-b"]);
  const run = suspendAtGates(workflow, ["gate-a", "gate-b"]);
  const deps = makeDeps(workflow, run);

  const first = await approve(deps, "gate-a");
  assertEquals(first?.kind, "completed");
  if (first?.kind === "completed") {
    assertEquals(first.data.allGatesDecided, false);
  }

  const second = await approve(deps, "gate-b");
  assertEquals(second?.kind, "completed");
  if (second?.kind === "completed") {
    assertEquals(second.data.allGatesDecided, true);
  }
});
