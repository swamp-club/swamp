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

import { assertEquals, assertNotEquals } from "@std/assert";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";

function createWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

Deno.test("computeWorkflowFingerprint: returns 64-char hex string", async () => {
  const wf = createWorkflow("test-wf");
  const fp = await computeWorkflowFingerprint(wf);

  assertEquals(fp.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(fp), true);
});

Deno.test("computeWorkflowFingerprint: same structure produces same hash", async () => {
  const wf1 = createWorkflow("test-wf");
  const wf2 = createWorkflow("test-wf");

  const fp1 = await computeWorkflowFingerprint(wf1);
  const fp2 = await computeWorkflowFingerprint(wf2);

  assertEquals(fp1, fp2);
});

Deno.test("computeWorkflowFingerprint: different structure produces different hash", async () => {
  const wf1 = createWorkflow("wf-a");
  const wf2 = createWorkflow("wf-b");

  const fp1 = await computeWorkflowFingerprint(wf1);
  const fp2 = await computeWorkflowFingerprint(wf2);

  assertNotEquals(fp1, fp2);
});

Deno.test("computeWorkflowFingerprint: ignores workflow UUID", async () => {
  const wf1 = createWorkflow("same-name");
  const wf2 = createWorkflow("same-name");

  // Both have different UUIDs (from Workflow.create) but same structure
  assertNotEquals(wf1.id, wf2.id);

  const fp1 = await computeWorkflowFingerprint(wf1);
  const fp2 = await computeWorkflowFingerprint(wf2);

  assertEquals(fp1, fp2);
});
