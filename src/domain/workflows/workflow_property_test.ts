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
import fc from "fast-check";
import { Workflow, WorkflowSchema } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";

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

const arbWorkflowName = fc.string({ minLength: 1, maxLength: 30 }).filter(
  (s) =>
    !s.includes("..") && !s.includes("/") && !s.includes("\\") &&
    !s.includes("\0"),
);

Deno.test("property: schema rejects empty jobs array", () => {
  fc.assert(
    fc.property(arbWorkflowName, (name) => {
      assertThrows(() => {
        WorkflowSchema.parse({
          id: crypto.randomUUID(),
          name,
          jobs: [],
          version: 1,
        });
      });
    }),
    { numRuns: 50 },
  );
});

Deno.test("property: duplicate job names cause rejection", () => {
  fc.assert(
    fc.property(
      arbWorkflowName,
      fc.string({ minLength: 1, maxLength: 20 }),
      (wfName, jobName) => {
        const wf = Workflow.create({
          name: wfName,
          jobs: [makeJob(jobName)],
        });
        assertThrows(
          () => wf.addJob(makeJob(jobName)),
          Error,
          "already exists",
        );
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("property: version is always positive", () => {
  fc.assert(
    fc.property(arbWorkflowName, (name) => {
      const wf = Workflow.create({
        name,
        jobs: [makeJob("job-1")],
      });
      assert(wf.version >= 1);
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: serialization round-trips", () => {
  fc.assert(
    fc.property(
      arbWorkflowName,
      fc.string({ minLength: 1, maxLength: 20 }),
      (wfName, jobName) => {
        const original = Workflow.create({
          name: wfName,
          jobs: [makeJob(jobName)],
        });
        const restored = Workflow.fromData(original.toData());
        assertEquals(restored.id, original.id);
        assertEquals(restored.name, original.name);
        assertEquals(restored.version, original.version);
        assertEquals(restored.jobs.length, original.jobs.length);
        assertEquals(restored.jobs[0].name, original.jobs[0].name);
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("property: getJob finds jobs by name", () => {
  fc.assert(
    fc.property(
      arbWorkflowName,
      fc.string({ minLength: 1, maxLength: 20 }),
      (wfName, jobName) => {
        const wf = Workflow.create({
          name: wfName,
          jobs: [makeJob(jobName)],
        });
        const found = wf.getJob(jobName);
        assert(found !== undefined);
        assertEquals(found!.name, jobName);
        assertEquals(wf.getJob("nonexistent-" + jobName), undefined);
      },
    ),
    { numRuns: 50 },
  );
});
