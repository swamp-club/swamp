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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderNoActivity, renderSummary } from "./summarise_output.ts";
import type { ActivitySummary } from "../../domain/summary/summary_types.ts";

function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

const emptySummary: ActivitySummary = {
  since: "2026-02-25T00:00:00.000Z",
  methodExecutions: [],
  workflows: [],
  data: { totalItems: 0, totalVersions: 0, uniqueModels: 0, byModelType: [] },
};

const populatedSummary: ActivitySummary = {
  since: "2026-02-25T00:00:00.000Z",
  methodExecutions: [
    {
      modelName: "my-bucket",
      type: "aws/s3-bucket",
      succeeded: 5,
      failed: 1,
      total: 6,
      methods: [
        {
          method: "apply",
          succeeded: 5,
          failed: 1,
          total: 6,
          runs: [
            {
              id: "r1",
              definitionId: "d1",
              startedAt: "2026-03-04T10:15:00.000Z",
              durationMs: 1200,
              status: "succeeded",
              triggeredBy: "manual",
            },
            {
              id: "r2",
              definitionId: "d1",
              startedAt: "2026-03-03T14:30:00.000Z",
              durationMs: 800,
              status: "failed",
              error: "AccessDenied",
              triggeredBy: "workflow",
            },
          ],
        },
      ],
    },
  ],
  workflows: [
    {
      workflowName: "deploy-staging",
      succeeded: 2,
      failed: 1,
      total: 3,
      runs: [
        {
          id: "w1",
          startedAt: "2026-03-04T09:00:00.000Z",
          completedAt: "2026-03-04T09:05:00.000Z",
          status: "succeeded",
          steps: [
            {
              jobName: "main",
              stepName: "deploy",
              modelName: "my-bucket",
              status: "succeeded",
              durationMs: 300000,
            },
          ],
        },
        {
          id: "w2",
          startedAt: "2026-03-03T12:00:00.000Z",
          status: "failed",
          firstFailedStep: "build",
          steps: [
            {
              jobName: "main",
              stepName: "build",
              modelName: "builder",
              status: "failed",
              error: "compile error",
            },
          ],
        },
      ],
    },
  ],
  data: {
    totalItems: 8,
    totalVersions: 15,
    uniqueModels: 3,
    byModelType: [
      { modelType: "aws/s3-bucket", items: 5, versions: 10 },
      { modelType: "aws/ec2-instance", items: 3, versions: 5 },
    ],
  },
};

Deno.test("renderSummary - json mode outputs valid JSON", () => {
  const lines = captureLogs(() => {
    renderSummary(populatedSummary, "7d", "json", "normal");
  });

  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.since, populatedSummary.since);
  assertEquals(parsed.methodExecutions.length, 1);
  assertEquals(parsed.workflows.length, 1);
  assertEquals(parsed.data.totalItems, 8);
});

Deno.test("renderSummary - log mode shows method executions", () => {
  const lines = captureLogs(() => {
    renderSummary(populatedSummary, "7d", "log", "normal");
  });

  const output = lines.join("\n");
  assertStringIncludes(output, "Activity summary (last 7d)");
  assertStringIncludes(output, "Direct Model Method Executions");
  assertStringIncludes(output, "Model:");
  assertStringIncludes(output, "my-bucket");
  assertStringIncludes(output, "aws/s3-bucket");
  assertStringIncludes(output, "apply");
  assertStringIncludes(output, "Workflow Runs");
  assertStringIncludes(output, "deploy-staging");
  assertStringIncludes(output, "8 items");
});

Deno.test("renderSummary - verbose mode includes run details", () => {
  const lines = captureLogs(() => {
    renderSummary(populatedSummary, "7d", "log", "verbose");
  });

  const output = lines.join("\n");
  assertStringIncludes(output, "succeeded");
  assertStringIncludes(output, "failed");
  assertStringIncludes(output, "AccessDenied");
  assertStringIncludes(output, "build");
  // Workflow step details
  assertStringIncludes(output, "main > deploy");
  assertStringIncludes(output, "(my-bucket)");
  assertStringIncludes(output, "main > build");
  assertStringIncludes(output, "compile error");
  // Verbose data breakdown
  assertStringIncludes(output, "aws/s3-bucket");
  assertStringIncludes(output, "5 items");
  assertStringIncludes(output, "10 versions");
});

Deno.test("renderSummary - empty summary shows 'none' labels", () => {
  const lines = captureLogs(() => {
    renderSummary(emptySummary, "7d", "log", "normal");
  });

  const output = lines.join("\n");
  assertStringIncludes(output, "none");
});

Deno.test("renderNoActivity - json mode", () => {
  const lines = captureLogs(() => {
    renderNoActivity("7d", "json");
  });

  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.message, "No activity found.");
});
