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
import {
  evaluatedJobMismatch,
  pairExpressionJobs,
  workflowJobOf,
} from "./job_pairing.ts";
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
  return runWithInputs(workflow, {}, ...stored);
}

function runWithInputs(
  workflow: Workflow,
  inputs: Record<string, unknown>,
  ...stored: string[]
): WorkflowRun {
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "failed",
    inputs,
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

Deno.test("pairExpressionJobs: a name that only reads inputs pairs by the run's stored inputs, wherever the job now stands", () => {
  const inputs = { a: "west", b: "east" };
  const run = runWithInputs(
    workflowOf(A, B, "literal"),
    inputs,
    "site-west",
    "site-east",
    "literal",
  );
  // The two expression-named jobs swapped since the run.
  const swapped = workflowOf(B, A, "literal");
  assertEquals(
    pairExpressionJobs(swapped, run),
    new Map([[B, "site-east"], [A, "site-west"]]),
  );
  // And a job added, which position alone could not survive.
  const added = workflowOf("first", B, A, "literal");
  assertEquals(
    pairExpressionJobs(added, run),
    new Map([[B, "site-east"], [A, "site-west"]]),
  );
});

Deno.test("pairExpressionJobs: a name that reads more than inputs pairs by position", () => {
  const env = "site-${{ env.REGION }}";
  const wf = workflowOf(env, "literal");
  const run = runWithInputs(wf, { a: "west" }, "site-north", "literal");
  assertEquals(pairExpressionJobs(wf, run), new Map([[env, "site-north"]]));
});

Deno.test("pairExpressionJobs: undefined when two jobs would share one stored job", () => {
  const same = "site-${{ inputs.a }}";
  const other = "site-${{ inputs.b }}";
  const wf = workflowOf(same, other);
  const run = runWithInputs(wf, { a: "x", b: "x" }, "site-x", "site-x");
  assertEquals(pairExpressionJobs(wf, run), undefined);
});

Deno.test("pairExpressionJobs: a name with many expressions is checked in one pass", () => {
  const template = Array.from({ length: 40 }, (_, i) => `p${i}-\${{ env.X }}`)
    .join("");
  const wf = workflowOf(template);
  const stored = "a".repeat(5_000);
  assertEquals(pairExpressionJobs(wf, runOf(wf, stored)), undefined);
});

Deno.test("evaluatedJobMismatch: accepts jobs that evaluate to the stored jobs they were paired with", () => {
  const wf = workflowOf(A, "literal");
  const run = runOf(wf, "site-west", "literal");
  assertEquals(
    evaluatedJobMismatch(
      wf,
      workflowOf("site-west", "literal"),
      run,
      new Set(["site-west"]),
    ),
    undefined,
  );
});

Deno.test("evaluatedJobMismatch: refuses a reset job that now evaluates to another stored job, and any job evaluating to a name the run lacks", () => {
  const env = "site-${{ env.REGION }}";
  const two = workflowOf(env, B);
  const stored = runOf(two, "site-north", "site-east");
  assertEquals(
    evaluatedJobMismatch(
      two,
      workflowOf("site-east", "site-east"),
      stored,
      new Set(["site-north"]),
    ),
    'Job "site-${{ env.REGION }}" now evaluates to "site-east", but the run stored it as "site-north".',
  );
  const wf = workflowOf(env, "site-other");
  const run = runOf(wf, "site-north", "site-other");
  assertEquals(
    evaluatedJobMismatch(
      wf,
      workflowOf("site-south", "site-other"),
      run,
      new Set(),
    ),
    'Job "site-${{ env.REGION }}" now evaluates to "site-south", which is not in the run.',
  );
});

Deno.test("evaluatedJobMismatch: a job the reset does not reach is walked by the stored job its name evaluates to", () => {
  // Two expression-named jobs of the same shape swapped since the run: the
  // positional pairing is wrong, but nothing was reset in them, as on a
  // suspended run or a reset of a literal job.
  const ea = "site-${{ env.A }}";
  const eb = "site-${{ env.B }}";
  const swapped = workflowOf(eb, ea, "literal");
  const run = runOf(swapped, "site-west", "site-east", "literal");
  const resolved = workflowOf("site-east", "site-west", "literal");
  assertEquals(
    evaluatedJobMismatch(swapped, resolved, run, new Set()),
    undefined,
  );
  assertEquals(
    evaluatedJobMismatch(swapped, resolved, run, new Set(["literal"])),
    undefined,
  );
});
