// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { workflowSummaryReport } from "./workflow_summary_report.ts";
import type { WorkflowReportContext } from "../report_context.ts";
import { createDataId } from "../../data/data_id.ts";

function makeStepExecution(
  overrides: Partial<WorkflowReportContext["stepExecutions"][0]> = {},
): WorkflowReportContext["stepExecutions"][0] {
  return {
    jobName: "deploy-job",
    stepName: "deploy-step",
    modelName: "my-server",
    modelType: "server",
    methodName: "deploy",
    status: "succeeded",
    dataHandles: [],
    methodArgs: {},
    modelId: "def-1",
    globalArgs: {},
    ...overrides,
  };
}

function makeWorkflowContext(
  overrides: Partial<WorkflowReportContext> = {},
): WorkflowReportContext {
  return {
    scope: "workflow",
    repoDir: "/tmp/test-repo",
    // deno-lint-ignore no-explicit-any
    logger: {} as any,
    // deno-lint-ignore no-explicit-any
    dataRepository: {} as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    workflowId: "wf-1",
    workflowRunId: "run-1",
    workflowName: "deploy-all",
    workflowStatus: "succeeded",
    stepExecutions: [],
    ...overrides,
  };
}

Deno.test("workflowSummaryReport: all steps succeeded — no Failures section", async () => {
  const ctx = makeWorkflowContext({
    workflowStatus: "succeeded",
    stepExecutions: [
      makeStepExecution({ status: "succeeded" }),
      makeStepExecution({
        stepName: "validate-step",
        status: "succeeded",
      }),
    ],
  });

  const result = await workflowSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "# Workflow Summary");
  assertStringIncludes(result.markdown, "**Status**: succeeded");
  assertStringIncludes(result.markdown, "## Steps");
  assert(!result.markdown.includes("## Failures"));

  assertEquals(result.json.succeeded, 2);
  assertEquals(result.json.failed, 0);
  assertEquals(
    (result.json.failures as Array<unknown>).length,
    0,
  );
});

Deno.test("workflowSummaryReport: failures section appears before steps section", async () => {
  const ctx = makeWorkflowContext({
    workflowStatus: "failed",
    stepExecutions: [
      makeStepExecution({ status: "failed", stepName: "bad-step" }),
      makeStepExecution({ status: "succeeded" }),
    ],
  });

  const result = await workflowSummaryReport.execute(ctx);

  const failuresIdx = result.markdown.indexOf("## Failures");
  const stepsIdx = result.markdown.indexOf("## Steps");

  assert(failuresIdx !== -1, "Failures section should exist");
  assert(failuresIdx < stepsIdx, "Failures section should appear before Steps");
  assertStringIncludes(result.markdown, "| deploy-job | bad-step |");
});

Deno.test("workflowSummaryReport: mixed statuses — correct counts in JSON", async () => {
  const ctx = makeWorkflowContext({
    workflowStatus: "failed",
    stepExecutions: [
      makeStepExecution({ status: "succeeded", stepName: "step-1" }),
      makeStepExecution({ status: "failed", stepName: "step-2" }),
      makeStepExecution({ status: "skipped", stepName: "step-3" }),
      makeStepExecution({ status: "failed", stepName: "step-4" }),
    ],
  });

  const result = await workflowSummaryReport.execute(ctx);

  assertEquals(result.json.totalSteps, 4);
  assertEquals(result.json.succeeded, 1);
  assertEquals(result.json.failed, 2);
  assertEquals(result.json.skipped, 1);
  assertEquals(
    (result.json.failures as Array<Record<string, string>>).length,
    2,
  );
});

Deno.test("workflowSummaryReport: empty dataHandles shows no data produced by any step", async () => {
  const ctx = makeWorkflowContext({
    stepExecutions: [
      makeStepExecution({ dataHandles: [] }),
    ],
  });

  const result = await workflowSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "No data produced by any step.");
});

Deno.test("workflowSummaryReport: steps with data list artifact names", async () => {
  const ctx = makeWorkflowContext({
    stepExecutions: [
      makeStepExecution({
        stepName: "provision",
        dataHandles: [
          {
            name: "state.json",
            specName: "state",
            kind: "resource",
            dataId: createDataId("d-1"),
            version: 1,
            size: 512,
            tags: {},
            // deno-lint-ignore no-explicit-any
            metadata: {} as any,
          },
          {
            name: "logs.txt",
            specName: "logs",
            kind: "file",
            dataId: createDataId("d-2"),
            version: 1,
            size: 100,
            tags: {},
            // deno-lint-ignore no-explicit-any
            metadata: {} as any,
          },
        ],
      }),
    ],
  });

  const result = await workflowSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "**provision**: state.json, logs.txt");
});

Deno.test("workflowSummaryReport: JSON output structure matches expected shape", async () => {
  const ctx = makeWorkflowContext({
    stepExecutions: [
      makeStepExecution({ status: "succeeded" }),
    ],
  });

  const result = await workflowSummaryReport.execute(ctx);
  const json = result.json;

  const expectedKeys = [
    "status",
    "workflowId",
    "workflowRunId",
    "workflowName",
    "totalSteps",
    "succeeded",
    "failed",
    "skipped",
    "failures",
    "steps",
  ];
  assertEquals(Object.keys(json).sort(), expectedKeys.sort());

  // Verify step item shape
  const steps = json.steps as Array<Record<string, unknown>>;
  assertEquals(steps.length, 1);
  const stepKeys = [
    "jobName",
    "stepName",
    "modelName",
    "modelType",
    "methodName",
    "status",
  ];
  assertEquals(Object.keys(steps[0]).sort(), stepKeys.sort());
});
