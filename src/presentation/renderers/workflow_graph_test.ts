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

import { assertStringIncludes } from "@std/assert";
import type { WorkflowGetData } from "../../libswamp/mod.ts";
import { renderWorkflowGraph } from "./workflow_graph.ts";

const singleJobWorkflow: WorkflowGetData = {
  id: "wf-1",
  name: "simple",
  version: 1,
  tags: {},
  jobs: [
    {
      name: "build",
      dependsOn: [],
      steps: [
        {
          name: "compile",
          dependsOn: [],
          task: { type: "model_method", modelIdOrName: "m", methodName: "run" },
        },
      ],
    },
  ],
  path: "/workflows/simple.yaml",
};

const multiJobWorkflow: WorkflowGetData = {
  id: "wf-2",
  name: "deploy-pipeline",
  version: 1,
  tags: {},
  jobs: [
    {
      name: "build",
      dependsOn: [],
      steps: [
        {
          name: "compile",
          dependsOn: [],
          task: { type: "model_method", modelIdOrName: "m", methodName: "run" },
        },
      ],
    },
    {
      name: "test",
      dependsOn: [{ job: "build", condition: { type: "succeeded" } }],
      steps: [
        {
          name: "unit",
          dependsOn: [],
          task: { type: "model_method", modelIdOrName: "m", methodName: "run" },
        },
        {
          name: "integration",
          dependsOn: [{ step: "unit", condition: { type: "succeeded" } }],
          task: { type: "model_method", modelIdOrName: "m", methodName: "run" },
        },
      ],
    },
    {
      name: "deploy",
      dependsOn: [{ job: "test", condition: { type: "succeeded" } }],
      steps: [
        {
          name: "approve",
          dependsOn: [],
          task: {
            type: "manual_approval",
            prompt: "Deploy?",
            timeout: 3600,
          },
        },
        {
          name: "run-deploy",
          dependsOn: [{ step: "approve", condition: { type: "succeeded" } }],
          task: {
            type: "workflow",
            workflowIdOrName: "child-deploy",
          },
        },
      ],
    },
  ],
  path: "/workflows/deploy-pipeline.yaml",
};

Deno.test("renderWorkflowGraph: includes workflow name and counts", () => {
  const output = renderWorkflowGraph(multiJobWorkflow);
  assertStringIncludes(output, "Workflow: deploy-pipeline");
  assertStringIncludes(output, "3 jobs");
  assertStringIncludes(output, "5 steps");
});

Deno.test("renderWorkflowGraph: renders job-level DAG when jobs have dependencies", () => {
  const output = renderWorkflowGraph(multiJobWorkflow);
  assertStringIncludes(output, "Jobs:");
  assertStringIncludes(output, "build");
  assertStringIncludes(output, "test");
  assertStringIncludes(output, "deploy");
});

Deno.test("renderWorkflowGraph: renders step-level DAG for jobs with step dependencies", () => {
  const output = renderWorkflowGraph(multiJobWorkflow);
  assertStringIncludes(output, "Job: test");
  assertStringIncludes(output, "unit");
  assertStringIncludes(output, "integration");
  assertStringIncludes(output, "Job: deploy");
  assertStringIncludes(output, "approve");
  assertStringIncludes(output, "run-deploy");
});

Deno.test("renderWorkflowGraph: shows task type labels in step DAG", () => {
  const output = renderWorkflowGraph(multiJobWorkflow);
  assertStringIncludes(output, "- model");
  assertStringIncludes(output, "- approval");
  assertStringIncludes(output, "- workflow");
});

Deno.test("renderWorkflowGraph: skips job DAG when no job dependencies", () => {
  const output = renderWorkflowGraph(singleJobWorkflow);
  assertStringIncludes(output, "Workflow: simple");
  assertStringIncludes(output, "1 job");
  assertStringIncludes(output, "1 step");
  const hasJobsSection = output.includes("Jobs:");
  if (hasJobsSection) {
    throw new Error("Expected no Jobs section for single job without deps");
  }
});
