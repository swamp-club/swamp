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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import type {
  WorkflowId,
  WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  WorkflowRun,
  type WorkflowRunData,
} from "../../domain/workflows/workflow_run.ts";
import {
  detachedNestedRunsOf,
  nestedWaitGateError,
  nestedWaitGateOf,
} from "./nested_runs.ts";

const childWorkflow = Workflow.create({
  name: "child",
  jobs: [
    Job.create({
      name: "child-job",
      steps: [
        Step.create({ name: "gate", task: StepTask.manualApproval("Approve") }),
      ],
    }),
  ],
});

const parentWorkflow = Workflow.create({
  name: "parent",
  jobs: [
    Job.create({
      name: "main",
      steps: [
        Step.create({ name: "call-child", task: StepTask.workflow("child") }),
      ],
    }),
  ],
});

/**
 * A parent cancelled while its step waited on a child, and a run repository
 * answering for the child as `lookup` says.
 */
function cancelledParent(
  lookup: (child: WorkflowRun) => Promise<WorkflowRun | null>,
  childFields: Partial<WorkflowRunData> = {},
): {
  parent: WorkflowRun;
  child: WorkflowRun;
  runRepo: {
    findById(w: WorkflowId, r: WorkflowRunId): Promise<WorkflowRun | null>;
  };
} {
  const parent = WorkflowRun.create(parentWorkflow);
  parent.start();
  const created = WorkflowRun.create(childWorkflow);
  created.start();
  created.suspend();
  const child = WorkflowRun.fromData({ ...created.toData(), ...childFields });
  parent.getJob("main")!.getStep("call-child")!.waitForNestedRun({
    workflowId: childWorkflow.id,
    workflowName: childWorkflow.name,
    runId: child.id,
  });
  parent.suspend();
  parent.endAsCancelled("Cancelled by user");
  return { parent, child, runRepo: { findById: () => lookup(child) } };
}

Deno.test("detachedNestedRunsOf: reports an unfinished child with the command that cancels it", async () => {
  const { parent, child, runRepo } = cancelledParent((c) => Promise.resolve(c));
  const detached = await detachedNestedRunsOf({ runRepo }, parent);
  assertEquals(detached.map((d) => d.runId), [child.id]);
  assertEquals(
    detached[0].cancelCommand,
    `swamp workflow cancel child --run ${child.id}`,
  );
});

Deno.test("detachedNestedRunsOf: leaves out a child that already finished or no longer exists", async () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    const { parent, runRepo } = cancelledParent(
      (c) => Promise.resolve(c),
      { status },
    );
    assertEquals(await detachedNestedRunsOf({ runRepo }, parent), [], status);
  }
  const { parent, runRepo } = cancelledParent(() => Promise.resolve(null));
  assertEquals(await detachedNestedRunsOf({ runRepo }, parent), []);
});

Deno.test("detachedNestedRunsOf: reports a child it cannot read, since it may still be unfinished", async () => {
  const { parent, child, runRepo } = cancelledParent(() =>
    Promise.reject(new Error("unreadable"))
  );
  const detached = await detachedNestedRunsOf({ runRepo }, parent);
  assertEquals(detached.map((d) => d.runId), [child.id]);
});

/** A parent whose step waits on a suspended child. */
function waitingParent(): { parent: WorkflowRun; child: WorkflowRun } {
  const parent = WorkflowRun.create(parentWorkflow);
  parent.start();
  const child = WorkflowRun.create(childWorkflow);
  child.start();
  child.suspend();
  parent.getJob("main")!.getStep("call-child")!.waitForNestedRun({
    workflowId: childWorkflow.id,
    workflowName: childWorkflow.name,
    runId: child.id,
  });
  parent.suspend();
  return { parent, child };
}

Deno.test("nestedWaitGateError: names the nested run, and carries its workflow and a refusal that names none", () => {
  const { parent, child } = waitingParent();
  const error = nestedWaitGateError(parent, "call-child");
  assert(error);
  assertStringIncludes(error.message, child.id);
  assertStringIncludes(error.message, `workflow "${childWorkflow.name}"`);
  const gate = nestedWaitGateOf(error);
  assertEquals(gate?.workflowId, childWorkflow.id);
  assertEquals(gate?.workflowName, childWorkflow.name);
  assert(!gate!.genericMessage.includes(child.id));
  assert(
    !gate!.genericMessage.includes(`workflow "${childWorkflow.name}"`),
  );
});

Deno.test("nestedWaitGateError: undefined for a step that does not wait on a nested run", () => {
  const { parent } = waitingParent();
  assertEquals(nestedWaitGateError(parent, "no-such-step"), undefined);
});

Deno.test("nestedWaitGateOf: undefined for an error that is not a nested gate refusal", () => {
  assertEquals(
    nestedWaitGateOf({ code: "validation_failed", message: "nope" }),
    undefined,
  );
});
