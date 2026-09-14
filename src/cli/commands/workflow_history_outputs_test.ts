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
import type { WorkflowRunView } from "../../libswamp/mod.ts";

function extractOutputs(
  runView: WorkflowRunView,
): Record<string, Record<string, unknown>> {
  const outputs: Record<string, Record<string, unknown>> = {};
  for (const job of runView.jobs) {
    for (const step of job.steps) {
      if (step.outputs && Object.keys(step.outputs).length > 0) {
        outputs[step.name] = step.outputs;
      }
    }
  }
  return outputs;
}

Deno.test("extractOutputs: collects outputs from steps with outputs", () => {
  const runView: WorkflowRunView = {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "test-wf",
    status: "succeeded",
    jobs: [
      {
        name: "job1",
        status: "succeeded",
        steps: [
          {
            name: "create-audience",
            status: "succeeded",
            outputs: { audienceId: "aud_123", status: "Building" },
          },
          {
            name: "validate",
            status: "succeeded",
          },
        ],
      },
    ],
  };

  const outputs = extractOutputs(runView);
  assertEquals(Object.keys(outputs).length, 1);
  assertEquals(outputs["create-audience"].audienceId, "aud_123");
  assertEquals(outputs["create-audience"].status, "Building");
});

Deno.test("extractOutputs: returns empty when no steps have outputs", () => {
  const runView: WorkflowRunView = {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "test-wf",
    status: "succeeded",
    jobs: [
      {
        name: "job1",
        status: "succeeded",
        steps: [
          { name: "step1", status: "succeeded" },
        ],
      },
    ],
  };

  const outputs = extractOutputs(runView);
  assertEquals(Object.keys(outputs).length, 0);
});

Deno.test("extractOutputs: collects from multiple jobs", () => {
  const runView: WorkflowRunView = {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "test-wf",
    status: "succeeded",
    jobs: [
      {
        name: "build",
        status: "succeeded",
        steps: [
          {
            name: "compile",
            status: "succeeded",
            outputs: { artifactId: "art_1" },
          },
        ],
      },
      {
        name: "deploy",
        status: "succeeded",
        steps: [
          {
            name: "push",
            status: "succeeded",
            outputs: { deploymentId: "dep_1" },
          },
        ],
      },
    ],
  };

  const outputs = extractOutputs(runView);
  assertEquals(Object.keys(outputs).length, 2);
  assertEquals(outputs["compile"].artifactId, "art_1");
  assertEquals(outputs["push"].deploymentId, "dep_1");
});
