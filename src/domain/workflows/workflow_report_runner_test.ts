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
import { workflowSummaryReport } from "../reports/builtin/workflow_summary_report.ts";
import type { WorkflowReportContext } from "../reports/report_context.ts";

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
    workflowName: "test-workflow",
    workflowStatus: "succeeded",
    stepExecutions: [],
    ...overrides,
  };
}

Deno.test("WorkflowReportContext: inputs field is available when set", () => {
  const ctx = makeWorkflowContext({
    inputs: { region: "us-east-1", costDays: 7 },
  });

  assertEquals(ctx.inputs, { region: "us-east-1", costDays: 7 });
});

Deno.test("WorkflowReportContext: inputs is undefined when omitted", () => {
  const ctx = makeWorkflowContext();

  assertEquals(ctx.inputs, undefined);
});

Deno.test("WorkflowReportContext: existing workflow summary report works with inputs present", async () => {
  const ctx = makeWorkflowContext({
    inputs: { region: "eu-west-1", repo: "swamp" },
    stepExecutions: [
      {
        jobName: "deploy-job",
        stepName: "deploy-step",
        taskType: "model_method",
        modelName: "my-server",
        modelType: "server",
        methodName: "deploy",
        status: "succeeded",
        dataHandles: [],
        methodArgs: {},
        modelId: "def-1",
        globalArgs: {},
      },
    ],
  });

  const result = await workflowSummaryReport.execute(ctx);

  assertEquals(result.json.status, "succeeded");
  assertEquals(result.json.totalSteps, 1);
  assertEquals(result.json.succeeded, 1);
});

Deno.test("WorkflowReportContext: existing workflow summary report works without inputs", async () => {
  const ctx = makeWorkflowContext({
    stepExecutions: [
      {
        jobName: "build-job",
        stepName: "build-step",
        taskType: "model_method",
        modelName: "app",
        modelType: "app",
        methodName: "build",
        status: "failed",
        dataHandles: [],
        methodArgs: {},
        modelId: "def-2",
        globalArgs: {},
      },
    ],
  });

  const result = await workflowSummaryReport.execute(ctx);

  assertEquals(result.json.status, "succeeded");
  assertEquals(result.json.totalSteps, 1);
  assertEquals(result.json.failed, 1);
});
