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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Workflow, WorkflowSchema } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";

function makeStep(name: string): Step {
  return Step.create({
    name,
    task: StepTask.modelMethod("test/model", "run"),
  });
}

function makeJob(name: string): Job {
  return Job.create({
    name,
    steps: [makeStep("step-1")],
  });
}

Deno.test("contract: job ordering is preserved through serialization round-trip", () => {
  const wf = Workflow.create({
    name: "ordered-workflow",
    jobs: [
      makeJob("deploy"),
      makeJob("test"),
      makeJob("cleanup"),
    ],
  });

  const restored = Workflow.fromData(wf.toData());
  assertEquals(restored.jobs.map((j) => j.name), [
    "deploy",
    "test",
    "cleanup",
  ]);
});

Deno.test("contract: addJob appends in call order", () => {
  const wf = Workflow.create({
    name: "builder-workflow",
    jobs: [makeJob("first")],
  });

  wf.addJob(makeJob("second"));
  wf.addJob(makeJob("third"));

  assertEquals(wf.jobs.map((j) => j.name), ["first", "second", "third"]);
});

Deno.test("contract: create allows empty jobs but fromData rejects them", () => {
  const wf = Workflow.create({ name: "empty-start" });
  assertEquals(wf.jobs.length, 0);

  assertThrows(() => {
    WorkflowSchema.parse({
      id: crypto.randomUUID(),
      name: "bad-workflow",
      jobs: [],
      version: 1,
    });
  });
});

Deno.test("contract: job with dependencies preserves dependency structure through round-trip", () => {
  const setupJob = makeJob("setup");
  const deployJob = Job.create({
    name: "deploy",
    steps: [makeStep("apply")],
    dependsOn: [{ job: "setup", condition: TriggerCondition.succeeded() }],
  });

  const wf = Workflow.create({
    name: "dep-workflow",
    jobs: [setupJob, deployJob],
  });

  const restored = Workflow.fromData(wf.toData());
  const restoredDeploy = restored.getJob("deploy");
  assert(restoredDeploy !== undefined);
  assertEquals(restoredDeploy!.getDependencyNames(), ["setup"]);
  assertEquals(restoredDeploy!.dependsOn[0].condition.data.type, "succeeded");
});

Deno.test("contract: workflow with multiple steps per job preserves step order", () => {
  const multiStepJob = Job.create({
    name: "multi-step",
    steps: [
      makeStep("validate"),
      makeStep("plan"),
      makeStep("apply"),
    ],
  });

  const wf = Workflow.create({
    name: "multi-step-wf",
    jobs: [multiStepJob],
  });

  const restored = Workflow.fromData(wf.toData());
  const job = restored.getJob("multi-step");
  assert(job !== undefined);
  assertEquals(job!.steps.map((s) => s.name), ["validate", "plan", "apply"]);
});

Deno.test("contract: Job.create rejects empty steps", () => {
  assertThrows(
    () =>
      Job.create({
        name: "empty-job",
        steps: [],
      }),
    Error,
    "at least one step",
  );
});

Deno.test("contract: fromData then toData produces round-trip stable tags", () => {
  const wf = Workflow.create({
    name: "tag-roundtrip",
    tags: { env: "prod" },
    jobs: [makeJob("job-1")],
  });

  const data = wf.toData();
  const restored = Workflow.fromData(data);

  assertEquals(restored.tags.env, "prod");

  // Mutating the serialized data should not affect the restored workflow
  // because fromData goes through WorkflowSchema.parse which copies tags
  data.tags.env = "HACKED";
  assertEquals(restored.tags.env, "prod");
});
