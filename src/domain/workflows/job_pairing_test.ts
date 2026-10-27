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
import { Job } from "./job.ts";
import { pairExpressionJobs, workflowJobOf } from "./job_pairing.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

function workflowOf(...names: string[]): Workflow {
  return Workflow.create({
    name: "pairing-wf",
    jobs: names.map((name) =>
      Job.create({
        name,
        steps: [Step.create({ name: "s", task: StepTask.model("m", "run") })],
      })
    ),
  });
}

/** A run whose jobs are stored under `stored`, in order. */
function runOf(workflow: Workflow, ...stored: string[]): WorkflowRun {
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "failed",
    jobs: stored.map((jobName) => ({
      jobName,
      status: "failed" as const,
      steps: [{ stepName: "s", status: "failed" as const }],
    })),
  });
}

const A = "site-${{ inputs.a }}";
const B = "site-${{ inputs.b }}";

Deno.test("pairExpressionJobs: pairs each expression-named job with the stored job at its position", () => {
  const wf = workflowOf(A, B, "literal");
  const run = runOf(wf, "site-west", "site-east", "literal");
  assertEquals(
    pairExpressionJobs(wf, run),
    new Map([[A, "site-west"], [B, "site-east"]]),
  );
});

Deno.test("pairExpressionJobs: an empty map for a workflow without expression-named jobs", () => {
  const wf = workflowOf("a", "b");
  assertEquals(pairExpressionJobs(wf, runOf(wf, "b")), new Map());
});

Deno.test("pairExpressionJobs: undefined once the workflow's jobs no longer line up with the run's", () => {
  const wf = workflowOf(A, B, "literal");
  // A job added or removed since the run.
  assertEquals(
    pairExpressionJobs(wf, runOf(wf, "site-west", "site-east")),
    undefined,
  );
  // A literal job moved.
  assertEquals(
    pairExpressionJobs(wf, runOf(wf, "literal", "site-west", "site-east")),
    undefined,
  );
  // A stored name that does not fit the literal text around the expression.
  assertEquals(
    pairExpressionJobs(wf, runOf(wf, "host-west", "site-east", "literal")),
    undefined,
  );
  // A stored name that is a literal job of the workflow.
  const withSite = workflowOf(A, "site-east");
  assertEquals(
    pairExpressionJobs(withSite, runOf(withSite, "site-east", "site-east")),
    undefined,
  );
});

Deno.test("workflowJobOf: a stored job belongs to its literal job, else to its paired expression-named job", () => {
  const wf = workflowOf(A, B, "literal");
  const run = runOf(wf, "site-west", "site-east", "literal");
  const pairs = pairExpressionJobs(wf, run);
  assertEquals(workflowJobOf(wf, run.jobs[1], pairs)?.name, B);
  assertEquals(workflowJobOf(wf, run.jobs[2], pairs)?.name, "literal");
  assertEquals(workflowJobOf(wf, run.jobs[0], undefined), undefined);
});
